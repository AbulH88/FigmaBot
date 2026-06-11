// scraper/run.js — orchestrator. Invoked daily by cron and by the dashboard "Run now".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { loadConfig } = require('./config');
const tokensLib = require('./tokens');
const { discoverNiche, TokenExhaustedError } = require('./discover');
const { selectReels } = require('./select');
const { downloadReel, sweepRetention, DOWNLOADS_DIR } = require('./download');
const state = require('./state');

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    if (!state.acquireLock()) {
        log('Another scraper run is in progress (lock held) — exiting.');
        process.exitCode = 2;
        return;
    }
    try {
        const config = loadConfig();
        const tokens = tokensLib.loadTokens();
        const month = tokensLib.currentMonth();
        const downloaded = state.loadDownloaded();

        const removed = sweepRetention(DOWNLOADS_DIR, config.retentionDays);
        if (removed.length) log(`Retention sweep removed: ${removed.join(', ')}`);

        if (tokens.length === 0) {
            throw new Error('No Apify tokens configured — add one in the dashboard Scraper tab.');
        }

        // --- Discovery (the only part that consumes Apify credit) ---
        let resultsFetched = 0;
        const candidatesByNiche = {};
        for (const [niche, def] of Object.entries(config.niches)) {
            if (resultsFetched >= config.maxResultsPerRun) {
                log(`Result cap (${config.maxResultsPerRun}) reached — skipping niche "${niche}".`);
                continue;
            }
            const budget = config.maxResultsPerRun - resultsFetched;
            const perHashtag = Math.max(1, Math.min(
                config.resultsPerHashtag,
                Math.floor(budget / def.hashtags.length)
            ));

            let items = null;
            // Retry the same niche with the next token when one is exhausted.
            while (items === null) {
                const tok = tokensLib.pickToken(tokens, month);
                if (!tok) {
                    log('All Apify tokens are exhausted for this month — add another or wait for reset.');
                    break;
                }
                try {
                    log(`Niche "${niche}": ${perHashtag}/hashtag for [${def.hashtags.join(', ')}] via token "${tok.label}"...`);
                    items = await discoverNiche({ hashtags: def.hashtags, resultsLimit: perHashtag, token: tok.token });
                } catch (err) {
                    if (err instanceof TokenExhaustedError) {
                        log(`Token "${tok.label}" exhausted — rotating. (${err.message})`);
                        tokensLib.markExhausted(tokens, tok.label, month);
                        tokensLib.saveTokens(tokens);
                    } else {
                        log(`Niche "${niche}" discovery failed: ${err.message} — skipping this niche.`);
                        break;
                    }
                }
            }
            if (!items) continue;
            log(`Niche "${niche}": ${items.length} candidates.`);
            resultsFetched += items.length;
            candidatesByNiche[niche] = items;
        }

        // --- Selection ---
        const picked = selectReels({
            candidatesByNiche,
            downloadedSet: downloaded,
            filters: config.filters,
            niches: config.niches
        });

        // --- Download (free: direct CDN fetch, no Apify involvement) ---
        let ok = 0, failed = 0;
        for (const [niche, items] of Object.entries(picked)) {
            for (const item of items) {
                let done = false;
                for (let attempt = 1; attempt <= 2 && !done; attempt++) {
                    try {
                        const file = await downloadReel(item, { niche });
                        // Persist immediately so a crash mid-run doesn't redownload
                        downloaded.add(item.shortcode);
                        state.saveDownloaded(downloaded);
                        log(`Downloaded [${niche}] ${item.creator}/${item.shortcode} (${item.plays} plays) -> ${file}`);
                        done = true;
                        ok++;
                    } catch (err) {
                        log(`Download failed (attempt ${attempt}/2) ${item.shortcode}: ${err.message}`);
                    }
                }
                if (!done) failed++; // shortcode NOT recorded -> future run can retry it
            }
        }

        log(`Run complete: ${ok} downloaded, ${failed} failed, ${resultsFetched} discovery results consumed.`);
        if (ok === 0 && failed > 0) process.exitCode = 1;
    } catch (err) {
        log(`FATAL: ${err.message}`);
        process.exitCode = 1;
    } finally {
        state.releaseLock();
    }
}

main();
