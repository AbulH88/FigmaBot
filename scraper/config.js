// scraper/config.js — load/validate/save the scraper configuration.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
    niches: {
        dance: { hashtags: ['dancechallenge', 'choreography'], creators: [], dailyQuota: 8 },
        fashion: { hashtags: ['modelpose', 'fashionreels'], creators: [], dailyQuota: 8 },
        lifestyle: { hashtags: ['grwm', 'dayinmylife'], creators: [], dailyQuota: 7 }
    },
    resultsPerHashtag: 8,
    maxResultsPerRun: 70,
    filters: { minPlays: 10000, maxAgeDays: 14, maxDurationSec: 60 },
    retentionDays: 60,
    downloadVideos: true // false = save metadata + reel link only (no MP4 on disk)
};

function isPosInt(n) { return Number.isInteger(n) && n > 0; }

const FILTER_KEYS = ['minPlays', 'maxAgeDays', 'maxDurationSec'];

function validateConfig(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, errors: ['config must be an object'] };
    }
    const errors = [];
    const cfg = {
        niches: {},
        resultsPerHashtag: raw.resultsPerHashtag !== undefined ? raw.resultsPerHashtag : DEFAULTS.resultsPerHashtag,
        maxResultsPerRun: raw.maxResultsPerRun !== undefined ? raw.maxResultsPerRun : DEFAULTS.maxResultsPerRun,
        filters: Object.fromEntries(FILTER_KEYS.map(k => [k,
            raw.filters && raw.filters[k] !== undefined ? raw.filters[k] : DEFAULTS.filters[k]
        ])),
        retentionDays: raw.retentionDays !== undefined ? raw.retentionDays : DEFAULTS.retentionDays,
        downloadVideos: raw.downloadVideos !== undefined ? raw.downloadVideos : DEFAULTS.downloadVideos
    };
    if (typeof cfg.downloadVideos !== 'boolean') errors.push('downloadVideos must be true or false');

    const niches = raw.niches || {};
    if (Object.keys(niches).length === 0) errors.push('at least one niche is required');
    for (const [name, niche] of Object.entries(niches)) {
        if (!/^[a-z0-9_-]+$/i.test(name)) { errors.push(`invalid niche name: ${name}`); continue; }
        if (typeof niche !== 'object' || niche === null) { errors.push(`niche "${name}" must be an object`); continue; }
        const hashtags = (Array.isArray(niche.hashtags) ? niche.hashtags : [])
            .map(h => String(h).trim().replace(/^#/, '').toLowerCase())
            .filter(Boolean);
        // Creators (IG usernames) take priority over hashtags during discovery —
        // used to pin a niche to a curated list of (e.g. US-based) accounts.
        const creators = (Array.isArray(niche.creators) ? niche.creators : [])
            .map(c => String(c).trim().replace(/^@/, '').toLowerCase())
            .filter(c => /^[a-z0-9._]+$/.test(c));
        if (hashtags.length === 0 && creators.length === 0) {
            errors.push(`niche "${name}" needs at least one hashtag or creator`);
        }
        if (!isPosInt(niche.dailyQuota)) errors.push(`niche "${name}" needs a positive integer dailyQuota`);
        cfg.niches[name] = { hashtags, creators, dailyQuota: niche.dailyQuota };
    }
    for (const key of ['resultsPerHashtag', 'maxResultsPerRun', 'retentionDays']) {
        if (!isPosInt(cfg[key])) errors.push(`${key} must be a positive integer`);
    }
    for (const key of FILTER_KEYS) {
        if (!Number.isInteger(cfg.filters[key]) || cfg.filters[key] < 0) {
            errors.push(`filters.${key} must be a non-negative integer`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, config: cfg };
}

function loadConfig(file = CONFIG_PATH) {
    if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(DEFAULTS));
    const result = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!result.ok) throw new Error('Invalid scraper config: ' + result.errors.join('; '));
    return result.config;
}

function saveConfig(cfg, file = CONFIG_PATH) {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { CONFIG_PATH, DEFAULTS, validateConfig, loadConfig, saveConfig };
