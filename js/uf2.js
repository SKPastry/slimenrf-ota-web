import { crc32 } from './crc32.js';

const UF2_MAGIC_START0 = 0x0A324655;
const UF2_MAGIC_START1 = 0x9E5D5157;
const UF2_MAGIC_END    = 0x0AB16F30;
const UF2_BLOCK_SIZE   = 512;
const UF2_DATA_SIZE    = 256;

/**
 * Parse a UF2 file and extract the contiguous firmware image.
 *
 * @param {ArrayBuffer} buffer  Raw UF2 file contents
 * @param {number} flashOffset  Skip blocks below this address (default 0x1000)
 * @returns {{ data: Uint8Array, baseAddress: number, crc32: number, totalBlocks: number, appBlocks: number }}
 */
export function parseUF2(buffer, flashOffset = 0x1000) {
  const raw = new Uint8Array(buffer);
  if (raw.length % UF2_BLOCK_SIZE !== 0) {
    throw new Error(`UF2 file size (${raw.length}) is not a multiple of 512`);
  }

  const numBlocks = raw.length / UF2_BLOCK_SIZE;
  const view = new DataView(buffer);
  const blocks = [];

  for (let i = 0; i < numBlocks; i++) {
    const off = i * UF2_BLOCK_SIZE;

    const magic0 = view.getUint32(off, true);
    const magic1 = view.getUint32(off + 4, true);
    const magicEnd = view.getUint32(off + 508, true);

    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1) {
      throw new Error(`Block ${i}: bad start magic`);
    }
    if (magicEnd !== UF2_MAGIC_END) {
      throw new Error(`Block ${i}: bad end magic`);
    }

    const addr = view.getUint32(off + 12, true);
    let size = view.getUint32(off + 16, true);
    if (size > UF2_DATA_SIZE) size = UF2_DATA_SIZE;

    if (addr < flashOffset) continue;

    const payload = raw.slice(off + 32, off + 32 + size);
    blocks.push({ addr, payload });
  }

  if (blocks.length === 0) {
    throw new Error('No application blocks found in UF2');
  }

  blocks.sort((a, b) => a.addr - b.addr);
  const base = blocks[0].addr;
  const end = blocks[blocks.length - 1].addr + blocks[blocks.length - 1].payload.length;
  const imageSize = end - base;

  // Fill gaps with 0xFF (erased flash)
  const image = new Uint8Array(imageSize).fill(0xFF);
  for (const { addr, payload } of blocks) {
    image.set(payload, addr - base);
  }

  return {
    data: image,
    baseAddress: base,
    crc32: crc32(image),
    totalBlocks: numBlocks,
    appBlocks: blocks.length,
  };
}
