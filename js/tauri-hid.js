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
  }

  async close() {
    await ensureTauriAPI();
    if (this._unlisten) {
      this._unlisten();
      this._unlisten = null;
    }
    try {
      await _invoke('hid_close_device', { path: this._path });
    } catch { /* ignore if already closed */ }
    this.opened = false;
  }

  async sendReport(reportId, data) {
    await ensureTauriAPI();
    const arr = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data));
    await _invoke('hid_write', { path: this._path, data: arr });
  }

  // Convenience: match WebHID oninputreport setter pattern
  set oninputreport(handler) {
    this._oninputreportHandler = handler;
    this.addEventListener('inputreport', handler);
  }

  get oninputreport() {
    return this._oninputreportHandler || null;
  }
}

/**
 * Tauri-backed navigator.hid replacement.
 */
class TauriHID extends EventTarget {
  /**
   * requestDevice — lists all matching devices and returns them
   * (no browser permission dialog needed in native app).
   */
  async requestDevice({ filters = [] } = {}) {
    await ensureTauriAPI();

    const vid = filters[0]?.vendorId || 0;
    const pid = filters[0]?.productId || 0;

    const deviceList = await _invoke('hid_list_devices', { vid, pid });

    // Deduplicate by serial number (hidapi may list multiple interfaces)
    const seen = new Map();
    for (const info of deviceList) {
      const key = info.serialNumber || info.path;
      if (!seen.has(key)) {
        seen.set(key, info);
      }
    }

    return Array.from(seen.values()).map(info => new TauriHIDDevice(info));
  }

  async getDevices() {
    return [];
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
