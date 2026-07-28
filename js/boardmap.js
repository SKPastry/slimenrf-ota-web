// Board target ↔ firmware filename mapping for auto-detection.
//
// Data sources (pre-computed, updated 2025-06):
//   1. /mnt/d/uf2 flasher/config.yaml — local flasher config
//   2. SKPastry/SlimeVR-Tracker-nRF devc workflow.yml — CI build matrix (tracker)
//   3. SKPastry/SlimeVR-Tracker-nRF-Receiver devc workflow.yml — CI build matrix (receiver)
//   4. Shine-Bright-Meow/SlimeNRF-Firmware-CI boards.matrix.json — community CI
//
// Static maps updated from these sources. Online fetch refreshes at runtime.

// ── Static Tracker Map ──────────────────────────────────────────────
// boardTarget → [filename patterns (case-insensitive substring match)]
// More specific patterns must come before general ones.

const STATIC_MAP = {
  // ── Styria ────────────────────────────────────────────────────
  'styria_mini_uf2/nrf52840/spi': [
    'Styria_Mini_Tracker',       // workflow.yml
    'styria_mini_zephyr_spi',    // config.yaml
  ],

  // ── ProMicro StackedSmol ──────────────────────────────────────
  'promicro_uf2/nrf52840/spi': [
    'StackedSmol_Tracker_SPI',        // workflow.yml (non-SD)
    'Mag_SPI_StackedSmol_JitingCat',  // boards.matrix.json
    'Mag_SPI_StackedSmol',            // boards.matrix.json (short)
    'Tracker_SPI_StackedSmol',        // config.yaml
  ],
  'promicro_uf2/nrf52840/i2c': [
    'StackedSmol_Tracker_I2C',        // workflow.yml
    'Mag_I2C_StackedSmol_JitingCat',  // boards.matrix.json
    'Mag_I2C_StackedSmol',            // boards.matrix.json (short)
    'Tracker_I2C_StackedSmol',        // config.yaml
  ],

  // ── ProMicro Default ──────────────────────────────────────────
  'promicro_uf2/nrf52840/default_spi': [
    'ProMicro_Tracker_SPI',        // workflow.yml
    'Mag_SPI_ProMicro_JitingCat',  // boards.matrix.json
    'Mag_SPI_ProMicro',            // boards.matrix.json (short)
    'Tracker_DefaultSPI',          // config.yaml
  ],
  'promicro_uf2/nrf52840/default_i2c': [
    'ProMicro_Tracker_I2C',        // workflow.yml
    'Mag_I2C_ProMicro_JitingCat',  // boards.matrix.json
    'Mag_I2C_ProMicro',            // boards.matrix.json (short)
    'Tracker_DefaultI2C',          // config.yaml
  ],

  // ── ProMicro Special Variants ─────────────────────────────────
  'promicro_uf2/nrf52840/chrysalis': [
    'Chrysalis_Tracker',              // workflow.yml
    'Mag_Chrysalis_ProMicro_JitingCat', // boards.matrix.json
    'Chrysalis',                      // generic match
  ],
  'promicro_uf2/nrf52840/lwkj_icm45v1': [
    'LWKJ_ICM45V1',  // config.yaml
  ],
  'promicro_uf2/nrf52840/bao': [
    'Tracker_Bao_JitingCat',  // boards.matrix.json
    'Tracker_Bao',
  ],
  'promicro_uf2/nrf52840/smspi': [
    'smSPI',  // boards.matrix.json combined naming
  ],

  // ── FoxSnack ──────────────────────────────────────────────────
  'foxsnacklite_uf2/nrf52840': [
    'FoxSnackLite_Tracker',  // workflow.yml
    'FoxSnackLite',          // config.yaml
    'foxlite_tracker',       // config.yaml
  ],

  // ── Mochi ─────────────────────────────────────────────────────
  'mochi_uf2/nrf52833': [
    'Mochi_Tracker',                  // workflow.yml
    'Tracker_Mag_Mochi_JitingCat',    // boards.matrix.json
    'mochi_tracker',                  // config.yaml
  ],

  // ── Aero ──────────────────────────────────────────────────────
  'aero_tracker_uf2/nrf52840': [
    'Aero_Tracker',   // workflow.yml
    'aero_tracker',   // config.yaml
  ],

  // ── XIAO (sense MUST be before generic xiao) ──────────────────
  'xiao_ble/nrf52840/sense': [
    'XIAO_Sense_Tracker',  // workflow.yml
  ],
  'xiao_ble/nrf52840': [
    'XIAO_Tracker',  // workflow.yml
  ],

  // ── Dawn ──────────────────────────────────────────────────────
  'dawn_tracker_mini_uf2/nrf52833': [
    'Dawn_Tracker_Mini',  // workflow.yml
  ],

  // ── Kawazu ────────────────────────────────────────────────────
  'kawazu_uf2/nrf52833': [
    'Kawazu_Tracker',           // workflow.yml
    'Tracker_Kawazu_JitingCat', // boards.matrix.json
  ],

  // ── NiNi ──────────────────────────────────────────────────────
  'nini_slimevr_mag_uf2/nrf52833': [
    'NiNi_SlimeVR_MAG',  // workflow.yml
  ],

  // ── R3 ────────────────────────────────────────────────────────
  'slimenrf_r3/nrf52840/uf2': [
    'R3_Tracker',  // boards.matrix.json combined naming
  ],

  // ── SlimeVR Mini (community) ──────────────────────────────────
  'slimevrmini_p1_uf2/nrf52833': ['SlimevrMini_Tracker', 'SlimevrMini '],
  'slimevrmini_p2_uf2/nrf52833': ['SlimevrMini2_Tracker', 'SlimevrMini2'],
  'slimevrmini_p3r6_uf2/nrf52833': ['SlimevrMini3_R6'],
  'slimevrmini_p3r7_uf2/nrf52833': ['SlimevrMini3_R7'],
  'slimevrmini_p4_uf2/nrf52833': ['SlimevrMini4_Tracker', 'SlimevrMini4 '],
  'slimevrmini_p4r9_uf2/nrf52833': ['SlimevrMini4R9'],
  'slimevrmini_p4r11_uf2/nrf52833': ['SlimevrMini4R11'],
};

