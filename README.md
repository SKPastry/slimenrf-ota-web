# SlimeNRF OTA Web Updater

A browser-based firmware update tool for SlimeNRF trackers using the **WebHID API**. No backend, no installation — just open the page and update.

## Features

- 🌐 **Pure web** — runs entirely in the browser via WebHID
- 📡 **Auto-discovery** — scans connected receivers and enumerates trackers
- 📦 **UF2 parsing** — drag & drop `.uf2` firmware files
- ⚡ **Parallel OTA** — batch updates with flow-controlled streaming
- 🔒 **CRC32 verification** — validates firmware integrity before activation
- 🎨 **Dark/light theme** — DaisyUI-powered UI

## Browser Support

WebHID requires a Chromium-based browser:
- ✅ Chrome 89+
- ✅ Edge 89+
- ✅ Opera 75+
- ❌ Firefox (not supported)
- ❌ Safari (not supported)

## Quick Start

```bash
cd slimevr-ota-web
npm install
npm run dev
```

Then open `http://localhost:5173` in Chrome/Edge.

### No dev server? Just serve static files:

```bash
npx serve .
# or
python -m http.server 8000
```

> **Note:** WebHID works on `localhost` without HTTPS. For remote access, HTTPS is required.

## Usage

1. Click **Connect** — the browser will show a device picker for SlimeNRF receivers
2. Trackers are scanned automatically — online trackers show firmware info
3. **Drag & drop** a `.uf2` firmware file (or click Choose File)
4. **Select trackers** to update by clicking their cards
5. Click **Start Update** — the tool will:
   - Send BEGIN to selected trackers
   - Stream firmware data with flow control
   - Verify CRC32 integrity
   - Activate new firmware (trackers reboot automatically)

## Tech Stack

- **Alpine.js** — lightweight reactivity (ESM, no build)
- **TailwindCSS + DaisyUI** — styling via CDN
- **WebHID API** — direct USB HID communication
- **Vite** — dev server only (no transformation)
- **ESM + Import Maps** — native browser modules, zero build step

## Architecture

```
js/
├── crc32.js         CRC32 lookup-table implementation
├── uf2.js           UF2 binary parser
├── protocol.js      OTA protocol constants & packet helpers
├── ota.js           OTA session manager (WebHID + flow control)
└── app.js           Alpine.js application & UI state
```

The OTA protocol is a direct port of `esb_ota.py` to WebHID:
- **VID** `0x1209` / **PID** `0x7690`
- 64-byte HID reports with 4 × 16-byte sub-report packing
- Flow-controlled streaming with ring buffer backpressure (max 239 in-flight)
- Batch parallel updates (2 trackers for nRF52840, 1 for nRF52833)
