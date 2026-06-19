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
