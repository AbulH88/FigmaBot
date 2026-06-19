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
