import { crc32 } from './crc32.js';

/**
 * Parse an Intel HEX file and extract the contiguous firmware image.
 *
 * Supports record types:
 *  00 - Data
 *  01 - End Of File
 *  02 - Extended Segment Address
 *  04 - Extended Linear Address
 *
 * @param {string} text  Raw Intel HEX file contents as text
 * @param {number} flashOffset  Skip data below this address (default 0x1000)
 * @returns {{ data: Uint8Array, baseAddress: number, crc32: number, totalRecords: number, appRecords: number }}
 */
export function parseHex(text, flashOffset = 0x1000) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let baseAddr = 0;
  let totalRecords = 0;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (!line || line[0] !== ':') continue;

    // Parse Intel HEX record: :LLAAAATT[DD...]CC
    const hex = line.slice(1);
    if (hex.length < 10) {
      throw new Error(`Line ${lineNo + 1}: record too short`);
    }

    const raw = new Uint8Array(hex.length / 2);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }

    const byteCount = raw[0];
    const address = (raw[1] << 8) | raw[2];
    const recType = raw[3];
    const data = raw.slice(4, 4 + byteCount);
    const checksum = raw[4 + byteCount];

    // Verify checksum
    let sum = 0;
    for (let i = 0; i < 4 + byteCount; i++) sum += raw[i];
    const expected = (~sum + 1) & 0xFF;
    if (checksum !== expected) {
      throw new Error(
        `Line ${lineNo + 1}: checksum mismatch (got 0x${checksum.toString(16).padStart(2, '0')}, expected 0x${expected.toString(16).padStart(2, '0')})`
      );
    }

    totalRecords++;

    if (recType === 0x00) {
      // Data record
      const fullAddr = baseAddr + address;
      if (fullAddr >= flashOffset) {
        records.push({ addr: fullAddr, data: data });
      }
    } else if (recType === 0x01) {
      // EOF
      break;
    } else if (recType === 0x02) {
      // Extended segment address
      baseAddr = ((data[0] << 8) | data[1]) << 4;
    } else if (recType === 0x04) {
      // Extended linear address
      baseAddr = ((data[0] << 8) | data[1]) << 16;
    }
    // Ignore types 03 (start segment) and 05 (start linear address)
  }

  if (records.length === 0) {
    throw new Error('No application data found in HEX file');
  }

  // Sort by address and create contiguous image
  records.sort((a, b) => a.addr - b.addr);
  const base = records[0].addr;
  const end = records[records.length - 1].addr + records[records.length - 1].data.length;
  const imageSize = end - base;

  // Allocate and fill (0xFF for gaps — erased flash)
  const image = new Uint8Array(imageSize).fill(0xFF);
  for (const { addr, data } of records) {
    image.set(data, addr - base);
  }

  return {
    data: image,
    baseAddress: base,
    crc32: crc32(image),
    totalRecords,
    appRecords: records.length,
  };
}
