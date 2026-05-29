/**
 * WebHID polyfill for Tauri — provides a navigator.hid-compatible API
 * backed by Tauri's native HID commands (hidapi).
 *
 * Usage: import { installTauriHID, isTauri } from './tauri-hid.js';
 *        if (isTauri()) installTauriHID();
 */

let _invoke = null;
let _listen = null;

async function ensureTauriAPI() {
  if (_invoke) return;
  const core = await import('@tauri-apps/api/core');
  const event = await import('@tauri-apps/api/event');
  _invoke = core.invoke;
  _listen = event.listen;
}

/** Check if running inside Tauri webview */
export function isTauri() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

/**
 * A HIDDevice-like object backed by Tauri commands.
 * Implements the subset of the WebHID API used by ota.js.
 */
class TauriHIDDevice extends EventTarget {
  constructor(info) {
    super();
    this._path = info.path;
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
    this.serialNumber = info.serialNumber || '';
    this.opened = false;
    this._unlisten = null;
    this._unlistenDisconnect = null;
    this._oninputreportHandler = null;
  }

  async open() {
    await ensureTauriAPI();
    await _invoke('hid_open_device', { path: this._path });
    this.opened = true;

    // Listen for input reports from Tauri backend
    this._unlisten = await _listen('hid-input-report', (event) => {
      const { devicePath, reportId, data } = event.payload;
      if (devicePath !== this._path) return;

      const buffer = new Uint8Array(data).buffer;
      const inputEvent = new Event('inputreport');
      inputEvent.reportId = reportId;
      inputEvent.data = new DataView(buffer);
      inputEvent.device = this;
      this.dispatchEvent(inputEvent);
    });

    // Listen for device disconnection
    this._unlistenDisconnect = await _listen('hid-device-disconnected', (event) => {
      if (event.payload?.devicePath !== this._path) return;
      this.opened = false;
      if (this._unlisten) { this._unlisten(); this._unlisten = null; }
      if (this._unlistenDisconnect) { this._unlistenDisconnect(); this._unlistenDisconnect = null; }
      // Notify the TauriHID manager (set by installTauriHID)
      if (this._onDisconnect) this._onDisconnect(this);
    });
  }

  async close() {
    await ensureTauriAPI();
    if (this._unlisten) { this._unlisten(); this._unlisten = null; }
    if (this._unlistenDisconnect) { this._unlistenDisconnect(); this._unlistenDisconnect = null; }
    try {
      await _invoke('hid_close_device', { path: this._path });
    } catch { /* ignore if already closed */ }
    this.opened = false;
  }

  async sendReport(reportId, data) {
    await ensureTauriAPI();
    const arr = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data));
    await _invoke('hid_write', { path: this._path, reportId, data: arr });
  }

  // Match WebHID oninputreport setter pattern (properly handles replacement)
  set oninputreport(handler) {
    if (this._oninputreportHandler) {
      this.removeEventListener('inputreport', this._oninputreportHandler);
    }
    this._oninputreportHandler = handler;
    if (handler) {
      this.addEventListener('inputreport', handler);
    }
  }

  get oninputreport() {
    return this._oninputreportHandler;
  }
}

/**
 * Tauri-backed navigator.hid replacement.
 */
class TauriHID extends EventTarget {
  constructor() {
    super();
    this._openedDevices = new Map(); // path → TauriHIDDevice
    this._knownPaths = new Set(); // track known device paths for connect detection
    this._pollTimer = null;
    this._filters = []; // remembered from last requestDevice()
  }

  /**
   * requestDevice — lists all matching devices and returns them
   * (no browser permission dialog needed in native app).
   */
  async requestDevice({ filters = [] } = {}) {
    this._filters = filters; // remember for getDevices() and polling
    const devices = await this._listMatchingDevices(filters);
    // Track devices for getDevices()
    for (const d of devices) {
      this._openedDevices.set(d._path, d);
      this._knownPaths.add(d._path);
      d._onDisconnect = (dev) => this._handleDisconnect(dev);
    }
    this._startPolling();
    return devices;
  }

  /**
   * getDevices — return previously seen devices that are still connected.
   * In Tauri, we re-scan and return matching devices (no permission gating).
   */
  async getDevices() {
    const devices = await this._listMatchingDevices(this._filters);
    const currentPaths = new Set(devices.map(d => d._path));
    for (const [path] of this._openedDevices) {
      if (!currentPaths.has(path)) this._openedDevices.delete(path);
    }
    for (const d of devices) {
      if (!this._openedDevices.has(d._path)) {
        this._openedDevices.set(d._path, d);
        this._knownPaths.add(d._path);
        d._onDisconnect = (dev) => this._handleDisconnect(dev);
      }
    }
    // Return tracked device instances (preserve opened state)
    return Array.from(this._openedDevices.values());
  }

  /** List and deduplicate matching HID devices. */
  async _listMatchingDevices(filters) {
    await ensureTauriAPI();
    const vid = filters[0]?.vendorId || 0;
    const pid = filters[0]?.productId || 0;
    const deviceList = await _invoke('hid_list_devices', { vid, pid });

    // Deduplicate by serial number (hidapi may list multiple interfaces)
    const seen = new Map();
    for (const info of deviceList) {
      const key = info.serialNumber || info.path;
      if (!seen.has(key)) {
        // Reuse existing device instance if we already track this path
        const existing = this._openedDevices.get(info.path);
        seen.set(key, existing || new TauriHIDDevice(info));
      }
    }
    return Array.from(seen.values());
  }

  /** Handle device disconnection — emit 'disconnect' event (matches WebHID spec). */
  _handleDisconnect(device) {
    this._openedDevices.delete(device._path);
    this._knownPaths.delete(device._path);
    const event = new Event('disconnect');
    event.device = device;
    this.dispatchEvent(event);
  }

  /** Poll for newly connected devices and emit 'connect' events. */
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      try {
        const devices = await this._listMatchingDevices(this._filters);
        for (const d of devices) {
          if (!this._knownPaths.has(d._path)) {
            this._knownPaths.add(d._path);
            this._openedDevices.set(d._path, d);
            d._onDisconnect = (dev) => this._handleDisconnect(dev);
            const event = new Event('connect');
            event.device = d;
            this.dispatchEvent(event);
          }
        }
        // Clean stale paths
        const currentPaths = new Set(devices.map(d => d._path));
        for (const path of this._knownPaths) {
          if (!currentPaths.has(path)) this._knownPaths.delete(path);
        }
      } catch { /* ignore polling errors */ }
    }, 3000);
  }
}

/**
 * Install the Tauri HID polyfill — replaces navigator.hid.
 * Call this before any WebHID code runs.
 */
export function installTauriHID() {
  if (!isTauri()) return;

  Object.defineProperty(navigator, 'hid', {
    value: new TauriHID(),
    writable: false,
    configurable: true,
  });

  console.log('[TauriHID] WebHID polyfill installed (native HID backend)');
}
