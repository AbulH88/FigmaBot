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

test('validateConfig handles null niche and non-array hashtags without throwing', () => {
    const r1 = validateConfig({ niches: { dance: null } });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.errors.join(' '), /must be an object/);

    const r2 = validateConfig({ niches: { dance: { hashtags: 'dance', dailyQuota: 3 } } });
    assert.strictEqual(r2.ok, false);
    assert.match(r2.errors.join(' '), /at least one hashtag/);
});

test('validateConfig drops unknown filter keys', () => {
    const r = validateConfig({ niches: { dance: { hashtags: ['x'], dailyQuota: 3 } }, filters: { minPlays: 5, bogus: 'nope' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.filters.minPlays, 5);
    assert.strictEqual('bogus' in r.config.filters, false);
    assert.strictEqual(r.config.filters.maxAgeDays, 14);
});

test('validateConfig accepts creators-only niche and normalizes @handles', () => {
    const r = validateConfig({ niches: { usa: { creators: ['@Dancer.One', ' modelTwo ', 'bad handle!'], dailyQuota: 5 } } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.config.niches.usa.creators, ['dancer.one', 'modeltwo']);
    assert.deepStrictEqual(r.config.niches.usa.hashtags, []);
});

test('validateConfig rejects niche with neither hashtags nor creators', () => {
    const r = validateConfig({ niches: { empty: { hashtags: [], creators: [], dailyQuota: 5 } } });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors.join(' '), /at least one hashtag or creator/);
});

test('downloadVideos defaults to true, accepts false, rejects non-boolean', () => {
    const def = validateConfig({ niches: { dance: { hashtags: ["x"], dailyQuota: 3 } } });
    assert.strictEqual(def.config.downloadVideos, true);

    const off = validateConfig({ niches: { dance: { hashtags: ["x"], dailyQuota: 3 } }, downloadVideos: false });
    assert.strictEqual(off.ok, true);
    assert.strictEqual(off.config.downloadVideos, false);

    const bad = validateConfig({ niches: { dance: { hashtags: ["x"], dailyQuota: 3 } }, downloadVideos: "yes" });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.errors.join(" "), /downloadVideos/);
});
