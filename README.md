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
