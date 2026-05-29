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
   * requestPort — lists serial ports matching filters and lets user pick.
   * In Tauri, we auto-select by VID/PID (no browser dialog).
   * If multiple ports match, returns the first one.
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
      throw new DOMException('No port selected', 'NotFoundError');
    }

    // Return the first matching port
    return new TauriSerialPort(matching[0]);
  }

  async getPorts() {
    return [];
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
