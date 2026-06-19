# FigmaBot Desktop (Electron) — Design Spec

**Date:** 2026-06-19
**Status:** Approved
**Purpose:** Package the existing FigmaBot dashboard as a Windows desktop application so the whole tool runs locally on the user's PC — using their 4G dongle's mobile IP for account creation instead of paid proxies. The VPS is retired; everything runs on the desktop.

## Goals

- Ship a double-click Windows desktop app (installer with shortcut) that contains the full existing dashboard: Dashboard, Proxies, Accounts, Settings, and Reel Scraper tabs.
- Run entirely locally — no VPS, no external server dependency (Apify is still used by the scraper for discovery, that is unchanged).
- Account-creation bot uses the machine's own connection by default (`PROXY_MODE=local`), so the user's 4G dongle IP is the exit IP. The proxy-list option remains available.
- Bundle Playwright's Chromium inside the installer so the app works offline from first launch.
- Store all user data and downloads in a visible `Documents\FigmaBot\` folder.

## Non-Goals

- No feature changes to the bot, scraper, account flow, proxy/local toggle, Apify tokens, or links-only mode — this wraps existing, working code.
- No automatic scheduling of the reel scrape — it is manual (Run Now) only. (The VPS cron is not replaced.)
- No macOS/Linux build — Windows only.
- No rewrite of the UI to native Electron IPC — the Express/socket.io UI is kept and hosted in-process.
- No auto-update mechanism.

## Architecture

Electron wraps the existing app. The Electron **main process** starts the current Express server in-process and opens a `BrowserWindow` pointing at `http://127.0.0.1:<port>`. The UI, server, bot, and scraper are the existing code; Electron is a shell.

```
electron-main.js  (NEW — Electron entry)
  ├─ resolve DATA_DIR = Documents\FigmaBot\  (create if missing)
  ├─ set env: DATA_DIR, default PROXY_MODE=local, PLAYWRIGHT_BROWSERS_PATH
  ├─ require('./server').start({ port })      (Express in-process)
  └─ BrowserWindow -> http://127.0.0.1:<port>

server.js   (MODIFIED — export start(); keep CLI listen under a guard)
bot.js      (MODIFIED — data paths + Electron-node child spawn)
scraper/*   (MODIFIED — data paths)
paths.js    (NEW — single source of truth for all file locations)
public/*    (UNCHANGED — same dashboard)
```

### 1. Data paths (`paths.js`) — the core refactor

A new module resolves every writable path from a single `DATA_DIR`:

- `DATA_DIR` = `process.env.DATA_DIR` if set, else the project dir (dev fallback). Electron sets it to `Documents\FigmaBot\`.
- Exposes: `dataDir`, `envPath`, `accountsCsv`, `proxiesTxt`, `errorsDir`, `downloadsDir`, and scraper paths (`configJson`, `tokensJson`, `stateDir`).
- On first use, `DATA_DIR` and its subfolders are created.

Files updated to use `paths.js` instead of hardcoded relative/`__dirname` paths:

| File | Currently | Change to |
|---|---|---|
| `bot.js` | `'accounts.csv'`, `'proxies.txt'`, `'errors/'`, `dotenv` cwd | `paths.accountsCsv`, `paths.proxiesTxt`, `paths.errorsDir`, `dotenv({path: paths.envPath})` |
| `server.js` | `.env`, `proxies.txt`, `accounts.csv`, `downloads/` | corresponding `paths.*` |
| `scraper/config.js` | `__dirname/config.json` | `paths.configJson` |
| `scraper/tokens.js` | `__dirname/apify_tokens.json` | `paths.tokensJson` |
| `scraper/state.js` | `__dirname/state` | `paths.stateDir` |
| `scraper/download.js` | `__dirname/../downloads` | `paths.downloadsDir` |
| `scraper/run.js` | `dotenv ../.env` | `dotenv({path: paths.envPath})` |

The scraper modules currently default their paths via `__dirname`; they keep accepting an explicit path argument (already do, used by tests), so unit tests are unaffected. Only the *default* changes to `paths.*`.

### 2. Server export (`server.js`)

Wrap the `server.listen(...)` block in an exported `start({ port })` function. Keep `if (require.main === module) start()` so `npm start` (dev) still works. Electron calls `require('./server').start({ port })`. Pick a fixed local port (default 3000; if taken, the OS-assigned port is read back and passed to the window URL).

### 3. Child-process launch (Electron node)

`server.js` spawns `bot.js`; `run.js` is spawned for the scraper. In a packaged app there is no system `node`. A small helper resolves the node binary:

- Dev: `'node'`.
- Packaged: `process.execPath` (the Electron exe) with env `ELECTRON_RUN_AS_NODE=1`.

Detected via `process.env.FIGMABOT_PACKAGED` (set by `electron-main.js` when `app.isPackaged`). All `spawn('node', [script])` calls route through this helper.

### 4. Playwright Chromium bundling

- `electron-builder` config includes the Playwright browsers folder via `extraResources`, copied to `resources/ms-playwright`.
- `electron-main.js` sets `PLAYWRIGHT_BROWSERS_PATH` to that resources path (packaged) so `bot.js`'s `chromium.launch()` finds the bundled browser.
- Dev uses the normal Playwright cache.
- **Fallback (documented, not built):** if bundling proves unreliable, switch to download-on-first-launch via `npx playwright install chromium` triggered on first run.

### 5. Electron shell (`electron-main.js`)

Responsibilities:
- Resolve and create `Documents\FigmaBot\`; set `DATA_DIR`.
- If no `.env` exists in `DATA_DIR`, seed one (default `PROXY_MODE=local`) so the app opens in 4G/local mode.
- Set `PLAYWRIGHT_BROWSERS_PATH` and `FIGMABOT_PACKAGED` when packaged.
- `require('./server').start()`, then create a `BrowserWindow` (1200×800, app icon) loading the local URL.
- Quit the app (and any child bot/scraper processes) when the window closes.

### 6. Build (`electron-builder`)

- Dev dependencies: `electron`, `electron-builder`.
- `package.json`: `"main": "electron-main.js"`, scripts `"electron": "electron ."` and `"dist": "electron-builder"`.
- Target: Windows NSIS installer (desktop + Start-menu shortcut).
- `files`/`extraResources` configured to include `public/`, `scraper/`, server/bot code, and the Playwright browser; exclude `downloads/`, `errors/`, test files.

## Data flow

- User opens app → window shows dashboard (served by in-process Express on localhost).
- Account bot: Accounts/Dashboard tab → Start → `server.js` spawns `bot.js` via Electron-node → bot reads creds from `Documents\FigmaBot\.env`, runs Playwright (bundled Chromium) on the local/4G IP → writes `accounts.csv` in `Documents\FigmaBot\`.
- Reel scraper: Scraper tab → Run Now → spawns `scraper/run.js` → discovers via Apify, writes reels/links to `Documents\FigmaBot\downloads\`.
- All logs stream to the dashboard via socket.io exactly as today.

## Error handling

- **Port in use:** bind to `0`, read the actual port, load that URL.
- **Chromium missing (packaged):** bot logs a clear message ("browser not found — reinstall the app"); does not crash the dashboard.
- **DATA_DIR not writable:** show an Electron error dialog at startup with the path and stop.
- **Child process spawn failure:** surfaced in the existing log panel (unchanged behavior).
- **Window closed mid-run:** main process kills child bot/scraper before quitting.

## Testing

- **Existing unit tests** (`scraper/test/*`, 43 tests) must still pass — they pass explicit paths, so unaffected by the `paths.js` default change. Add a small `paths.test.js` verifying `DATA_DIR` override and defaults.
- **Dev smoke:** `npm run electron` opens the window, dashboard loads, scraper Run Now works against a real token, account bot Start works in local mode.
- **Packaged smoke (the critical gate):** build the installer, install it, and verify on a clean run: (a) `Documents\FigmaBot\` is created, (b) the bundled Chromium launches and the bot reaches a real signup/login, (c) the scraper downloads a reel. Playwright-in-Electron is only "done" when the *packaged* app does this, not just dev.

## Migration / retirement

- The VPS (`figma.thecristinaadam.com`, pm2 `figmabot`, cron) is retired once the desktop app is verified. Existing VPS data (`accounts.csv`, `apify_tokens.json`, downloaded reels) can be copied into `Documents\FigmaBot\` to carry over. Retirement is a manual step after the user confirms the desktop app works; not automated here.
