# Instagram Reel Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily automated discovery of trending Instagram reels per niche via the Apify Hashtag Scraper, downloading 10–30 MP4s/day to organized folders, managed from a new `#scraper` tab in the FigmaBot dashboard, free-tier-budget-capped with multi-token rotation.

**Architecture:** Small single-purpose CommonJS modules in a new `scraper/` directory (config, tokens, discover, select, download, state, run orchestrator). The dashboard's Express server gets `/api/scraper/*` endpoints and spawns `scraper/run.js` as a child process (same pattern as the existing bot), streaming logs over socket.io events `scraperLog`/`scraperStatus`. Cron on the VPS invokes the same `run.js` daily.

**Tech Stack:** Node.js (CommonJS), axios (already a dependency), Node built-in `node:test` for tests, vanilla JS frontend (existing patterns), Apify REST API (`run-sync-get-dataset-items` on actor `apify~instagram-hashtag-scraper`).

**Spec:** `docs/superpowers/specs/2026-06-11-reel-scraper-design.md`

## Reference: Apify API contract

- Endpoint: `POST https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items` with header `Authorization: Bearer <token>`, JSON body `{ "hashtags": ["dance"], "resultsLimit": 8 }`. Response body is a JSON array of result items. `resultsLimit` applies per hashtag.
- Result items contain (field names verified during manual E2E in Task 11; `select.js` maps defensively): `shortCode`, `url`, `videoUrl`, `videoPlayCount`, `likesCount`, `ownerUsername`, `videoDuration`, `timestamp`, `caption`, `type`.
- Credit exhaustion: HTTP **402**, or **403** with a message mentioning usage/limit. Anything else is a normal error (do NOT mark token exhausted).

## File Structure

```
scraper/
  config.js          # load/validate/save config.json, DEFAULTS
  config.json        # created on first dashboard save (gitignored? NO — commit defaults; tokens are the secret)
  tokens.js          # token store CRUD + rotation (apify_tokens.json, gitignored)
  discover.js        # Apify actor calls, TokenExhaustedError
  select.js          # normalize/dedupe/filter/rank
  download.js        # MP4 streaming, sidecar JSON, retention sweep
  state.js           # downloaded.json Set persistence + run lockfile
  run.js             # CLI orchestrator (cron + dashboard entry point)
  test/              # node:test unit tests, one file per module
server.js            # MODIFY: add /api/scraper/* endpoints + child process mgmt
public/index.html    # MODIFY: nav link + #view-scraper section
public/script.js     # MODIFY: scraper view logic
public/style.css     # MODIFY: small additions for token/niche rows
.gitignore           # MODIFY: scraper/apify_tokens.json, scraper/state/, downloads/
package.json         # MODIFY: "test": "node --test scraper/test/"
```

---

### Task 1: Test runner + gitignore

**Files:**
- Modify: `package.json:8`
- Modify: `.gitignore`

- [ ] **Step 1: Add test script to package.json**

Change the `scripts` block:

```json
"scripts": {
    "start": "node server.js",
    "test": "node --test scraper/test/"
},
```

- [ ] **Step 2: Add gitignore entries**

Append to `.gitignore`:

```
# Reel scraper secrets & runtime data
scraper/apify_tokens.json
scraper/state/
downloads/
```

- [ ] **Step 3: Verify test runner works (no tests yet = pass with 0 tests)**

Run: `mkdir scraper\test` then `npm test`
Expected: exits 0, reports `tests 0` (Node 18+: `node --test` on a directory runs all `*.test.js` inside).

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add node:test runner and scraper gitignore entries"
```

---

### Task 2: scraper/config.js

**Files:**
- Create: `scraper/config.js`
- Test: `scraper/test/config.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, validateConfig, loadConfig, saveConfig } = require('../config');

test('loadConfig returns defaults when file is missing', () => {
    const cfg = loadConfig(path.join(os.tmpdir(), 'nope-' + Date.now() + '.json'));
    assert.deepStrictEqual(cfg, DEFAULTS);
});

test('validateConfig rejects empty niches', () => {
    const r = validateConfig({ niches: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors.join(' '), /at least one niche/);
});

test('validateConfig normalizes hashtags (strips #, lowercases, drops blanks)', () => {
    const r = validateConfig({ niches: { dance: { hashtags: ['#Dance', '  GRWM ', ''], dailyQuota: 5 } } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.config.niches.dance.hashtags, ['dance', 'grwm']);
});

test('validateConfig rejects bad quota and fills missing top-level keys with defaults', () => {
    const bad = validateConfig({ niches: { dance: { hashtags: ['x'], dailyQuota: 0 } } });
    assert.strictEqual(bad.ok, false);

    const good = validateConfig({ niches: { dance: { hashtags: ['x'], dailyQuota: 3 } } });
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.config.resultsPerHashtag, DEFAULTS.resultsPerHashtag);
    assert.strictEqual(good.config.filters.minPlays, DEFAULTS.filters.minPlays);
});

test('saveConfig + loadConfig round-trips', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
    const r = validateConfig({ niches: { fashion: { hashtags: ['modelpose'], dailyQuota: 4 } }, retentionDays: 30 });
    saveConfig(r.config, file);
    const loaded = loadConfig(file);
    assert.strictEqual(loaded.retentionDays, 30);
    assert.deepStrictEqual(loaded.niches.fashion.hashtags, ['modelpose']);
});

