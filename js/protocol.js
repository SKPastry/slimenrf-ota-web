// SlimeNRF ESB OTA Protocol — constants, packet builders, parsers
// Mirrors the Python esb_ota.py protocol layer for WebHID usage.

// ── HID Device ──────────────────────────────────────────────────────

export const VID = 0x1209;
export const PID = 0x7690;
export const REPORT_SIZE = 64;

// ── HID OTA Report Types ────────────────────────────────────────────

export const HID_OTA_QUERY_INFO = 0xf0;
export const HID_OTA_FW_INFO    = 0xf1;
export const HID_OTA_BEGIN      = 0xf2;
export const HID_OTA_DATA       = 0xf3;
export const HID_OTA_STATUS     = 0xf4;
export const HID_OTA_VERIFY     = 0xf5;
export const HID_OTA_ACTIVATE   = 0xf6;
export const HID_OTA_ABORT      = 0xf7;

// ── OTA Status Codes ────────────────────────────────────────────────

export const OTA_STATUS_IDLE           = 0x00;
export const OTA_STATUS_READY          = 0x01;
export const OTA_STATUS_RECEIVING      = 0x02;
export const OTA_STATUS_VERIFY_OK      = 0x03;
export const OTA_STATUS_VERIFY_FAIL    = 0x04;
export const OTA_STATUS_ACTIVATING     = 0x05;
export const OTA_STATUS_COMPLETE       = 0x06;
export const OTA_STATUS_ERROR          = 0x10;
export const OTA_STATUS_BOARD_MISMATCH = 0x11;
export const OTA_STATUS_FLASH_ERROR    = 0x12;
export const OTA_STATUS_SIZE_ERROR     = 0x13;
export const OTA_STATUS_SEQ_ERROR      = 0x14;
export const OTA_STATUS_TIMEOUT        = 0x15;

export const STATUS_NAMES = {
  [OTA_STATUS_IDLE]:           'Idle',
  [OTA_STATUS_READY]:          'Ready',
  [OTA_STATUS_RECEIVING]:      'Receiving',
  [OTA_STATUS_VERIFY_OK]:      'Verify OK',
  [OTA_STATUS_VERIFY_FAIL]:    'Verify Failed',
  [OTA_STATUS_ACTIVATING]:     'Activating',
  [OTA_STATUS_COMPLETE]:       'Complete',
  [OTA_STATUS_ERROR]:          'Error',
  [OTA_STATUS_BOARD_MISMATCH]: 'Board Mismatch',
  [OTA_STATUS_FLASH_ERROR]:    'Flash Error',
  [OTA_STATUS_SIZE_ERROR]:     'Size Error',
  [OTA_STATUS_SEQ_ERROR]:      'Sequence Error',
  [OTA_STATUS_TIMEOUT]:        'Timeout',
};

export const TERMINAL_STATUSES = new Set([
  OTA_STATUS_COMPLETE,
  OTA_STATUS_ERROR,
  OTA_STATUS_VERIFY_FAIL,
  OTA_STATUS_TIMEOUT,
  OTA_STATUS_BOARD_MISMATCH,
  OTA_STATUS_SIZE_ERROR,
  OTA_STATUS_FLASH_ERROR,
]);

// ── Protocol Constants ──────────────────────────────────────────────

export const OTA_PROTOCOL_VERSION = 1;
export const OTA_DATA_MAX_PAYLOAD = 60;
export const OTA_BOARD_TARGET_MAX = 48;
export const RING_BUFFER_SIZE     = 127;
export const MAX_IN_FLIGHT        = RING_BUFFER_SIZE - 16; // 111
export const BURST_SIZE           = 48;
export const RECEIVER_OTA_ID      = 0xFE; // tracker_id for receiver self-OTA

const BL_TYPES = { 0: 'none', 1: 'adafruit_uf2', 2: 'nrf5_opendfu' };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Packet Builders ─────────────────────────────────────────────────

export function buildQueryInfo(trackerId) {
  const pkt = new Uint8Array(REPORT_SIZE);
  pkt[0] = HID_OTA_QUERY_INFO;
  pkt[1] = trackerId;
  return pkt;
}

export function buildBegin(trackerId, imageSize, imageCrc32, totalPackets,
                           boardTarget, flashBase = 0) {
  const pkt = new Uint8Array(REPORT_SIZE);
  const dv = new DataView(pkt.buffer);
  pkt[0] = HID_OTA_BEGIN;
  pkt[1] = trackerId;
  dv.setUint32(2, imageSize, true);           // LE
  dv.setUint32(6, imageCrc32, true);          // LE
  dv.setUint16(10, totalPackets, false);      // BE
  pkt[12] = OTA_PROTOCOL_VERSION;
  const target = textEncoder.encode(boardTarget.substring(0, OTA_BOARD_TARGET_MAX - 1));
  pkt.set(target, 13);
  if (flashBase > 0) {
    dv.setUint16(61, flashBase >>> 12, false); // BE, page-aligned
  }
  return pkt;
}

