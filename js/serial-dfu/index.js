// Serial DFU — main entry point
// Auto-detects protocol (Adafruit Legacy vs Nordic Secure) and manages the DFU flow

import { AdafruitDfu } from './adafruit-dfu.js';
import { NordicDfu } from './nordic-dfu.js';
import { parseDfuZip, createDfuPackageFromBinary, ADAFRUIT_DEVICE_TYPE, DEV_REV } from './package.js';
import { generateNordicInitPacket, FwType } from './nordic-init-packet.js';
import { slipEncode, END } from './slip.js';

/**
 * DFU protocol types — matches bootloader_type from firmware protocol.
 */
export const DFU_PROTOCOL = {
  ADAFRUIT: 'adafruit',  // Legacy HCI DFU (Adafruit nRF52 bootloader)
  NORDIC:   'nordic',    // Secure DFU (Nordic SDK 15+ bootloader)
};

/**
 * Detect DFU protocol from a connected serial device.
 * Tries Nordic ping first (faster detection), falls back to Adafruit.
 *
 * @param {SerialPort} port - already-opened serial port
 * @returns {Promise<string>} DFU_PROTOCOL value
 */
export async function detectProtocol(port) {
  // Nordic bootloader responds to Ping (opcode 0x09)
  // Adafruit bootloader ignores unknown opcodes and only responds to HCI packets
  // Try Nordic first since it has explicit Ping support

  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();

  try {
    // Send Nordic Ping
    const pingData = [0x09, 0x01]; // Ping with id=1
    const encoded = slipEncode(pingData);
    const frame = new Uint8Array(encoded.length + 1);
    frame.set(encoded);
    frame[frame.length - 1] = END;
    await writer.write(frame);

    // Wait for response (short timeout)
    const response = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ value: null, done: false }), 500)),
    ]);

    if (response.value && response.value.length > 0) {
      // Check if response looks like Nordic (starts with 0x60 = Response opcode)
      // After SLIP decoding, first byte should be 0x60
      const raw = response.value;
      // Look for 0x60 in the response (may be SLIP-encoded)
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === 0x60) return DFU_PROTOCOL.NORDIC;
      }
    }

    return DFU_PROTOCOL.ADAFRUIT;
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

/**
 * High-level Serial DFU manager.
 * Handles protocol detection, firmware preparation, and update execution.
 */
export class SerialDfu {
  /**
   * @param {object} options
   * @param {function} [options.onProgress] - (percent, phase, detail) => void
   * @param {function} [options.onLog] - (message) => void
   * @param {string} [options.protocol] - force protocol ('adafruit' or 'nordic')
   */
  constructor(options = {}) {
    this._onProgress = options.onProgress ?? (() => {});
    this._onLog = options.onLog ?? (() => {});
    this._protocol = options.protocol ?? null;
    this._dfu = null;
    this._port = null;
  }

  /**
   * Request and open a serial port, then run DFU.
   *
   * @param {Uint8Array|ArrayBuffer} firmwareData - UF2, HEX, DFU ZIP, or raw binary
   * @param {object} [options]
   * @param {string} [options.format] - 'zip', 'uf2', 'hex', 'bin' (auto-detected if omitted)
   * @param {string} [options.protocol] - 'adafruit' or 'nordic' (auto-detected if omitted)
   * @param {object} [options.initOptions] - options for init packet generation
   * @param {number} [options.baudRate=115200]
   */
  async update(firmwareData, options = {}) {
    const data = firmwareData instanceof ArrayBuffer ? new Uint8Array(firmwareData) : firmwareData;
    const format = options.format ?? this._detectFormat(data);
    const protocol = options.protocol ?? this._protocol;

    this._onLog(`Firmware format: ${format}`);

    // Request serial port with DFU bootloader VID filter
    this._onLog('Requesting serial port...');
    const DFU_FILTERS = [
      { usbVendorId: 0x1915 },  // Nordic Semiconductor (nRF5 Open DFU)
      { usbVendorId: 0x239A },  // Adafruit (UF2 bootloader)
      { usbVendorId: 0x1209 },  // pid.codes (Styria, SlimeVR)
      { usbVendorId: 0x2FE3 },  // nRF DFU
      { usbVendorId: 0x2886 },  // SeeedStudio (XIAO)
      { usbVendorId: 0x1B4F },  // SparkFun
    ];
    try {
      this._port = await navigator.serial.requestPort({ filters: DFU_FILTERS });
    } catch (err) {
      if (err.name === 'NotFoundError') {
        this._onLog('No port selected');
        return false;
      }
      throw err;
    }

    // Determine protocol (auto-detect or user-specified)
    let activeProtocol = options.protocol ?? this._protocol;
    if (!activeProtocol) {
      const baudRate = options.baudRate ?? 115200;
      await this._port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      try {
        activeProtocol = await detectProtocol(this._port);
      } finally {
        await this._port.close();
      }
      this._onLog(`Detected protocol: ${activeProtocol}`);
    }

    // Prepare firmware package
    this._onProgress(0, 'prepare', 'Preparing firmware...');
    let images;
    if (format === 'zip') {
      const pkg = await parseDfuZip(data.buffer ?? data);
      images = pkg.images;
      this._onLog(`DFU ZIP: ${images.length} image(s)`);
    } else {
      // Extract raw binary from UF2/HEX or use as-is
      let binary = data;
      if (format === 'uf2') {
        const { parseUF2 } = await import('../uf2.js');
        const buf = data.buffer.byteLength === data.byteLength
          ? data.buffer
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        // Auto-detect flash offset for serial DFU:
        // Parse all blocks first to find the application region
        const flashOffset = options.flashOffset ?? this._detectUf2AppOffset(buf);
        const parsed = parseUF2(buf, flashOffset);
        binary = parsed.data;
        this._onLog(`UF2: ${binary.length} bytes, base=0x${parsed.baseAddress.toString(16)}, flashOffset=0x${flashOffset.toString(16)}`);
      } else if (format === 'hex') {
        const { parseHex } = await import('../hex.js');
        // parseHex expects a text string, not Uint8Array
        const text = (data instanceof Uint8Array || data instanceof ArrayBuffer)
          ? new TextDecoder().decode(data)
          : data;
        const parsed = parseHex(text);
        binary = parsed.data;
        this._onLog(`HEX: ${binary.length} bytes, base=0x${parsed.baseAddress.toString(16)}`);
      }

      if (activeProtocol === DFU_PROTOCOL.NORDIC) {
        this._onLog('⚠ Generating init packet from raw binary — if update fails, try a DFU ZIP package');
        const initPacket = await generateNordicInitPacket(binary, options.initOptions);
        images = [{ type: 'application', firmware: binary, initPacket, sdSize: 0, blSize: 0 }];
      } else {
        const pkg = createDfuPackageFromBinary(binary, options.initOptions);
        images = pkg.images;
      }
    }

    // Run DFU
    try {
      if (activeProtocol === DFU_PROTOCOL.NORDIC) {
        this._dfu = new NordicDfu({ onProgress: this._onProgress, onLog: this._onLog });
        await this._dfu.open(this._port, { baudRate: options.baudRate });

        for (const img of images) {
          this._onLog(`Sending ${img.type}: ${img.firmware.length} bytes`);
          await this._dfu.sendImage(img.firmware, img.initPacket);
        }
      } else {
        this._dfu = new AdafruitDfu({ onProgress: this._onProgress, onLog: this._onLog });
        await this._dfu.open(this._port, { baudRate: options.baudRate });

        for (const img of images) {
          this._onLog(`Sending ${img.type}: ${img.firmware.length} bytes`);
          await this._dfu.sendFirmware(img.firmware, img.initPacket, {
            sdSize: img.sdSize, blSize: img.blSize,
          });
        }
      }

      return true;
    } finally {
      await this.close();
    }
  }

