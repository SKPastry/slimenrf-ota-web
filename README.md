# SlimeNRF OTA Updater

A firmware update tool for SlimeNRF trackers — works both as a **web app** (WebHID) and as a **native desktop app** (Tauri).

🌐 **Live:** [smol-ota.jtcat.com](https://smol-ota.jtcat.com)

## Features

- 📡 **Auto-discovery** — scans connected receivers and enumerates trackers
- ⚡ **Parallel OTA** — batch updates with flow-controlled streaming (2 trackers at a time)
- 📦 **UF2 / HEX parsing** — drag & drop firmware files
- 🔒 **CRC32 verification** — validates firmware integrity before activation
- 🔌 **Serial DFU** — receiver firmware updates via Adafruit or Nordic DFU bootloader
- 🌍 **i18n** — English and Chinese translations
- 🎨 **Dark/light theme** — DaisyUI-powered responsive UI
- 🖥️ **Desktop app** — Tauri wrapper with native HID and Serial support

## Browser Support (Web)

WebHID requires a Chromium-based browser:
- ✅ Chrome 89+ / Edge 89+ / Opera 75+
- ❌ Firefox / Safari (use the desktop app instead)

## Desktop App (Tauri)

The Tauri build provides native HID and Serial access without browser restrictions.

### Pre-built Packages

| Format | Platform |
|--------|----------|
| `.deb` | Debian / Ubuntu |
| `.rpm` | Fedora / openSUSE |
| `.pkg.tar.zst` | Arch Linux |
| `.AppImage` | Universal Linux |

### Build from Source

```bash
# Prerequisites: rust, pnpm, nodejs, pkg-config
# On Arch: pacman -S webkit2gtk-4.1 gtk3 hidapi

pnpm install
pnpm tauri:build
```

### Arch Linux (PKGBUILD)

```bash
cd src-tauri
makepkg -si --skipchecksums
```

### Linux: udev Rules

For HID/Serial access without root, install the udev rules:

```bash
sudo cp src-tauri/resources/99-slimenrf.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

The `.deb` package installs these automatically.

## Development

```bash
pnpm install
pnpm dev          # Vite dev server (web)
pnpm tauri:dev    # Tauri dev mode (desktop)
```

### Deploy

```bash
pnpm deploy:prod      # Cloudflare Pages (production)
pnpm deploy:staging   # Cloudflare Pages (staging)
```

## Tech Stack

- **Alpine.js** — lightweight reactivity
- **TailwindCSS v4 + DaisyUI v5** — styling
- **Vite** — build tool
- **WebHID / Web Serial** — browser APIs for USB communication
- **Tauri v2** — desktop wrapper with Rust backend (hidapi + serialport)

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
├── tauri-hid.js     WebHID polyfill for Tauri (native HID)
├── tauri-serial.js  Web Serial polyfill for Tauri (native serial)
├── serial-dfu/      Serial DFU implementation (Adafruit + Nordic)
└── i18n/            Translation files (en, zh-CN)

src-tauri/
├── src/lib.rs       Rust HID + Serial backend commands
├── tauri.conf.json  App configuration
├── PKGBUILD         Arch Linux package build script
└── resources/       udev rules, bundled assets
```

## OTA Protocol

Direct port of `esb_ota.py` to WebHID:
- **VID** `0x1209` / **PID** `0x7690`
- 64-byte HID reports with 4 × 16-byte sub-report packing
- Flow-controlled streaming with ring buffer backpressure (max 239 in-flight)
- Batch parallel updates grouped by board target (2 parallel for nRF52840, 1 for others)
