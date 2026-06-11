# Instagram Reel Scraper — Design Spec

**Date:** 2026-06-11
**Status:** Approved
**Purpose:** Automatically discover trending Instagram reels in configured niches and download them as MP4s for use as motion-control reference footage for an AI influencer model.

## Goals

- Daily, unattended discovery of "trending" reels across four niche groups: dance/choreography, model poses/fashion, lifestyle/talking-head, and user-defined custom niches.
- Download 10–30 MP4s per day into organized folders on the VPS.
- Run at $0/month by staying inside Apify free-plan credits, rotating across multiple free accounts.
- Manage everything (API tokens, niches, manual runs) from a new tab in the existing FigmaBot dashboard.

## Non-Goals

- No Instagram login, no burner IG accounts, no browser automation for IG.
- No video pre-processing (cropping, pose extraction) — raw MP4s only.
- No yt-dlp dependency (may be added later as a download fallback if direct URLs prove unreliable).
- No alerting/notifications on failure — log and retry next scheduled run.
- Downloaded clips are motion reference only; the tool does not publish or redistribute content.

## Discovery: what "trending" means here

Instagram exposes no public trending feed. The practical proxy: for each niche's hashtags, fetch Instagram's own **"top posts"** ranking via the **Apify Instagram Hashtag Scraper** actor (`apify/instagram-hashtag-scraper`), filtered to recent reels. Each result includes metadata (play count, likes, creator, duration, hashtags) and a **direct video URL**.

### Cost model (drives the design)

- Apify free plan: $5 usage credit per account per month.
- Hashtag Scraper actor: pay-per-result, ~$2.60 per 1,000 results on the free plan, no rental fee.
- Cost is incurred on **discovery results fetched**, not downloads (video URLs are fetched directly by us at no Apify cost).
- Budget: ~60 candidate results/day ≈ 1,900/month ≈ $5 — one free account's full credit. Multiple accounts extend this.
- There is no Apify pay-as-you-go tier between free ($5) and Starter ($29/mo); the design therefore enforces a **hard per-run result cap** to stay within free credits.

## Multi-token rotation

- Tokens stored in `scraper/apify_tokens.json`: ordered array of `{ label, token, enabled, exhaustedMonth }`.
- A run uses the first enabled, non-exhausted token. On an Apify insufficient-credit / usage-limit error, the token is marked exhausted for the current calendar month (`exhaustedMonth: "2026-06"`) and the run continues with the next token.
- `exhaustedMonth` older than the current month is treated as available again (credits reset monthly).
- 3–4 free accounts ≈ $15–20 effective monthly credit.

## Architecture

New `scraper/` directory inside the FigmaBot repo. Small single-purpose CommonJS modules matching existing project style:

| Module | Responsibility |
|---|---|
| `scraper/config.js` | Load/validate `scraper/config.json` (niches, hashtags, quotas, filters, caps, retention). |
| `scraper/tokens.js` | Token store CRUD + rotation/exhaustion logic. |
| `scraper/discover.js` | Call the Apify actor per niche hashtag set; return candidate reels with metadata. Enforces the per-run result cap. |
| `scraper/select.js` | Dedupe against state, filter (min plays, max age, max duration, must-be-video), rank by play count, take top N per niche. |
| `scraper/download.js` | Stream MP4 to disk, write metadata sidecar, record shortcode in state, apply retention sweep. |
| `scraper/run.js` | Orchestrator + CLI entry point. Logs to stdout (captured by dashboard/pm2/cron). |

### Data layout

```
scraper/
  config.json            # niches, hashtags, quotas, filters, caps, retention days
  apify_tokens.json      # token list (gitignored)
  state/downloaded.json  # shortcodes already downloaded (dedupe)
downloads/
  <niche>/<YYYY-MM-DD>/<creator>_<shortcode>.mp4
  <niche>/<YYYY-MM-DD>/<creator>_<shortcode>.json   # metadata sidecar
```

`apify_tokens.json`, `state/`, and `downloads/` are gitignored.

### config.json shape (defaults)

```json
{
  "niches": {
    "dance":     { "hashtags": ["dancechallenge", "choreography"], "dailyQuota": 8 },
    "fashion":   { "hashtags": ["modelpose", "fashionreels"],      "dailyQuota": 8 },
    "lifestyle": { "hashtags": ["grwm", "dayinmylife"],            "dailyQuota": 7 }
  },
  "resultsPerHashtag": 8,
  "maxResultsPerRun": 70,
  "filters": { "minPlays": 10000, "maxAgeDays": 14, "maxDurationSec": 60 },
  "retentionDays": 60
}
```

## Dashboard integration

New hash-routed `#scraper` view in the existing FigmaBot dashboard (vanilla JS, same patterns as `#proxies`/`#settings`):

- **Tokens panel**: add/remove/reorder/enable tokens; per-token status badge (active / exhausted this month). Token values masked in the UI after entry.
- **Niches panel**: edit hashtag lists, daily quotas, and filters; saves `config.json`.
- **Run panel**: "Run now" button, live log stream, recent downloads list.

### API endpoints (same auth middleware as the rest of the dashboard)

- `GET/POST/DELETE /api/scraper/tokens` — manage token list (GET returns masked tokens).
- `GET/POST /api/scraper/config` — read/write scraper config.
- `POST /api/scraper/run` — spawn `node scraper/run.js` as a child process (refuse if already running); stream stdout/stderr to socket.io `log`.
- `GET /api/scraper/status` — `{ running, lastRun, lastResult }`.
- `GET /api/scraper/downloads` — recent downloads (walk `downloads/`, newest first, capped).

## Scheduling & runtime

- VPS cron entry runs `node scraper/run.js` daily (offset from peak hours). Manual runs via dashboard spawn the same script — single code path.
- A lockfile (`scraper/state/run.lock`, stale after 1h) prevents overlapping cron + manual runs.
- Errors: log and exit non-zero; no retries within a run beyond per-download retry (2 attempts). Next scheduled run is the retry.

## Error handling

- **Token exhausted:** mark + rotate; if all tokens exhausted, log clearly and exit (dashboard shows badges).
- **Actor failure / malformed results:** skip that hashtag, continue others.
- **Download failure (expired URL, network):** retry once, then skip and leave shortcode unrecorded so a future run can retry it.
- **Disk:** retention sweep deletes files older than `retentionDays` at the start of each run.

## Testing

- Unit tests for the pure logic: token rotation/exhaustion-month handling, select/dedupe/filter/rank, config validation.
- `discover.js` tested against recorded fixture responses (no live Apify calls in tests).
- Manual end-to-end verification with one real token before deploying the cron entry.

## Deployment

- Lives in the FigmaBot repo; deployed with it to the existing VPS (figma.thecristinaadam.com, pm2).
- User supplies 3–4 Apify free-account tokens via the dashboard after deploy.
