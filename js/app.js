// SlimeNRF OTA Web Updater — Alpine.js application

import Alpine from 'alpinejs';
import { OTASession } from './ota.js';
import { parseUF2 } from './uf2.js';
import { parseHex } from './hex.js';
import { buildAbort, VID, PID, OTA_DATA_MAX_PAYLOAD, RECEIVER_OTA_ID } from './protocol.js';
import { matchBoardTarget, matchReceiverBoardTarget, refreshOnlineMaps } from './boardmap.js';
import {
  fetchReleases, fetchCIRuns, fetchRunArtifacts,
  fetchReceiverCIRuns, fetchReceiverRunArtifacts,
  downloadArtifact, downloadReleaseAsset, openDownloadUrl,
  extractUF2FromZip, isProxyAvailable, formatDate, formatSize,
} from './github.js';

/**
 * Check if a firmware image contains SoftDevice + Application by looking
 * for a valid ARM Cortex-M vector table at the expected app base address.
 *
 * @param {Uint8Array} fwData  Firmware image data
 * @param {number} fwBase     Base address of the firmware image
 * @param {number} deviceBase Device's expected app start address (e.g., 0x27000)
 * @returns {boolean} true if a valid vector table exists at deviceBase within the image
 */
function looksLikeSdPlusApp(fwData, fwBase, deviceBase) {
  if (fwBase >= deviceBase) return false;
  const offset = deviceBase - fwBase;
  if (offset + 8 > fwData.length) return false;

  // Read initial SP and reset vector at the device's app base
  const dv = new DataView(fwData.buffer, fwData.byteOffset + offset, 8);
  const initialSP = dv.getUint32(0, true);
  const resetVector = dv.getUint32(4, true);

  // SP should point to RAM (0x20000000 - 0x20040000 for nRF52)
  const spValid = (initialSP >= 0x20000000 && initialSP <= 0x20040000);
  // Reset vector should be in flash at/after device base (odd = Thumb mode)
  const rvValid = (resetVector >= deviceBase && resetVector < 0x100000 && (resetVector & 1) === 1);

  return spValid && rvValid;
}

// ── Alpine.js Component ─────────────────────────────────────────────

