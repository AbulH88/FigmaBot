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
