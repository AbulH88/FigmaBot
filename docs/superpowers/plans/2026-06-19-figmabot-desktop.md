# FigmaBot Desktop (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing FigmaBot dashboard as a self-contained Windows desktop app that runs entirely locally (VPS retired), uses the PC's 4G-dongle IP for account creation, and bundles Playwright's Chromium.

**Architecture:** An Electron shell (`electron-main.js`) starts the existing Express server in-process and shows it in a window. A new `paths.js` relocates all writable data to `Documents\FigmaBot\`; a new `childNode.js` lets spawned child processes use Electron's bundled Node when packaged. electron-builder produces a Windows installer with Chromium bundled.

**Tech Stack:** Node.js (CommonJS), Electron, electron-builder, Express + socket.io (existing), Playwright (existing), Node built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-19-figmabot-desktop-design.md`

## Global Constraints

- Windows only; installer target NSIS.
- Behavior-preserving in dev: when `DATA_DIR` is unset, every path must resolve to its current location so `npm start` and the 43 existing tests behave exactly as today.
- Data root when packaged: `Documents\FigmaBot\` (`os.homedir()/Documents/FigmaBot`).
- Account bot defaults to `PROXY_MODE=local` (4G dongle IP); proxy-list option stays available.
- Existing 43 `scraper/test/*.test.js` tests must stay green throughout.
- No feature changes to bot/scraper/UI — this is packaging + path relocation only.
- Test command becomes: `node --test test/*.test.js scraper/test/*.test.js`.

## File Structure

```
paths.js          (NEW) single source of truth for all data file locations
childNode.js      (NEW) resolve the node binary for child_process (dev vs packaged)
electron-main.js  (NEW) Electron entry: data dir, env, start server, open window
test/             (NEW) root tests for paths.js and childNode.js
server.js         (MOD) export start()/stopChildren(); route file paths via paths.js; spawn via childNode
bot.js            (MOD) route accounts/proxies/errors/.env via paths.js
scraper/config.js (MOD) default CONFIG_PATH -> paths.configJson
scraper/tokens.js (MOD) default TOKENS_PATH -> paths.tokensJson
scraper/state.js  (MOD) default dirs -> paths.stateDir
scraper/download.js (MOD) default DOWNLOADS_DIR -> paths.downloadsDir
scraper/run.js    (MOD) dotenv -> paths.envPath
package.json      (MOD) main, scripts, test glob, electron deps, build config
.gitignore        (MOD) ignore pw-browsers/ and dist/
```

---

### Task 1: `paths.js` + root test runner

**Files:**
- Create: `paths.js`
- Create: `test/paths.test.js`
- Modify: `package.json` (test script)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `dataPaths(dir?)` → object `{ dataDir, envPath, accountsCsv, proxiesTxt, errorsDir, downloadsDir, configJson, tokensJson, stateDir }`; `ensureDirs(p?)`; and a default singleton where each of those keys is also exported directly (e.g. `require('./paths').configJson`).

- [ ] **Step 1: Write the failing test**

```js
// test/paths.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');

test('dataPaths(dir) builds every path under the given dir', () => {
    const p = paths.dataPaths('/tmp/fb');
    assert.strictEqual(p.dataDir, '/tmp/fb');
    assert.strictEqual(p.envPath, path.join('/tmp/fb', '.env'));
    assert.strictEqual(p.accountsCsv, path.join('/tmp/fb', 'accounts.csv'));
    assert.strictEqual(p.proxiesTxt, path.join('/tmp/fb', 'proxies.txt'));
    assert.strictEqual(p.errorsDir, path.join('/tmp/fb', 'errors'));
    assert.strictEqual(p.downloadsDir, path.join('/tmp/fb', 'downloads'));
    assert.strictEqual(p.configJson, path.join('/tmp/fb', 'scraper', 'config.json'));
    assert.strictEqual(p.tokensJson, path.join('/tmp/fb', 'scraper', 'apify_tokens.json'));
    assert.strictEqual(p.stateDir, path.join('/tmp/fb', 'scraper', 'state'));
});

test('dataPaths() with no arg falls back to project root (dev), not homedir', () => {
    delete process.env.DATA_DIR;
    const p = paths.dataPaths();
    assert.strictEqual(p.dataDir, path.join(__dirname, '..'));
});

test('dataPaths honors DATA_DIR env', () => {
    process.env.DATA_DIR = '/tmp/fbenv';
    const p = paths.dataPaths();
    assert.strictEqual(p.dataDir, '/tmp/fbenv');
    delete process.env.DATA_DIR;
});

test('ensureDirs creates dataDir, scraper, downloads, errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-'));
    const p = paths.dataPaths(dir);
    paths.ensureDirs(p);
    assert.ok(fs.existsSync(p.dataDir));
    assert.ok(fs.existsSync(path.dirname(p.configJson))); // scraper/
    assert.ok(fs.existsSync(p.downloadsDir));
    assert.ok(fs.existsSync(p.errorsDir));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../paths'`

- [ ] **Step 3: Implement `paths.js`**

```js
// paths.js — single source of truth for all writable data locations.
// Dev (DATA_DIR unset): everything resolves to the project root, exactly
// matching the pre-desktop layout. Electron sets DATA_DIR to Documents\FigmaBot.
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = __dirname;

function dataPaths(dir) {
    const base = dir || process.env.DATA_DIR || PROJECT_ROOT;
    return {
        dataDir: base,
        envPath: path.join(base, '.env'),
        accountsCsv: path.join(base, 'accounts.csv'),
        proxiesTxt: path.join(base, 'proxies.txt'),
        errorsDir: path.join(base, 'errors'),
        downloadsDir: path.join(base, 'downloads'),
        configJson: path.join(base, 'scraper', 'config.json'),
        tokensJson: path.join(base, 'scraper', 'apify_tokens.json'),
        stateDir: path.join(base, 'scraper', 'state')
    };
}

function ensureDirs(p = dataPaths()) {
    for (const d of [p.dataDir, path.dirname(p.configJson), p.downloadsDir, p.errorsDir]) {
        fs.mkdirSync(d, { recursive: true });
    }
    return p;
}

// Default singleton: resolved once from the environment at require time.
module.exports = Object.assign({ dataPaths, ensureDirs }, dataPaths());
```

- [ ] **Step 4: Update test script and gitignore**

In `package.json` change the test script:

```json
"test": "node --test test/*.test.js scraper/test/*.test.js",
```

Append to `.gitignore`:

```
# Electron build artifacts and bundled browser
dist/
pw-browsers/
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 new paths tests + the existing 43 (47 total).

- [ ] **Step 6: Commit**

```bash
git add paths.js test/paths.test.js package.json .gitignore
git commit -m "feat(desktop): central data-path module (paths.js)"
```

---

### Task 2: `childNode.js` (node binary resolver)

**Files:**
- Create: `childNode.js`
- Create: `test/childNode.test.js`

**Interfaces:**
- Produces: `nodeCommand()` → `{ command: string, extraEnv: object }`. Dev → `{ command: 'node', extraEnv: {} }`. Packaged (`process.env.FIGMABOT_PACKAGED === '1'`) → `{ command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }`.

- [ ] **Step 1: Write the failing test**

```js
// test/childNode.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { nodeCommand } = require('../childNode');

test('dev mode resolves to system node with no extra env', () => {
    delete process.env.FIGMABOT_PACKAGED;
    const c = nodeCommand();
    assert.strictEqual(c.command, 'node');
    assert.deepStrictEqual(c.extraEnv, {});
});

test('packaged mode uses Electron binary as node', () => {
    process.env.FIGMABOT_PACKAGED = '1';
    const c = nodeCommand();
    assert.strictEqual(c.command, process.execPath);
    assert.strictEqual(c.extraEnv.ELECTRON_RUN_AS_NODE, '1');
    delete process.env.FIGMABOT_PACKAGED;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/childNode.test.js`
Expected: FAIL — `Cannot find module '../childNode'`

- [ ] **Step 3: Implement `childNode.js`**

```js
// childNode.js — resolve how to spawn a Node child process.
// A packaged Electron app has no system `node`; its own executable runs as
// Node when ELECTRON_RUN_AS_NODE=1. In dev we use the real `node`.
function nodeCommand() {
    if (process.env.FIGMABOT_PACKAGED === '1') {
        return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { command: 'node', extraEnv: {} };
}

module.exports = { nodeCommand };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (49 total).

- [ ] **Step 5: Commit**

```bash
git add childNode.js test/childNode.test.js
git commit -m "feat(desktop): node-binary resolver for packaged child processes"
```

---

### Task 3: Route scraper modules through `paths.js`

**Files:**
- Modify: `scraper/config.js`, `scraper/tokens.js`, `scraper/state.js`, `scraper/download.js`, `scraper/run.js`

**Interfaces:**
- Consumes: `require('../paths')` defaults (`configJson`, `tokensJson`, `stateDir`, `downloadsDir`, `envPath`).
- Produces: unchanged public APIs — only the *default* path constants change. All functions still accept an explicit path argument (tests rely on this).

- [ ] **Step 1: Edit `scraper/config.js`**

Replace:
```js
const CONFIG_PATH = path.join(__dirname, 'config.json');
```
with:
```js
const CONFIG_PATH = require('../paths').configJson;
```

- [ ] **Step 2: Edit `scraper/tokens.js`**

Replace:
```js
const TOKENS_PATH = path.join(__dirname, 'apify_tokens.json');
```
with:
```js
const TOKENS_PATH = require('../paths').tokensJson;
```

- [ ] **Step 3: Edit `scraper/state.js`**

Replace:
```js
const STATE_DIR = path.join(__dirname, 'state');
```
with:
```js
const STATE_DIR = require('../paths').stateDir;
```
(The `DOWNLOADED_PATH` and `LOCK_PATH` lines below it already derive from `STATE_DIR` — leave them.)

- [ ] **Step 4: Edit `scraper/download.js`**

Replace:
```js
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
```
with:
```js
const DOWNLOADS_DIR = require('../paths').downloadsDir;
```

- [ ] **Step 5: Edit `scraper/run.js`**

Replace the dotenv line:
```js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
```
with:
```js
require('dotenv').config({ path: require('../paths').envPath });
```

- [ ] **Step 6: Run tests to verify nothing broke**

Run: `npm test`
Expected: PASS (49). In dev `DATA_DIR` is unset so every default resolves to the same project-root location as before; the existing scraper tests pass explicit temp paths and are unaffected.

- [ ] **Step 7: Commit**

```bash
git add scraper/config.js scraper/tokens.js scraper/state.js scraper/download.js scraper/run.js
git commit -m "feat(desktop): scraper modules resolve data paths via paths.js"
```

---

### Task 4: Route `bot.js` through `paths.js`

**Files:**
- Modify: `bot.js`

**Interfaces:**
- Consumes: `require('./paths')` (`accountsCsv`, `proxiesTxt`, `errorsDir`, `envPath`).

- [ ] **Step 1: Update the dotenv + requires at the top of `bot.js`**

Replace line 1:
```js
require('dotenv').config();
```
with (place the paths require alongside the other requires near the top):
```js
const paths = require('./paths');
require('dotenv').config({ path: paths.envPath });
```

- [ ] **Step 2: Replace the accounts CSV constant**

Replace:
```js
const ACCOUNTS_CSV = 'accounts.csv';
```
with:
```js
const ACCOUNTS_CSV = paths.accountsCsv;
```

- [ ] **Step 3: Replace the proxies file read**

In `run()`, replace:
```js
    if (fs.existsSync('proxies.txt')) {
        proxies = fs.readFileSync('proxies.txt', 'utf8').split('\n').map(p => p.trim()).filter(p => p);
    }
```
with:
```js
    if (fs.existsSync(paths.proxiesTxt)) {
        proxies = fs.readFileSync(paths.proxiesTxt, 'utf8').split('\n').map(p => p.trim()).filter(p => p);
    }
```

- [ ] **Step 4: Replace the errors directory**

In the `catch` block replace:
```js
                const errDir = path.join(__dirname, 'errors', dateStamp);
```
with:
```js
                const errDir = path.join(paths.errorsDir, dateStamp);
```

- [ ] **Step 5: Syntax check**

Run: `node --check bot.js`
Expected: no output (exit 0).

- [ ] **Step 6: Behavior check (dev paths unchanged)**

Run:
```bash
node -e "const p=require('./paths'); const path=require('path'); console.log(p.accountsCsv===path.join(__dirname,'accounts.csv'), p.proxiesTxt===path.join(__dirname,'proxies.txt'))"
```
Expected: `true true` (dev resolves to project root, so the bot reads/writes the same files as before).

- [ ] **Step 7: Commit**

```bash
git add bot.js
git commit -m "feat(desktop): bot.js resolves data paths via paths.js"
```

---

### Task 5: `server.js` — export `start()`/`stopChildren()`, route paths, spawn via childNode

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `paths.*`, `nodeCommand()`.
- Produces: `module.exports = { start, stopChildren }`. `start({ port?, host? })` → `Promise<number>` (the actual listening port). `stopChildren()` kills any running bot/scraper child.

- [ ] **Step 1: Add requires near the top (after the existing requires)**

```js
const paths = require('./paths');
const { nodeCommand } = require('./childNode');
```

- [ ] **Step 2: Point dotenv at the data dir**

Replace line 1 `require('dotenv').config();` with:
```js
require('dotenv').config({ path: require('./paths').envPath });
```

- [ ] **Step 3: Settings endpoints use `paths.envPath`**

In `GET /api/settings` and `POST /api/settings`, replace every `'.env'` literal with `paths.envPath`, and the reload line:
```js
    require('dotenv').config({ override: true });
```
with:
```js
    require('dotenv').config({ path: paths.envPath, override: true });
```

- [ ] **Step 4: Proxies endpoints use `paths.proxiesTxt`**

In the proxies `GET`/`POST`/`DELETE` handlers and the `/api/bot/start` pre-flight, replace every `'proxies.txt'` literal with `paths.proxiesTxt`.

- [ ] **Step 5: Accounts endpoints use `paths.accountsCsv`**

In `GET /api/accounts` and `DELETE /api/accounts`, replace every `'accounts.csv'` literal with `paths.accountsCsv`.

- [ ] **Step 6: Scraper downloads endpoint uses `paths.downloadsDir`**

Replace:
```js
    const base = path.join(__dirname, 'downloads');
```
with:
```js
    const base = paths.downloadsDir;
```

- [ ] **Step 7: Spawn the bot via the node resolver**

In `spawnBot()` replace:
```js
    botProcess = spawn('node', ['bot.js'], { detached: process.platform !== 'win32' });
```
with:
```js
    const nc = nodeCommand();
    botProcess = spawn(nc.command, [path.join(__dirname, 'bot.js')], {
        detached: process.platform !== 'win32',
        env: { ...process.env, ...nc.extraEnv }
    });
```

- [ ] **Step 8: Spawn the scraper via the node resolver**

In `POST /api/scraper/run` replace:
```js
    scraperProcess = spawn('node', [path.join(__dirname, 'scraper', 'run.js')], {
        detached: process.platform !== 'win32'
    });
```
with:
```js
    const nc = nodeCommand();
    scraperProcess = spawn(nc.command, [path.join(__dirname, 'scraper', 'run.js')], {
        detached: process.platform !== 'win32',
        env: { ...process.env, ...nc.extraEnv }
    });
```

- [ ] **Step 9: Replace the listen block with `start()` + `stopChildren()` exports**

Replace:
```js
const PORT = process.env.PORT || 3000;
// Localhost-only by default; set HOST=0.0.0.0 (and DASHBOARD_PASSWORD) to expose on the network
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
    console.log(`Web UI running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '0.0.0.0' && !DASHBOARD_PASSWORD) {
        console.log('[!] WARNING: exposed on the network without DASHBOARD_PASSWORD set.');
    }
});
```
with:
```js
function stopChildren() {
    for (const child of [botProcess, scraperProcess]) {
        if (!child) continue;
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { child.kill('SIGTERM'); }
        }
    }
    botProcess = null;
    scraperProcess = null;
}

function start({ port = process.env.PORT || 3000, host = process.env.HOST || '127.0.0.1' } = {}) {
    paths.ensureDirs();
    return new Promise((resolve) => {
        server.listen(port, host, () => {
            const actual = server.address().port;
            console.log(`Web UI running on http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`);
            if (host === '0.0.0.0' && !DASHBOARD_PASSWORD) {
                console.log('[!] WARNING: exposed on the network without DASHBOARD_PASSWORD set.');
            }
            resolve(actual);
        });
    });
}

// Run directly (dev): `npm start`. Required by Electron: it calls start().
if (require.main === module) start();

module.exports = { start, stopChildren };
```

- [ ] **Step 10: Syntax check + dev smoke**

Run: `node --check server.js` → exit 0.

Then dev smoke with an isolated data dir (PowerShell):
```powershell
$env:DATA_DIR = "$env:TEMP\fbsmoke"; npm start
```
In another shell:
```bash
curl.exe -s http://127.0.0.1:3000/api/scraper/config | head -c 60
curl.exe -s http://127.0.0.1:3000/api/scraper/tokens
```
Expected: config JSON (default niches) and `[]`. Confirm `%TEMP%\fbsmoke\scraper\` and `%TEMP%\fbsmoke\downloads\` were created. Stop the server; `Remove-Item Env:\DATA_DIR`.

- [ ] **Step 11: Full test run + commit**

Run: `npm test` → PASS (49).

```bash
git add server.js
git commit -m "feat(desktop): server exports start()/stopChildren(), data paths via paths.js, childNode spawn"
```

---

### Task 6: `electron-main.js` shell + package.json wiring (dev-runnable)

**Files:**
- Create: `electron-main.js`
- Modify: `package.json` (main, electron devDependency, electron script)

**Interfaces:**
- Consumes: `require('./server').start`, `require('./server').stopChildren`.

- [ ] **Step 1: Install Electron as a dev dependency**

Run: `npm install --save-dev electron`
Expected: electron added to devDependencies.

- [ ] **Step 2: Create `electron-main.js`**

```js
// electron-main.js — desktop shell. Hosts the existing Express app in-process
// and shows it in a window. All data lives in Documents\FigmaBot.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'Documents', 'FigmaBot');
process.env.DATA_DIR = DATA_DIR;

if (app.isPackaged) {
    process.env.FIGMABOT_PACKAGED = '1';
    // Bundled Chromium lives in resources/ms-playwright (see electron-builder config).
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
}

let win = null;

async function createWindow() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // Seed local mode (4G dongle IP) on first launch.
        const envPath = path.join(DATA_DIR, '.env');
        if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, 'PROXY_MODE=local\n');
    } catch (err) {
        dialog.showErrorBox('FigmaBot — cannot write data folder', `${DATA_DIR}\n\n${err.message}`);
        app.quit();
        return;
    }

    const { start } = require('./server');
    const port = await start({ port: 0 }); // any free port — avoids conflicts

    win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'FigmaBot',
        autoHideMenuBar: true
    });
    win.loadURL(`http://127.0.0.1:${port}`);
    win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);

app.on('before-quit', () => {
    try { require('./server').stopChildren(); } catch (e) { /* server may not have started */ }
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 3: Wire package.json main + script**

