// scraper/discover.js — Apify Instagram actor calls (hashtag + creator discovery).
const axios = require('axios');

const ACTOR_ID = 'apify~instagram-hashtag-scraper';
const REEL_ACTOR_ID = 'apify~instagram-reel-scraper';
const RUN_SYNC_URL = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items`;
const REEL_RUN_SYNC_URL = `https://api.apify.com/v2/acts/${REEL_ACTOR_ID}/run-sync-get-dataset-items`;

class TokenExhaustedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenExhaustedError';
    }
}

// Each returned item costs Apify credit, so callers budget resultsLimit carefully.
async function callActor(url, input, token, http) {
    try {
        const res = await http.post(url, input, {
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

// Hashtag discovery; resultsLimit applies per hashtag.
// resultsType 'reels' — without it the actor defaults to 'posts' and
// returns recent feed images with no videoUrl/play counts.
async function discoverNiche({ hashtags, resultsLimit, token, http = axios }) {
    return callActor(RUN_SYNC_URL, { hashtags, resultsLimit, resultsType: 'reels' }, token, http);
}

// Creator discovery: latest reels from specific accounts (e.g. a curated
// US-creator list); resultsLimit applies per username.
async function discoverCreators({ usernames, resultsLimit, token, http = axios }) {
    return callActor(REEL_RUN_SYNC_URL, {
        username: usernames,
        resultsLimit,
        skipPinnedPosts: true // pinned reels are usually old evergreens, not fresh content
    }, token, http);
}

module.exports = {
    discoverNiche, discoverCreators, TokenExhaustedError,
    ACTOR_ID, REEL_ACTOR_ID, RUN_SYNC_URL, REEL_RUN_SYNC_URL
};
