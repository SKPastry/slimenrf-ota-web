# SlimeNRF OTA Updater

A web-based firmware update tool for SlimeNRF trackers using WebHID.

🌐 **Live:** [smol-ota.jtcat.com](https://smol-ota.jtcat.com)

## Firmware Compatibility

This tool is designed specifically for the
[SlimeNRF tracker firmware (`devc`)](https://github.com/SKPastry/SlimeVR-Tracker-nRF/tree/devc)
and
[SlimeNRF receiver firmware (`devc`)](https://github.com/SKPastry/SlimeVR-Tracker-nRF-Receiver/tree/devc)
maintained by `SKPastry`.

> [!WARNING]
> The OTA protocol is specific to the current SlimeNRF implementation. It may
> **not compatible with the official upstream SlimeVR firmware or its OTA
> implementation**.

## Features

- 📡 **Auto-discovery** — scans connected receivers and enumerates trackers
- ⚡ **Parallel OTA** — batch updates with flow-controlled streaming (2 trackers at a time)
- 📦 **UF2 / HEX parsing** — drag & drop firmware files
- 🔒 **CRC32 verification** — validates firmware integrity before activation
- 🔌 **Serial DFU** — receiver firmware updates via Adafruit or Nordic DFU bootloader
- 🌍 **i18n** — English and Chinese translations
- 🎨 **Dark/light theme** — DaisyUI-powered responsive UI

## Browser Support

- WebHID OTA requires a Chromium-based browser such as Chrome, Edge, or Opera.
- Serial DFU works independently in browsers that provide Web Serial, including Firefox builds with Web Serial support.

## Development

```bash
pnpm install
pnpm dev          # Vite dev server with HTTPS
```

Open `https://localhost:5173/?dev=true` to enable the explicit developer bypass. In this mode, firmware can be mapped to a different OTA target, and Serial DFU skips the physical-target and second typed confirmations. The page displays a persistent warning because an incompatible image may require USB or SWD recovery.

### Deploy

```bash
pnpm deploy:prod      # Cloudflare Pages (production)
pnpm deploy:staging   # Cloudflare Pages (staging)
```

## Tech Stack

- **Alpine.js** — lightweight reactivity
- **TailwindCSS v4 + DaisyUI v5** — styling
- **Vite** — development server and production bundler
- **WebHID / Web Serial** — browser APIs for USB communication

## Architecture

```
js/
├── app.js           Alpine.js application & UI state
├── ota.js           OTA session manager (WebHID + flow control)
├── protocol.js      OTA protocol constants & packet helpers
├── uf2.js           UF2 binary parser
├── hex.js           Intel HEX parser
├── crc32.js         CRC32 lookup-table implementation
├── github.js        GitHub release/CI artifact fetching
├── boardmap.js      Board target matching
├── serial-dfu/      Serial DFU implementation (Adafruit + Nordic)
└── i18n/            Translation files (en, zh-CN)
```

## OTA Protocol

Direct port of `esb_ota.py` to WebHID:
- **VID** `0x1209` / **PID** `0x7690`
- 64-byte HID reports with 4 × 16-byte sub-report packing
- Flow-controlled streaming with ring buffer backpressure (max 239 in-flight)
- Batch parallel updates grouped by board target (2 parallel for nRF52840, 1 for others)

## Contributing

Issues and pull requests are welcome. Before submitting a change, install the
dependencies and confirm that the production build succeeds:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Changes to visible text should update both `js/i18n/en.js` and
`js/i18n/zh-CN.js`. Changes to OTA protocol behavior should be checked against
the matching tracker and receiver firmware implementations.

## License

This project is licensed under the [MIT License](LICENSE).
