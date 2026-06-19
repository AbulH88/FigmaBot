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