test('loadConfig throws on invalid stored config', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
    fs.writeFileSync(file, JSON.stringify({ niches: {} }));
    assert.throws(() => loadConfig(file), /Invalid scraper config/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../config'`

- [ ] **Step 3: Implement scraper/config.js**

```js
// scraper/config.js — load/validate/save the scraper configuration.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
    niches: {
        dance: { hashtags: ['dancechallenge', 'choreography'], dailyQuota: 8 },
        fashion: { hashtags: ['modelpose', 'fashionreels'], dailyQuota: 8 },
        lifestyle: { hashtags: ['grwm', 'dayinmylife'], dailyQuota: 7 }
    },
    resultsPerHashtag: 8,
    maxResultsPerRun: 70,
    filters: { minPlays: 10000, maxAgeDays: 14, maxDurationSec: 60 },
    retentionDays: 60
};

function isPosInt(n) { return Number.isInteger(n) && n > 0; }

function validateConfig(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, errors: ['config must be an object'] };
    }
    const errors = [];
    const cfg = {
        niches: {},
        resultsPerHashtag: raw.resultsPerHashtag !== undefined ? raw.resultsPerHashtag : DEFAULTS.resultsPerHashtag,
        maxResultsPerRun: raw.maxResultsPerRun !== undefined ? raw.maxResultsPerRun : DEFAULTS.maxResultsPerRun,
        filters: Object.assign({}, DEFAULTS.filters, raw.filters || {}),
        retentionDays: raw.retentionDays !== undefined ? raw.retentionDays : DEFAULTS.retentionDays
    };

    const niches = raw.niches || {};
    if (Object.keys(niches).length === 0) errors.push('at least one niche is required');
    for (const [name, niche] of Object.entries(niches)) {
        if (!/^[a-z0-9_-]+$/i.test(name)) { errors.push(`invalid niche name: ${name}`); continue; }
        const hashtags = ((niche && niche.hashtags) || [])
            .map(h => String(h).trim().replace(/^#/, '').toLowerCase())
            .filter(Boolean);
        if (hashtags.length === 0) errors.push(`niche "${name}" needs at least one hashtag`);
        if (!isPosInt(niche && niche.dailyQuota)) errors.push(`niche "${name}" needs a positive integer dailyQuota`);
        cfg.niches[name] = { hashtags, dailyQuota: niche.dailyQuota };
    }
    for (const key of ['resultsPerHashtag', 'maxResultsPerRun', 'retentionDays']) {
        if (!isPosInt(cfg[key])) errors.push(`${key} must be a positive integer`);
    }
    for (const key of ['minPlays', 'maxAgeDays', 'maxDurationSec']) {
        if (!Number.isInteger(cfg.filters[key]) || cfg.filters[key] < 0) {
            errors.push(`filters.${key} must be a non-negative integer`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, config: cfg };
}

function loadConfig(file = CONFIG_PATH) {
    if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(DEFAULTS));
    const result = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!result.ok) throw new Error('Invalid scraper config: ' + result.errors.join('; '));
    return result.config;
}

function saveConfig(cfg, file = CONFIG_PATH) {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { CONFIG_PATH, DEFAULTS, validateConfig, loadConfig, saveConfig };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scraper/config.js scraper/test/config.test.js
git commit -m "feat(scraper): config load/validate/save with niche defaults"
```

---

### Task 3: scraper/tokens.js

**Files:**
- Create: `scraper/tokens.js`
- Test: `scraper/test/tokens.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/tokens.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../tokens');

function mk(label, extra = {}) {
    return Object.assign({ label, token: 'apify_api_' + label, enabled: true, exhaustedMonth: null }, extra);
}

test('currentMonth formats as YYYY-MM (UTC)', () => {
    assert.strictEqual(t.currentMonth(new Date('2026-06-11T10:00:00Z')), '2026-06');
    assert.strictEqual(t.currentMonth(new Date('2026-01-05T00:00:00Z')), '2026-01');
});

test('pickToken returns first enabled, non-exhausted token in order', () => {
    const list = [mk('a', { enabled: false }), mk('b', { exhaustedMonth: '2026-06' }), mk('c')];
    assert.strictEqual(t.pickToken(list, '2026-06').label, 'c');
});

test('token exhausted last month is available this month', () => {
    const list = [mk('a', { exhaustedMonth: '2026-05' })];
    assert.strictEqual(t.pickToken(list, '2026-06').label, 'a');
});

test('pickToken returns null when all exhausted/disabled', () => {
    const list = [mk('a', { enabled: false }), mk('b', { exhaustedMonth: '2026-06' })];
    assert.strictEqual(t.pickToken(list, '2026-06'), null);
});

test('markExhausted sets the month on the right token', () => {
    const list = [mk('a'), mk('b')];
    t.markExhausted(list, 'b', '2026-06');
    assert.strictEqual(list[0].exhaustedMonth, null);
    assert.strictEqual(list[1].exhaustedMonth, '2026-06');
});

test('addToken validates and appends; rejects duplicate labels and blanks', () => {
    const list = [];
    t.addToken(list, { label: ' g1 ', token: ' tok1 ' });
    assert.deepStrictEqual(list[0], { label: 'g1', token: 'tok1', enabled: true, exhaustedMonth: null });
    assert.throws(() => t.addToken(list, { label: 'g1', token: 'x' }), /already exists/);
    assert.throws(() => t.addToken(list, { label: '', token: 'x' }), /label is required/);
    assert.throws(() => t.addToken(list, { label: 'g2', token: '' }), /token is required/);
});

test('removeToken / toggleToken / moveToken', () => {
    const list = [mk('a'), mk('b'), mk('c')];
    t.moveToken(list, 'c', 'up');
    assert.deepStrictEqual(list.map(x => x.label), ['a', 'c', 'b']);
    t.moveToken(list, 'a', 'up'); // no-op at edge
    assert.strictEqual(list[0].label, 'a');
    t.toggleToken(list, 'a');
    assert.strictEqual(list[0].enabled, false);
    t.removeToken(list, 'c');
    assert.deepStrictEqual(list.map(x => x.label), ['a', 'b']);
    assert.throws(() => t.removeToken(list, 'zzz'), /no such token/);
});

test('maskToken hides all but a short prefix', () => {
    assert.strictEqual(t.maskToken('apify_api_AbCdEfGh123456'), 'apify_api_…');
    assert.strictEqual(t.maskToken('short'), 'sh…');
});

test('loadTokens returns [] for missing or corrupt file; saveTokens round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
    const file = path.join(dir, 'apify_tokens.json');
    assert.deepStrictEqual(t.loadTokens(file), []);
    fs.writeFileSync(file, '{not json');
    assert.deepStrictEqual(t.loadTokens(file), []);
    const list = [mk('a')];
    t.saveTokens(list, file);
    assert.deepStrictEqual(t.loadTokens(file), list);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../tokens'`

- [ ] **Step 3: Implement scraper/tokens.js**

```js
// scraper/tokens.js — ordered Apify token store with monthly-exhaustion rotation.
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, 'apify_tokens.json');

function loadTokens(file = TOKENS_PATH) {
    if (!fs.existsSync(file)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveTokens(tokens, file = TOKENS_PATH) {
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + '\n');
}

// Apify free credits reset each calendar month, so exhaustion is tagged by month.
function currentMonth(now = new Date()) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isExhausted(token, month) {
    return token.exhaustedMonth === month;
}

function pickToken(tokens, month) {
    return tokens.find(t => t.enabled && !isExhausted(t, month)) || null;
}

function markExhausted(tokens, label, month) {
    const t = tokens.find(x => x.label === label);
    if (t) t.exhaustedMonth = month;
    return tokens;
}

function addToken(tokens, { label, token } = {}) {
    label = String(label || '').trim();
    token = String(token || '').trim();
    if (!label) throw new Error('label is required');
    if (!token) throw new Error('token is required');
    if (tokens.some(t => t.label === label)) throw new Error(`label already exists: ${label}`);
    tokens.push({ label, token, enabled: true, exhaustedMonth: null });
    return tokens;
}

function findIndexOrThrow(tokens, label) {
    const idx = tokens.findIndex(t => t.label === label);
    if (idx === -1) throw new Error(`no such token: ${label}`);
    return idx;
}

function removeToken(tokens, label) {
    tokens.splice(findIndexOrThrow(tokens, label), 1);
    return tokens;
}

function moveToken(tokens, label, direction) {
    const idx = findIndexOrThrow(tokens, label);
    const to = direction === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= tokens.length) return tokens;
    [tokens[idx], tokens[to]] = [tokens[to], tokens[idx]];
    return tokens;
}

function toggleToken(tokens, label) {
    const t = tokens[findIndexOrThrow(tokens, label)];
    t.enabled = !t.enabled;
    return tokens;
}

function maskToken(token) {
    const s = String(token);
    return (s.length <= 10 ? s.slice(0, 2) : s.slice(0, 10)) + '…';
}

module.exports = {
    TOKENS_PATH, loadTokens, saveTokens, currentMonth, isExhausted,
    pickToken, markExhausted, addToken, removeToken, moveToken, toggleToken, maskToken
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (config 6 + tokens 9)

- [ ] **Step 5: Commit**

```bash
git add scraper/tokens.js scraper/test/tokens.test.js
git commit -m "feat(scraper): token store with monthly exhaustion rotation"
```

---

### Task 4: scraper/select.js

**Files:**
- Create: `scraper/select.js`
- Test: `scraper/test/select.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/select.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeItem, selectReels } = require('../select');

const NOW = new Date('2026-06-11T12:00:00Z');

function rawItem(over = {}) {
    return Object.assign({
        shortCode: 'ABC123',
        url: 'https://www.instagram.com/reel/ABC123/',
        videoUrl: 'https://cdn.example.com/v.mp4',
        videoPlayCount: 50000,
        likesCount: 1200,
        ownerUsername: 'dancer.girl',
        videoDuration: 22.5,
        timestamp: '2026-06-10T08:00:00.000Z',
        caption: 'hello #dance'
    }, over);
}

test('normalizeItem maps Apify fields', () => {
    const item = normalizeItem(rawItem());
    assert.strictEqual(item.shortcode, 'ABC123');
    assert.strictEqual(item.videoUrl, 'https://cdn.example.com/v.mp4');
    assert.strictEqual(item.plays, 50000);
    assert.strictEqual(item.creator, 'dancer.girl');
    assert.strictEqual(item.durationSec, 22.5);
});

test('normalizeItem returns null for non-video items or missing shortcode', () => {
    assert.strictEqual(normalizeItem(rawItem({ videoUrl: undefined })), null);
    assert.strictEqual(normalizeItem(rawItem({ shortCode: undefined, url: undefined })), null);
    assert.strictEqual(normalizeItem(null), null);
});

test('normalizeItem falls back to shortcode from url and alternate count fields', () => {
    const item = normalizeItem(rawItem({ shortCode: undefined, videoPlayCount: undefined, playsCount: 777 }));
    assert.strictEqual(item.shortcode, 'ABC123');
    assert.strictEqual(item.plays, 777);
});

const FILTERS = { minPlays: 10000, maxAgeDays: 14, maxDurationSec: 60 };
const NICHES = { dance: { hashtags: ['x'], dailyQuota: 2 }, fashion: { hashtags: ['y'], dailyQuota: 2 } };

test('selectReels filters below minPlays, too old, too long', () => {
    const out = selectReels({
        candidatesByNiche: {
            dance: [
                rawItem({ shortCode: 'LOW', videoPlayCount: 50 }),
                rawItem({ shortCode: 'OLD', timestamp: '2026-01-01T00:00:00.000Z' }),
                rawItem({ shortCode: 'LONG', videoDuration: 300 }),
                rawItem({ shortCode: 'GOOD' })
            ]
        },
        downloadedSet: new Set(), filters: FILTERS, niches: NICHES, now: NOW
    });
    assert.deepStrictEqual(out.dance.map(i => i.shortcode), ['GOOD']);
});

test('selectReels dedupes against downloadedSet and across niches, ranks by plays, caps at quota', () => {
    const out = selectReels({
        candidatesByNiche: {
            dance: [
                rawItem({ shortCode: 'SEEN' }),
                rawItem({ shortCode: 'A', videoPlayCount: 30000 }),
                rawItem({ shortCode: 'B', videoPlayCount: 90000 }),
                rawItem({ shortCode: 'C', videoPlayCount: 60000 })
            ],
            fashion: [rawItem({ shortCode: 'A' }), rawItem({ shortCode: 'D' })]
        },
        downloadedSet: new Set(['SEEN']), filters: FILTERS, niches: NICHES, now: NOW
    });
    assert.deepStrictEqual(out.dance.map(i => i.shortcode), ['B', 'C']); // quota 2, plays desc
    assert.deepStrictEqual(out.fashion.map(i => i.shortcode), ['D']);   // 'A' already taken by dance
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../select'`

- [ ] **Step 3: Implement scraper/select.js**

```js
// scraper/select.js — pure selection logic: normalize Apify items, dedupe, filter, rank.

// Field names vary slightly across Apify actor versions, so map defensively.
function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const videoUrl = raw.videoUrl || raw.video_url || null;
    if (!videoUrl) return null;
    const fromUrl = typeof raw.url === 'string' ? (raw.url.match(/\/(?:reel|p)\/([^/?]+)/) || [])[1] : null;
    const shortcode = raw.shortCode || raw.shortcode || fromUrl || null;
    if (!shortcode) return null;

    const plays = [raw.videoPlayCount, raw.playsCount, raw.videoViewCount]
        .find(v => typeof v === 'number');

    return {
        shortcode,
        videoUrl,
        pageUrl: raw.url || `https://www.instagram.com/reel/${shortcode}/`,
        plays: plays !== undefined ? plays : 0,
        likes: typeof raw.likesCount === 'number' ? raw.likesCount : 0,
        creator: raw.ownerUsername || 'unknown',
        durationSec: typeof raw.videoDuration === 'number' ? raw.videoDuration : null,
        timestamp: raw.timestamp || null,
        caption: raw.caption || ''
    };
}

function selectReels({ candidatesByNiche, downloadedSet, filters, niches, now = new Date() }) {
    const seen = new Set(downloadedSet); // copy: also dedupes across niches within this run
    const maxAgeMs = filters.maxAgeDays * 24 * 60 * 60 * 1000;
    const byNiche = {};

    for (const [niche, rawItems] of Object.entries(candidatesByNiche)) {
        const quota = niches[niche] ? niches[niche].dailyQuota : 0;
        const items = [];
        for (const raw of rawItems || []) {
            const item = normalizeItem(raw);
            if (!item) continue;
            if (seen.has(item.shortcode)) continue;
            if (item.plays < filters.minPlays) continue;
            if (item.timestamp) {
                const age = now - new Date(item.timestamp);
                if (Number.isFinite(age) && age > maxAgeMs) continue;
            }
            if (item.durationSec !== null && item.durationSec > filters.maxDurationSec) continue;
            seen.add(item.shortcode);
            items.push(item);
        }
        items.sort((a, b) => b.plays - a.plays);
        byNiche[niche] = items.slice(0, quota);
    }
    return byNiche;
}

module.exports = { normalizeItem, selectReels };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add scraper/select.js scraper/test/select.test.js
git commit -m "feat(scraper): reel selection — normalize, dedupe, filter, rank"
```

---

### Task 5: scraper/discover.js

**Files:**
- Create: `scraper/discover.js`
- Test: `scraper/test/discover.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/discover.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { discoverNiche, TokenExhaustedError, ACTOR_ID } = require('../discover');

function httpError(status, message) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data: { error: { message } } };
    return err;
}

