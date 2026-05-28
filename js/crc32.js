// CRC32 (IEEE 802.3) — lookup-table implementation
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  TABLE[i] = c;
}

/**
 * Compute CRC32 of a Uint8Array.
 * @param {Uint8Array} data
 * @param {number} [prevCrc=0] - previous CRC for incremental calculation
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(data, prevCrc = 0) {
  let crc = (prevCrc ? (prevCrc ^ 0xFFFFFFFF) : 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
