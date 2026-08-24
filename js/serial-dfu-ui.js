// Serial DFU Alpine.js component
// Handles UI state for the Serial DFU card

import { compareFirmwareTarget, detectFirmwareIdentity } from './boardmap.js';

import Alpine from 'alpinejs';

Alpine.data('serialDfuApp', () => ({
  webSerialSupported: 'serial' in navigator,

  // State machine: 'idle' | 'running' | 'done'
  dfuState: 'idle',

  // Protocol selection
  dfuProtocol: 'auto', // 'auto' | 'adafruit' | 'nordic'

  // File selection — either from local file picker or from shared store
  dfuFile: null,      // { name, size, data: ArrayBuffer }
  dfuFileFormat: '',   // 'zip' | 'uf2' | 'hex' | 'bin'
  dfuFileSource: '',   // 'local' | 'loaded' — where the firmware came from

  dfuFirmwareRole: '',
  dfuFirmwareTarget: '',
  dfuFirmwareAmbiguous: false,
  dfuExpectedRole: '',
  dfuExpectedTarget: '',
  // Progress
  dfuProgress: 0,
  dfuPhase: '',
  dfuPhaseText: '',

  // Result
  dfuSuccess: false,
  dfuResultMsg: '',

  // Log
  dfuLogs: [],
  dfuLogExpanded: false,

  // Internal
  _dfuInstance: null,
  _dfuDismissTimer: null,
  dfuConfirmation: null,
  dfuModelConfirmation: '',
  _resolveDfuConfirmation: null,

  // ─── Computed-like getters ────────────
  get sharedFirmwareFiles() {
    return Alpine.store('firmware')?.files ?? [];
  },

  get dfuTargetGuard() {
    if (!this.dfuExpectedRole || !this.dfuExpectedTarget.trim()) {
      return { level: 'error', code: 'unconfirmed' };
    }
    return compareFirmwareTarget(
      this.dfuExpectedRole,
      this.dfuExpectedTarget.trim(),
      {
        role: this.dfuFirmwareRole || null,
        boardTarget: this.dfuFirmwareTarget || null,
        ambiguous: this.dfuFirmwareAmbiguous,
      },
    );
  },

  get dfuTargetGuardMessage() {
    switch (this.dfuTargetGuard.code) {
      case 'exact': return this.$t('dfu.targetExact');
      case 'unknown': return this.$t('dfu.targetUnknown');
      case 'mode-change': return this.$t('dfu.modeChange', { target: this.dfuFirmwareTarget });
      case 'role-mismatch': return this.$t('dfu.roleMismatch', { role: this.dfuFirmwareRole });
      case 'target-mismatch': return this.$t('dfu.targetMismatch', { target: this.dfuFirmwareTarget });
      case 'ambiguous': return this.$t('dfu.targetAmbiguous');
      default: return '';
    }
  },

  // ─── Methods ─────────────────────────

  async dfuSelectFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const data = await file.arrayBuffer();
    this.dfuFile = { name: file.name, size: file.size, data };
    this.dfuFileFormat = this._detectFormat(file.name, new Uint8Array(data));
    this.dfuFileSource = 'local';
    const identity = detectFirmwareIdentity(file.name);
    this._setFirmwareIdentity(identity.role, identity.boardTarget, identity.ambiguous);
    this._dfuLog(`Loaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${this.dfuFileFormat})`);
  },

  /** Use firmware already loaded in the main OTA app. */
  dfuUseSharedFirmware(sharedFw) {
    this.dfuFile = { name: sharedFw.name, size: sharedFw.size, data: sharedFw.data };
    this.dfuFileFormat = this._detectFormat(sharedFw.name, new Uint8Array(sharedFw.data.slice(0, 16)));
    this.dfuFileSource = 'loaded';
    this._setFirmwareIdentity(sharedFw.role, sharedFw.boardTarget, sharedFw.targetAmbiguous);
    this._dfuLog(`Using loaded firmware: ${sharedFw.name} (${(sharedFw.size / 1024).toFixed(1)} KB, ${this.dfuFileFormat})`);
  },

  /** Clear the currently selected firmware. */
  dfuClearFile() {
    this.dfuFile = null;
    this.dfuFileFormat = '';
    this.dfuFileSource = '';
    this._setFirmwareIdentity(null, null, false);
  },

  async dfuStart() {
    if (!this.dfuFile || this.dfuState === 'running' || this.dfuTargetGuard.level === 'error') return;

    this.dfuState = 'running';
    this.dfuProgress = 0;
    this.dfuPhase = 'init';
    this.dfuPhaseText = 'Initializing...';
    this.dfuSuccess = false;
    this.dfuResultMsg = '';
    this.dfuLogs = [];

    try {
      const { SerialDfu, DFU_PROTOCOL } = await import('./serial-dfu/index.js');

      const protocolMap = {
        'auto': null,
        'adafruit': DFU_PROTOCOL.ADAFRUIT,
        'nordic': DFU_PROTOCOL.NORDIC,
      };

      const dfu = new SerialDfu({
        protocol: protocolMap[this.dfuProtocol],
        onProgress: (pct, phase, detail) => {
          this.dfuProgress = pct;
          this.dfuPhase = phase;
          this.dfuPhaseText = detail;
        },
        onLog: (msg) => this._dfuLog(msg),
        onPreflight: (device) => this._confirmSerialDevice(device),
      });

      this._dfuInstance = dfu;

      const firmware = new Uint8Array(this.dfuFile.data);
      const success = await dfu.update(firmware, {
        format: this.dfuFileFormat,
        protocol: protocolMap[this.dfuProtocol],
      });

      this.dfuState = 'done';
      this.dfuSuccess = success !== false;
      this.dfuResultMsg = success !== false
        ? 'Firmware updated successfully. Device will reboot.'
        : 'Update was cancelled.';

      // Auto-dismiss success after 8 seconds
      if (this.dfuSuccess) {
        this._dfuDismissTimer = setTimeout(() => this.dfuReset(), 8000);
      }
    } catch (err) {
      this.dfuState = 'done';
      this.dfuSuccess = false;
      this.dfuResultMsg = err.message || 'Unknown error';
      this._dfuLog(`Error: ${err.message}`);
    } finally {
      this._dfuInstance = null;
    }
  },

  async _confirmSerialDevice(device) {
    this.dfuModelConfirmation = '';
    this.dfuConfirmation = {
      ...device,
      firmwareRole: this.dfuFirmwareRole,
      firmwareTarget: this.dfuFirmwareTarget,
      expectedRole: this.dfuExpectedRole,
      expectedTarget: this.dfuExpectedTarget.trim(),
      expectedIdentity: `${this.dfuExpectedRole}:${this.dfuExpectedTarget.trim()}`,
    };
    return new Promise((resolve) => {
      this._resolveDfuConfirmation = resolve;
    });
  },

  approveDfuConfirmation() {
    if (this.dfuModelConfirmation.trim() !== this.dfuConfirmation.expectedIdentity) return;
    const resolve = this._resolveDfuConfirmation;
    this.dfuConfirmation = null;
    this._resolveDfuConfirmation = null;
    resolve?.(true);
  },

  cancelDfuConfirmation() {
    const resolve = this._resolveDfuConfirmation;
    this.dfuConfirmation = null;
    this._resolveDfuConfirmation = null;
    resolve?.(false);
  },

  dfuAbort() {
    this._dfuInstance?.abort();
    this._dfuLog('Aborting...');
  },

  dfuReset() {
    clearTimeout(this._dfuDismissTimer);
    this.dfuState = 'idle';
    this.dfuProgress = 0;
    this.dfuPhase = '';
    this.dfuPhaseText = '';
    this.dfuSuccess = false;
    this.dfuResultMsg = '';
  },

  _setFirmwareIdentity(role, boardTarget, ambiguous = false) {
    this.dfuFirmwareRole = role || '';
    this.dfuFirmwareTarget = boardTarget || '';
    this.dfuFirmwareAmbiguous = Boolean(ambiguous);
    this.dfuExpectedRole = role || '';
    this.dfuExpectedTarget = '';
    this.dfuModelConfirmation = '';
  },

  // ─── Internal ─────────────────────────

  _dfuLog(msg) {
    this.dfuLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    // Auto-expand log on first message
    if (this.dfuLogs.length === 1) this.dfuLogExpanded = true;
  },

  _detectFormat(filename, data) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'zip') return 'zip';
    if (ext === 'uf2') return 'uf2';
    if (ext === 'hex') return 'hex';

    // Check magic bytes
    if (data.length >= 4) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data[0] === 0x50 && data[1] === 0x4B) return 'zip';
      if (view.getUint32(0, true) === 0x0A324655) return 'uf2';
      if (data[0] === 0x3A) return 'hex';
    }

    return 'bin';
  },
}));