test('discoverNiche posts hashtags/resultsLimit with bearer token and returns items', async () => {
    let captured = null;
    const fakeHttp = {
        post: async (url, body, opts) => {
            captured = { url, body, opts };
            return { data: [{ shortCode: 'X1' }, { shortCode: 'X2' }] };
        }
    };
    const items = await discoverNiche({ hashtags: ['dance'], resultsLimit: 5, token: 'tok123', http: fakeHttp });
    assert.deepStrictEqual(items.map(i => i.shortCode), ['X1', 'X2']);
    assert.match(captured.url, new RegExp(ACTOR_ID));
    assert.match(captured.url, /run-sync-get-dataset-items/);
    assert.deepStrictEqual(captured.body, { hashtags: ['dance'], resultsLimit: 5 });
    assert.strictEqual(captured.opts.headers.Authorization, 'Bearer tok123');
});

test('discoverNiche returns [] for non-array response', async () => {
    const items = await discoverNiche({
        hashtags: ['x'], resultsLimit: 1, token: 't',
        http: { post: async () => ({ data: { error: 'weird' } }) }
    });
    assert.deepStrictEqual(items, []);
});

test('HTTP 402 throws TokenExhaustedError', async () => {
    await assert.rejects(
        discoverNiche({ hashtags: ['x'], resultsLimit: 1, token: 't', http: { post: async () => { throw httpError(402, 'Insufficient credit'); } } }),
        TokenExhaustedError
    );
});

test('HTTP 403 with usage-limit message throws TokenExhaustedError', async () => {
    await assert.rejects(
        discoverNiche({ hashtags: ['x'], resultsLimit: 1, token: 't', http: { post: async () => { throw httpError(403, 'Monthly usage hard limit exceeded'); } } }),
        TokenExhaustedError
    );
});