// ── Static Receiver Map ────────────────────────────────────────────
// Same structure: boardTarget → [filename patterns]

const RECEIVER_STATIC_MAP = {
  // ── Styria ────────────────────────────────────────────────────
  'styria_r1_uf2/nrf52840': ['Styria_R1_Receiver', 'styria_receiver_r1'],
  // ── AeroRX ────────────────────────────────────────────────────
  'aerorx_r1_uf2/nrf52840': ['AeroRX_R1_Receiver', 'aerorx_receiver_r1'],
  // ── ProMicro ──────────────────────────────────────────────────
  'promicro_uf2/nrf52840': ['ProMicro_Receiver', 'promicro-receiver', 'promicro_receiver'],
  // ── HolyIoT ───────────────────────────────────────────────────
  'holyiot_21017/nrf52840': ['Holyiot_Dongle_Receiver', 'holyiot_receiver'],
  // ── Nordic / eByte Dongle ─────────────────────────────────────
  'nrf52840dongle/nrf52840': ['Nordic_eByte_Dongle_Receiver', 'dongle_receiver'],
  // ── Seeed XIAO ────────────────────────────────────────────────
  'xiao_ble/nrf52840': ['XIAO_Receiver'],
  // ── etee ──────────────────────────────────────────────────────
  'etee_dongle_uf2/nrf52840': ['etee_Receiver'],
  // ── nRF52840 DK ───────────────────────────────────────────────
  'nrf52840dk/nrf52840': ['nRF52840dk_Receiver'],
};

// Merged runtime maps (static + online, static has priority)
let _mergedMap = { ...STATIC_MAP };
let _mergedReceiverMap = { ...RECEIVER_STATIC_MAP };

// ── Matching ────────────────────────────────────────────────────────

/**
 * Match a firmware filename to a tracker board target.
 * Returns the board target string or null if no match.
 */
export function matchBoardTarget(filename) {
  const lower = filename.toLowerCase();
  for (const [board, patterns] of Object.entries(_mergedMap)) {
    for (const pattern of patterns) {
      if (lower.includes(pattern.toLowerCase())) return board;
    }
  }
  return null;
}

/**
 * Match a firmware filename to a receiver board target.
 * Returns the board target string or null if no match.
 */
export function matchReceiverBoardTarget(filename) {
  const lower = filename.toLowerCase();
  for (const [board, patterns] of Object.entries(_mergedReceiverMap)) {
    for (const pattern of patterns) {
      if (lower.includes(pattern.toLowerCase())) return board;
    }
  }
  return null;
}

/**
 * Get a friendly short name for a board target.
 */
export function boardFriendlyName(boardTarget) {
  const parts = boardTarget.split('/');
  const board = parts[0].replace(/_uf2$/, '').replace(/_/g, ' ');
  const variant = parts.slice(2).join('/');
  return variant ? `${board} (${variant})` : board;
}

/**
 * Return the current merged tracker map (for display/debugging).
 */
export function getBoardMap() {
  return { ..._mergedMap };
}

/**
 * Return the current merged receiver map (for display/debugging).
 */
export function getReceiverBoardMap() {
  return { ..._mergedReceiverMap };
}

// ── Online Sources ──────────────────────────────────────────────────

const WORKFLOW_URL = 'https://raw.githubusercontent.com/SKPastry/SlimeVR-Tracker-nRF/refs/heads/devc/.github/workflows/workflow.yml';
const RECEIVER_WORKFLOW_URL = 'https://raw.githubusercontent.com/SKPastry/SlimeVR-Tracker-nRF-Receiver/refs/heads/devc/.github/workflows/workflow.yml';
const BOARDS_MATRIX_URL = 'https://raw.githubusercontent.com/Shine-Bright-Meow/SlimeNRF-Firmware-CI/refs/heads/main/boards.matrix.json';