export function buildData(trackerId, seq, payload) {
  const pkt = new Uint8Array(REPORT_SIZE);
  const dv = new DataView(pkt.buffer);
  pkt[0] = HID_OTA_DATA;
  pkt[1] = trackerId;
  dv.setUint16(2, seq, false);                // BE
  const len = Math.min(payload.length, OTA_DATA_MAX_PAYLOAD);
  pkt.set(payload.subarray(0, len), 4);
  return pkt;
}

export function buildVerify(trackerId) {
  const pkt = new Uint8Array(REPORT_SIZE);
  pkt[0] = HID_OTA_VERIFY;
  pkt[1] = trackerId;
  return pkt;
}

export function buildActivate(trackerId) {
  const pkt = new Uint8Array(REPORT_SIZE);
  pkt[0] = HID_OTA_ACTIVATE;
  pkt[1] = trackerId;
  return pkt;
}

export function buildAbort(trackerId = 0xff) {
  const pkt = new Uint8Array(REPORT_SIZE);
  pkt[0] = HID_OTA_ABORT;
  pkt[1] = trackerId;
  return pkt;
}

// ── Parsers ─────────────────────────────────────────────────────────

/** Split a 64-byte HID frame into 4 × 16-byte sub-reports. */
export function parseSubReports(frame) {
  const subs = [];
  for (let off = 0; off < Math.min(frame.length, 64); off += 16) {
    const sub = frame.slice(off, off + 16);
    if (sub.length >= 1) subs.push(sub);
  }
  return subs;
}

/** Parse an OTA_STATUS sub-report → structured object. */
export function parseStatus(report) {
  if (report.length < 10 || report[0] !== HID_OTA_STATUS) return null;
  const dv = new DataView(report.buffer, report.byteOffset, report.byteLength);
  return {
    trackerId:    report[1],
    status:       report[2],
    statusName:   STATUS_NAMES[report[2]] ?? `0x${report[2].toString(16).padStart(2, '0')}`,
    nextSeq:      dv.getUint16(3, false),  // BE
    bytesWritten: dv.getUint32(5, true),   // LE
    ringCount:    report[9],
  };
}

/**
 * Reassemble 6 FW_INFO chunks (each 16-byte sub-report) into firmware info.
 *
 * Layout of the 66-byte info block:
 *   [2]     major
 *   [3]     minor
 *   [4]     patch
 *   [5–8]   build_datetime  (32-bit BE, FAT-style packed)
 *   [9–12]  firmware_size   (LE)
 *   [13]    bootloader_type (0=none, 1=adafruit_uf2, 2=nrf5_opendfu)
 *   [14]    ota_protocol_version
 *   [15–62] board_target    (null-terminated UTF-8)
 *   [63–64] flash_base >> 12 (BE)
 */
export function parseFwInfo(chunks) {
  const info = new Uint8Array(66);
  for (const c of chunks) {
    if (c.length < 3 || c[0] !== HID_OTA_FW_INFO) continue;
    const idx = c[2];
    if (idx > 5) continue;
    const off = 2 + idx * 13;
    const len = Math.min(13, 66 - off);
    if (len > 0) info.set(c.slice(3, 3 + len), off);
  }

  const dv  = new DataView(info.buffer);
  const dt  = dv.getUint32(5, false); // BE
  const year   = ((dt >>> 25) & 0x7f) + 2020;
  const month  = (dt >>> 21) & 0x0f;
  const day    = (dt >>> 16) & 0x1f;
  const hour   = (dt >>> 11) & 0x1f;
  const minute = (dt >>> 5)  & 0x3f;
  const second = (dt & 0x1f) * 2;

  const pad = (n) => String(n).padStart(2, '0');

  // Find null-terminator in board_target field [15..63)
  let boardEnd = 63;
  for (let i = 15; i < 63; i++) {
    if (info[i] === 0) { boardEnd = i; break; }
  }

  return {
    version:         `${info[2]}.${info[3]}.${info[4]}`,
    buildDate:       `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    firmwareSize:    dv.getUint32(9, true), // LE
    bootloader:      BL_TYPES[info[13]] ?? `unknown(${info[13]})`,
    protocolVersion: info[14],
    boardTarget:     textDecoder.decode(info.slice(15, boardEnd)),
    flashBase:       dv.getUint16(63, false) << 12, // BE, page-aligned
  };
}
