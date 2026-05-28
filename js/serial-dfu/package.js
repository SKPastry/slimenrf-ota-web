// DFU package handling — parse ZIP packages and generate init packets
// Supports: DFU ZIP (nrfutil format), UF2, HEX → init packet generation

import { crc16 } from './crc16.js';

// Init packet field IDs (from nordicsemi.dfu.init_packet)
// Fields are serialized in order of their enum value (little-endian struct)
const FIELD = {
  DEVICE_TYPE:    1,
  DEVICE_REVISION: 2,
  APP_VERSION:    3,
  SD_REQ_ARRAY:   4,
  FIRMWARE_CRC16: 9,
};

// Adafruit bootloader device type check
const ADAFRUIT_DEVICE_TYPE = 0x0052;

// Device revisions
const DEV_REV = {
  NRF52840: 52840,  // 0xCE58
  NRF52833: 52833,  // 0xCE41
  NRF52832: 0xADAF,
  ANY:      0xFFFF,
};

// Default values matching adafruit-nrfutil defaults
const DEFAULTS = {
  deviceType:   ADAFRUIT_DEVICE_TYPE,
  deviceRev:    DEV_REV.ANY,
  appVersion:   0xFFFFFFFF,
  sdReq:        [0xFFFE], // any softdevice
  dfuVersion:   0.5,
};

/**
 * Generate a binary init packet (.dat file) for Adafruit legacy DFU.
 *
 * Binary layout (little-endian, DFU v0.5):
 *   u16 device_type
 *   u16 device_rev
 *   u32 app_version
 *   u16 sd_array_length
 *   u16[] sd_req
 *   u16 firmware_crc16
 *
 * @param {Uint8Array} firmwareBin - raw firmware binary
 * @param {object} [options]
 * @param {number} [options.deviceType=0x0052]
 * @param {number} [options.deviceRev=0xFFFF]
 * @param {number} [options.appVersion=0xFFFFFFFF]
 * @param {number[]} [options.sdReq=[0xFFFE]]
 * @returns {Uint8Array} init packet bytes
 */
export function generateInitPacket(firmwareBin, options = {}) {
  const deviceType = options.deviceType ?? DEFAULTS.deviceType;
  const deviceRev  = options.deviceRev ?? DEFAULTS.deviceRev;
  const appVersion = options.appVersion ?? DEFAULTS.appVersion;
  const sdReq      = options.sdReq ?? DEFAULTS.sdReq;

  // Calculate CRC16 of firmware binary
  const fwCrc = crc16(firmwareBin);

  // Build init packet: all fields little-endian
  const sdLen = sdReq.length;
  const totalSize = 2 + 2 + 4 + 2 + (sdLen * 2) + 2; // last 2 = CRC16
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  let offset = 0;

  view.setUint16(offset, deviceType, true); offset += 2;
  view.setUint16(offset, deviceRev, true);  offset += 2;
  view.setUint32(offset, appVersion, true); offset += 4;
  view.setUint16(offset, sdLen, true);      offset += 2;
  for (const sd of sdReq) {
    view.setUint16(offset, sd, true);       offset += 2;
  }
  view.setUint16(offset, fwCrc, true);      offset += 2;

  return new Uint8Array(buf);
}

/**
 * Parse a DFU ZIP package (nrfutil format).
 *
 * ZIP contains:
 *   manifest.json — describes firmware components
 *   *.bin         — firmware binary
 *   *.dat         — init packet
 *
 * @param {ArrayBuffer} zipData - ZIP file content
 * @returns {Promise<DfuPackage>}
 */
export async function parseDfuZip(zipData) {
  // Use the browser's native ZIP support via ReadableStream
  // We parse the central directory manually to avoid external dependencies

  const zip = await parseZipEntries(zipData);

  // Find and parse manifest.json
  const manifestEntry = zip.find(e => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('DFU ZIP: manifest.json not found');

  const manifestJson = new TextDecoder().decode(manifestEntry.data);
  const manifest = JSON.parse(manifestJson);

  if (!manifest.manifest) throw new Error('DFU ZIP: invalid manifest format');

  const m = manifest.manifest;
  const images = [];

  // Process each firmware component
  for (const [type, fw] of Object.entries(m)) {
    if (!fw || !fw.bin_file || !fw.dat_file) continue;

    const binEntry = zip.find(e => e.name === fw.bin_file);
    const datEntry = zip.find(e => e.name === fw.dat_file);
    if (!binEntry) throw new Error(`DFU ZIP: ${fw.bin_file} not found`);
    if (!datEntry) throw new Error(`DFU ZIP: ${fw.dat_file} not found`);

    images.push({
      type,
      firmware: binEntry.data,
      initPacket: datEntry.data,
      sdSize: fw.sd_size ?? 0,
      blSize: fw.bl_size ?? 0,
    });
  }

  if (images.length === 0) throw new Error('DFU ZIP: no firmware images found');

  return { manifest: m, images };
}

/**
 * Create a DFU package from a raw firmware binary.
 * Generates the init packet on-the-fly.
 *
 * @param {Uint8Array} firmwareBin - raw firmware binary
 * @param {object} [options] - same as generateInitPacket options
 * @returns {DfuPackage}
 */
export function createDfuPackageFromBinary(firmwareBin, options = {}) {
  const initPacket = generateInitPacket(firmwareBin, options);
  return {
    manifest: { application: { bin_file: 'firmware.bin', dat_file: 'firmware.dat' } },
    images: [{
      type: 'application',
      firmware: firmwareBin,
      initPacket,
      sdSize: 0,
      blSize: 0,
    }],
  };
}

// ─── Minimal ZIP parser (no external deps) ────────────────────────────

/**
 * Parse ZIP file entries from an ArrayBuffer.
 * Supports only Store (0) and Deflate (8) compression.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
async function parseZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Find End of Central Directory record (search from end)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('ZIP: End of Central Directory not found');

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdCount  = view.getUint16(eocdOffset + 10, true);

  const entries = [];
  let pos = cdOffset;

  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('ZIP: Invalid central directory entry');
    }

    const compression = view.getUint16(pos + 10, true);
    const compSize    = view.getUint32(pos + 20, true);
    const uncompSize  = view.getUint32(pos + 24, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);

    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    // Read local file header to get actual data offset
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('ZIP: Invalid local file header');
    }
    const localNameLen  = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset    = localOffset + 30 + localNameLen + localExtraLen;

    const compData = bytes.subarray(dataOffset, dataOffset + compSize);

    let data;
    if (compression === 0) {
      // Store — no compression
      data = compData;
    } else if (compression === 8) {
      // Deflate — use DecompressionStream
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      writer.write(compData);
      writer.close();

      const chunks = [];
      let totalLen = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLen += value.length;
      }

      data = new Uint8Array(totalLen);
      let off = 0;
      for (const chunk of chunks) {
        data.set(chunk, off);
        off += chunk.length;
      }
    } else {
      throw new Error(`ZIP: Unsupported compression method ${compression}`);
    }

    entries.push({ name, data });
  }

  return entries;
}

export { ADAFRUIT_DEVICE_TYPE, DEV_REV, DEFAULTS };