test('other errors are rethrown unchanged (not exhaustion)', async () => {
    await assert.rejects(
        discoverNiche({ hashtags: ['x'], resultsLimit: 1, token: 't', http: { post: async () => { throw httpError(500, 'Internal error'); } } }),
        err => !(err instanceof TokenExhaustedError) && /500/.test(err.message)
    );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../discover'`

- [ ] **Step 3: Implement scraper/discover.js**

```js
// scraper/discover.js — Apify Instagram Hashtag Scraper calls.
const axios = require('axios');

const ACTOR_ID = 'apify~instagram-hashtag-scraper';
const RUN_SYNC_URL = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;

class TokenExhaustedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenExhaustedError';
    }
}

// One synchronous actor run per niche; resultsLimit applies per hashtag.
// Each returned item costs Apify credit, so callers budget resultsLimit carefully.
async function discoverNiche({ hashtags, resultsLimit, token, http = axios }) {
    try {
        const res = await http.post(RUN_SYNC_URL, { hashtags, resultsLimit }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 300000 // run-sync endpoint can take minutes for cold actor starts
        });
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        const status = err.response ? err.response.status : null;
        const msg = err.response && err.response.data && err.response.data.error
            ? String(err.response.data.error.message || '')
            : '';
        if (status === 402 || (status === 403 && /limit|credit|usage/i.test(msg))) {
            throw new TokenExhaustedError(`Apify token exhausted (HTTP ${status}): ${msg}`);
        }
        throw err;
    }
}

module.exports = { discoverNiche, TokenExhaustedError, ACTOR_ID, RUN_SYNC_URL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add scraper/discover.js scraper/test/discover.test.js
git commit -m "feat(scraper): Apify hashtag discovery with exhaustion detection"
```

---

### Task 6: scraper/state.js

**Files:**
- Create: `scraper/state.js`
- Test: `scraper/test/state.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/state.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../state');

function tmpfile(name) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), name);
}

test('loadDownloaded returns empty Set for missing or corrupt file', () => {
    assert.deepStrictEqual(state.loadDownloaded(tmpfile('downloaded.json')), new Set());
    const f = tmpfile('downloaded.json');
    fs.writeFileSync(f, 'garbage');
    assert.deepStrictEqual(state.loadDownloaded(f), new Set());
});

test('saveDownloaded + loadDownloaded round-trips (creates parent dir)', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), 'deep', 'downloaded.json');
    state.saveDownloaded(new Set(['A', 'B']), f);
    assert.deepStrictEqual(state.loadDownloaded(f), new Set(['A', 'B']));
});

test('acquireLock succeeds on free lock, fails on fresh lock, succeeds on stale lock', () => {
    const f = tmpfile('run.lock');
    const t0 = Date.now();
    assert.strictEqual(state.acquireLock(f, t0), true);
    assert.strictEqual(state.acquireLock(f, t0 + 1000), false);
    assert.strictEqual(state.acquireLock(f, t0 + state.LOCK_STALE_MS + 1), true);
});

test('releaseLock removes the lock; releasing a missing lock is fine', () => {
    const f = tmpfile('run.lock');
    state.acquireLock(f, Date.now());
    state.releaseLock(f);
    assert.strictEqual(fs.existsSync(f), false);
    state.releaseLock(f); // no throw
});

test('corrupt lock file counts as stale', () => {
    const f = tmpfile('run.lock');
    fs.writeFileSync(f, '{broken');
    assert.strictEqual(state.acquireLock(f, Date.now()), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../state'`

- [ ] **Step 3: Implement scraper/state.js**

```js
// scraper/state.js — downloaded-shortcode persistence and the run lockfile.
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');
const DOWNLOADED_PATH = path.join(STATE_DIR, 'downloaded.json');
const LOCK_PATH = path.join(STATE_DIR, 'run.lock');
const LOCK_STALE_MS = 60 * 60 * 1000; // a crashed run's lock expires after 1h

function loadDownloaded(file = DOWNLOADED_PATH) {
    if (!fs.existsSync(file)) return new Set();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (e) {
        return new Set();
    }
}

function saveDownloaded(set, file = DOWNLOADED_PATH) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...set], null, 2) + '\n');
}

function acquireLock(file = LOCK_PATH, now = Date.now()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
        let fresh = false;
        try {
            const { time } = JSON.parse(fs.readFileSync(file, 'utf8'));
            fresh = now - time < LOCK_STALE_MS;
        } catch (e) { /* corrupt lock counts as stale */ }
        if (fresh) return false;
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, time: now }));
    return true;
}

function releaseLock(file = LOCK_PATH) {
    try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
}

module.exports = {
    STATE_DIR, DOWNLOADED_PATH, LOCK_PATH, LOCK_STALE_MS,
    loadDownloaded, saveDownloaded, acquireLock, releaseLock
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add scraper/state.js scraper/test/state.test.js
git commit -m "feat(scraper): downloaded-state persistence and run lockfile"
```

---

### Task 7: scraper/download.js

**Files:**
- Create: `scraper/download.js`
- Test: `scraper/test/download.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scraper/test/download.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { downloadReel, sweepRetention, sanitize, datestamp } = require('../download');

const NOW = new Date('2026-06-11T12:00:00Z');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
}

const ITEM = {
    shortcode: 'ABC123', videoUrl: 'https://cdn.example.com/v.mp4',
    pageUrl: 'https://www.instagram.com/reel/ABC123/', plays: 50000, likes: 100,
    creator: 'dancer.girl', durationSec: 20, timestamp: '2026-06-10T08:00:00.000Z', caption: 'hi'
};

test('sanitize strips unsafe filename characters', () => {
    assert.strictEqual(sanitize('dancer.girl'), 'dancer.girl');
    assert.strictEqual(sanitize('we/ird*na me'), 'we_ird_na_me');
    assert.strictEqual(sanitize(''), 'unknown');
});

test('datestamp formats YYYY-MM-DD', () => {
    assert.strictEqual(datestamp(NOW), '2026-06-11');
});

test('downloadReel streams mp4 and writes metadata sidecar', async () => {
    const base = tmpdir();
    const fakeHttp = { get: async () => ({ data: Readable.from(Buffer.from('FAKE_MP4_BYTES')) }) };
    const file = await downloadReel(ITEM, { niche: 'dance', baseDir: base, http: fakeHttp, now: NOW });

    assert.strictEqual(file, path.join(base, 'dance', '2026-06-11', 'dancer.girl_ABC123.mp4'));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'FAKE_MP4_BYTES');

    const meta = JSON.parse(fs.readFileSync(file.replace(/\.mp4$/, '.json'), 'utf8'));
    assert.strictEqual(meta.shortcode, 'ABC123');
    assert.strictEqual(meta.niche, 'dance');
    assert.strictEqual(meta.plays, 50000);
    assert.strictEqual(meta.downloadedAt, NOW.toISOString());
});

test('sweepRetention removes only date-dirs older than cutoff, prunes empty niche dirs', () => {
    const base = tmpdir();
    for (const d of ['2026-03-01', '2026-06-10']) {
        fs.mkdirSync(path.join(base, 'dance', d), { recursive: true });
        fs.writeFileSync(path.join(base, 'dance', d, 'x.mp4'), 'x');
    }
    fs.mkdirSync(path.join(base, 'old', '2026-01-01'), { recursive: true });
    fs.mkdirSync(path.join(base, 'dance', 'not-a-date'), { recursive: true });

    const removed = sweepRetention(base, 60, NOW);

    assert.deepStrictEqual(removed.sort(), ['dance/2026-03-01', 'old/2026-01-01']);
    assert.strictEqual(fs.existsSync(path.join(base, 'dance', '2026-06-10')), true);
    assert.strictEqual(fs.existsSync(path.join(base, 'dance', 'not-a-date')), true);
    assert.strictEqual(fs.existsSync(path.join(base, 'old')), false); // emptied -> pruned
});

test('sweepRetention on missing baseDir returns []', () => {
    assert.deepStrictEqual(sweepRetention(path.join(os.tmpdir(), 'missing-' + Date.now()), 60, NOW), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../download'`

- [ ] **Step 3: Implement scraper/download.js**

```js
// scraper/download.js — MP4 streaming to disk, metadata sidecars, retention sweep.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

function sanitize(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'unknown';
}

function datestamp(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

async function downloadReel(item, { niche, baseDir = DOWNLOADS_DIR, http = axios, now = new Date() }) {
    const dir = path.join(baseDir, sanitize(niche), datestamp(now));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${sanitize(item.creator)}_${sanitize(item.shortcode)}`;
    const filePath = path.join(dir, `${base}.mp4`);

    const res = await http.get(item.videoUrl, { responseType: 'stream', timeout: 120000 });
    await pipeline(res.data, fs.createWriteStream(filePath));

    const sidecar = {
        shortcode: item.shortcode,
        creator: item.creator,
        plays: item.plays,
        likes: item.likes,
        durationSec: item.durationSec,
        timestamp: item.timestamp,
        pageUrl: item.pageUrl,
        caption: item.caption,
        niche,
        downloadedAt: now.toISOString()
    };
    fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(sidecar, null, 2) + '\n');
    return filePath;
}

