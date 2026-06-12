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
