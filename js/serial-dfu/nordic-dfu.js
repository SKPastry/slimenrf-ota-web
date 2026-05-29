// Nordic Secure DFU session manager (SDK 15+ protocol)
// Command-response based protocol over SLIP framing
// Ported from pc-nrfutil nordicsemi.dfu.dfu_transport_serial

import { slipEncode, SlipDecoder, END } from './slip.js';
import { crc32 } from '../crc32.js';

// DFU opcodes
const OP = {
  CreateObject:  0x01,
  SetPRN:        0x02,
  CalcChecksum:  0x03,
  Execute:       0x04,
  ReadError:     0x05,
  ReadObject:    0x06,
  GetSerialMTU:  0x07,
  WriteObject:   0x08,
  Ping:          0x09,
  Response:      0x60,
};

// Response result codes
const RES = {
  InvalidCode:        0x00,
  Success:            0x01,
  NotSupported:       0x02,
  InvalidParameter:   0x03,
  InsufficientResources: 0x04,
  InvalidObject:      0x05,
  InvalidSignature:   0x06,
  UnsupportedType:    0x07,
  OperationNotPermitted: 0x08,
  OperationFailed:    0x0A,
  ExtendedError:      0x0B,
};

// Object types
const OBJ_TYPE_COMMAND = 0x01;
const OBJ_TYPE_DATA    = 0x02;

// Extended error codes
const EXT_ERRORS = [
  'No error',
  'Invalid error code',
  'Wrong command format',
  'Unknown command',
  'Init command invalid',
  'FW version too low',
  'HW version mismatch',
  'SD version mismatch',
  'Signature missing',
  'Wrong hash type',
  'Hash failed',
  'Wrong signature type',
  'Verification failed',
  'Insufficient space',
];

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_TIMEOUT   = 10000; // ms
const DEFAULT_PRN       = 0; // 0 = disable packet receipt notifications

