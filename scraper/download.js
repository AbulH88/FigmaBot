// scraper/download.js — MP4 streaming to disk, metadata sidecars, retention sweep.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');

const DOWNLOADS_DIR = require('../paths').downloadsDir;

function sanitize(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'unknown';
}

function datestamp(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function targetDir(item, niche, baseDir, now) {
    const dir = path.join(baseDir, sanitize(niche), datestamp(now));
    fs.mkdirSync(dir, { recursive: true });
    return { dir, base: `${sanitize(item.creator)}_${sanitize(item.shortcode)}` };
}

function buildSidecar(item, niche, now) {
    return {
        shortcode: item.shortcode,
        creator: item.creator,
        plays: item.plays,
        likes: item.likes,
        durationSec: item.durationSec,
        timestamp: item.timestamp,
        pageUrl: item.pageUrl,
        // Direct CDN URL — note: Instagram signs these, they expire within days.
        // pageUrl is the permanent reference for manual downloads.
        videoUrl: item.videoUrl,
        caption: item.caption,
        niche,
        downloadedAt: now.toISOString()
    };
}

async function downloadReel(item, { niche, baseDir = DOWNLOADS_DIR, http = axios, now = new Date() }) {
    const { dir, base } = targetDir(item, niche, baseDir, now);
    const filePath = path.join(dir, `${base}.mp4`);
    const tmpPath = filePath + '.tmp';

    const res = await http.get(item.videoUrl, { responseType: 'stream', timeout: 120000 });
    try {
        await pipeline(res.data, fs.createWriteStream(tmpPath));
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (e) { /* already gone */ }
        throw err;
    }

    fs.writeFileSync(path.join(dir, `${base}.json`),
        JSON.stringify(buildSidecar(item, niche, now), null, 2) + '\n');
    return filePath;
}

// Links-only mode: write just the metadata sidecar (with pageUrl for manual
// download later) — no video file, no disk weight.
function saveReelMeta(item, { niche, baseDir = DOWNLOADS_DIR, now = new Date() }) {
    const { dir, base } = targetDir(item, niche, baseDir, now);
    const metaPath = path.join(dir, `${base}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(buildSidecar(item, niche, now), null, 2) + '\n');
    return metaPath;
}

// Deletes downloads/<niche>/<YYYY-MM-DD>/ older than retentionDays; prunes emptied niche dirs.
function sweepRetention(baseDir = DOWNLOADS_DIR, retentionDays, now = new Date()) {
    if (!fs.existsSync(baseDir)) return [];
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const niche of fs.readdirSync(baseDir)) {
        const nicheDir = path.join(baseDir, niche);
        if (!fs.statSync(nicheDir).isDirectory()) continue;
        for (const dateName of fs.readdirSync(nicheDir)) {
            const m = dateName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) continue;
            if (Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff) {
                fs.rmSync(path.join(nicheDir, dateName), { recursive: true, force: true });
                removed.push(`${niche}/${dateName}`);
            }
        }
        if (fs.readdirSync(nicheDir).length === 0) fs.rmdirSync(nicheDir);
    }
    return removed;
}

module.exports = { DOWNLOADS_DIR, downloadReel, saveReelMeta, sweepRetention, sanitize, datestamp };