// Deletes downloads/<niche>/<YYYY-MM-DD>/ older than retentionDays; prunes emptied niche dirs.
function sweepRetention(baseDir = DOWNLOADS_DIR, retentionDays, now = new Date()) {
    if (!fs.existsSync(baseDir)) return [];
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const niche of fs.readdirSync(baseDir)) {
        const nicheDir = path.join(baseDir, niche);
        if (!fs.statSync(nicheDir).isDirectory()) continue;
        for (const dateName of fs.readdirSync(nicheDir)) {
            const m = dateName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) continue;
            if (Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff) {
                fs.rmSync(path.join(nicheDir, dateName), { recursive: true, force: true });
                removed.push(`${niche}/${dateName}`);
            }
        }
        if (fs.readdirSync(nicheDir).length === 0) fs.rmdirSync(nicheDir);
    }
    return removed;
}

module.exports = { DOWNLOADS_DIR, downloadReel, sweepRetention, sanitize, datestamp };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add scraper/download.js scraper/test/download.test.js
git commit -m "feat(scraper): MP4 download with sidecar metadata and retention sweep"
```

---

### Task 8: scraper/run.js orchestrator

**Files:**
- Create: `scraper/run.js`

No unit test — this is glue over already-tested modules. Verified by smoke test below and the manual E2E in Task 11.

- [ ] **Step 1: Implement scraper/run.js**

```js
// scraper/run.js — orchestrator. Invoked daily by cron and by the dashboard "Run now".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { loadConfig } = require('./config');
const tokensLib = require('./tokens');
const { discoverNiche, TokenExhaustedError } = require('./discover');
const { selectReels } = require('./select');
const { downloadReel, sweepRetention, DOWNLOADS_DIR } = require('./download');
const state = require('./state');

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    if (!state.acquireLock()) {
        log('Another scraper run is in progress (lock held) — exiting.');
        process.exitCode = 2;
        return;
    }
    try {
        const config = loadConfig();
        const tokens = tokensLib.loadTokens();
        const month = tokensLib.currentMonth();
        const downloaded = state.loadDownloaded();

        const removed = sweepRetention(DOWNLOADS_DIR, config.retentionDays);
        if (removed.length) log(`Retention sweep removed: ${removed.join(', ')}`);

        if (tokens.length === 0) {
            throw new Error('No Apify tokens configured — add one in the dashboard Scraper tab.');
        }

        // --- Discovery (the only part that consumes Apify credit) ---
        let resultsFetched = 0;
        const candidatesByNiche = {};
        for (const [niche, def] of Object.entries(config.niches)) {
            if (resultsFetched >= config.maxResultsPerRun) {
                log(`Result cap (${config.maxResultsPerRun}) reached — skipping niche "${niche}".`);
                continue;
            }
            const budget = config.maxResultsPerRun - resultsFetched;
            const perHashtag = Math.max(1, Math.min(
                config.resultsPerHashtag,
                Math.floor(budget / def.hashtags.length)
            ));

            let items = null;
            // Retry the same niche with the next token when one is exhausted.
            while (items === null) {
                const tok = tokensLib.pickToken(tokens, month);
                if (!tok) {
                    log('All Apify tokens are exhausted for this month — add another or wait for reset.');
                    break;
                }
                try {
                    log(`Niche "${niche}": ${perHashtag}/hashtag for [${def.hashtags.join(', ')}] via token "${tok.label}"...`);
                    items = await discoverNiche({ hashtags: def.hashtags, resultsLimit: perHashtag, token: tok.token });
                } catch (err) {
                    if (err instanceof TokenExhaustedError) {
                        log(`Token "${tok.label}" exhausted — rotating. (${err.message})`);
                        tokensLib.markExhausted(tokens, tok.label, month);
                        tokensLib.saveTokens(tokens);
                    } else {
                        log(`Niche "${niche}" discovery failed: ${err.message} — skipping this niche.`);
                        break;
                    }
                }
            }
            if (!items) continue;
            log(`Niche "${niche}": ${items.length} candidates.`);
            resultsFetched += items.length;
            candidatesByNiche[niche] = items;
        }

        // --- Selection ---
        const picked = selectReels({
            candidatesByNiche,
            downloadedSet: downloaded,
            filters: config.filters,
            niches: config.niches
        });

        // --- Download (free: direct CDN fetch, no Apify involvement) ---
        let ok = 0, failed = 0;
        for (const [niche, items] of Object.entries(picked)) {
            for (const item of items) {
                let done = false;
                for (let attempt = 1; attempt <= 2 && !done; attempt++) {
                    try {
                        const file = await downloadReel(item, { niche });
                        // Persist immediately so a crash mid-run doesn't redownload
                        downloaded.add(item.shortcode);
                        state.saveDownloaded(downloaded);
                        log(`Downloaded [${niche}] ${item.creator}/${item.shortcode} (${item.plays} plays) -> ${file}`);
                        done = true;
                        ok++;
                    } catch (err) {
                        log(`Download failed (attempt ${attempt}/2) ${item.shortcode}: ${err.message}`);
                    }
                }
                if (!done) failed++; // shortcode NOT recorded -> future run can retry it
            }
        }

        log(`Run complete: ${ok} downloaded, ${failed} failed, ${resultsFetched} discovery results consumed.`);
        if (ok === 0 && failed > 0) process.exitCode = 1;
    } catch (err) {
        log(`FATAL: ${err.message}`);
        process.exitCode = 1;
    } finally {
        state.releaseLock();
    }
}

main();
```

- [ ] **Step 2: Smoke test — no tokens configured**

Run: `node scraper/run.js`
Expected output: `FATAL: No Apify tokens configured — add one in the dashboard Scraper tab.` and exit code 1.
Check: `echo %errorlevel%` (cmd) / `$LASTEXITCODE` (PowerShell) is `1`, and `scraper/state/run.lock` does NOT exist afterward.

- [ ] **Step 3: Smoke test — lock contention**

Create a fresh lock, then run:

PowerShell:
```powershell
New-Item -ItemType Directory -Force scraper/state | Out-Null
Set-Content scraper/state/run.lock ('{"pid":1,"time":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + '}') -Encoding utf8
node scraper/run.js
```
Expected: `Another scraper run is in progress (lock held) — exiting.`, exit code 2. Then delete the lock: `Remove-Item scraper/state/run.lock`.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS (all suites still green)

- [ ] **Step 5: Commit**

```bash
git add scraper/run.js
git commit -m "feat(scraper): run orchestrator with token rotation and result cap"
```

---

### Task 9: Server API endpoints

**Files:**
- Modify: `server.js` (insert after the Accounts endpoints, before `// Socket connection` at `server.js:273`; also modify the `io.on('connection')` block)

