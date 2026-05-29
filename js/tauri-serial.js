/**
 * Web Serial polyfill for Tauri — provides a navigator.serial-compatible API
 * backed by Tauri's native serial commands (serialport crate).
 *
 * Implements the subset of the Web Serial API used by serial-dfu/:
 * - navigator.serial.requestPort({ filters })
 * - port.open({ baudRate, ... })
 * - port.close()
 * - port.readable.getReader() → { read(), releaseLock() }
 * - port.writable.getWriter() → { write(), releaseLock(), close() }
 *
 * Usage: import { installTauriSerial } from './tauri-serial.js';
 *        if (isTauri()) installTauriSerial();
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

/**
 * A SerialPort-like object backed by Tauri serial commands.
 */
class TauriSerialPort {
  constructor(info) {
    this._path = info.path;
    this._info = info;
    this._opened = false;
    this._readable = null;
    this._writable = null;
    this._unlistenData = null;
    this._unlistenDisconnect = null;
    this._dataBuffer = [];
    this._dataResolve = null;
  }

  getInfo() {
    return {
      usbVendorId: this._info.vendorId ?? undefined,
      usbProductId: this._info.productId ?? undefined,
    };
  }

  async open(options = {}) {
    await ensureTauriAPI();
    const baudRate = options.baudRate ?? 115200;
    await _invoke('serial_open', { path: this._path, baudRate });
    this._opened = true;

    // Listen for incoming data
    this._unlistenData = await _listen('serial-data', (event) => {
      if (event.payload?.portPath !== this._path) return;
      const chunk = new Uint8Array(event.payload.data);
      if (this._dataResolve) {
        const resolve = this._dataResolve;
        this._dataResolve = null;
        resolve({ value: chunk, done: false });
      } else {
        this._dataBuffer.push(chunk);
      }
    });

    // Listen for disconnection
    this._unlistenDisconnect = await _listen('serial-disconnected', (event) => {
      if (event.payload?.portPath !== this._path) return;
      this._handleDisconnect();
    });

    // Create readable/writable stream proxies
    this._readable = new TauriReadableStream(this);
    this._writable = new TauriWritableStream(this);
  }

  async close() {
    await ensureTauriAPI();
    if (this._unlistenData) { this._unlistenData(); this._unlistenData = null; }
    if (this._unlistenDisconnect) { this._unlistenDisconnect(); this._unlistenDisconnect = null; }
    // Resolve any pending reads with done=true
    if (this._dataResolve) {
      const resolve = this._dataResolve;
      this._dataResolve = null;
      resolve({ value: undefined, done: true });
    }
    try {
      await _invoke('serial_close', { path: this._path });
    } catch { /* ignore if already closed */ }
    this._opened = false;
    this._readable = null;
    this._writable = null;
    this._dataBuffer = [];
  }

  async setSignals(signals = {}) {
    await ensureTauriAPI();
    await _invoke('serial_set_signals', {
      path: this._path,
      dtr: signals.dataTerminalReady ?? null,
      rts: signals.requestToSend ?? null,
    });
  }

  get readable() {
    return this._opened ? this._readable : null;
  }

  get writable() {
    return this._opened ? this._writable : null;
  }

  /** Internal: get next chunk of received data. */
  _readNext() {
    if (this._dataBuffer.length > 0) {
      return Promise.resolve({ value: this._dataBuffer.shift(), done: false });
    }
    return new Promise((resolve) => {
      this._dataResolve = resolve;
    });
  }

  /** Internal: write data to serial port. */
  async _write(data) {
    await ensureTauriAPI();
    const arr = data instanceof Uint8Array ? Array.from(data) : Array.from(new Uint8Array(data));
    await _invoke('serial_write', { path: this._path, data: arr });
  }

  _handleDisconnect() {
    if (this._unlistenData) { this._unlistenData(); this._unlistenData = null; }
    if (this._unlistenDisconnect) { this._unlistenDisconnect(); this._unlistenDisconnect = null; }
    if (this._dataResolve) {
      const resolve = this._dataResolve;
      this._dataResolve = null;
      resolve({ value: undefined, done: true });
    }
    this._opened = false;
    this._readable = null;
    this._writable = null;
  }
}

/** Minimal ReadableStream proxy that provides getReader(). */
class TauriReadableStream {
  constructor(port) {
    this._port = port;
    this._locked = false;
  }