/**
 * Fetch board→filename mapping from the SKPastry tracker devc workflow.yml.
 * Parses the YAML matrix section via regex.
 */
async function fetchWorkflowMap() {
  const resp = await fetch(WORKFLOW_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const map = {};
  const re = /\{boardname:\s*"([^"]+)",\s*filename:\s*"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const [, board, filename] = m;
    if (!map[board]) map[board] = [];
    if (!map[board].includes(filename)) map[board].push(filename);
  }
  return map;
}

/**
 * Fetch board→filename mapping from the SKPastry receiver devc workflow.yml.
 */
async function fetchReceiverWorkflowMap() {
  const resp = await fetch(RECEIVER_WORKFLOW_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const map = {};
  const re = /\{boardname:\s*"([^"]+)",\s*filename:\s*"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const [, board, filename] = m;
    if (!map[board]) map[board] = [];
    if (!map[board].includes(filename)) map[board].push(filename);
  }
  return map;
}

/**
 * Fetch board→filename mapping from Shine-Bright-Meow boards.matrix.json.
 * Returns { tracker: {…}, receiver: {…} }.
 */
async function fetchBoardsMatrixMaps() {
  const resp = await fetch(BOARDS_MATRIX_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const tracker = {};
  const receiver = {};
  for (const v of data.variants || []) {
    if (!v.filename || !v.filename.includes('JitingCat')) continue;
    const target = v.type === 'receiver' ? receiver : tracker;
    if (!target[v.boardname]) target[v.boardname] = [];
    if (!target[v.boardname].includes(v.filename)) target[v.boardname].push(v.filename);
  }
  return { tracker, receiver };
}

/**
 * Refresh the merged maps by fetching online sources.
 * Falls back gracefully — static maps always stay.
 * Returns { updated: boolean, sources: string[], errors: string[], addedBoards: number, addedPatterns: number }.
 */
export async function refreshOnlineMaps() {
  const sources = [];
  const errors = [];
  const onlineTracker = {};
  const onlineReceiver = {};

  const results = await Promise.allSettled([
    fetchWorkflowMap(),
    fetchReceiverWorkflowMap(),
    fetchBoardsMatrixMaps(),
  ]);

  // Tracker workflow.yml
  if (results[0].status === 'fulfilled') {
    const m = results[0].value;
    if (Object.keys(m).length > 0) {
      Object.assign(onlineTracker, m);
      sources.push('workflow.yml');
    }
  } else {
    errors.push(`workflow.yml: ${results[0].reason?.message || 'unknown error'}`);
  }

  // Receiver workflow.yml
  if (results[1].status === 'fulfilled') {
    const m = results[1].value;
    if (Object.keys(m).length > 0) {
      _mergeInto(onlineReceiver, m);
      sources.push('receiver-workflow.yml');
    }
  } else {
    errors.push(`receiver-workflow.yml: ${results[1].reason?.message || 'unknown error'}`);
  }

  // boards.matrix.json (tracker + receiver)
  if (results[2].status === 'fulfilled') {
    const { tracker, receiver } = results[2].value;
    if (Object.keys(tracker).length > 0 || Object.keys(receiver).length > 0) {
      _mergeInto(onlineTracker, tracker);
      _mergeInto(onlineReceiver, receiver);
      sources.push('boards.matrix.json');
    }
  } else {
    errors.push(`boards.matrix.json: ${results[2].reason?.message || 'unknown error'}`);
  }

  // Merge into tracker map
  _mergedMap = { ...STATIC_MAP };
  let addedBoards = 0;
  let addedPatterns = 0;
  const trackerCounts = _mergeOnlineIntoMap(_mergedMap, onlineTracker);
  addedBoards += trackerCounts.boards;
  addedPatterns += trackerCounts.patterns;

  // Merge into receiver map
  _mergedReceiverMap = { ...RECEIVER_STATIC_MAP };
  const receiverCounts = _mergeOnlineIntoMap(_mergedReceiverMap, onlineReceiver);
  addedBoards += receiverCounts.boards;
  addedPatterns += receiverCounts.patterns;

  return { updated: sources.length > 0, sources, errors, addedBoards, addedPatterns };
}

/** Merge source map entries into target map (mutates target). */
function _mergeInto(target, source) {
  for (const [board, patterns] of Object.entries(source)) {
    if (!target[board]) target[board] = [];
    for (const p of patterns) {
      if (!target[board].includes(p)) target[board].push(p);
    }
  }
}

/** Merge online map into a static base map, count new additions. */
function _mergeOnlineIntoMap(baseMap, online) {
  let boards = 0;
  let patterns = 0;
  for (const [board, pats] of Object.entries(online)) {
    if (!baseMap[board]) {
      baseMap[board] = [];
      boards++;
    }
    for (const p of pats) {
      if (!baseMap[board].some((s) => s.toLowerCase() === p.toLowerCase())) {
        baseMap[board].push(p);
        patterns++;
      }
    }
  }
  return { boards, patterns };
}