- [ ] **Step 1: Add scraper requires near the top of server.js (after line 10, with the other requires)**

```js
const scraperTokens = require('./scraper/tokens');
const scraperConfig = require('./scraper/config');
```

- [ ] **Step 2: Add the endpoint block before `// Socket connection`**

```js
// ---------------- Reel Scraper ----------------
let scraperProcess = null;
let scraperLastRun = null; // { startedAt, finishedAt, code }

function publicTokens() {
    const month = scraperTokens.currentMonth();
    return scraperTokens.loadTokens().map(t => ({
        label: t.label,
        masked: scraperTokens.maskToken(t.token),
        enabled: t.enabled,
        exhausted: scraperTokens.isExhausted(t, month)
    }));
}

// Shared wrapper: load -> mutate -> save -> respond. Token values never leave the server unmasked.
function mutateTokens(res, fn) {
    try {
        const tokens = scraperTokens.loadTokens();
        fn(tokens);
        scraperTokens.saveTokens(tokens);
        res.json({ success: true, tokens: publicTokens() });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
}

app.get('/api/scraper/tokens', (req, res) => res.json(publicTokens()));

app.post('/api/scraper/tokens', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.addToken(tokens, req.body || {})));

app.delete('/api/scraper/tokens', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.removeToken(tokens, (req.body || {}).label)));

app.post('/api/scraper/tokens/toggle', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.toggleToken(tokens, (req.body || {}).label)));

app.post('/api/scraper/tokens/move', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.moveToken(tokens, (req.body || {}).label, (req.body || {}).direction)));

app.get('/api/scraper/config', (req, res) => {
    try {
        res.json(scraperConfig.loadConfig());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/scraper/config', (req, res) => {
    const result = scraperConfig.validateConfig(req.body);
    if (!result.ok) return res.json({ success: false, error: result.errors.join('; ') });
    scraperConfig.saveConfig(result.config);
    res.json({ success: true });
});

app.post('/api/scraper/run', (req, res) => {
    if (scraperProcess) {
        return res.json({ success: false, error: 'Scraper is already running.' });
    }
    scraperLastRun = { startedAt: new Date().toISOString(), finishedAt: null, code: null };
    scraperProcess = spawn('node', [path.join(__dirname, 'scraper', 'run.js')], {
        detached: process.platform !== 'win32'
    });
    scraperProcess.stdout.on('data', d => io.emit('scraperLog', d.toString()));
    scraperProcess.stderr.on('data', d => io.emit('scraperLog', `[ERROR] ${d.toString()}`));
    scraperProcess.on('close', (code) => {
        scraperLastRun.finishedAt = new Date().toISOString();
        scraperLastRun.code = code;
        io.emit('scraperLog', `\n[SYSTEM] Scraper finished with code ${code}\n`);
        scraperProcess = null;
        io.emit('scraperStatus', false);
    });
    io.emit('scraperStatus', true);
    res.json({ success: true });
});

app.get('/api/scraper/status', (req, res) => {
    res.json({ running: !!scraperProcess, lastRun: scraperLastRun });
});

app.get('/api/scraper/downloads', (req, res) => {
    const base = path.join(__dirname, 'downloads');
    const out = [];
    if (fs.existsSync(base)) {
        for (const niche of fs.readdirSync(base)) {
            const nicheDir = path.join(base, niche);
            if (!fs.statSync(nicheDir).isDirectory()) continue;
            for (const date of fs.readdirSync(nicheDir)) {
                const dateDir = path.join(nicheDir, date);
                if (!fs.statSync(dateDir).isDirectory()) continue;
                for (const f of fs.readdirSync(dateDir)) {
                    if (!f.endsWith('.json')) continue;
                    try {
                        const meta = JSON.parse(fs.readFileSync(path.join(dateDir, f), 'utf8'));
                        out.push(Object.assign({ niche, date, file: f.replace(/\.json$/, '.mp4') }, meta));
                    } catch (e) { /* skip unreadable sidecar */ }
                }
            }
        }
    }
    out.sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')));
    res.json(out.slice(0, 100));
});
```

- [ ] **Step 3: Emit scraper status on socket connect**

Change the existing block:

```js
// Socket connection
io.on('connection', (socket) => {
    socket.emit('botStatus', !!botProcess);
    socket.emit('scraperStatus', !!scraperProcess);
});
```

- [ ] **Step 4: Manual verification with curl**

Run: `npm start` in one terminal, then in another:

```bash
curl -s http://127.0.0.1:3000/api/scraper/tokens
# Expected: []
curl -s -X POST http://127.0.0.1:3000/api/scraper/tokens -H "Content-Type: application/json" -d "{\"label\":\"test\",\"token\":\"apify_api_test123\"}"
# Expected: {"success":true,"tokens":[{"label":"test","masked":"apify_api_…","enabled":true,"exhausted":false}]}
curl -s http://127.0.0.1:3000/api/scraper/config
# Expected: JSON with default niches dance/fashion/lifestyle
curl -s -X POST http://127.0.0.1:3000/api/scraper/run
# Expected: {"success":true} — and the server terminal shows nothing, but
curl -s http://127.0.0.1:3000/api/scraper/status
# Expected (after ~2s): {"running":false,"lastRun":{...,"code":1}}  (token is fake -> FATAL exit 1; that's correct)
curl -s -X DELETE http://127.0.0.1:3000/api/scraper/tokens -H "Content-Type: application/json" -d "{\"label\":\"test\"}"
# Expected: {"success":true,"tokens":[]}
```

