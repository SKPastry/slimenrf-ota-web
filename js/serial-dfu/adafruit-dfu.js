// Adafruit Legacy DFU session manager
// Implements the complete DFU flow: START → INIT → DATA → STOP → ACTIVATE
// Ported from adafruit-nrfutil nordicsemi.dfu.dfu + dfu_transport_serial
//
// Bootloader compatibility (auto-detected via INIT probe after START):
// - New bootloader: defers flash erase to per-page during DATA writes (~90ms/page).
//   USB stays alive throughout. INIT probe succeeds → skip straight to DATA.
// - Old bootloader: erases all flash pages synchronously in START (~90ms/page × N).
//   CPU blocks for seconds, causing USB disconnect. INIT probe times out →
//   wait for erase to complete, reconnect, then retry INIT.

import { AdafruitHciTransport } from './adafruit-hci.js';

// DFU packet types (match bootloader dfu_types.h)
const DFU_START_PACKET     = 3;
const DFU_INIT_PACKET      = 1;
const DFU_DATA_PACKET      = 4;
const DFU_STOP_DATA_PACKET = 5;

// DFU update modes
const DFU_UPDATE_APP = 4;

// Timing constants (from Adafruit nrfutil, based on nRF52840 flash specs)
const FLASH_PAGE_SIZE       = 4096;
const FLASH_PAGE_ERASE_TIME = 0.0897; // seconds, max per page
const FLASH_WORD_WRITE_TIME = 0.000100;
const FLASH_PAGE_WRITE_TIME = (FLASH_PAGE_SIZE / 4) * FLASH_WORD_WRITE_TIME;
const DFU_PACKET_MAX_SIZE   = 512;

// Reconnection constants
const RECONNECT_POLL_INTERVAL = 500;  // ms between reopen attempts
const RECONNECT_EXTRA_WAIT    = 2000; // extra wait after erase for USB re-enum

// Serial port config
const DEFAULT_BAUD_RATE     = 115200;

/** Pack a 32-bit little-endian value into 4 bytes */
function uint32LE(v) {
  return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]);
}

/** Pack a 16-bit little-endian value into 2 bytes */
function uint16LE(v) {
  return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);
}

/** Concatenate multiple Uint8Arrays */
function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** Sleep for ms milliseconds */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Adafruit Legacy DFU session.
 * Handles the complete firmware update flow over serial.
 */
export class AdafruitDfu {
  /**
   * @param {object} options
   * @param {function} [options.onProgress] - (percent, phase, detail) => void
   * @param {function} [options.onLog] - (message) => void
   */
  constructor(options = {}) {
    this._onProgress = options.onProgress ?? (() => {});
    this._onLog = options.onLog ?? (() => {});
    this._port = null;
    this._transport = null;
    this._aborted = false;
    this._baudRate = DEFAULT_BAUD_RATE;
    this._hciSeq = 0; // preserved across reconnects
  }

  /**
   * Open serial port and prepare for DFU.
   * @param {SerialPort} port - Web Serial API port
   * @param {object} [options]
   * @param {number} [options.baudRate=115200]
   */
  async open(port, options = {}) {
    this._port = port;
    this._aborted = false;
    this._baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this._hciSeq = 0;

    await this._openTransport();

    // DTR toggle to signal DFU tool presence
    await port.setSignals({ dataTerminalReady: false });
    await sleep(50);
    await port.setSignals({ dataTerminalReady: true });
    await sleep(100);

    this._onLog('DFU transport ready');
  }

  /**
   * Internal: open the serial port and create an HCI transport.
   * Called on initial open and after USB reconnection.
   */
  async _openTransport() {
    if (!this._port.readable) {
      await this._port.open({
        baudRate: this._baudRate,
        dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none',
      });
      this._onLog(`Serial port opened (${this._baudRate} baud)`);
    }

    const writer = this._port.writable.getWriter();
    const reader = this._port.readable.getReader();

    this._transport = new AdafruitHciTransport(writer, reader, {
      onLog: this._onLog,
      initialSeq: this._hciSeq,
    });
    this._transport.startReading();
  }

  /**
   * Internal: close current transport (but keep port reference).
   */
  async _closeTransport() {
    if (this._transport) {
      this._hciSeq = this._transport.seq; // preserve sequence number
      this._transport.stop();
      // Cancel pending read before releasing lock — reader.releaseLock()
      // throws if there's a pending read() call
      try { await this._transport._reader.cancel(); } catch { /* device may be gone */ }
      try { this._transport._reader.releaseLock(); } catch { /* may already be released */ }
      try { this._transport._writer.releaseLock(); } catch { /* may already be released */ }
      this._transport = null;
    }
  }

