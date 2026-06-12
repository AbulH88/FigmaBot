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