Set `"main": "electron-main.js"` and add to `scripts`:
```json
"electron": "electron .",
```
(Keep `"start": "node server.js"` for headless/dev use.)

- [ ] **Step 4: Dev smoke — launch the desktop window**

Run: `npm run electron`
Expected: a desktop window opens showing the dashboard. Verify:
1. `Documents\FigmaBot\.env` was created containing `PROXY_MODE=local`.
2. The Scraper tab loads; the Proxies tab shows the local-mode toggle checked.
3. Close the window → process exits cleanly.

(If a real Apify token is added and Run Now is clicked, reels land in `Documents\FigmaBot\downloads\` — optional here, covered in Task 7's packaged smoke.)

- [ ] **Step 5: Commit**

```bash
git add electron-main.js package.json package-lock.json
git commit -m "feat(desktop): Electron shell hosting the dashboard in-process"
```

---

### Task 7: electron-builder packaging with bundled Chromium

**Files:**
- Modify: `package.json` (electron-builder devDependency, `dist` script, `build` config)

**Interfaces:** none (produces the installer).

- [ ] **Step 1: Install electron-builder**

Run: `npm install --save-dev electron-builder`

- [ ] **Step 2: Stage Playwright's Chromium into a project-local folder**

Run (PowerShell):
```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\pw-browsers"; npx playwright install chromium
```
Expected: a `pw-browsers\chromium-*` folder appears. (This is what gets bundled; `pw-browsers/` is gitignored from Task 1.)

- [ ] **Step 3: Add the `dist` script and `build` config to package.json**

Add to `scripts`:
```json
"dist": "electron-builder",
```

Add a top-level `build` block:
```json
"build": {
    "appId": "com.figmabot.desktop",
    "productName": "FigmaBot",
    "directories": { "output": "dist" },
    "files": [
        "electron-main.js",
        "server.js",
        "bot.js",
        "paths.js",
        "childNode.js",
        "proxyCheck.js",
        "check_inbox.js",
        "scraper/**/*",
        "public/**/*",
        "node_modules/**/*",
        "!scraper/test/**",
        "!test/**",
        "!**/*.test.js",
        "!errors/**",
        "!downloads/**"
    ],
    "extraResources": [
        { "from": "pw-browsers", "to": "ms-playwright" }
    ],
    "win": { "target": "nsis" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```

- [ ] **Step 4: Build the installer**

Run: `npm run dist`
Expected: `dist\FigmaBot Setup <version>.exe` is produced; build log shows `ms-playwright` copied into resources.

- [ ] **Step 5: Packaged smoke test (the critical gate)**

Install from `dist\FigmaBot Setup *.exe`, launch from the Start-menu shortcut, and verify on a clean machine state:
1. `Documents\FigmaBot\` is created with a seeded `.env` (`PROXY_MODE=local`).
2. The dashboard window opens (no terminal).
3. Add a real Apify token → Scraper → Run Now → at least one reel/link lands in `Documents\FigmaBot\downloads\` (proves the bundled scraper + child-process node work).
4. Accounts/Dashboard → Start Bot in local mode → the **bundled Chromium launches** and the bot reaches Weavy/Figma signup (proves Playwright-in-Electron bundling). Watch the log panel for the fingerprint/navigation lines; a "browser not found" error here means `PLAYWRIGHT_BROWSERS_PATH`/`extraResources` are mismatched — fix the `from`/`to` mapping and rebuild.

If Chromium fails to launch in the packaged app and the mapping is correct, fall back to download-on-first-launch (documented in the spec) — out of scope unless bundling cannot be made to work.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(desktop): electron-builder Windows installer with bundled Chromium"
```

---

## Self-Review

**Spec coverage:**
- Full dashboard, all tabs, local → Tasks 5–6 (server hosted in-process, no tab removal). ✓
- `paths.js` central data dir → Task 1; consumers → Tasks 3,4,5. ✓
- `server.js` export start() → Task 5. ✓
- Electron-node child spawn → Task 2 + Tasks 5. ✓
- electron-main.js shell, Documents\FigmaBot, seed local mode → Task 6. ✓
- Playwright Chromium bundling → Task 7 (stage + extraResources + PLAYWRIGHT_BROWSERS_PATH in Task 6). ✓
- Windows installer → Task 7. ✓
- Manual-only scrape (no scheduler) → nothing to build; confirmed by omission. ✓
- 43 tests stay green → Tasks 1,3 verify; behavior-preserving defaults. ✓
- Data-dir-not-writable error dialog → Task 6 (`dialog.showErrorBox`). ✓
- Port-in-use → Task 6 uses port 0 (free port), sidestepping conflicts. ✓
- Window-closed kills children → Task 5 `stopChildren()` + Task 6 `before-quit`. ✓
- VPS retirement/migration → manual post-step, noted in spec; no task needed. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `dataPaths`/`ensureDirs`/`nodeCommand`/`start`/`stopChildren` names used consistently across tasks. `paths.*` keys match between `paths.js` (Task 1) and consumers (Tasks 3–5).