Alpine.data('otaApp', () => ({
  // ── Feature detection ───────────────────────────────────────
  webHIDSupported: 'hid' in navigator,
  secureContext: window.isSecureContext,

  // ── UI state ────────────────────────────────────────────────
  otaNoticeHidden: false,

  // ── Connection state ────────────────────────────────────────
  pairedDevices: [],   // Previously paired HIDDevices from getDevices()
  selectedDevice: null, // Currently active HIDDevice
  connected: false,
  connecting: false,
  _receiverCache: {},  // { [serial]: { trackerCount, lastSeen } } — persisted in localStorage

  // ── Tracker state ───────────────────────────────────────────
  scanning: false,
  trackers: {},         // { [tid]: { addr, online, info } }
  selectedTrackers: {}, // { [tid]: boolean }
  queryingTrackers: {}, // { [tid]: boolean } — currently querying firmware info
  trackerTps: {},       // { [tid]: number } — packets per second
  _packetCounts: {},    // internal per-second counters
  _lastSeen: {},        // { [tid]: timestamp }
  _monitorHandler: null,
  _tpsInterval: null,
  _infoQueue: [],       // trackers needing info query

  // ── Firmware state ──────────────────────────────────────────
  firmwareFiles: [],     // [{ id, file, raw, parsed }]
  firmwareMapping: {},   // { [boardTarget]: firmwareFileId }
  _nextFwId: 1,
  _activeFirmware: null, // firmware being flashed (for progress display)

  // ── GitHub download state ──────────────────────────────────
  ghTab: 'releases',          // 'releases' | 'ci' | 'receiver-ci'
  ghExpanded: false,
  ghLoading: false,
  ghReleases: [],             // [{ tag, name, date, assets }]
  ghSelectedRelease: null,    // tag string
  ghReleaseFilter: 'tracker', // 'tracker' | 'receiver' | 'all'
  ghCIRuns: [],               // [{ id, number, title, date, sha }]
  ghSelectedRun: null,        // run id
  ghRunArtifacts: [],         // [{ name, size, downloadUrl }]
  ghReceiverCIRuns: [],       // [{ id, number, title, date, sha }]
  ghSelectedReceiverRun: null, // run id
  ghReceiverRunArtifacts: [], // [{ name, size, downloadUrl }]
  ghDownloading: {},          // { [key]: { progress, error } }
  ghArtifactsLoading: false,
  ghFilterByTarget: true,     // filter firmware list by detected tracker board targets
  ghProxyAvailable: false,    // whether CORS proxy is available (CF Pages deployment)

  // ── Update state ────────────────────────────────────────────
  updating: false,
  updatePhase: '',       // begin, stream, verify, activate, complete
  updateStep: 0,         // 1–4 (or 5 for complete)
  progress: { consumed: 0, total: 1, speed: 0, inFlight: 0 },
  trackerStatuses: {},   // { [tid]: statusString }
  batchInfo: { current: 0, total: 0, trackerIds: [] },
  updateSuccess: null,   // true/false/null
  _updateDismissTimer: null,

  // ── Receiver OTA state ──────────────────────────────────────
  receiverInfo: null,           // parsed firmware info from receiver
  receiverInfoQueried: false,   // whether receiver info has been queried
  queryingReceiver: false,      // currently querying receiver info
  receiverUpdating: false,      // receiver OTA in progress
  enteringDfu: false,           // sending DFU command via serial

  // ── Session ─────────────────────────────────────────────────
  _session: null,

  // ── Log ─────────────────────────────────────────────────────
  logs: [],
  logExpanded: false,

  // ── Theme ───────────────────────────────────────────────────
  theme: localStorage.getItem('slimevr-ota-theme') || 'dark',

  // ── Lifecycle ───────────────────────────────────────────────
  init() {
    document.documentElement.setAttribute('data-theme', this.theme);

    // Listen for device connect/disconnect (hot-plug)
    if (this.webHIDSupported) {
      this._loadReceiverCache();

      navigator.hid.addEventListener('disconnect', (e) => {
        if (this.selectedDevice && e.device === this.selectedDevice) {
          this.log('⚠ Device disconnected');
          this._lastDeviceSerial = this.selectedDevice.serialNumber ?? null;
          this._lastDeviceName = this.selectedDevice.productName ?? null;
          this._stopMonitoring();
          this.connected = false;
          this.selectedDevice = null;
          this._session?.destroy();
          this._session = null;
        }
        this._refreshPairedDevices();
      });

      navigator.hid.addEventListener('connect', () => {
        this._refreshPairedDevices();
        // Auto-reconnect if we were previously connected and lost connection
        if (!this.connected && !this.connecting) {
          this._autoConnect();
        }
      });

      // Auto-connect on page load
      this._autoConnect();
    }

    // Fetch online board mappings in background
    refreshOnlineMaps().then(({ sources, errors, addedBoards, addedPatterns }) => {
      if (sources.length > 0) {
        const detail = (addedBoards || addedPatterns)
          ? ` (+${addedBoards} boards, +${addedPatterns} patterns)`
          : ' (no new entries)';
        this.log(`Board map synced from: ${sources.join(', ')}${detail}`);
      }
      if (errors.length > 0) {
        this.log(`Board map fetch errors: ${errors.join('; ')}`);
      }
    }).catch((e) => {
      console.warn('[BoardMap] refreshOnlineMaps failed:', e);
    });

    // Check for CORS proxy availability
    isProxyAvailable().then((available) => {
      this.ghProxyAvailable = available;
      if (available) {
        this.log('CORS proxy available — direct firmware downloads enabled');
      }
    });
  },

  // ── Computed ────────────────────────────────────────────────

  get allTrackerIds() {
    return Object.keys(this.trackers).map(Number).sort((a, b) => a - b);
  },

  get onlineTrackerIds() {
    return Object.keys(this.trackers)
      .filter((tid) => this.trackers[tid].online)
      .map(Number)
      .sort((a, b) => a - b);
  },

  get offlineTrackerIds() {
    return Object.keys(this.trackers)
      .filter((tid) => !this.trackers[tid].online)
      .map(Number)
      .sort((a, b) => a - b);
  },

  get selectedCount() {
    return Object.values(this.selectedTrackers).filter(Boolean).length;
  },

  get selectedIds() {
    return Object.keys(this.selectedTrackers)
      .filter((tid) => this.selectedTrackers[tid])
      .map(Number)
      .sort((a, b) => a - b);
  },

  get canUpdate() {
    if (!this.connected || this.firmwareFiles.length === 0 || this.updating) return false;

    const hasTrackerTargets = this.selectedCount > 0;
    const hasReceiverTarget = this._hasReceiverUpdate();

    // Need at least one target (tracker or receiver)
    if (!hasTrackerTargets && !hasReceiverTarget) return false;

    // Check all selected trackers with known board targets have mapped firmware
    if (hasTrackerTargets) {
      for (const tid of this.selectedIds) {
        const bt = this.trackers[tid]?.info?.boardTarget;
        if (bt && !this.firmwareMapping[bt]) return false;
      }
    }
    return true;
  },

  get uniqueBoardTargets() {
    const targets = new Set();
    for (const tid of this.onlineTrackerIds) {
      const bt = this.trackers[tid]?.info?.boardTarget;
      if (bt) targets.add(bt);
    }
    return [...targets].sort();
  },

  /** Receiver board target (if known and supports self-OTA). */
  get receiverBoardTarget() {
    if (!this.receiverInfo || this.receiverInfo.protocolVersion === 0) return null;
    return this.receiverInfo.boardTarget || null;
  },

  /** All board targets that need firmware mapping (tracker + receiver). */
  get allBoardTargets() {
    const targets = [...this.uniqueBoardTargets];
    if (this.receiverBoardTarget && !targets.includes(this.receiverBoardTarget)) {
      targets.push(this.receiverBoardTarget);
    }
    return targets;
  },

  /** Whether to show the mapping section (any board targets with firmware loaded). */
  get showMapping() {
    return this.allBoardTargets.length > 0 && this.firmwareFiles.length > 0;
  },

  /** Check if all known board targets (tracker + receiver) are mapped. */
  get allMapped() {
    for (const bt of this.allBoardTargets) {
      if (!this.firmwareMapping[bt]) return false;
    }
    return true;
  },

  get progressPercent() {
    if (this.progress.total === 0) return 0;
    return Math.round((this.progress.consumed / this.progress.total) * 100);
  },

  get progressKB() {
    const fw = this._activeFirmware || this.firmwareFiles[0]?.parsed;
    const consumed = Math.min(
      this.progress.consumed * OTA_DATA_MAX_PAYLOAD,
      fw?.data?.length ?? 0,
    );
    return (consumed / 1024).toFixed(0);
  },

  get totalKB() {
    const fw = this._activeFirmware || this.firmwareFiles[0]?.parsed;
    return ((fw?.data?.length ?? 0) / 1024).toFixed(1);
  },

  // ── Theme ───────────────────────────────────────────────────

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('slimevr-ota-theme', this.theme);
  },

  // ── Logging ─────────────────────────────────────────────────

  log(msg) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.logs.push({ time, msg });
    // Auto-scroll log
    this.$nextTick(() => {
      const el = document.getElementById('log-container');
      if (el) el.scrollTop = el.scrollHeight;
    });
  },

  // ── Connection ──────────────────────────────────────────────

  /** Load receiver metadata cache from localStorage. */
  _loadReceiverCache() {
    try {
      this._receiverCache = JSON.parse(localStorage.getItem('slimevr-ota-receivers') || '{}');
    } catch { this._receiverCache = {}; }
  },

  /** Save receiver metadata cache to localStorage. */
  _saveReceiverCache() {
    try {
      localStorage.setItem('slimevr-ota-receivers', JSON.stringify(this._receiverCache));
    } catch { /* quota exceeded */ }
  },

  /** Update cached info for current receiver after scan. */
  _cacheReceiverInfo() {
    if (!this.selectedDevice?.serialNumber) return;
    const key = this._deviceKey(this.selectedDevice);
    const trackerCount = Object.keys(this.trackers).length;
    const onlineCount = Object.values(this.trackers).filter((t) => t.online).length;
    this._receiverCache[key] = { trackerCount, onlineCount, lastSeen: Date.now() };
    this._saveReceiverCache();
  },

  /** Get cached info for a device. */
  getReceiverCache(device) {
    if (!device) return null;
    const key = this._deviceKey(device);
    return this._receiverCache[key] || null;
  },

  /** Refresh the list of previously paired devices (no dialog). */
  async _refreshPairedDevices() {
    if (!this.webHIDSupported) return;
    try {
      const all = await navigator.hid.getDevices();
      const matching = all.filter(
        (d) => d.vendorId === VID && d.productId === PID
      );
      // Deduplicate only when serial is available (same physical device may expose multiple HID collections)
      // When serial is undefined, keep all entries (can't tell if same device)
      const seen = new Map();
      const result = [];
      for (const d of matching) {
        if (d.serialNumber) {
          if (!seen.has(d.serialNumber)) {
            seen.set(d.serialNumber, true);
            result.push(d);
          }
        } else {
          result.push(d);
        }
      }
      this.pairedDevices = result;
    } catch {
      this.pairedDevices = [];
    }
  },

  /** Get a stable key for a device (for cache lookups). */
  _deviceKey(device) {
    if (device?.serialNumber) return device.serialNumber;
    if (!device) return 'unknown';
    // No serial: use index in pairedDevices as part of key
    const idx = this.pairedDevices.indexOf(device);
    return `noSerial-${idx >= 0 ? idx : 'x'}`;
  },

  /** Get a display label for a device. */
  deviceLabel(device) {
    if (!device) return 'Disconnected';
    const name = device.productName || 'SlimeNRF Receiver';
    if (device.serialNumber) return `${name}  (${device.serialNumber})`;
    // Fallback: use index in paired list
    const idx = this.pairedDevices.indexOf(device);
    return idx >= 0 && this.pairedDevices.length > 1 ? `${name}  #${idx + 1}` : name;
  },

  /** Auto-connect to a previously paired device on page load / replug. */
  async _autoConnect() {
    await this._refreshPairedDevices();
    if (this.connected || this.connecting) return;
    if (this.pairedDevices.length === 0) return;

    // Prefer reconnecting to the device that was previously connected
    let target = this.pairedDevices[0];
    if (this._lastDeviceSerial) {
      const prev = this.pairedDevices.find(d => d.serialNumber === this._lastDeviceSerial);
      if (prev) target = prev;
    } else if (this._lastDeviceName) {
      // No serial available — pick the LAST device with the same product name
      // (after reboot, the reconnected device typically appears last in the list)
      const candidates = this.pairedDevices.filter(d => d.productName === this._lastDeviceName);
      if (candidates.length > 0) target = candidates[candidates.length - 1];
    }
    this._lastDeviceSerial = null;
    this._lastDeviceName = null;

    this.connecting = true;
    try {
      await this._openDevice(target);
    } catch (e) {
      console.warn('[AutoConnect]', e.message);
    } finally {
      this.connecting = false;
    }
  },

  /** Connect to a specific paired device (from custom picker). */
  async connectDevice(device) {
    if (this.connecting) return;
    if (this.connected) await this.disconnect();
    this.connecting = true;
    try {
      await this._openDevice(device);
    } catch (e) {
      this.log(`✗ Connection failed: ${e.message}`);
    } finally {
      this.connecting = false;
    }
  },

  /** Add a new device via browser permission dialog. */
  async addDevice() {
    if (!this.webHIDSupported) return;
    this.connecting = true;
    try {
      const [device] = await navigator.hid.requestDevice({
        filters: [{ vendorId: VID, productId: PID }],
      });
      if (!device) { this.connecting = false; return; }
      await this._refreshPairedDevices();
      await this._openDevice(device);
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        this.log(`✗ Connection failed: ${e.message}`);
      }
    } finally {
      this.connecting = false;
    }
  },

  /** Shorthand for the old connect() — now routes to addDevice(). */
  async connect() {
    return this.addDevice();
  },

  async _openDevice(device) {
    if (!device.opened) await device.open();
    this.selectedDevice = device;
    this.connected = true;
    this._session?.destroy();
    this._session = new OTASession(device, {
      onLog:           (msg) => this.log(msg),
      onProgress:      (p) => { this.progress = p; },
      onPhase:         (phase, step) => { this.updatePhase = phase; this.updateStep = step; },
      onTrackerStatus: (tid, s) => { this.trackerStatuses[tid] = s; },
      onBatchInfo:     (b) => { this.batchInfo = b; },
    });
    this.log(`✓ Connected: ${this.deviceLabel(device)}`);
    await this.scan();
    this._startMonitoring();
    // Auto-query receiver info (non-blocking)
    this.queryReceiverInfo();
  },

  async disconnect() {
    if (this.updating) return;
    this._stopMonitoring();
    this._session?.destroy();
    this._session = null;
    if (this.selectedDevice?.opened) {
      try { await this.selectedDevice.close(); } catch {}
    }
    this.selectedDevice = null;
    this.connected = false;
    this.trackers = {};
    this.selectedTrackers = {};
    this.trackerTps = {};
    this.log('Disconnected.');
  },

  // ── Real-time Monitoring ─────────────────────────────────────

  _startMonitoring() {
    if (this._monitorHandler || !this.selectedDevice) return;

    // TPS calculation: count packets per tracker each second
    this._packetCounts = {};
    this._lastSeen = {};

    this._monitorHandler = (event) => {
      const dv = event.data;
      const buf = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      const now = Date.now();

      for (let off = 0; off < Math.min(buf.length, 64); off += 16) {
        const sub = buf.subarray(off, off + 16);
        if (sub.length < 2) continue;
        const pktType = sub[0];
        const tid = sub[1];
        if (tid >= 64) continue;

        if (pktType === 0xff) {
          // Address registration — tracker exists (possibly offline)
          if (!this.trackers[tid]) {
            const addr = Array.from(sub.slice(2, 8)).reverse()
              .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
            this.trackers[tid] = { addr, online: false, info: null };
          }
        } else if (pktType > 0 && pktType < 0xf0) {
          // Active data packet — tracker is online
          this._packetCounts[tid] = (this._packetCounts[tid] || 0) + 1;
          this._lastSeen[tid] = now;

          if (!this.trackers[tid]) {
            this.trackers[tid] = { addr: '', online: true, info: null };
          } else if (!this.trackers[tid].online) {
            this.trackers[tid] = { ...this.trackers[tid], online: true };
            this.log(`Tracker ${tid} came online`);
            // Auto-query info only if we don't have cached info
            if (!this.updating && !this.trackers[tid].info) {
              setTimeout(() => this._enqueueInfoQuery(tid), 1000);
            }
          }
        }
      }
    };

    this.selectedDevice.addEventListener('inputreport', this._monitorHandler);

    // Every second: compute TPS and detect offline trackers
    this._tpsInterval = setInterval(() => {
      const now = Date.now();
      const OFFLINE_TIMEOUT = 3000; // 3 seconds without packets → offline
      const newTps = { ...this.trackerTps };

      for (const tidStr of Object.keys(this.trackers)) {
        const tid = Number(tidStr);
        // Update TPS
        newTps[tid] = this._packetCounts[tid] || 0;
        this._packetCounts[tid] = 0;

        // Check offline timeout
        if (this.trackers[tid]?.online && this._lastSeen[tid] &&
            now - this._lastSeen[tid] > OFFLINE_TIMEOUT) {
          this.trackers[tid] = { ...this.trackers[tid], online: false };
          newTps[tid] = 0;
          this.log(`Tracker ${tid} went offline`);
        }
      }
      this.trackerTps = newTps;
    }, 1000);

    // Periodic info query for online trackers that haven't been queried yet
    this._infoInterval = setInterval(() => {
      if (this.updating) return;
      for (const tidStr of Object.keys(this.trackers)) {
        const tid = Number(tidStr);
        if (this.trackers[tid]?.online && !this.trackers[tid]?.info && !this.trackers[tid]?.infoQueried) {
          this._enqueueInfoQuery(tid);
        }
      }
    }, 5000);
  },

  _stopMonitoring() {
    if (this._tpsInterval) { clearInterval(this._tpsInterval); this._tpsInterval = null; }
    if (this._infoInterval) { clearInterval(this._infoInterval); this._infoInterval = null; }
    if (this._infoQueryTimer) { clearTimeout(this._infoQueryTimer); this._infoQueryTimer = null; }
    if (this._monitorHandler && this.selectedDevice) {
      this.selectedDevice.removeEventListener('inputreport', this._monitorHandler);
    }
    this._monitorHandler = null;
    this._infoQueue = [];
  },

  _enqueueInfoQuery(tid) {
    if (this._infoQueue.includes(tid)) return;
    this._infoQueue.push(tid);
    this._drainInfoQueue();
  },

  async _drainInfoQueue() {
    if (this._infoDraining || this.updating) return;
    this._infoDraining = true;
    while (this._infoQueue.length > 0 && !this.updating) {
      const tid = this._infoQueue.shift();
      if (!this.trackers[tid]?.online) continue;
      this.queryingTrackers = { ...this.queryingTrackers, [tid]: true };
      try {
        let info = await this._session.queryInfo(tid);
        // Retry once on failure
        if (!info) {
          await new Promise((r) => setTimeout(r, 500));
          info = await this._session.queryInfo(tid);
        }
        this.trackers[tid] = { ...this.trackers[tid], info: info || null, infoQueried: true };
        // Auto-select trackers with valid OTA info
        if (info && !this.updating) this.selectedTrackers[tid] = true;
      } catch { /* ignore query failures during monitoring */ }
      this.queryingTrackers = { ...this.queryingTrackers, [tid]: false };
    }
    this._infoDraining = false;
  },

  /** TPS-based glow class for tracker cards (shadow-only, compatible with selection ring) */
  tpsGlowClass(tid) {
    const tps = this.trackerTps[tid] || 0;
    if (tps >= 120) return 'shadow-[0_0_14px_rgba(0,200,80,0.45),0_0_4px_rgba(0,200,80,0.2)]';
    if (tps >= 75)  return 'shadow-[0_0_10px_rgba(0,150,255,0.35),0_0_3px_rgba(0,150,255,0.15)]';
    if (tps >= 25)  return 'shadow-[0_0_6px_rgba(0,150,255,0.2)]';
    return '';
  },

  // ── Scan Trackers ───────────────────────────────────────────

  async scan() {
    if (!this._session || this.scanning || this.updating) return;
    this.scanning = true;
    this.selectedTrackers = {};
    this.log('Scanning for trackers…');

    try {
      const found = await this._session.discoverTrackers(1500);
      const tids = Object.keys(found).map(Number).sort((a, b) => a - b);

      // Force-refresh: clear all cached info on rescan
      const merged = {};
      for (const tid of tids) {
        merged[tid] = {
          ...found[tid],
          info: null,
          infoQueried: false,
        };
      }
      this.trackers = merged;

      const onlineIds = tids.filter((t) => found[t].online);
      this.log(`Found ${onlineIds.length} online, ${tids.length - onlineIds.length} offline tracker(s).`);

      // Query firmware info for all online trackers
      for (const tid of onlineIds) {
        this.queryingTrackers = { ...this.queryingTrackers, [tid]: true };
        try {
          let info = await this._session.queryInfo(tid, { timeoutMs: 3000 });
          // Retry once if first attempt fails
          if (!info) {
            await new Promise((r) => setTimeout(r, 500));
            info = await this._session.queryInfo(tid, { timeoutMs: 3000 });
          }
          this.trackers[tid] = {
            ...this.trackers[tid],
            info: info || null,
            infoQueried: true,
          };
          // Auto-select trackers with valid OTA info
          if (info) this.selectedTrackers[tid] = true;
        } catch {
          this.trackers[tid] = { ...this.trackers[tid], info: null, infoQueried: true };
        } finally {
          this.queryingTrackers = { ...this.queryingTrackers, [tid]: false };
        }
      }
    } catch (e) {
      this.log(`✗ Scan failed: ${e.message}`);
    } finally {
      this.scanning = false;
      this._autoMapFirmware();
      this._cacheReceiverInfo();
    }
  },

  // ── Tracker Selection ───────────────────────────────────────

  toggleTracker(tid) {
    this.selectedTrackers[tid] = !this.selectedTrackers[tid];
  },

  /** Refresh firmware info for a single tracker. */
  async refreshTracker(tid) {
    if (!this._session || this.updating) return;
    this.log(`Refreshing tracker ${tid}…`);
    this.queryingTrackers = { ...this.queryingTrackers, [tid]: true };
    try {
      const info = await this._session.queryInfo(tid);
      if (info) {
        this.trackers[tid] = { ...this.trackers[tid], info, infoQueried: true };
        this.log(`Tracker ${tid}: v${info.version}, ${info.boardTarget}`);
      } else {
        this.trackers[tid] = { ...this.trackers[tid], info: null, infoQueried: true };
        this.log(`Tracker ${tid}: no OTA response (may not support OTA)`);
      }
    } catch (e) {
      this.log(`✗ Refresh tracker ${tid} failed: ${e.message}`);
    } finally {
      this.queryingTrackers = { ...this.queryingTrackers, [tid]: false };
    }
  },

  /** Whether a tracker can be selected for OTA (online and not known to lack OTA). */
  canSelectTracker(tid) {
    const t = this.trackers[tid];
    if (!t?.online) return false;
    // If queried and no info → no OTA support → can't select
    if (t.infoQueried && !t.info) return false;
    return true;
  },

  selectAllOnline() {
    for (const tid of this.onlineTrackerIds) {
      if (this.canSelectTracker(tid)) {
        this.selectedTrackers[tid] = true;
      }
    }
  },

  deselectAll() {
    this.selectedTrackers = {};
  },

  // ── Firmware Selection ──────────────────────────────────────

  async selectFirmware(event) {
    const files = event.target?.files;
    if (!files?.length) return;
    for (const file of files) {
      if (file.name.endsWith('.zip')) {
        await this._addFirmwareFromZip(file);
      } else {
        await this._addFirmware(file);
      }
    }
    event.target.value = ''; // allow re-selecting same file
  },

  async handleDrop(event) {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    for (const file of files) {
      if (file.name.endsWith('.uf2') || file.name.endsWith('.hex')) {
        await this._addFirmware(file);
      } else if (file.name.endsWith('.zip')) {
        await this._addFirmwareFromZip(file);
      } else {
        this.log(`✗ Skipped ${file.name}: not a .uf2, .hex, or .zip file`);
      }
    }
  },

  async _addFirmware(file) {
    try {
      const raw = await file.arrayBuffer();
      let parsed = this._parseFirmware(raw, file.name);
      const id = this._nextFwId++;
      const detectedBoard = matchBoardTarget(file.name) || matchReceiverBoardTarget(file.name);

      // If matched to receiver and receiver flashBase is known, check compatibility
      const isReceiverFw = detectedBoard && matchReceiverBoardTarget(file.name);
      let sdPlusApp = false;
      if (isReceiverFw && this.receiverInfo && parsed.baseAddress !== this.receiverInfo.flashBase) {
        if (parsed.baseAddress > this.receiverInfo.flashBase) {
          this.log(`⚠ ${file.name}: base 0x${parsed.baseAddress.toString(16)} > receiver 0x${this.receiverInfo.flashBase.toString(16)} — requires SoftDevice not present`);
        } else if (looksLikeSdPlusApp(parsed.data, parsed.baseAddress, this.receiverInfo.flashBase)) {
          // SD+App: re-parse to extract app only
          sdPlusApp = true;
          parsed = this._parseFirmware(raw, file.name, this.receiverInfo.flashBase);
        }
        // Otherwise: pure app at lower base, keep as-is (cross-base update)
      } else if (!isReceiverFw && parsed.baseAddress < 0x27000) {
        // Check tracker firmware for SD+App pattern (heuristic at common 0x27000 base)
        sdPlusApp = looksLikeSdPlusApp(parsed.data, parsed.baseAddress, 0x27000);
      }

      this.firmwareFiles = [...this.firmwareFiles, { id, file, raw, parsed, detectedBoard, sdPlusApp }];
      this.log(
        `✓ Firmware loaded: ${file.name} — ` +
        `${(parsed.data.length / 1024).toFixed(1)} KB, ` +
        `CRC: 0x${parsed.crc32.toString(16).toUpperCase().padStart(8, '0')}` +
        (sdPlusApp ? ' [SD+App]' : '') +
        (detectedBoard ? ` → ${detectedBoard}` : ''),
      );
      this._autoMapFirmware();
      this._syncFirmwareStore();
    } catch (e) {
      this.log(`✗ Firmware parse error (${file.name}): ${e.message}`);
    }
  },

  /** Extract .uf2 files from a dropped .zip archive. */
  async _addFirmwareFromZip(file) {
    try {
      const raw = await file.arrayBuffer();
      const uf2Files = extractUF2FromZip(raw);
      for (const uf2 of uf2Files) {
        await this._addFirmwareFromBuffer(uf2.data, uf2.name);
      }
      this.log(`✓ Extracted ${uf2Files.length} firmware(s) from ${file.name}`);
    } catch (e) {
      this.log(`✗ Zip extraction error (${file.name}): ${e.message}`);
    }
  },

  /**
   * Auto-detect firmware format and parse.
   * @param {ArrayBuffer} buffer  Raw file contents
   * @param {string} name  Filename for format detection
   * @param {number} flashOffset  Flash offset (default 0x1000)
   */
  _parseFirmware(buffer, name, flashOffset = 0x1000) {
    if (name.endsWith('.hex') || name.endsWith('.ihex')) {
      const text = new TextDecoder().decode(buffer);
      return parseHex(text, flashOffset);
    }
    // Default: try UF2
    return parseUF2(buffer, flashOffset);
  },

  removeFirmware(id) {
    const removed = this.firmwareFiles.find((f) => f.id === id);
    this.firmwareFiles = this.firmwareFiles.filter((f) => f.id !== id);
    // Clean up mappings pointing to removed firmware
    const newMapping = {};
    for (const [bt, fwId] of Object.entries(this.firmwareMapping)) {
      if (fwId !== id) newMapping[bt] = fwId;
    }
    this.firmwareMapping = newMapping;
    this._autoMapFirmware();
    this._syncFirmwareStore();
    // Clear GitHub download state so user can re-download
    if (removed?.file?.name) {
      const stem = removed.file.name.replace(/\.[^.]+$/, '');
      const newDl = { ...this.ghDownloading };
      for (const key of Object.keys(newDl)) {
        // Match by exact name suffix or stem (handles both release assets and CI artifacts)
        if (key.endsWith(`:${removed.file.name}`) || key.endsWith(`:${stem}`)) {
          delete newDl[key];
        }
      }
      this.ghDownloading = newDl;
    }
  },

  /** Save a loaded firmware file to local disk. */
  saveFirmware(fw) {
    const blob = new Blob([fw.raw], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fw.file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  setFirmwareMapping(boardTarget, fwId) {
    this.firmwareMapping = { ...this.firmwareMapping, [boardTarget]: fwId || undefined };
    // Remove undefined entries
    if (!fwId) {
      const { [boardTarget]: _, ...rest } = this.firmwareMapping;
      this.firmwareMapping = rest;
    }
  },

  /**
   * Auto-map firmware to board targets.
   * - Single firmware: map to all targets.
   * - Multiple firmwares: map by detected board target from filename.
   */
  _autoMapFirmware() {
    const newMapping = {};
    const allTargets = this.allBoardTargets;
    const rcvTarget = this.receiverBoardTarget;
    const trackerTargets = allTargets.filter(bt => bt !== rcvTarget);

    if (this.firmwareFiles.length === 1) {
      const fw = this.firmwareFiles[0];
      const isReceiverFw = fw.detectedBoard && matchReceiverBoardTarget(fw.file?.name ?? '');
      const isTrackerFw = fw.detectedBoard && matchBoardTarget(fw.file?.name ?? '');

      if (isReceiverFw) {
        // Receiver firmware → map only to receiver target
        if (rcvTarget) newMapping[rcvTarget] = fw.id;
      } else if (isTrackerFw) {
        // Tracker firmware → map only to tracker targets
        for (const bt of trackerTargets) newMapping[bt] = fw.id;
      } else {
        // Unknown firmware → map to all tracker targets (not receiver)
        for (const bt of trackerTargets) newMapping[bt] = fw.id;
      }
    } else if (this.firmwareFiles.length > 1) {
      // Multiple firmwares → use detected board targets
      for (const bt of allTargets) {
        const match = this.firmwareFiles.find((fw) => fw.detectedBoard === bt);
        if (match) {
          newMapping[bt] = match.id;
        } else {
          // Keep existing mapping if any
          if (this.firmwareMapping[bt]) newMapping[bt] = this.firmwareMapping[bt];
        }
      }
    }

    this.firmwareMapping = newMapping;
  },

  /** Sync loaded firmware list to the shared Alpine store for Serial DFU bridge. */
  _syncFirmwareStore() {
    Alpine.store('firmware').files = this.firmwareFiles.map(fw => ({
      id: fw.id,
      name: fw.file?.name ?? `firmware-${fw.id}`,
      size: fw.raw.byteLength,
      data: fw.raw,
      format: fw.file?.name?.split('.').pop()?.toLowerCase() || 'uf2',
      boardTarget: fw.detectedBoard || null,
    }));
  },

  /** Get firmware entry by id. */
  _getFirmware(id) {
    return this.firmwareFiles.find((f) => f.id === id);
  },

  /** Re-parse already-loaded receiver firmware files with the correct flash base. */
  _reparseReceiverFirmware() {
    if (!this.receiverInfo) return;
    const base = this.receiverInfo.flashBase;
    for (const fw of this.firmwareFiles) {
      const isRcv = fw.detectedBoard && matchReceiverBoardTarget(fw.file.name);
      if (isRcv && fw.parsed.baseAddress !== base) {
        if (fw.parsed.baseAddress > base) {
          // fw.baseAddress > device base — firmware needs SoftDevice not present
          fw.sdPlusApp = false;
          this.log(`⚠ ${fw.file.name}: base 0x${fw.parsed.baseAddress.toString(16)} > receiver 0x${base.toString(16)} — requires SoftDevice not present`);
        } else if (looksLikeSdPlusApp(fw.parsed.data, fw.parsed.baseAddress, base)) {
          // SD+App: re-parse to extract app only
          fw.sdPlusApp = true;
          try {
            fw.parsed = this._parseFirmware(fw.raw, fw.file.name, base);
            this.log(`Re-parsed ${fw.file.name}: extracted app at 0x${base.toString(16).padStart(5, '0')} [SD+App]`);
          } catch (e) {
            this.log(`⚠ Cannot extract app from ${fw.file.name}: ${e.message}`);
          }
        } else {
          // Pure app at lower base: cross-base update, keep as-is
          fw.sdPlusApp = false;
          this.log(`${fw.file.name}: cross-base update (fw:0x${fw.parsed.baseAddress.toString(16)} → rcv:0x${base.toString(16)})`);
        }
      } else if (isRcv) {
        // Same base — re-evaluate sdPlusApp flag (may have been set speculatively before connection)
        fw.sdPlusApp = false;
      }
    }
    // Trigger reactivity
    this.firmwareFiles = [...this.firmwareFiles];
  },

  // ── Update Flow ─────────────────────────────────────────────

  async startUpdate() {
    if (!this.canUpdate) return;

    const ids = this.selectedIds;
    this.updating = true;
    this.updateSuccess = null;
    clearTimeout(this._updateDismissTimer);
    this.updatePhase = '';
    this.updateStep = 0;
    this.trackerStatuses = {};
    this.progress = { consumed: 0, total: 1, speed: 0, inFlight: 0 };

    try {
      // Query info for selected trackers and group by board_target
      const boardGroups = {};

      for (const tid of ids) {
        const cached = this.trackers[tid]?.info;
        const info = cached || await this._session.queryInfo(tid);
        if (!info || !info.boardTarget) {
          this.log(`⚠ Tracker ${tid}: could not get info, skipping`);
          continue;
        }

        // Block OTA for nRF5 OpenDFU bootloader trackers (ACL flash protection)
        if (info.bootloader === 'nrf5_opendfu') {
          this.log(`⚠ Tracker ${tid}: nRF5 OpenDFU bootloader — OTA not supported (ACL flash protection). Use SWD/DFU.`);
          continue;
        }

        if (!boardGroups[info.boardTarget]) {
          boardGroups[info.boardTarget] = { tids: [], info };
        }
        boardGroups[info.boardTarget].tids.push(tid);
      }

      // Build batch plan with per-target firmware
      const plan = [];
      for (const [bt, group] of Object.entries(boardGroups)) {
        const fwId = this.firmwareMapping[bt];
        const fwEntry = fwId ? this._getFirmware(fwId) : null;
        if (!fwEntry) {
          this.log(`✗ No firmware mapped for board target: ${bt}, skipping ${group.tids.length} tracker(s)`);
          continue;
        }

        let fw = fwEntry.parsed;

        // Determine effective device base: use reported flashBase, or infer from sdPlusApp flag
        let deviceBase = group.info.flashBase;
        if (deviceBase === 0 && fwEntry.sdPlusApp) {
          // Tracker doesn't report flashBase (old firmware) but we detected SD+App at load time.
          // Use 0x27000 as the standard SoftDevice app base for extraction.
          deviceBase = 0x27000;
        }

        // Check flash base mismatch
        if (deviceBase !== 0 && fw.baseAddress !== deviceBase) {
          if (fw.baseAddress > deviceBase) {
            // Firmware expects SoftDevice that isn't present — block
            this.log(`✗ Firmware base 0x${fw.baseAddress.toString(16).padStart(5, '0')} > tracker base 0x${deviceBase.toString(16).padStart(5, '0')} — firmware requires SoftDevice not present. Skipping ${bt}.`);
            continue;
          }
          // fw.baseAddress < device base: check if SD+App or pure app
          if (looksLikeSdPlusApp(fw.data, fw.baseAddress, deviceBase)) {
            // SD+App image: re-parse to extract only the application portion
            this.log(`Detected SD+App image, extracting app at 0x${deviceBase.toString(16).padStart(5, '0')}…`);
            try {
              fw = this._parseFirmware(fwEntry.raw, fwEntry.file.name, deviceBase);
              this.log(`Extracted: ${(fw.data.length / 1024).toFixed(1)} KB at 0x${fw.baseAddress.toString(16).padStart(5, '0')}`);
            } catch (e) {
              this.log(`✗ Cannot extract app from SD+App image: ${e.message}. Skipping ${bt}.`);
              continue;
            }
          } else {
            // Pure app at lower base: cross-base update (removing SoftDevice), use as-is
            this.log(`Cross-base update: firmware at 0x${fw.baseAddress.toString(16).padStart(5, '0')}, tracker at 0x${deviceBase.toString(16).padStart(5, '0')} — proceeding`);
          }
        }

        const mp = bt.includes('nrf52840') ? 2 : 1;
        for (let i = 0; i < group.tids.length; i += mp) {
          plan.push({ boardTarget: bt, ids: group.tids.slice(i, i + mp), firmware: fw });
        }
      }

      if (plan.length === 0 && !this._hasReceiverUpdate()) {
        this.log('✗ No valid targets found.');
        this.updating = false;
        return;
      }

      if (plan.length > 0) {
        this.log(`Update plan: ${plan.length} tracker batch(es)` + (this._hasReceiverUpdate() ? ' + receiver' : ''));
      }

      // Execute tracker batches
      let allOk = true;
      for (let b = 0; b < plan.length; b++) {
        const { boardTarget, ids: batchIds, firmware: fw } = plan[b];
        this.batchInfo = { current: b + 1, total: plan.length, trackerIds: batchIds };
        this.progress = { consumed: 0, total: 1, speed: 0, inFlight: 0 };
        this._activeFirmware = fw;

        const ok = await this._session.performUpdate(batchIds, fw, boardTarget);
        if (!ok) allOk = false;

        // Brief pause between batches
        if (b + 1 < plan.length) await new Promise((r) => setTimeout(r, 2000));
      }

      // After all tracker batches, update receiver if mapped
      if (allOk && this._hasReceiverUpdate()) {
        if (plan.length > 0) {
          this.log('Tracker updates complete. Updating receiver…');
          await new Promise((r) => setTimeout(r, 2000));
        }
        const rcvOk = await this._performReceiverOTA();
        if (!rcvOk) allOk = false;
      }

      this._activeFirmware = null;
      this.updatePhase = 'complete';
      this.updateStep = 5;
      this.updateSuccess = allOk;
      this.log(allOk ? '✓ OTA update completed successfully!' : '⚠ OTA update completed with errors.');

      // Auto-dismiss success after 8 seconds
      if (allOk) {
        clearTimeout(this._updateDismissTimer);
        this._updateDismissTimer = setTimeout(() => { this.updateSuccess = null; }, 8000);
      }

      // Auto-rescan after 5 seconds
      if (allOk && plan.length > 0) {
        this.log('Auto-rescan in 5 seconds…');
        setTimeout(() => this.scan(), 5000);
      }

    } catch (e) {
      if (e.message === 'Aborted') {
        this.log('Update aborted.');
      } else {
        this.log(`✗ Update error: ${e.message}`);
      }
      this.updateSuccess = false;
      this._activeFirmware = null;
      try { await this._session._send(buildAbort(0xff)); } catch {}
    } finally {
      this.updating = false;
      this.receiverUpdating = false;
    }
  },

  async abortUpdate() {
    if (!this._session) return;
    this._session.abort();
    this.log('Aborting…');
  },

  // ── Receiver OTA ──────────────────────────────────────────────

  async queryReceiverInfo({ autoRetry = true } = {}) {
    if (!this._session) return;
    this.queryingReceiver = true;
    try {
      let info = await this._session.queryReceiverInfo({ timeoutMs: 5000 });
      // Auto-retry once if no response (receiver may not be ready yet)
      if (!info && autoRetry) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!this._session) return; // disconnected during delay
        info = await this._session.queryReceiverInfo({ timeoutMs: 5000 });
      }
      if (info) {
        this.receiverInfo = info;
        this.receiverInfoQueried = true;
        this.log(
          `Receiver: v${info.version}  ${info.buildDate}  ${info.boardTarget}  ` +
          `flash:0x${info.flashBase.toString(16).padStart(5, '0')}  ` +
          `${(info.firmwareSize / 1024).toFixed(0)}KB  ${info.bootloader}`,
        );
        this._reparseReceiverFirmware();
        this._autoMapFirmware();
        if (info.bootloader === 'nrf5_opendfu') {
          this.log('⚠ nRF5 OpenDFU bootloader detected — enter DFU mode (double-tap reset), then use Serial DFU below to flash.');
        }
      } else {
        this.receiverInfo = null;
        this.receiverInfoQueried = true;
        this.log('⚠ Receiver did not respond — tap Refresh to retry');
      }
    } catch (e) {
      this.receiverInfoQueried = true;
      this.log(`✗ Receiver info query error: ${e.message}`);
    } finally {
      this.queryingReceiver = false;
    }
  },

  /** Send 'dfu' command via serial to make receiver enter DFU bootloader mode. */
  async enterReceiverDfu() {
    if (!('serial' in navigator)) {
      this.log('✗ Web Serial API not available');
      return;
    }
    this.enteringDfu = true;
    let port = null;
    try {
      port = await navigator.serial.requestPort({
        filters: [
          { usbVendorId: 0x1209 }, // pid.codes (SlimeVR/Styria)
          { usbVendorId: 0x239A }, // Adafruit
          { usbVendorId: 0x1915 }, // Nordic
          { usbVendorId: 0x2FE3 },
          { usbVendorId: 0x2886 }, // SeeedStudio
          { usbVendorId: 0x1B4F }, // SparkFun
        ],
      });
      await port.open({ baudRate: 115200 });
      this.log('Serial connected — sending DFU command…');

      const encoder = new TextEncoder();
      const writer = port.writable.getWriter();
      await writer.write(encoder.encode('dfu\r\n'));
      writer.releaseLock();

      // Brief pause for the device to process the command before it resets
      await new Promise(r => setTimeout(r, 500));

      try { await port.close(); } catch {}
      this.log('✓ DFU command sent — device is rebooting into bootloader mode');
      this.log('Wait a moment, then use Serial DFU below to flash firmware');

      // Scroll to Serial DFU section
      setTimeout(() => {
        document.getElementById('serial-dfu-section')?.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    } catch (e) {
      if (e.name === 'NotFoundError') {
        // User cancelled the port picker
      } else {
        this.log(`✗ DFU command error: ${e.message}`);
      }
    } finally {
      try { if (port?.readable) await port.close(); } catch {}
      this.enteringDfu = false;
    }
  },

  /** Check if receiver firmware is mapped and supports self-OTA. */
  _hasReceiverUpdate() {
    if (!this.receiverInfo) return false;
    if (this.receiverInfo.protocolVersion === 0) return false; // self-OTA not supported
    if (this.receiverInfo.bootloader === 'nrf5_opendfu') return false; // ACL-protected
    const bt = this.receiverInfo.boardTarget;
    return bt && this.firmwareMapping[bt] && this._getFirmware(this.firmwareMapping[bt]);
  },

  /** Perform receiver OTA update (used by unified update flow). */
  async _performReceiverOTA() {
    const bt = this.receiverInfo.boardTarget;
    const fwId = this.firmwareMapping[bt];
    const fwEntry = this._getFirmware(fwId);
    if (!fwEntry) return false;

    let fw = fwEntry.parsed;

    // Determine effective device base: use reported flashBase, or infer from sdPlusApp flag
    let deviceBase = this.receiverInfo.flashBase;
    if (deviceBase === 0 && fwEntry.sdPlusApp) {
      deviceBase = 0x27000;
    }

    // Check flash base mismatch
    if (deviceBase !== 0 && fw.baseAddress !== deviceBase) {
      if (fw.baseAddress > deviceBase) {
        // Firmware expects SoftDevice that isn't present — block
        this.log(`✗ Firmware base 0x${fw.baseAddress.toString(16).padStart(5, '0')} > receiver base 0x${deviceBase.toString(16).padStart(5, '0')} — firmware requires SoftDevice not present.`);
        return false;
      }
      // fw.baseAddress < device base: check if SD+App or pure app
      if (looksLikeSdPlusApp(fw.data, fw.baseAddress, deviceBase)) {
        this.log(`Detected SD+App image, extracting app at 0x${deviceBase.toString(16).padStart(5, '0')}…`);
        try {
          fw = this._parseFirmware(fwEntry.raw, fwEntry.file.name, deviceBase);
          this.log(`Extracted: ${(fw.data.length / 1024).toFixed(1)} KB at 0x${fw.baseAddress.toString(16).padStart(5, '0')}`);
        } catch (e) {
          this.log(`✗ Cannot extract app from SD+App image: ${e.message}`);
          return false;
        }
      } else {
        // Pure app at lower base: cross-base update (removing SoftDevice), use as-is
        this.log(`Cross-base update: firmware at 0x${fw.baseAddress.toString(16).padStart(5, '0')}, receiver at 0x${deviceBase.toString(16).padStart(5, '0')} — proceeding`);
      }
    }

    this.receiverUpdating = true;
    this.progress = { consumed: 0, total: 1, speed: 0, inFlight: 0 };
    this.log(`Updating receiver (${bt}, ${(fw.data.length / 1024).toFixed(1)} KB)…`);

    try {
      const ok = await this._session.performReceiverUpdate(fw, bt);
      if (ok) {
        this.log('✓ Receiver OTA update completed');
      } else {
        this.log('✗ Receiver OTA update failed');
      }
      return ok;
    } catch (e) {
      this.log(`✗ Receiver OTA error: ${e.message}`);
      return false;
    } finally {
      this.receiverUpdating = false;
    }
  },

  /** Standalone receiver update (from button). */
  async startReceiverUpdate() {
    if (!this._session || !this.receiverInfo) return;
    if (this.receiverInfo.protocolVersion === 0) {
      this.log('✗ Receiver does not support self-OTA. Flash via UF2/DFU instead.');
      return;
    }
    if (this.receiverInfo.bootloader === 'nrf5_opendfu') {
      this.log('✗ Receiver has nRF5 OpenDFU bootloader — self-OTA is blocked due to ACL flash write-protection. Use SWD or DFU to update.');
      return;
    }

    const bt = this.receiverInfo.boardTarget;
    if (!this._hasReceiverUpdate()) {
      this.log(`✗ No firmware mapped for receiver board target: ${bt}`);
      return;
    }

    const fwEntry = this._getFirmware(this.firmwareMapping[bt]);
    const fw = fwEntry.parsed;
    if (!confirm(`Update receiver firmware?\n\nBoard: ${bt}\nSize: ${(fw.data.length / 1024).toFixed(1)} KB\nCRC: 0x${fw.crc32.toString(16).toUpperCase().padStart(8, '0')}\n\nThe receiver will reboot after update.`)) {
      return;
    }

    this.updating = true;
    this.updatePhase = 'begin';
    this.updateStep = 1;
    this.trackerStatuses = {};
    this.updateSuccess = null;

    try {
      const ok = await this._performReceiverOTA();
      this.updateSuccess = ok;
      this.updatePhase = 'complete';
      this.updateStep = 5;
      if (ok) {
        clearTimeout(this._updateDismissTimer);
        this._updateDismissTimer = setTimeout(() => { this.updateSuccess = null; }, 8000);
      }
    } catch (e) {
      this.log(`✗ Receiver OTA error: ${e.message}`);
      this.updateSuccess = false;
    } finally {
      this.updating = false;
    }
  },

  // ── GitHub Downloads ──────────────────────────────────────────

  formatDate,
  formatSize,

  async ghLoadReleases() {
    if (this.ghReleases.length > 0) return; // already loaded
    this.ghLoading = true;
    try {
      this.ghReleases = await fetchReleases();
      if (this.ghReleases.length > 0) {
        this.ghSelectedRelease = this.ghReleases[0].tag;
      }
      this.log(`Loaded ${this.ghReleases.length} release(s) from GitHub`);
    } catch (e) {
      this.log(`✗ Failed to load releases: ${e.message}`);
    } finally {
      this.ghLoading = false;
    }
  },

  async ghLoadCIRuns() {
    if (this.ghCIRuns.length > 0) return; // already loaded
    this.ghLoading = true;
    try {
      this.ghCIRuns = await fetchCIRuns();
      this.log(`Loaded ${this.ghCIRuns.length} tracker CI run(s) from GitHub`);
    } catch (e) {
      this.log(`✗ Failed to load tracker CI runs: ${e.message}`);
    } finally {
      this.ghLoading = false;
    }
  },

  async ghLoadReceiverCIRuns() {
    if (this.ghReceiverCIRuns.length > 0) return; // already loaded
    this.ghLoading = true;
    try {
      this.ghReceiverCIRuns = await fetchReceiverCIRuns();
      this.log(`Loaded ${this.ghReceiverCIRuns.length} receiver CI run(s) from GitHub`);
    } catch (e) {
      this.log(`✗ Failed to load receiver CI runs: ${e.message}`);
    } finally {
      this.ghLoading = false;
    }
  },

  async ghSelectRun(runId) {
    this.ghSelectedRun = runId;
    this.ghRunArtifacts = [];
    this.ghArtifactsLoading = true;
    try {
      this.ghRunArtifacts = await fetchRunArtifacts(runId);
    } catch (e) {
      this.log(`✗ Failed to load artifacts: ${e.message}`);
    } finally {
      this.ghArtifactsLoading = false;
    }
  },

  async ghSelectReceiverRun(runId) {
    this.ghSelectedReceiverRun = runId;
    this.ghReceiverRunArtifacts = [];
    this.ghArtifactsLoading = true;
    try {
      this.ghReceiverRunArtifacts = await fetchReceiverRunArtifacts(runId);
    } catch (e) {
      this.log(`✗ Failed to load receiver artifacts: ${e.message}`);
    } finally {
      this.ghArtifactsLoading = false;
    }
  },

  get ghCurrentRelease() {
    return this.ghReleases.find((r) => r.tag === this.ghSelectedRelease);
  },

  get ghCurrentRun() {
    return this.ghCIRuns.find((r) => r.id === this.ghSelectedRun);
  },

  /** Unique board targets detected from connected trackers. */
  get ghDetectedTargets() {
    return this.uniqueBoardTargets; // reuse existing computed
  },

  /** Annotate and filter/sort release assets by detected tracker board targets. */
  get ghFilteredReleaseAssets() {
    const release = this.ghCurrentRelease;
    if (!release) return [];
    // Filter by type (tracker/receiver/all)
    let assets = release.assets;
    if (this.ghReleaseFilter !== 'all') {
      assets = assets.filter((a) => a.type === this.ghReleaseFilter);
    }
    const isReceiver = this.ghReleaseFilter === 'receiver';
    const isAll = this.ghReleaseFilter === 'all';
    return this._ghFilterAssets(assets, isReceiver, isAll);
  },

  /** Annotate and filter/sort CI artifacts by detected tracker board targets. */
  get ghFilteredArtifacts() {
    return this._ghFilterAssets(this.ghRunArtifacts, false);
  },

  /** Annotate and filter/sort receiver CI artifacts by receiver board target. */
  get ghFilteredReceiverArtifacts() {
    return this._ghFilterAssets(this.ghReceiverRunArtifacts, true);
  },

  /** Filter and sort asset/artifact list: matched items first, optionally hide unmatched. */
  _ghFilterAssets(items, isReceiver = false, isAll = false) {
    const trkTargets = this.ghDetectedTargets;
    const rcvTargets = this.receiverInfo?.boardTarget ? [this.receiverInfo.boardTarget] : [];

    const annotated = items.map((item) => {
      let board, matched;
      if (isAll) {
        // Try both matchers: receiver first (more specific), then tracker
        const rcvBoard = matchReceiverBoardTarget(item.name);
        const trkBoard = matchBoardTarget(item.name);
        if (rcvBoard && rcvTargets.includes(rcvBoard)) {
          board = rcvBoard;
          matched = true;
        } else if (trkBoard && trkTargets.includes(trkBoard)) {
          board = trkBoard;
          matched = true;
        } else {
          board = rcvBoard || trkBoard;
          matched = false;
        }
      } else {
        const targets = isReceiver ? rcvTargets : trkTargets;
        const matchFn = isReceiver ? matchReceiverBoardTarget : matchBoardTarget;
        board = matchFn(item.name);
        matched = board && targets.includes(board);
      }
      return { ...item, _matchedTarget: board, _matched: matched };
    });

    // Sort: matched items first, then alphabetically
    annotated.sort((a, b) => {
      if (a._matched && !b._matched) return -1;
      if (!a._matched && b._matched) return 1;
      return a.name.localeCompare(b.name);
    });

    if (this.ghFilterByTarget && (trkTargets.length > 0 || rcvTargets.length > 0)) {
      return annotated.filter((item) => item._matched);
    }
    return annotated;
  },

  /** Switch GitHub tab and lazy-load data. */
  ghSwitchTab(tab) {
    this.ghTab = tab;
    if (tab === 'releases') this.ghLoadReleases();
    else if (tab === 'ci') this.ghLoadCIRuns();
    else if (tab === 'receiver-ci') this.ghLoadReceiverCIRuns();
  },

  /** Toggle the GitHub downloads section. */
  ghToggle() {
    this.ghExpanded = !this.ghExpanded;
    if (this.ghExpanded) {
      if (this.ghTab === 'releases') this.ghLoadReleases();
      else if (this.ghTab === 'ci') this.ghLoadCIRuns();
      else if (this.ghTab === 'receiver-ci') this.ghLoadReceiverCIRuns();
    }
  },

  /** Download key for tracking per-item download state. */
  _ghDlKey(name) {
    return `${this.ghTab}:${name}`;
  },

  /** Download a release asset — tries direct fetch, falls back to new tab. */
  async ghDownloadRelease(asset) {
    const key = this._ghDlKey(asset.name);
    this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null } };

    try {
      // Try direct download (unlikely to work due to CORS)
      const result = await downloadReleaseAsset(asset.downloadUrl, (p) => {
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: p, error: null } };
      });

      if (result) {
        // Success — parse and add as firmware
        await this._addFirmwareFromBuffer(result.data, asset.name);
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 1, error: null, done: true } };
        this.log(`✓ Downloaded and loaded: ${asset.name}`);
      } else {
        // CORS blocked — open in new tab
        openDownloadUrl(asset.downloadUrl);
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null, fallback: true } };
        this.log(`Opening download link for ${asset.name} (CORS restricted, use drag-and-drop to load)`);
      }
    } catch (e) {
      this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: e.message } };
      this.log(`✗ Download error (${asset.name}): ${e.message}`);
    }
  },

  /** Download a CI artifact via nightly.link, extract zip, load .uf2. */
  async ghDownloadArtifact(artifact) {
    const key = this._ghDlKey(artifact.name);
    this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null } };

    try {
      const uf2Files = await downloadArtifact(artifact.downloadUrl, (p) => {
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: p, error: null } };
      });

      if (uf2Files) {
        for (const uf2 of uf2Files) {
          await this._addFirmwareFromBuffer(uf2.data, uf2.name);
        }
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 1, error: null, done: true } };
        this.log(`✓ Downloaded and extracted: ${artifact.name} (${uf2Files.length} file(s))`);
      } else {
        // CORS blocked — open nightly.link page in new tab
        openDownloadUrl(artifact.downloadUrl.replace(/\.zip$/, ''));
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null, fallback: true } };
        this.log(`Opening download link for ${artifact.name} (CORS restricted, drop .zip file to load)`);
      }
    } catch (e) {
      this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: e.message } };
      this.log(`✗ Artifact download error (${artifact.name}): ${e.message}`);
    }
  },

  /** Add firmware from an ArrayBuffer (from GitHub download). */
  async _addFirmwareFromBuffer(buffer, name) {
    try {
      let parsed = this._parseFirmware(buffer, name);
      const id = this._nextFwId++;
      const detectedBoard = matchBoardTarget(name) || matchReceiverBoardTarget(name);

      // If matched to receiver and receiver flashBase is known, check compatibility
      const isReceiverFw = detectedBoard && matchReceiverBoardTarget(name);
      let sdPlusApp = false;
      if (isReceiverFw && this.receiverInfo && parsed.baseAddress !== this.receiverInfo.flashBase) {
        if (parsed.baseAddress > this.receiverInfo.flashBase) {
          this.log(`⚠ ${name}: base 0x${parsed.baseAddress.toString(16)} > receiver 0x${this.receiverInfo.flashBase.toString(16)} — requires SoftDevice not present`);
        } else if (looksLikeSdPlusApp(parsed.data, parsed.baseAddress, this.receiverInfo.flashBase)) {
          // SD+App: re-parse to extract app only
          sdPlusApp = true;
          parsed = this._parseFirmware(buffer, name, this.receiverInfo.flashBase);
        }
        // Otherwise: pure app at lower base, keep as-is (cross-base update)
      } else if (!isReceiverFw && parsed.baseAddress < 0x27000) {
        // Check tracker firmware for SD+App pattern (heuristic at common 0x27000 base)
        sdPlusApp = looksLikeSdPlusApp(parsed.data, parsed.baseAddress, 0x27000);
      }

      const file = { name, size: buffer.byteLength };
      this.firmwareFiles = [...this.firmwareFiles, { id, file, raw: buffer, parsed, detectedBoard, sdPlusApp }];
      this.log(
        `✓ Firmware loaded: ${name} — ` +
        `${(parsed.data.length / 1024).toFixed(1)} KB, ` +
        `CRC: 0x${parsed.crc32.toString(16).toUpperCase().padStart(8, '0')}` +
        (sdPlusApp ? ' [SD+App]' : '') +
        (detectedBoard ? ` → ${detectedBoard}` : ''),
      );
      this._autoMapFirmware();
      this._syncFirmwareStore();
    } catch (e) {
      this.log(`✗ Firmware parse error (${name}): ${e.message}`);
    }
  },

  /** Get download state for a specific item. */
  ghDlState(name) {
    const key = this._ghDlKey(name);
    return this.ghDownloading[key] || null;
  },

  /** Check if a download is in progress for a specific item. */
  ghIsDownloading(name) {
    const state = this.ghDlState(name);
    return state && !state.done && !state.error && !state.fallback;
  },

  /** Save a release asset directly to disk (opens browser download). */
  ghSaveReleaseToDisk(asset) {
    openDownloadUrl(asset.downloadUrl);
  },

  /** Download a CI artifact and save the extracted .uf2 to disk. */
  async ghSaveArtifactToDisk(artifact) {
    const key = this._ghDlKey(artifact.name) + ':save';
    this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null } };

    try {
      const uf2Files = await downloadArtifact(artifact.downloadUrl, (p) => {
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: p, error: null } };
      });

      if (uf2Files && uf2Files.length > 0) {
        for (const uf2 of uf2Files) {
          const blob = new Blob([uf2.data], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = uf2.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 1, error: null, done: true } };
        this.log(`✓ Saved to disk: ${uf2Files.map(f => f.name).join(', ')}`);
      } else {
        openDownloadUrl(artifact.downloadUrl.replace(/\.zip$/, ''));
        this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: null, fallback: true } };
      }
    } catch (e) {
      this.ghDownloading = { ...this.ghDownloading, [key]: { progress: 0, error: e.message } };
      this.log(`✗ Save error (${artifact.name}): ${e.message}`);
    }
  },
}));

// ── Register Serial DFU component ─────────────────────────────────
import './serial-dfu-ui.js';
import './i18n.js';

// ── Shared Firmware Store ───────────────────────────────────────────
// Bridges the main OTA app's firmware list to the Serial DFU component
Alpine.store('firmware', {
  files: [], // [{ id, name, size, data: ArrayBuffer, format, boardTarget }]
});

// ── Start Alpine ──────────────────────────────────────────────────

Alpine.start();