  /** Abort in-progress DFU. */
  abort() {
    this._dfu?.abort();
  }

  /** Close serial port and clean up. */
  async close() {
    if (this._dfu) {
      await this._dfu.close();
      this._dfu = null;
    }
    this._port = null;
  }

  /**
   * Detect firmware file format from magic bytes.
   * @param {Uint8Array} data
   * @returns {string}
   */
  _detectFormat(data) {
    if (data.length < 4) return 'bin';

    // DFU ZIP (PK header)
    if (data[0] === 0x50 && data[1] === 0x4B) return 'zip';

    // UF2 (magic: 0x0A324655 "UF2\n")
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) === 0x0A324655) return 'uf2';

    // Intel HEX (starts with ':')
    if (data[0] === 0x3A) return 'hex';

    return 'bin';
  }

  /**
   * Auto-detect the application start offset in a UF2 file.
   *
   * Strategy:
   * - If ALL blocks are at/above a known SD boundary → app-only build, use that boundary
   * - Otherwise → use the lowest block address (no SD, or full image)
   *
   * @param {ArrayBuffer} buf - raw UF2 file
   * @returns {number} flash offset
   */
  _detectUf2AppOffset(buf) {
    const UF2_BLOCK_SIZE = 512;
    const UF2_MAGIC = 0x0A324655;
    const raw = new Uint8Array(buf);
    const view = new DataView(buf);
    const numBlocks = Math.floor(raw.length / UF2_BLOCK_SIZE);

    // Collect all block addresses
    const addrs = [];
    for (let i = 0; i < numBlocks; i++) {
      const off = i * UF2_BLOCK_SIZE;
      if (view.getUint32(off, true) !== UF2_MAGIC) continue;
      addrs.push(view.getUint32(off + 12, true));
    }
    if (addrs.length === 0) return 0x1000;

    const minAddr = Math.min(...addrs);

    // Known SoftDevice end addresses (app start offsets)
    const SD_BOUNDARIES = [0x27000, 0x26000, 0x1C000];

    // If ALL blocks are above a known SD boundary, it's an app-only build (SD not included)
    for (const boundary of SD_BOUNDARIES) {
      if (minAddr >= boundary) {
        this._onLog(`UF2 app-only build detected (min addr 0x${minAddr.toString(16)}, using offset 0x${boundary.toString(16)})`);
        return boundary;
      }
    }

    // Blocks start below any known SD boundary — use the lowest block address
    // This handles both no-SD builds (from 0x1000) and full SD+app images
    this._onLog(`UF2 starts at 0x${minAddr.toString(16)}`);
    return minAddr;
  }
}

export { AdafruitDfu } from './adafruit-dfu.js';
export { NordicDfu } from './nordic-dfu.js';
export { parseDfuZip, createDfuPackageFromBinary } from './package.js';
export { generateNordicInitPacket, FwType } from './nordic-init-packet.js';
