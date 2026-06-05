# OTA WEB KNOWLEDGE

**Generated:** 2026-06-05
**Scope:** `slimevr-ota-web/`

## OVERVIEW

Alpine.js + Vite + Tailwind/DaisyUI Cloudflare Pages app for SlimeNRF tracker OTA over WebHID and receiver/bootloader updates over Web Serial DFU.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| UI state | `js/app.js`, `index.html`, `styles.css` | Alpine app state, layout, theme |
| OTA session | `js/ota.js`, `js/protocol.js` | HID OTA flow control and packet constants |
| Firmware parsing | `js/uf2.js`, `js/hex.js`, `js/crc32.js` | UF2/HEX parsing and integrity checks |
| Board matching | `js/boardmap.js` | Firmware target mapping and fallback logic |
| Release/artifact fetch | `js/github.js`, `functions/api/proxy.js` | GitHub release/CI lookup through Pages function |
| Serial DFU UI | `js/serial-dfu-ui.js` | Browser UI bridge for serial DFU |
| Serial DFU core | `js/serial-dfu/` | Adafruit and Nordic DFU implementations |
| i18n | `js/i18n.js`, `js/i18n/` | English and zh-CN translations |
| Deploy config | `vite.config.js`, `wrangler.toml` | Vite and Cloudflare Pages settings |

## CONVENTIONS

- Use `pnpm` inside this directory.
- WebHID requires Chromium-family browsers; serial DFU also depends on browser Web Serial support.
- The HID OTA protocol uses 64-byte reports with four 16-byte subreports and explicit flow control. Keep changes aligned with receiver/tracker OTA code.
- Board matching should degrade gracefully through static maps when GitHub metadata is unavailable.
- Update both `js/i18n/en.js` and `js/i18n/zh-CN.js` for visible UI text changes.
- Generated `dist/`, `.wrangler/`, and `node_modules/` are not source.

## ANTI-PATTERNS

- Do not change OTA pacing or in-flight limits without checking receiver/tracker OTA buffer behavior.
- Do not assume Safari/Firefox support WebHID or Web Serial.
- Do not make deploy-only edits without running a local build first.

## COMMANDS

```bash
cd slimevr-ota-web
pnpm install
pnpm run build
pnpm run dev
pnpm run pages:dev
pnpm run deploy:staging
pnpm run deploy:prod
```
