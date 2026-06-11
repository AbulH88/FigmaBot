// scraper/select.js — pure selection logic: normalize Apify items, dedupe, filter, rank.

// Field names vary slightly across Apify actor versions, so map defensively.
function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const videoUrl = raw.videoUrl || raw.video_url || null;
    if (!videoUrl) return null;
    const fromUrl = typeof raw.url === 'string' ? (raw.url.match(/\/(?:reel|p)\/([^/?]+)/) || [])[1] : null;
    const shortcode = raw.shortCode || raw.shortcode || fromUrl || null;
    if (!shortcode) return null;

    const plays = [raw.videoPlayCount, raw.playsCount, raw.videoViewCount]
        .find(v => typeof v === 'number');

    return {
        shortcode,
        videoUrl,
        pageUrl: raw.url || `https://www.instagram.com/reel/${shortcode}/`,
        plays: plays !== undefined ? plays : 0,
        likes: typeof raw.likesCount === 'number' ? raw.likesCount : 0,
        creator: raw.ownerUsername || 'unknown',
        durationSec: typeof raw.videoDuration === 'number' ? raw.videoDuration : null,
        timestamp: raw.timestamp || null,
        caption: raw.caption || ''
    };
}

function selectReels({ candidatesByNiche, downloadedSet, filters, niches, now = new Date() }) {
    const seen = new Set(downloadedSet); // copy: also dedupes across niches within this run
    const maxAgeMs = filters.maxAgeDays * 24 * 60 * 60 * 1000;
    const byNiche = {};

    for (const [niche, rawItems] of Object.entries(candidatesByNiche)) {
        const quota = niches[niche] ? niches[niche].dailyQuota : 0;
        const items = [];
        for (const raw of rawItems || []) {
            const item = normalizeItem(raw);
            if (!item) continue;
            if (seen.has(item.shortcode)) continue;
            if (item.plays < filters.minPlays) continue;
            if (item.timestamp) {
                const age = now - new Date(item.timestamp);
                // Unparseable timestamps give NaN age — keep the item rather than
                // dropping it over bad metadata.
                if (Number.isFinite(age) && age > maxAgeMs) continue;
            }
            if (item.durationSec !== null && item.durationSec > filters.maxDurationSec) continue;
            seen.add(item.shortcode);
            items.push(item);
        }
        items.sort((a, b) => b.plays - a.plays);
        byNiche[niche] = items.slice(0, quota);
    }
    return byNiche;
}

module.exports = { normalizeItem, selectReels };