  getReader() {
    if (this._locked) throw new Error('ReadableStream is locked');
    this._locked = true;
    const stream = this;
    return {
      async read() {
        return stream._port._readNext();
      },
      releaseLock() {
        stream._locked = false;
      },
      cancel() {
        stream._locked = false;
      },
    };
  }
}

/** Minimal WritableStream proxy that provides getWriter(). */
class TauriWritableStream {
  constructor(port) {
    this._port = port;
    this._locked = false;
  }

  getWriter() {
    if (this._locked) throw new Error('WritableStream is locked');
    this._locked = true;
    const stream = this;
    return {
      async write(data) {
        await stream._port._write(data);
      },
      releaseLock() {
        stream._locked = false;
      },
      async close() {
        stream._locked = false;
      },
      get ready() {
        return Promise.resolve();
      },
    };
  }
}

/**
 * Tauri-backed navigator.serial replacement.
 */
class TauriSerial extends EventTarget {
  /**
   * requestPort — lists serial ports matching filters and shows a picker dialog.
   * In Tauri, we show a custom modal since there's no browser permission dialog.
   */
  async requestPort({ filters = [] } = {}) {
    await ensureTauriAPI();
    const portList = await _invoke('serial_list_ports');

    // Filter by VID/PID if specified
    let matching = portList;
    if (filters.length > 0) {
      matching = portList.filter((p) => {
        if (!p.vendorId) return false;
        return filters.some(
          (f) =>
            (!f.usbVendorId || p.vendorId === f.usbVendorId) &&
            (!f.usbProductId || p.productId === f.usbProductId),
        );
      });
    }

    if (matching.length === 0) {
      // No filter match — fall back to all USB ports
      matching = portList.filter((p) => p.portType === 'usb');
    }

    if (matching.length === 0) {
      throw new DOMException('No compatible serial port found', 'NotFoundError');
    }

    // Single match → auto-select (no dialog needed)
    if (matching.length === 1) {
      return new TauriSerialPort(matching[0]);
    }

    // Multiple matches → show picker dialog
    const selected = await this._showPortPicker(matching);
    if (!selected) {
      throw new DOMException('No port selected', 'NotFoundError');
    }
    return new TauriSerialPort(selected);
  }

  async getPorts() {
    return [];
  }

  /** Show a modal dialog for serial port selection. Returns selected port info or null. */
  _showPortPicker(ports) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal modal-open';
      dialog.innerHTML = `
        <div class="modal-box max-w-sm">
          <h3 class="font-bold text-lg mb-3">Select Serial Port</h3>
          <div class="space-y-1.5" id="_serial-port-list"></div>
          <div class="modal-action">
            <button class="btn btn-sm btn-ghost" id="_serial-cancel">Cancel</button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>
      `;

      const list = dialog.querySelector('#_serial-port-list');
      for (const port of ports) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-block btn-sm btn-outline justify-start gap-2 font-mono text-xs';
        const vid = port.vendorId ? `${port.vendorId.toString(16).toUpperCase().padStart(4, '0')}` : '----';
        const pid = port.productId ? `${port.productId.toString(16).toUpperCase().padStart(4, '0')}` : '----';
        const name = port.productName || port.path;
        btn.innerHTML = `
          <span class="badge badge-ghost badge-xs">${vid}:${pid}</span>
          <span class="truncate">${name}</span>
          <span class="opacity-40 ml-auto">${port.path}</span>
        `;
        btn.addEventListener('click', () => { cleanup(); resolve(port); });
        list.appendChild(btn);
      }

      dialog.querySelector('#_serial-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
      dialog.querySelector('.modal-backdrop button').addEventListener('click', () => { cleanup(); resolve(null); });

      function cleanup() {
        dialog.remove();
      }

      document.body.appendChild(dialog);
    });
  }
}

/**
 * Install the Tauri Serial polyfill — replaces navigator.serial.
 * Call this before any Web Serial code runs.
 */
export function installTauriSerial() {
  const { isTauri } = window.__TAURI_INTERNALS__ || {};
  // Check using the same method as tauri-hid.js
  if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return;

  Object.defineProperty(navigator, 'serial', {
    value: new TauriSerial(),
    writable: false,
    configurable: true,
  });

  console.log('[TauriSerial] Web Serial polyfill installed (native serial backend)');
}
