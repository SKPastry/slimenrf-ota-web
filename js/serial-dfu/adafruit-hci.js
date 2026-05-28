// Adafruit Legacy DFU — HCI reliable transport layer
// Ported from adafruit-nrfutil nordicsemi.dfu.dfu_transport_serial

import { slipEncode, SlipDecoder, END } from './slip.js';
import { crc16 } from './crc16.js';

// HCI header constants
const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET              = 1;
const HCI_PACKET_TYPE              = 14;

/**
 * Build 4-byte HCI header.
 *
 * Layout (from Nordic SDK docs):
 *   byte0: [seq:3][ack:3][dip:1][rp:1]
 *   byte1: [pkt_type:4][len_low:4]
 *   byte2: [len_high:8]
 *   byte3: header checksum (twos-complement of sum of bytes 0-2)
 *
 * @param {number} seq - sequence number (0-7)
 * @param {number} payloadLen - payload length
 * @returns {Uint8Array} 4-byte header
 */
function buildHciHeader(seq, payloadLen) {
  const ack = (seq + 1) % 8;
  const b0 = seq | (ack << 3) | (DATA_INTEGRITY_CHECK_PRESENT << 6) | (RELIABLE_PACKET << 7);
  const b1 = HCI_PACKET_TYPE | ((payloadLen & 0x0F) << 4);
  const b2 = (payloadLen & 0x0FF0) >> 4;
  const b3 = (~(b0 + b1 + b2) + 1) & 0xFF;
  return new Uint8Array([b0, b1, b2, b3]);
}

/**
 * Build a complete HCI packet ready to send over serial.
 *
 * Structure: [0xC0] [SLIP(header + payload + crc16)] [0xC0]
 *
 * @param {number} seq - sequence number (0-7)
 * @param {Uint8Array} payload - DFU command + data
 * @returns {{ data: Uint8Array, seq: number }}
 */
export function buildHciPacket(seq, payload) {
  const header = buildHciHeader(seq, payload.length);

  // CRC16 over header + payload (before SLIP encoding)
  const raw = new Uint8Array(header.length + payload.length);
  raw.set(header);
  raw.set(payload, header.length);
  const crc = crc16(raw);

  // Append CRC16 (little-endian)
  const withCrc = new Uint8Array(raw.length + 2);
  withCrc.set(raw);
  withCrc[raw.length]     = crc & 0xFF;
  withCrc[raw.length + 1] = (crc >> 8) & 0xFF;

  // SLIP-encode the body (not the frame delimiters)
  const encoded = slipEncode(withCrc);

  // Wrap with 0xC0 delimiters
  const packet = new Uint8Array(encoded.length + 2);
  packet[0] = END;
  packet.set(encoded, 1);
  packet[packet.length - 1] = END;

  return { data: packet, seq };
}

/**
 * Extract ACK number from a received HCI ACK packet.
 * Input should be SLIP-decoded (no 0xC0 delimiters).
 * @param {Uint8Array} decoded - SLIP-decoded ACK data
 * @returns {number} ACK number (0-7)
 */
export function extractAckNumber(decoded) {
  if (decoded.length < 1) throw new Error('HCI ACK packet too short');
  return (decoded[0] >> 3) & 0x07;
}

/**
 * Adafruit HCI transport — manages serial I/O with reliable delivery.
 */
export class AdafruitHciTransport {
  /**
   * @param {WritableStream} writer - serial port writable stream
   * @param {ReadableStream} reader - serial port readable stream
   * @param {object} [options]
   * @param {number} [options.ackTimeout=1000] - ACK timeout in ms
   * @param {number} [options.maxRetries=3] - max send retries per packet
   * @param {number} [options.initialSeq=0] - initial sequence number
   * @param {function} [options.onLog] - logging callback
   */
  constructor(writer, reader, options = {}) {
    this._writer = writer;
    this._reader = reader;
    this._ackTimeout = options.ackTimeout ?? 1000;
    this._maxRetries = options.maxRetries ?? 3;
    this._log = options.onLog ?? (() => {});
    this._seq = options.initialSeq ?? 0;
    this._decoder = new SlipDecoder();
    this._readBuf = [];
    this._reading = false;
    this._readPromiseResolve = null;
  }

  /** Current HCI sequence number */
  get seq() { return this._seq; }

  /**
   * Start background reading from serial port.
   * Call before sending any packets.
   */
  startReading() {
    if (this._reading) return;
    this._reading = true;
    this._readLoop();
  }

  async _readLoop() {
    try {
      while (this._reading) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        const packets = this._decoder.feed(value);
        for (const pkt of packets) {
          if (this._readPromiseResolve) {
            const resolve = this._readPromiseResolve;
            this._readPromiseResolve = null;
            resolve(pkt);
          } else {
            this._readBuf.push(pkt);
          }
        }
      }
    } catch (err) {
      if (this._reading) {
        this._log(`Read error: ${err.message}`);
      }
    }
  }

  /**
   * Wait for next SLIP-decoded packet from serial.
   * @param {number} timeoutMs
   * @returns {Promise<Uint8Array|null>}
   */
  _waitForPacket(timeoutMs) {
    // Check buffer first
    if (this._readBuf.length > 0) {
      return Promise.resolve(this._readBuf.shift());
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._readPromiseResolve = null;
        resolve(null);
      }, timeoutMs);

      this._readPromiseResolve = (pkt) => {
        clearTimeout(timer);
        resolve(pkt);
      };
    });
  }

  /**
   * Send an HCI packet and wait for ACK.
   *
   * Sequence numbering: pre-increment before building the packet.
   * This matches Python nrfutil's HciPacket.__init__() which does
   *   sequence_number = (sequence_number + 1) % 8
   * before building the header. The bootloader expects the first
   * packet with seq=1 (INITIAL_ACK_NUMBER_EXPECTED = 1).
   *
   * @param {Uint8Array} payload - DFU command payload
   * @returns {Promise<void>}
   */
  async sendPacket(payload) {
    // Pre-increment: _seq=0 → first packet uses seq=1 (matching bootloader expectation)
    this._seq = (this._seq + 1) % 8;

    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
      const pkt = buildHciPacket(this._seq, payload);
      await this._writer.write(pkt.data);

      const ackPkt = await this._waitForPacket(this._ackTimeout);

      if (!ackPkt) {
        // Timeout — reset seq to 0 (next sendPacket pre-increments to 1, matching Python)
        this._seq = 0;
        this._decoder.reset();
        this._log(`ACK timeout (attempt ${attempt + 1}/${this._maxRetries})`);
        if (attempt === this._maxRetries - 1) {
          throw new Error('No ACK received after max retries');
        }
        continue;
      }

      // ACK received — bootloader processed the packet.
      // No strict ACK number validation (matching Python nrfutil behavior where
      // send_packet() always breaks on first ACK with `if last_ack is None: break`).
      return;
    }

    throw new Error(`Failed to send packet after ${this._maxRetries} attempts`);
  }

  /**
   * Stop reading from serial port.
   */
  stop() {
    this._reading = false;
    if (this._readPromiseResolve) {
      this._readPromiseResolve(null);
      this._readPromiseResolve = null;
    }
  }

  /** Reset sequence number (e.g., for new DFU session). */
  resetSequence() {
    this._seq = 0;
    this._decoder.reset();
    this._readBuf = [];
  }
}