  /**
   * Wait for USB device to reconnect after a disconnect.
   * Uses the same paired port object — tries to reopen it periodically.
   * @param {number} maxWaitMs - maximum wait time
   */
  async _waitForReconnect(maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      this._checkAbort();
      attempt++;

      // Try closing first (might be in an error state)
      try { await this._port.close(); } catch { /* ok */ }

      await sleep(RECONNECT_POLL_INTERVAL);

      try {
        await this._port.open({
          baudRate: this._baudRate,
          dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none',
        });
        this._onLog(`Reconnected after ${attempt} attempt(s)`);
        return true;
      } catch {
        // Not ready yet — try again
      }
    }
    return false;
  }

  /**
   * Send a complete firmware image.
   *
   * @param {Uint8Array} firmware - raw firmware binary
   * @param {Uint8Array} initPacket - .dat file content (init packet)
   * @param {object} [options]
   * @param {number} [options.mode=4] - DFU update mode (4=app)
   * @param {number} [options.sdSize=0] - SoftDevice size
   * @param {number} [options.blSize=0] - Bootloader size
   */
  async sendFirmware(firmware, initPacket, options = {}) {
    if (!this._transport) throw new Error('DFU transport not opened');
    this._checkAbort();

    const mode   = options.mode ?? DFU_UPDATE_APP;
    const sdSize = options.sdSize ?? 0;
    const blSize = options.blSize ?? 0;
    const appSize = (mode === DFU_UPDATE_APP) ? firmware.length : 0;
    const totalSize = sdSize + blSize + appSize;

    // === Phase 1: START ===
    this._onProgress(0, 'start', 'Sending start packet...');
    this._onLog(`DFU START: mode=${mode}, sd=${sdSize}, bl=${blSize}, app=${appSize}`);

    const startPayload = concat(
      uint32LE(DFU_START_PACKET),
      uint32LE(mode),
      uint32LE(sdSize),
      uint32LE(blSize),
      uint32LE(appSize)
    );

    const erasePages = Math.ceil(totalSize / FLASH_PAGE_SIZE) + 1;

    // Send START — the HCI ACK arrives before the bootloader processes the DFU command.
    // On old bootloaders, processing triggers a bulk erase (~7s CPU block → USB disconnect).
    // On new bootloaders, processing is instant (erase deferred to per-page during DATA).
    let startAckLost = false;
    const startTime = Date.now();
    try {
      await this._transport.sendPacket(startPayload);
    } catch (err) {
      // If ACK was lost due to early USB disconnect, START was likely still processed.
      // Proceed with reconnection — if START wasn't received, INIT will fail clearly.
      this._onLog(`START ACK interrupted (${err instanceof Error ? err.message : String(err)}), continuing...`);
      startAckLost = true;
    }

    // Prepare INIT payload (used in both probe and reconnect paths)
    const initPayload = concat(
      uint32LE(DFU_INIT_PACKET),
      initPacket,
      uint16LE(0x0000) // padding required by protocol
    );

    // === Phase 2: INIT (with bootloader auto-detection) ===
    //
    // After START, we probe with INIT to detect which bootloader is running:
    // - New bootloader: erases only the first page (~90ms), then ready for INIT.
    //   Probe succeeds → skip straight to DATA (saves ~8s).
    // - Old bootloader: erases ALL pages synchronously (~7s), USB disconnects.
    //   Probe times out → fall back to wait + reconnect + retry INIT.
    // - START ACK lost: USB already disconnected → skip probe, go straight to reconnect.

    let initDone = false;

    if (!startAckLost) {
      // Wait for first-page erase on new bootloader (~90ms), then probe
      await sleep(500);

      const savedRetries = this._transport._maxRetries;
      const savedTimeout = this._transport._ackTimeout;
      const savedSeq = this._transport._seq;
      this._transport._maxRetries = 1;
      this._transport._ackTimeout = 1500;

      try {
        this._onProgress(5, 'init', 'Sending init packet...');
        this._onLog(`DFU INIT: ${initPacket.length} bytes`);
        await this._transport.sendPacket(initPayload);
        this._onLog('New bootloader — no bulk erase');
        initDone = true;
      } catch {
        // Probe failed — old bootloader is busy erasing.
        // Restore seq so reconnect path sends correct seq number.
        this._onLog('Old bootloader — bulk erase in progress');
        this._transport._seq = savedSeq;
      }

      this._transport._maxRetries = savedRetries;
      this._transport._ackTimeout = savedTimeout;
    }

    if (!initDone) {
      // Old bootloader path: wait for bulk erase to finish + USB re-enumeration
      const eraseWaitMs = Math.max(500, erasePages * FLASH_PAGE_ERASE_TIME * 1000);
      const elapsed = Date.now() - startTime;
      const remainingWait = Math.max(0, eraseWaitMs + RECONNECT_EXTRA_WAIT - elapsed);

      this._onLog(`Flash erase in progress (~${(eraseWaitMs / 1000).toFixed(1)}s for ${erasePages} pages)...`);
      this._onProgress(2, 'erase', `Erasing ${erasePages} pages...`);

      await this._closeTransport();

      // If START ACK was lost, _closeTransport saved a stale seq. Override:
      // the bootloader processed START (seq=1, via pre-increment from 0) and
      // now expects seq=2. Setting _hciSeq=1 ensures the next sendPacket
      // pre-increments to 2.
      if (startAckLost) {
        this._hciSeq = 1;
      }

      await sleep(remainingWait);
      this._checkAbort();

      this._onLog('Reconnecting after flash erase...');
      this._onProgress(4, 'reconnect', 'Reconnecting...');

      const reconnected = await this._waitForReconnect(15000);
      if (!reconnected) {
        throw new Error('Failed to reconnect after flash erase — please re-flash manually');
      }

      await this._openTransport();

      // DTR toggle to signal tool presence after reconnect
      try {
        await this._port.setSignals({ dataTerminalReady: false });
        await sleep(50);
        await this._port.setSignals({ dataTerminalReady: true });
      } catch { /* some devices don't support DTR */ }
      await sleep(200);

      this._checkAbort();

      this._onProgress(5, 'init', 'Sending init packet...');
      this._onLog(`DFU INIT: ${initPacket.length} bytes`);
      await this._transport.sendPacket(initPayload);
    }

    this._checkAbort();

    // === Phase 3: DATA ===
    this._onProgress(8, 'data', 'Streaming firmware...');
    this._onLog(`DFU DATA: ${firmware.length} bytes in ${Math.ceil(firmware.length / DFU_PACKET_MAX_SIZE)} packets`);

    const totalPackets = Math.ceil(firmware.length / DFU_PACKET_MAX_SIZE);
    let packetCount = 0;

    for (let offset = 0; offset < firmware.length; offset += DFU_PACKET_MAX_SIZE) {
      this._checkAbort();

      const chunk = firmware.subarray(offset, Math.min(offset + DFU_PACKET_MAX_SIZE, firmware.length));
      const dataPayload = concat(uint32LE(DFU_DATA_PACKET), chunk);
      await this._transport.sendPacket(dataPayload);

      packetCount++;
      const pct = 8 + Math.round((packetCount / totalPackets) * 87);
      this._onProgress(pct, 'data', `${offset + chunk.length} / ${firmware.length} bytes`);

      // After every 8 packets (4KB page), pause for flash write
      if (packetCount % 8 === 0) {
        await sleep(FLASH_PAGE_WRITE_TIME * 1000);
      }
    }

    // Wait for last page write
    await sleep(FLASH_PAGE_WRITE_TIME * 1000);

    // === Phase 4: STOP ===
    this._onProgress(96, 'stop', 'Finalizing...');
    this._onLog('DFU STOP');

    await this._transport.sendPacket(uint32LE(DFU_STOP_DATA_PACKET));

    // === Phase 5: ACTIVATE ===
    this._onProgress(98, 'activate', 'Activating firmware...');
    this._onLog('Activating new firmware');

    // Single-bank: activate only writes bootloader settings (1 page erase+write).
    // No bank copy needed — data was written directly to bank 0 during DATA phase.
    await sleep(500);

    this._onProgress(100, 'done', 'Firmware update complete!');
    this._onLog('DFU complete');
  }

  /**
   * Close the transport and serial port.
   */
  async close() {
    await this._closeTransport();
    if (this._port) {
      try {
        await this._port.close();
      } catch { /* port may already be closed */ }
      this._port = null;
    }
  }

  /** Abort an in-progress update. */
  abort() {
    this._aborted = true;
    this._onLog('DFU aborted by user');
  }

  _checkAbort() {
    if (this._aborted) throw new Error('DFU aborted');
  }
}

export { DFU_UPDATE_APP, DFU_PACKET_MAX_SIZE, DEFAULT_BAUD_RATE };
