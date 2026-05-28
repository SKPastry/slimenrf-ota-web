// Minimal protobuf encoder for Nordic DFU init packets
// Only supports the subset needed for dfu-cc.proto Packet message
// No external dependencies — hand-coded protobuf wire format

import { crc32 } from '../crc32.js';

// Protobuf wire types
const WIRE_VARINT  = 0;
const WIRE_LEN     = 2;

// Enum values from dfu-cc.proto
export const FwType = {
  APPLICATION:            0,
  SOFTDEVICE:             1,
  BOOTLOADER:             2,
  SOFTDEVICE_BOOTLOADER:  3,
  EXTERNAL_APPLICATION:   4,
};

export const HashType = {
  NO_HASH:  0,
  CRC:      1,
  SHA256:   3,
};

/** Encode a varint */
function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0; // ensure unsigned
  while (v > 0x7F) {
    bytes.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7F);
  return bytes;
}

/** Encode a field tag */
function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/** Encode a varint field */
function varintField(fieldNumber, value) {
  return [...encodeTag(fieldNumber, WIRE_VARINT), ...encodeVarint(value)];
}

/** Encode a length-delimited field (bytes or embedded message) */
function lenField(fieldNumber, data) {
  return [...encodeTag(fieldNumber, WIRE_LEN), ...encodeVarint(data.length), ...data];
}

/** Encode packed repeated uint32 */
function packedField(fieldNumber, values) {
  const packed = [];
  for (const v of values) packed.push(...encodeVarint(v));
  return lenField(fieldNumber, packed);
}

/**
 * Encode a Hash message: { hash_type: HashType, hash: bytes }
 */
function encodeHash(hashType, hashBytes) {
  const inner = [
    ...varintField(1, hashType),
    ...lenField(2, hashBytes),
  ];
  return inner;
}

/**
 * Encode an InitCommand message.
 */
function encodeInitCommand(opts) {
  const fields = [];

  if (opts.fwVersion !== undefined)  fields.push(...varintField(1, opts.fwVersion));
  if (opts.hwVersion !== undefined)  fields.push(...varintField(2, opts.hwVersion));
  if (opts.sdReq && opts.sdReq.length > 0) fields.push(...packedField(3, opts.sdReq));
  if (opts.type !== undefined)       fields.push(...varintField(4, opts.type));
  if (opts.sdSize)                   fields.push(...varintField(5, opts.sdSize));
  if (opts.blSize)                   fields.push(...varintField(6, opts.blSize));
  if (opts.appSize)                  fields.push(...varintField(7, opts.appSize));
  if (opts.hash)                     fields.push(...lenField(8, encodeHash(opts.hash.type, opts.hash.bytes)));
  if (opts.isDebug)                  fields.push(...varintField(9, 1));

  return fields;
}

/**
 * Encode a Command message: { op_code: INIT, init: InitCommand }
 */
function encodeCommand(initCommandBytes) {
  const fields = [
    ...varintField(1, 1), // op_code = INIT = 1
    ...lenField(2, initCommandBytes),
  ];
  return fields;
}

/**
 * Encode a Packet message: { command: Command }
 * Field 1 = command (unsigned), Field 2 = signed_command (not used)
 */
function encodePacket(commandBytes) {
  return new Uint8Array(lenField(1, commandBytes));
}

/**
 * Generate a Nordic Secure DFU init packet (protobuf-encoded).
 *
 * This produces the .dat file content for Nordic SDK 15+ bootloaders.
 *
 * @param {Uint8Array} firmwareBin - firmware binary (for hash)
 * @param {object} [options]
 * @param {number} [options.fwVersion=0xFFFFFFFF]
 * @param {number} [options.hwVersion=52] - hardware version
 * @param {number[]} [options.sdReq=[]] - required softdevice versions (empty = no SD required)
 * @param {number} [options.type=0] - FwType enum
 * @param {number} [options.appSize] - auto-calculated from firmware if not set
 * @param {number} [options.sdSize=0]
 * @param {number} [options.blSize=0]
 * @param {string} [options.hashType='sha256'] - 'sha256' or 'crc'
 * @returns {Promise<Uint8Array>}
 */
export async function generateNordicInitPacket(firmwareBin, options = {}) {
  const fwVersion  = options.fwVersion ?? 0xFFFFFFFF;
  const hwVersion  = options.hwVersion ?? 52;
  const sdReq      = options.sdReq ?? [];
  const type       = options.type ?? FwType.APPLICATION;
  const sdSize     = options.sdSize ?? 0;
  const blSize     = options.blSize ?? 0;
  const appSize    = options.appSize ?? (type === FwType.APPLICATION ? firmwareBin.length : 0);
  const hashType   = options.hashType ?? 'sha256';

  // Compute hash
  let hash;
  if (hashType === 'sha256') {
    const digest = await crypto.subtle.digest('SHA-256', firmwareBin);
    // nRF DFU convention: SHA256 hash stored in little-endian (reversed) byte order
    const hashBytes = new Uint8Array(digest);
    hashBytes.reverse();
    hash = { type: HashType.SHA256, bytes: hashBytes };
  } else {
    // CRC32 hash (fallback)
    const fwCrc = crc32(firmwareBin);
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, fwCrc, true);
    hash = { type: HashType.CRC, bytes: crcBytes };
  }

  const initCmd = encodeInitCommand({
    fwVersion, hwVersion, sdReq, type,
    sdSize, blSize, appSize, hash,
  });
  const cmd = encodeCommand(initCmd);
  return encodePacket(cmd);
}
