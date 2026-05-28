// Serial DFU Alpine.js component
// Handles UI state for the Serial DFU card

import Alpine from 'alpinejs';

Alpine.data('serialDfuApp', () => ({
  webSerialSupported: 'serial' in navigator,

  // State machine: 'idle' | 'running' | 'done'
  dfuState: 'idle',

  // Protocol selection
  dfuProtocol: 'auto', // 'auto' | 'adafruit' | 'nordic'

  // File selection
  dfuFile: null,      // { name, size, data: ArrayBuffer }
  dfuFileFormat: '',   // 'zip' | 'uf2' | 'hex' | 'bin'

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

  // ─── Methods ─────────────────────────

  async dfuSelectFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const data = await file.arrayBuffer();
    this.dfuFile = { name: file.name, size: file.size, data };
    this.dfuFileFormat = this._detectFormat(file.name, new Uint8Array(data));
    this._dfuLog(`Loaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${this.dfuFileFormat})`);
  },

  async dfuStart() {
    if (!this.dfuFile || this.dfuState === 'running') return;

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
    } catch (err) {
      this.dfuState = 'done';
      this.dfuSuccess = false;
      this.dfuResultMsg = err.message || 'Unknown error';
      this._dfuLog(`Error: ${err.message}`);
    } finally {
      this._dfuInstance = null;
    }
  },

  dfuAbort() {
    this._dfuInstance?.abort();
    this._dfuLog('Aborting...');
  },

  dfuReset() {
    this.dfuState = 'idle';
    this.dfuProgress = 0;
    this.dfuPhase = '';
    this.dfuPhaseText = '';
    this.dfuSuccess = false;
    this.dfuResultMsg = '';
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