Note: the fake-token run exits with `FATAL` from Apify auth (401) — that proves spawn/log/close wiring works. Delete `scraper/state/run.lock` if it lingers (it shouldn't).

- [ ] **Step 5: Run test suite, commit**

Run: `npm test` — Expected: PASS

```bash
git add server.js
git commit -m "feat(scraper): dashboard API — tokens, config, run, status, downloads"
```

---

### Task 10: Frontend — #scraper tab

**Files:**
- Modify: `public/index.html` (nav at line 31, new section before `</main>` at line 180)
- Modify: `public/script.js` (VIEWS at line 20, showView at line 30, new section at end before Init)
- Modify: `public/style.css` (append)

- [ ] **Step 1: Add nav link in index.html (after the Accounts link, before Settings)**

```html
                <a href="#scraper" class="nav-link" data-view="scraper">
                    <span class="nav-icon">▸</span> Reel Scraper
                </a>
```

- [ ] **Step 2: Add the view section in index.html (after the Settings section, before `</main>`)**

```html
            <!-- Reel Scraper view -->
            <section class="view" id="view-scraper" hidden>
                <div class="view-header">
                    <h1 class="view-title">Reel Scraper</h1>
                    <div class="view-actions">
                        <button id="scraper-run" class="btn btn-success">▶ Run Now</button>
                    </div>
                </div>

                <div class="card glass-card">
                    <h2>Apify Tokens <span class="count-badge" id="token-count">0</span></h2>
                    <div class="inline-form">
                        <input type="text" id="token-label" placeholder="Label (e.g. gmail-1)">
                        <input type="password" id="token-value" placeholder="Apify API token">
                        <button id="token-add" class="btn btn-primary">Add Token</button>
                    </div>
                    <ul id="token-list" class="proxy-list"></ul>
                </div>

                <div class="card glass-card">
                    <h2>Niches &amp; Filters</h2>
                    <div id="niche-list"></div>
                    <div class="inline-form">
                        <input type="text" id="niche-name" placeholder="New niche name (e.g. fitness)">
                        <button id="niche-add" class="btn btn-secondary">+ Add Niche</button>
                    </div>
                    <div class="form-grid scraper-filters">
                        <div class="input-group">
                            <label for="f-minPlays">Min plays</label>
                            <input type="number" id="f-minPlays" min="0">
                        </div>
                        <div class="input-group">
                            <label for="f-maxAgeDays">Max age (days)</label>
                            <input type="number" id="f-maxAgeDays" min="0">
                        </div>
                        <div class="input-group">
                            <label for="f-maxDurationSec">Max duration (sec)</label>
                            <input type="number" id="f-maxDurationSec" min="0">
                        </div>
                        <div class="input-group">
                            <label for="f-resultsPerHashtag">Results per hashtag</label>
                            <input type="number" id="f-resultsPerHashtag" min="1">
                        </div>
                        <div class="input-group">
                            <label for="f-maxResultsPerRun">Max results per run</label>
                            <input type="number" id="f-maxResultsPerRun" min="1">
                        </div>
                        <div class="input-group">
                            <label for="f-retentionDays">Retention (days)</label>
                            <input type="number" id="f-retentionDays" min="1">
                        </div>
                    </div>
                    <button id="scraper-save-config" class="btn btn-primary">Save Config</button>
                </div>

                <div class="terminal-container glass-card">
                    <div class="terminal-header">
                        <span>Scraper Logs</span>
                        <button id="scraper-clear-logs" class="btn btn-ghost btn-sm">Clear</button>
                    </div>
                    <pre id="scraper-terminal" class="terminal"></pre>
                </div>

                <div class="card glass-card accounts-table-container">
                    <h2>Recent Downloads <span class="count-badge" id="download-count">0</span></h2>
                    <table>
                        <thead>
                            <tr><th>Niche</th><th>Creator</th><th>Plays</th><th>Date</th><th>File</th></tr>
                        </thead>
                        <tbody id="downloads-body"></tbody>
                    </table>
                </div>
            </section>
```

- [ ] **Step 3: Update routing in script.js**

Line 20, add `'scraper'`:

```js
const VIEWS = ['dashboard', 'proxies', 'accounts', 'settings', 'scraper'];
```

In `showView`, after the existing two load lines (`script.js:30-31`), add:

```js
    if (name === 'scraper') { loadScraperTokens(); loadScraperConfig(); loadDownloads(); }
```

- [ ] **Step 4: Add scraper section to script.js (before `// ---------- Init ----------`)**

```js
// ---------- Reel Scraper ----------
const scraperTerminal = document.getElementById('scraper-terminal');
const btnScraperRun = document.getElementById('scraper-run');
const tokenList = document.getElementById('token-list');
const nicheList = document.getElementById('niche-list');
const downloadsBody = document.getElementById('downloads-body');

socket.on('scraperStatus', (running) => {
    btnScraperRun.disabled = running;
    btnScraperRun.textContent = running ? '⏳ Running…' : '▶ Run Now';
    if (!running) setTimeout(() => { loadDownloads(); loadScraperTokens(); }, 1500);
});

socket.on('scraperLog', (msg) => {
    scraperTerminal.textContent += msg;
    scraperTerminal.scrollTop = scraperTerminal.scrollHeight;
});

btnScraperRun.addEventListener('click', async () => {
    try {
        scraperTerminal.textContent = '';
        const data = await api('/api/scraper/run', { method: 'POST' });
        if (!data.success) toast(data.error || 'Failed to start scraper', 'error');
    } catch (err) {
        toast(`Failed to start scraper: ${err.message}`, 'error');
    }
});

document.getElementById('scraper-clear-logs').addEventListener('click', () => {
    scraperTerminal.textContent = '';
});

// --- Tokens ---
function renderTokens(tokens) {
    document.getElementById('token-count').textContent = tokens.length;
    tokenList.innerHTML = '';
    tokens.forEach((t, idx) => {
        const li = document.createElement('li');

        const name = document.createElement('span');
        name.textContent = `${t.label} (${t.masked})`;

        const right = document.createElement('span');
        right.className = 'token-actions';

        const badge = document.createElement('span');
        badge.className = `proxy-status ${!t.enabled ? 'pending' : t.exhausted ? 'bad' : 'good'}`;
        badge.textContent = !t.enabled ? 'Disabled' : t.exhausted ? 'Exhausted' : 'Active';

        const mk = (txt, title, fn, disabled = false) => {
            const b = document.createElement('button');
            b.className = 'btn btn-ghost btn-sm';
            b.textContent = txt;
            b.title = title;
            b.disabled = disabled;
            b.addEventListener('click', fn);
            return b;
        };
        right.append(
            badge,
            mk('↑', 'Move up', () => tokenAction('/api/scraper/tokens/move', { label: t.label, direction: 'up' }), idx === 0),
            mk('↓', 'Move down', () => tokenAction('/api/scraper/tokens/move', { label: t.label, direction: 'down' }), idx === tokens.length - 1),
            mk(t.enabled ? '⏸' : '▶', t.enabled ? 'Disable' : 'Enable', () => tokenAction('/api/scraper/tokens/toggle', { label: t.label })),
            mk('✕', 'Delete', () => {
                if (confirm(`Delete token "${t.label}"?`)) tokenAction('/api/scraper/tokens', { label: t.label }, 'DELETE');
            })
        );
        li.append(name, right);
        tokenList.appendChild(li);
    });
}

async function tokenAction(url, body, method = 'POST') {
    try {
        const data = await api(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!data.success) return toast(data.error || 'Token action failed', 'error');
        renderTokens(data.tokens);
    } catch (err) {
        toast(`Token action failed: ${err.message}`, 'error');
    }
}

async function loadScraperTokens() {
    try {
        renderTokens(await api('/api/scraper/tokens'));
    } catch (err) {
        toast(`Failed to load tokens: ${err.message}`, 'error');
    }
}

document.getElementById('token-add').addEventListener('click', async () => {
    const label = document.getElementById('token-label').value.trim();
    const token = document.getElementById('token-value').value.trim();
    if (!label || !token) return toast('Label and token are both required', 'error');
    await tokenAction('/api/scraper/tokens', { label, token });
    document.getElementById('token-label').value = '';
    document.getElementById('token-value').value = '';
});

// --- Config (niches + filters) ---
let scraperCfg = null;

function renderNiches() {
    nicheList.innerHTML = '';
    Object.entries(scraperCfg.niches).forEach(([name, niche]) => {
        const row = document.createElement('div');
        row.className = 'niche-row';
        row.dataset.niche = name;

        const label = document.createElement('span');
        label.className = 'niche-name';
        label.textContent = name;

        const tags = document.createElement('input');
        tags.type = 'text';
        tags.className = 'niche-hashtags';
        tags.value = niche.hashtags.join(', ');
        tags.placeholder = 'hashtags, comma separated';

        const quota = document.createElement('input');
        quota.type = 'number';
        quota.className = 'niche-quota';
        quota.min = '1';
        quota.value = niche.dailyQuota;
        quota.title = 'Daily download quota';

        const del = document.createElement('button');
        del.className = 'btn btn-danger btn-sm';
        del.textContent = '✕';
        del.addEventListener('click', () => {
            delete scraperCfg.niches[name];
            renderNiches();
        });

        row.append(label, tags, quota, del);
        nicheList.appendChild(row);
    });
}

async function loadScraperConfig() {
    try {
        scraperCfg = await api('/api/scraper/config');
        renderNiches();
        document.getElementById('f-minPlays').value = scraperCfg.filters.minPlays;
        document.getElementById('f-maxAgeDays').value = scraperCfg.filters.maxAgeDays;
        document.getElementById('f-maxDurationSec').value = scraperCfg.filters.maxDurationSec;
        document.getElementById('f-resultsPerHashtag').value = scraperCfg.resultsPerHashtag;
        document.getElementById('f-maxResultsPerRun').value = scraperCfg.maxResultsPerRun;
        document.getElementById('f-retentionDays').value = scraperCfg.retentionDays;
    } catch (err) {
        toast(`Failed to load scraper config: ${err.message}`, 'error');
    }
}

document.getElementById('niche-add').addEventListener('click', () => {
    const name = document.getElementById('niche-name').value.trim().toLowerCase();
    if (!name) return;
    if (!/^[a-z0-9_-]+$/.test(name)) return toast('Niche name: letters/numbers/dashes only', 'error');
    if (scraperCfg.niches[name]) return toast('Niche already exists', 'error');
    scraperCfg.niches[name] = { hashtags: [], dailyQuota: 5 };
    document.getElementById('niche-name').value = '';
    renderNiches();
});

document.getElementById('scraper-save-config').addEventListener('click', async () => {
    // Collect niche rows from the DOM
    const niches = {};
    nicheList.querySelectorAll('.niche-row').forEach(row => {
        niches[row.dataset.niche] = {
            hashtags: row.querySelector('.niche-hashtags').value.split(',').map(s => s.trim()).filter(Boolean),
            dailyQuota: parseInt(row.querySelector('.niche-quota').value, 10)
        };
    });
    const body = {
        niches,
        resultsPerHashtag: parseInt(document.getElementById('f-resultsPerHashtag').value, 10),
        maxResultsPerRun: parseInt(document.getElementById('f-maxResultsPerRun').value, 10),
        retentionDays: parseInt(document.getElementById('f-retentionDays').value, 10),
        filters: {
            minPlays: parseInt(document.getElementById('f-minPlays').value, 10),
            maxAgeDays: parseInt(document.getElementById('f-maxAgeDays').value, 10),
            maxDurationSec: parseInt(document.getElementById('f-maxDurationSec').value, 10)
        }
    };
    try {
        const data = await api('/api/scraper/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!data.success) return toast(data.error || 'Invalid config', 'error');
        toast('Scraper config saved', 'success');
        await loadScraperConfig();
    } catch (err) {
        toast(`Failed to save config: ${err.message}`, 'error');
    }
});

// --- Downloads ---
async function loadDownloads() {
    try {
        const items = await api('/api/scraper/downloads');
        document.getElementById('download-count').textContent = items.length;
        downloadsBody.innerHTML = '';
        if (items.length === 0) {
            downloadsBody.innerHTML =
                '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No downloads yet.</td></tr>';
            return;
        }
        items.forEach(it => {
            const tr = document.createElement('tr');
            [it.niche, it.creator, (it.plays || 0).toLocaleString(), it.date, it.file].forEach(v => {
                const td = document.createElement('td');
                td.textContent = v == null ? '-' : v;
                tr.appendChild(td);
            });
            downloadsBody.appendChild(tr);
        });
    } catch (err) {
        downloadsBody.innerHTML =
            '<tr><td colspan="5" style="text-align: center; color: var(--danger);">Failed to load downloads.</td></tr>';
    }
}
```

- [ ] **Step 5: Append CSS to public/style.css**

```css
/* ---------- Reel Scraper ---------- */
.inline-form {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
}

.inline-form input {
    flex: 1;
    min-width: 140px;
}

.token-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.niche-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
}

.niche-name {
    min-width: 90px;
    font-weight: 600;
}

.niche-hashtags {
    flex: 1;
}

.niche-quota {
    width: 70px;
}

.scraper-filters {
    margin-top: 14px;
    margin-bottom: 14px;
}
```

(If `.inline-form input` styling looks off, match the input styling already used by `.input-group input` in `style.css` — inspect and reuse those rules.)

- [ ] **Step 6: Manual browser verification**

Run: `npm start`, open `http://127.0.0.1:3000/#scraper` and verify:
1. "Reel Scraper" appears in the sidebar and the view renders.
2. Add a token `gmail-1` / `apify_api_fake` → appears with Active badge, masked value.
3. Toggle → badge says Disabled. Move ↑/↓ with a second token. Delete works.
4. Niches show dance/fashion/lifestyle defaults; edit hashtags, add niche `fitness`, Save Config → success toast; reload page → persisted.
5. Set Min plays to `-5`, Save → error toast from server validation; restore.
6. Run Now → scraper terminal shows the run output live ending with `[SYSTEM] Scraper finished with code 1` (fake token → expected failure).
7. Other tabs (Dashboard/Proxies/Accounts/Settings) still work; bot logs do NOT appear in the scraper terminal and vice versa.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/script.js public/style.css
git commit -m "feat(scraper): dashboard tab — tokens, niches, run, downloads"
```

---

### Task 11: Real-token E2E, deploy notes, cron

**Files:**
- Modify: `README.md` (append a "Reel Scraper" section)

- [ ] **Step 1: Real end-to-end run (requires user's real Apify token)**

Checklist (with a real token added via the dashboard):
1. In the dashboard, temporarily set Min plays to `1000` and Results per hashtag to `2` (keeps the test cheap: ~6 results ≈ $0.016).
2. Click Run Now. Watch the logs: discovery per niche → candidates → downloads.
3. Verify files exist: `downloads/<niche>/<today>/<creator>_<shortcode>.mp4` plays in a video player, and the `.json` sidecar has plays/creator/pageUrl.
4. **Verify field mapping:** if logs show `0 candidates` for all niches despite results returned, dump one raw item (`console.log(JSON.stringify(items[0]))` temporarily in run.js or check the Apify console dataset view) and fix field names in `select.js normalizeItem` to match reality. This is the one place reality can differ from the plan.
5. Run again immediately → previously downloaded shortcodes are skipped (dedupe works).
6. Restore Min plays / Results per hashtag to real values (10000 / 8).

- [ ] **Step 2: Append deploy notes to README.md**

```markdown
## Reel Scraper

Downloads trending IG reels per niche for motion-control reference. Managed from the
dashboard **Reel Scraper** tab (Apify tokens, niches/hashtags, filters, manual runs).

- Discovery: Apify `instagram-hashtag-scraper` (pay-per-result; free plan = $5/mo credit).
  Multiple free-account tokens rotate automatically when one runs out.
- Output: `downloads/<niche>/<YYYY-MM-DD>/<creator>_<shortcode>.mp4` + `.json` metadata.
- State: `scraper/state/downloaded.json` (dedupe), `scraper/apify_tokens.json` (secrets, gitignored).

### VPS cron (daily at 06:30 server time)

```bash
crontab -e
# add:
30 6 * * * cd /www/wwwroot/figmabot && /usr/bin/node scraper/run.js >> scraper/cron.log 2>&1
```

The same script powers the dashboard Run Now button; a lockfile prevents overlap.
Logs: `scraper/cron.log` (cron) and the dashboard Scraper Logs panel (manual runs).
```

(Adjust the VPS path to the actual app directory used by pm2 — check with `pm2 info figmabot` during deploy.)

- [ ] **Step 3: Final full test run**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: reel scraper usage and VPS cron setup"
```

- [ ] **Step 5: Deploy to VPS** (after user approval)

1. `git push` / pull on VPS (or the deploy flow used for FigmaBot).
2. `pm2 restart figmabot`.
3. Add real tokens via the dashboard Scraper tab at figma.thecristinaadam.com.
4. Install the crontab entry (Step 2) with the correct path and node binary (`which node`).
5. Run once manually on the VPS: `node scraper/run.js` — verify downloads land and disk usage is sane (`du -sh downloads`).
```
