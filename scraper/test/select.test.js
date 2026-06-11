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
