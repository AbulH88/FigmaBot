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

test('downloadReel cleans up temp file when the stream fails mid-transfer', async () => {
    const base = tmpdir();
    function failingStream() {
        const s = Readable.from((async function* () {
            yield Buffer.from('PARTIAL');
            throw new Error('connection reset');
        })());
        return s;
    }
    const fakeHttp = { get: async () => ({ data: failingStream() }) };
    await assert.rejects(
        downloadReel(ITEM, { niche: 'dance', baseDir: base, http: fakeHttp, now: NOW }),
        /connection reset/
    );
    const dir = path.join(base, 'dance', '2026-06-11');
    assert.deepStrictEqual(fs.readdirSync(dir), []); // no .mp4, no .tmp, no sidecar
});

test('saveReelMeta writes sidecar with pageUrl and no mp4', () => {
    const { saveReelMeta } = require("../download");
    const base = tmpdir();
    const metaPath = saveReelMeta(ITEM, { niche: "dance", baseDir: base, now: NOW });
    assert.strictEqual(metaPath, path.join(base, "dance", "2026-06-11", "dancer.girl_ABC123.json"));
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.strictEqual(meta.pageUrl, "https://www.instagram.com/reel/ABC123/");
    assert.strictEqual(meta.shortcode, "ABC123");
    const dir = path.join(base, "dance", "2026-06-11");
    assert.deepStrictEqual(fs.readdirSync(dir), ["dancer.girl_ABC123.json"]); // no .mp4
});
