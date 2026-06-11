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
