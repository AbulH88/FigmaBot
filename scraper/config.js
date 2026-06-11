// scraper/config.js — load/validate/save the scraper configuration.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
    niches: {
        dance: { hashtags: ['dancechallenge', 'choreography'], dailyQuota: 8 },
        fashion: { hashtags: ['modelpose', 'fashionreels'], dailyQuota: 8 },
        lifestyle: { hashtags: ['grwm', 'dayinmylife'], dailyQuota: 7 }
    },
    resultsPerHashtag: 8,
    maxResultsPerRun: 70,
    filters: { minPlays: 10000, maxAgeDays: 14, maxDurationSec: 60 },
    retentionDays: 60
};

function isPosInt(n) { return Number.isInteger(n) && n > 0; }

function validateConfig(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, errors: ['config must be an object'] };
    }
    const errors = [];
    const cfg = {
        niches: {},
        resultsPerHashtag: raw.resultsPerHashtag !== undefined ? raw.resultsPerHashtag : DEFAULTS.resultsPerHashtag,
        maxResultsPerRun: raw.maxResultsPerRun !== undefined ? raw.maxResultsPerRun : DEFAULTS.maxResultsPerRun,
        filters: Object.assign({}, DEFAULTS.filters, raw.filters || {}),
        retentionDays: raw.retentionDays !== undefined ? raw.retentionDays : DEFAULTS.retentionDays
    };

    const niches = raw.niches || {};
    if (Object.keys(niches).length === 0) errors.push('at least one niche is required');
    for (const [name, niche] of Object.entries(niches)) {
        if (!/^[a-z0-9_-]+$/i.test(name)) { errors.push(`invalid niche name: ${name}`); continue; }
        const hashtags = ((niche && niche.hashtags) || [])
            .map(h => String(h).trim().replace(/^#/, '').toLowerCase())
            .filter(Boolean);
        if (hashtags.length === 0) errors.push(`niche "${name}" needs at least one hashtag`);
        if (!isPosInt(niche && niche.dailyQuota)) errors.push(`niche "${name}" needs a positive integer dailyQuota`);
        cfg.niches[name] = { hashtags, dailyQuota: niche.dailyQuota };
    }
    for (const key of ['resultsPerHashtag', 'maxResultsPerRun', 'retentionDays']) {
        if (!isPosInt(cfg[key])) errors.push(`${key} must be a positive integer`);
    }
    for (const key of ['minPlays', 'maxAgeDays', 'maxDurationSec']) {
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
