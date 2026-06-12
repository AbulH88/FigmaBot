// scraper/discover.js — Apify Instagram Hashtag Scraper calls.
const axios = require('axios');

const ACTOR_ID = 'apify~instagram-hashtag-scraper';
const RUN_SYNC_URL = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;

class TokenExhaustedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenExhaustedError';
    }
}

// One synchronous actor run per niche; resultsLimit applies per hashtag.
// Each returned item costs Apify credit, so callers budget resultsLimit carefully.
async function discoverNiche({ hashtags, resultsLimit, token, http = axios }) {
    try {
        // resultsType 'reels' — without it the actor defaults to 'posts' and
        // returns recent feed images with no videoUrl/play counts.
        const res = await http.post(RUN_SYNC_URL, { hashtags, resultsLimit, resultsType: 'reels' }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 300000 // run-sync endpoint can take minutes for cold actor starts
        });
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        const status = err.response ? err.response.status : null;
        const msg = err.response && err.response.data && err.response.data.error
            ? String(err.response.data.error.message || '')
            : '';
        if (status === 402 || (status === 403 && /limit|credit|usage/i.test(msg))) {
            throw new TokenExhaustedError(`Apify token exhausted (HTTP ${status}): ${msg}`);
        }
        throw err;
    }
}

module.exports = { discoverNiche, TokenExhaustedError, ACTOR_ID, RUN_SYNC_URL };
