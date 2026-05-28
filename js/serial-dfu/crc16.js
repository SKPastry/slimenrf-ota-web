// CRC16 — same algorithm used by Adafruit nRF52 bootloader / nrfutil
// Polynomial: custom (not standard CCITT), init: 0xFFFF

/**
 * Calculate CRC16 over a byte array.
 * Matches nordicsemi.dfu.crc16.calc_crc16() from adafruit-nrfutil.
 * @param {Uint8Array} data
 * @param {number} [crc=0xFFFF] initial CRC value
 * @returns {number} 16-bit CRC
 */
export function crc16(data, crc = 0xFFFF) {
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00);
    crc ^= data[i];
    crc ^= (crc & 0x00FF) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00FF) << 4) << 1;
    crc &= 0xFFFF;
  }
  return crc;
}