/** Pack u16 LE */
function u16LE(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]); }
/** Pack u32 LE */
function u32LE(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]); }
/** Read u16 LE */
function readU16(data, off) { return data[off] | (data[off + 1] << 8); }
/** Read u32 LE */
function readU32(data, off) { return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Nordic Secure DFU session.
 */
export class NordicDfu {
  /**
   * @param {object} options
   * @param {function} [options.onProgress] - (percent, phase, detail) => void
   * @param {function} [options.onLog] - (message) => void
   * @param {number} [options.prn=0] - packet receipt notification interval (0=disabled)
   */
  constructor(options = {}) {
    this._onProgress = options.onProgress ?? (() => {});
    this._onLog = options.onLog ?? (() => {});
    this._prn = options.prn ?? DEFAULT_PRN;
    this._port = null;
    this._writer = null;
    this._reader = null;
    this._decoder = new SlipDecoder();
    this._mtu = 0;
    this._pingId = 0;
    this._aborted = false;
    this._readBuf = [];
    this._readResolve = null;
    this._reading = false;
  }

  /**
   * Open serial port and initialize DFU protocol.
   * @param {SerialPort} port
   * @param {object} [options]
   * @param {number} [options.baudRate=115200]
   * @param {boolean} [options.flowControl=false]
   */
  async open(port, options = {}) {
    this._port = port;
    this._aborted = false;

    const baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    const flowControl = options.flowControl ? 'hardware' : 'none';

    await port.open({
      baudRate,
      dataBits: 8, stopBits: 1, parity: 'none',
      flowControl,
    });
    this._onLog(`Serial port opened (${baudRate} baud, flow=${flowControl})`);

    this._writer = port.writable.getWriter();
    this._reader = port.readable.getReader();
    this._startReading();

    // Ping until bootloader responds
    this._onLog('Pinging bootloader...');
    let pingOk = false;
    const start = Date.now();
    while (Date.now() - start < DEFAULT_TIMEOUT && !pingOk) {
      pingOk = await this._ping();
      if (!pingOk) await sleep(200);
    }
    if (!pingOk) throw new Error('No ping response from bootloader');
    this._onLog('Bootloader responded');

    // Set PRN
    await this._setPRN(this._prn);

    // Get MTU
    await this._getMTU();
    this._onLog(`MTU: ${this._mtu}`);
  }

  /**
   * Send init packet (command object).
   * @param {Uint8Array} initPacket - serialized init packet (.dat file)
   */
  async sendInitPacket(initPacket) {
    this._checkAbort();
    this._onProgress(5, 'init', 'Sending init packet...');

    // Log init packet hex for debugging
    this._onLog(`Init packet (${initPacket.length}B): ${Array.from(initPacket).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

    // Select command object to check for existing state
    this._onLog('SelectObject(COMMAND)...');
    const sel = await this._selectObject(OBJ_TYPE_COMMAND);
    this._onLog(`  maxSize=${sel.maxSize}, offset=${sel.offset}, crc=0x${sel.crc.toString(16)}`);

    // Try to recover existing init packet
    if (sel.offset > 0 && sel.offset <= initPacket.length) {
      const expectedCrc = crc32(initPacket.subarray(0, sel.offset));
      if (expectedCrc === sel.crc) {
        if (initPacket.length > sel.offset) {
          // Send remaining portion
          this._onLog(`Resuming init packet from offset ${sel.offset}`);
          await this._streamData(initPacket.subarray(sel.offset), expectedCrc, sel.offset);
        }
        this._onLog('Execute (resume)...');
        await this._execute();
        return;
      }
    }

    // Send fresh init packet
    if (initPacket.length > sel.maxSize) {
      throw new Error(`Init packet too large: ${initPacket.length} > ${sel.maxSize}`);
    }

    this._onLog(`CreateObject(COMMAND, ${initPacket.length})...`);
    await this._createObject(OBJ_TYPE_COMMAND, initPacket.length);
    this._onLog('StreamData...');
    await this._streamData(initPacket);
    this._onLog('Execute...');
    await this._execute();
    this._onLog('Init packet accepted');
  }

  /**
   * Send firmware data.
   * @param {Uint8Array} firmware - raw firmware binary
   */
  async sendFirmware(firmware) {
    this._checkAbort();
    this._onProgress(10, 'data', 'Sending firmware...');

    const sel = await this._selectObject(OBJ_TYPE_DATA);
    this._onLog(`Data object: maxSize=${sel.maxSize}, offset=${sel.offset}, crc=0x${sel.crc.toString(16)}`);
    let offset = 0;
    let runCrc = 0;

    // Try to recover
    if (sel.offset > 0) {
      const expectedCrc = crc32(firmware.subarray(0, sel.offset));
      if (expectedCrc === sel.crc) {
        const remainder = sel.offset % sel.maxSize;
        if (remainder !== 0 && sel.offset !== firmware.length) {
          // Send rest of current page
          const toSend = firmware.subarray(sel.offset, sel.offset + sel.maxSize - remainder);
          runCrc = await this._streamData(toSend, expectedCrc, sel.offset);
          offset = sel.offset + toSend.length;
        } else {
          offset = sel.offset;
          runCrc = expectedCrc;
        }
        if (offset > 0) {
          await this._execute();
          this._onProgress(10 + Math.round((offset / firmware.length) * 85), 'data',
            `Resumed at ${offset} / ${firmware.length}`);
        }
      }
    }

    // Send remaining data in maxSize chunks
    const totalObjects = Math.ceil((firmware.length - offset) / sel.maxSize);
    let objIdx = 0;
    for (let i = offset; i < firmware.length; i += sel.maxSize) {
      this._checkAbort();
      objIdx++;

      const chunk = firmware.subarray(i, Math.min(i + sel.maxSize, firmware.length));
      await this._createObject(OBJ_TYPE_DATA, chunk.length);
      runCrc = await this._streamData(chunk, runCrc, i);
      this._onLog(`Execute data object ${objIdx}/${totalObjects} (offset=${i + chunk.length}, crc=0x${runCrc.toString(16)})`);
      await this._execute();

      const pct = 10 + Math.round(((i + chunk.length) / firmware.length) * 85);
      this._onProgress(pct, 'data', `${i + chunk.length} / ${firmware.length} bytes`);
    }

    this._onLog(`Firmware sent: ${firmware.length}B, final CRC32=0x${runCrc.toString(16)}`);
    this._onProgress(98, 'done', 'Firmware sent');
  }

  /**
   * Full DFU update: init packet + firmware.
   * @param {Uint8Array} firmware
   * @param {Uint8Array} initPacket
   */
  async sendImage(firmware, initPacket) {
    this._onLog(`DFU: init=${initPacket.length}B, firmware=${firmware.length}B`);

    // Log SHA256 of firmware for verification
    const digest = await crypto.subtle.digest('SHA-256', firmware);
    const hashHex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    this._onLog(`Firmware SHA256: ${hashHex}`);

    await this.sendInitPacket(initPacket);
    await this.sendFirmware(firmware);
    this._onProgress(100, 'done', 'Firmware update complete!');
    this._onLog('DFU complete');
  }

  async close() {
    this._reading = false;
    if (this._readResolve) {
      this._readResolve(null);
      this._readResolve = null;
    }
    try {
      if (this._writer) { this._writer.releaseLock(); this._writer = null; }
      if (this._reader) { this._reader.releaseLock(); this._reader = null; }
      if (this._port) { await this._port.close(); this._port = null; }
    } catch { /* port may be gone */ }
  }

  abort() {
    this._aborted = true;
    this._onLog('DFU aborted');
  }

  _checkAbort() {
    if (this._aborted) throw new Error('DFU aborted');
  }

  // ─── Low-level protocol ──────────────────────

  _startReading() {
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
          if (this._readResolve) {
            const resolve = this._readResolve;
            this._readResolve = null;
            resolve(pkt);
          } else {
            this._readBuf.push(pkt);
          }
        }
      }
    } catch (err) {
      if (this._reading) this._onLog(`Read error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  _waitForPacket(timeoutMs = DEFAULT_TIMEOUT) {
    if (this._readBuf.length > 0) return Promise.resolve(this._readBuf.shift());
    return new Promise(resolve => {
      const timer = setTimeout(() => { this._readResolve = null; resolve(null); }, timeoutMs);
      this._readResolve = (pkt) => { clearTimeout(timer); resolve(pkt); };
    });
  }

  async _sendMessage(data) {
    // Nordic SLIP: encode payload, append END byte (no leading END)
    const encoded = slipEncode(data);
    const frame = new Uint8Array(encoded.length + 1);
    frame.set(encoded);
    frame[frame.length - 1] = END;
    await this._writer.write(frame);
  }

  async _getResponse(expectedOp) {
    const resp = await this._waitForPacket();
    if (!resp) return null;

    if (resp[0] !== OP.Response) throw new Error(`Expected Response(0x60), got 0x${resp[0].toString(16)}`);
    if (resp[1] !== expectedOp) {
      throw new Error(`Unexpected opcode in response: expected 0x${expectedOp.toString(16)}, got 0x${resp[1].toString(16)}`);
    }
    if (resp[2] === RES.Success) return resp.length > 3 ? resp.slice(3) : [];
    if (resp[2] === RES.ExtendedError) {
      const errIdx = resp[3] ?? 0;
      throw new Error(`DFU extended error: ${EXT_ERRORS[errIdx] ?? `unknown(${errIdx})`}`);
    }
    const codeName = Object.entries(RES).find(([, v]) => v === resp[2])?.[0] ?? `0x${resp[2].toString(16)}`;
    const opName = Object.entries(OP).find(([, v]) => v === expectedOp)?.[0] ?? `0x${expectedOp.toString(16)}`;
    this._onLog(`Error response: op=${opName} result=${codeName} raw=[${Array.from(resp).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
    throw new Error(`DFU error: ${codeName}`);
  }

  async _ping() {
    this._pingId = (this._pingId + 1) % 256;
    await this._sendMessage([OP.Ping, this._pingId]);

    const resp = await this._waitForPacket(1000);
    if (!resp) return false;
    if (resp[0] !== OP.Response || resp[1] !== OP.Ping) return false;
    // Success or any error code means bootloader is alive
    return true;
  }

  async _setPRN(prn) {
    await this._sendMessage([OP.SetPRN, ...u16LE(prn)]);
    await this._getResponse(OP.SetPRN);
  }

  async _getMTU() {
    await this._sendMessage([OP.GetSerialMTU]);
    const resp = await this._getResponse(OP.GetSerialMTU);
    this._mtu = readU16(resp, 0);
  }

  async _createObject(objectType, size) {
    await this._sendMessage([OP.CreateObject, objectType, ...u32LE(size)]);
    await this._getResponse(OP.CreateObject);
  }

  async _selectObject(objectType) {
    await this._sendMessage([OP.ReadObject, objectType]);
    const resp = await this._getResponse(OP.ReadObject);
    return {
      maxSize: readU32(resp, 0),
      offset:  readU32(resp, 4),
      crc:     readU32(resp, 8),
    };
  }

  async _calcChecksum() {
    await this._sendMessage([OP.CalcChecksum]);
    const resp = await this._getResponse(OP.CalcChecksum);
    if (!resp) throw new Error('No checksum response');
    return {
      offset: readU32(resp, 0),
      crc:    readU32(resp, 4),
    };
  }

  async _execute() {
    await this._sendMessage([OP.Execute]);
    await this._getResponse(OP.Execute);
  }

  /**
   * Stream data using WriteObject commands.
   * Chunk size is based on MTU (accounting for SLIP worst-case doubling).
   */
  async _streamData(data, startCrc = 0, startOffset = 0) {
    // Max payload per WriteObject = (MTU-1)/2 - 1 (account for SLIP expansion + opcode)
    const chunkSize = Math.max(1, Math.floor((this._mtu - 1) / 2) - 1);
    let runCrc = startCrc;
    let offset = startOffset;
    let prnCount = 0;

    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
      const msg = new Uint8Array(1 + chunk.length);
      msg[0] = OP.WriteObject;
      msg.set(chunk, 1);
      await this._sendMessage(msg);

      runCrc = crc32(chunk, runCrc);
      offset += chunk.length;
      prnCount++;

      // If PRN is set, read checksum response every N packets
      if (this._prn > 0 && prnCount >= this._prn) {
        prnCount = 0;
        const cs = await this._getChecksumResponse();
        this._validateChecksum(cs, runCrc, offset);
      }
    }

    // Final checksum verification
    const cs = await this._calcChecksum();
    this._validateChecksum(cs, runCrc, offset);
    return runCrc;
  }

  async _getChecksumResponse() {
    const resp = await this._getResponse(OP.CalcChecksum);
    return { offset: readU32(resp, 0), crc: readU32(resp, 4) };
  }

  _validateChecksum(response, expectedCrc, expectedOffset) {
    if (response.crc !== expectedCrc) {
      throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${response.crc.toString(16)}`);
    }
    if (response.offset !== expectedOffset) {
      throw new Error(`Offset mismatch: expected ${expectedOffset}, got ${response.offset}`);
    }
  }
}

export { OP, RES, OBJ_TYPE_COMMAND, OBJ_TYPE_DATA, DEFAULT_BAUD_RATE };
