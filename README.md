# FigmaBot

Web dashboard + Playwright bot for automated account creation. The Express
server (`server.js`) serves the control panel and spawns `bot.js` runs;
live logs stream over socket.io.

## Local setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in your credentials
npm start              # dashboard at http://localhost:3000
```

## VPS deployment (Ubuntu/Debian)

### 1. Install Node.js 20+ and clone

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
git clone https://github.com/AbulH88/FigmaBot.git
cd FigmaBot
npm install
```

### 2. Install Playwright's browser + system dependencies

```bash
npx playwright install --with-deps chromium
```

(`--with-deps` pulls in the system libraries headless Chromium needs.)

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Required: `DA_URL`, `DA_USERNAME`, `DA_PASSWORD`, `EMAIL_DOMAIN`,
`IMAP_HOST`, `IMAP_PORT`.

**For remote access, set both of these** — the server only listens on
127.0.0.1 until you do:

```
HOST=0.0.0.0
DASHBOARD_PASSWORD=a_strong_password
```

### 4. Run under pm2 (survives reboots and crashes)

```bash
sudo npm install -g pm2
pm2 start server.js --name figmabot
pm2 save
pm2 startup   # then run the command it prints
```

Useful: `pm2 logs figmabot`, `pm2 restart figmabot`, `pm2 stop figmabot`.

### 5. Open the firewall (if using ufw)

```bash
sudo ufw allow 3000/tcp
```

Then browse to `http://YOUR_VPS_IP:3000` — any username, your
`DASHBOARD_PASSWORD` as the password.

### Recommended: HTTPS via reverse proxy

Basic Auth sends the password base64-encoded on every request, so over
plain HTTP it is readable by anyone on the path. If the dashboard is
internet-facing, put nginx + Let's Encrypt in front:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

```nginx
# /etc/nginx/sites-available/figmabot
server {
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # websocket (live logs)
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/figmabot /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain.com
sudo systemctl reload nginx
```

With nginx in front, keep `HOST=127.0.0.1` in `.env` and don't open
port 3000 in the firewall — only nginx (443) is exposed.

## Environment variables

| Variable | Purpose |
|---|---|
| `DA_URL` / `DA_USERNAME` / `DA_PASSWORD` | DirectAdmin API for creating mailboxes |
| `EMAIL_DOMAIN` | Domain the mailboxes are created on |
| `IMAP_HOST` / `IMAP_PORT` | IMAP server for reading verification emails |
| `ACCOUNTS_TO_CREATE` | Accounts per bot run (also settable from the dashboard) |
| `DASHBOARD_PASSWORD` | Optional: require login for the dashboard |
| `HOST` | Bind address; default `127.0.0.1` (localhost only) |
| `PORT` | Dashboard port; default `3000` |

## Reel Scraper

Downloads trending IG reels per niche for motion-control reference. Managed from the
dashboard **Reel Scraper** tab (Apify tokens, niches/hashtags, filters, manual runs).

- Discovery: Apify `instagram-hashtag-scraper` (pay-per-result; free plan = $5/mo credit).
  Multiple free-account tokens rotate automatically when one runs out.
- Output: `downloads/<niche>/<YYYY-MM-DD>/<creator>_<shortcode>.mp4` + `.json` metadata.
- State: `scraper/state/downloaded.json` (dedupe), `scraper/apify_tokens.json` (secrets, gitignored).
- Cost cap: `maxResultsPerRun` in `scraper/config.json` keeps discovery inside the free
  credit (~48 results/day by default, roughly $3.75/month per token).

### VPS cron (daily at 06:30 server time)

```bash
crontab -e
# add (adjust the path to the app directory used by pm2 — check `pm2 info figmabot`):
30 6 * * * cd /www/wwwroot/figmabot && /usr/bin/node scraper/run.js >> scraper/cron.log 2>&1
```

The same script powers the dashboard Run Now button; a lockfile prevents overlap.
Logs: `scraper/cron.log` (cron) and the dashboard Scraper Logs panel (manual runs).
