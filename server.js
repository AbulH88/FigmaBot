require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { parseProxyUrl, validateProxy } = require('./proxyCheck');
const multer = require('multer');
const scraperTokens = require('./scraper/tokens');
const scraperConfig = require('./scraper/config');

const app = express();
const server = http.createServer(app);

// --- Auth (opt-in): set DASHBOARD_PASSWORD in .env to require a login ---
const DASHBOARD_PASSWORD = (process.env.DASHBOARD_PASSWORD || '').trim();

function checkAuth(authHeader) {
    if (!DASHBOARD_PASSWORD) return true;
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const given = Buffer.from(pass);
    const expected = Buffer.from(DASHBOARD_PASSWORD);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// allowRequest gates the socket.io handshake itself — socket.io attaches to
// the HTTP server ahead of Express, so Express middleware can't cover it
const io = new Server(server, {
    allowRequest: (req, callback) => callback(null, checkAuth(req.headers.authorization))
});

app.use(express.json());

app.use((req, res, next) => {
    if (checkAuth(req.headers.authorization)) return next();
    res.set('WWW-Authenticate', 'Basic realm="FigmaBot"');
    res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'public')));

let botProcess = null;

// Endpoints for Settings
app.get('/api/settings', (req, res) => {
    const envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
    const settings = {};
    envContent.split('\n').forEach(line => {
        if (line.includes('=')) {
            const [key, ...val] = line.split('=');
            settings[key.trim()] = val.join('=').trim();
        }
    });
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const settings = req.body;
    let envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';

    for (const [key, value] of Object.entries(settings)) {
        const cleanKey = String(key).trim();
        // Only allow valid env var names — blocks injection via crafted keys
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) continue;
        // Strip newlines so a value can't inject extra env entries
        const cleanValue = String(value).replace(/[\r\n]+/g, ' ').trim();

        const regex = new RegExp(`^${cleanKey}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${cleanKey}=${cleanValue}`);
        } else {
            envContent += `\n${cleanKey}=${cleanValue}`;
        }
    }
    fs.writeFileSync('.env', envContent.trim() + '\n');
    require('dotenv').config({ override: true }); // Reload env (override needed to refresh already-loaded values)
    res.json({ success: true });
});

// Endpoints for Proxies
app.get('/api/proxies', (req, res) => {
    const proxies = fs.existsSync('proxies.txt') ? fs.readFileSync('proxies.txt', 'utf8').split('\n').filter(p => p.trim()) : [];
    res.json(proxies);
});

const upload = multer();
app.post('/api/proxies', upload.single('proxyFile'), (req, res) => {
    let newProxies = [];
    if (req.file) {
        newProxies = req.file.buffer.toString().split('\n').map(p => p.trim()).filter(p => p);
    } else if (req.body.proxies) {
        newProxies = req.body.proxies.split('\n').map(p => p.trim()).filter(p => p);
    }
    fs.writeFileSync('proxies.txt', newProxies.join('\n'));
    res.json({ success: true, count: newProxies.length });
});

app.delete('/api/proxies', (req, res) => {
    fs.writeFileSync('proxies.txt', '');
    res.json({ success: true });
});

app.post('/api/check-proxy', async (req, res) => {
    const proxyUrl = parseProxyUrl(req.body && req.body.proxy);
    if (!proxyUrl) return res.json({ success: false, error: 'Invalid proxy format' });

    // Make a real request through the proxy and require a genuine exit IP.
    // A locked/denied proxy (4xx/5xx) fails here instead of reporting "working".
    const result = await validateProxy(proxyUrl);
    if (result.ok) {
        const loc = [result.city, result.region, result.country].filter(Boolean).join(', ');
        return res.json({ success: true, ip: result.ip, location: loc });
    }
    return res.json({ success: false, error: result.error });
});

// Endpoints for Bot Control

// Spawn bot.js and wire its output to the dashboard. detached on POSIX puts
// the bot in its own process group so stop can kill the whole tree.
function spawnBot() {
    botProcess = spawn('node', ['bot.js'], { detached: process.platform !== 'win32' });
    botProcess.stdout.on('data', (data) => io.emit('log', data.toString()));
    botProcess.stderr.on('data', (data) => io.emit('log', `[ERROR] ${data.toString()}`));
    botProcess.on('close', (code) => {
        io.emit('log', `\n[SYSTEM] Bot stopped with code ${code}\n`);
        botProcess = null;
        io.emit('botStatus', false);
    });
    io.emit('botStatus', true);
}

app.post('/api/bot/start', async (req, res) => {
    if (botProcess) {
        return res.json({ success: false, error: 'Bot is already running.' });
    }

    // Local mode: user routes traffic through their own router/VPN, so skip the
    // proxy list and pre-flight entirely and run on the server's connection.
    if ((process.env.PROXY_MODE || 'list').toLowerCase() === 'local') {
        io.emit('log', "[*] Local connection mode — skipping proxy validation; bot runs on this server's IP (your router/VPN must provide a safe exit).\n");
        spawnBot();
        return res.json({ success: true });
    }

    // --- Pre-flight: validate proxies before the bot creates anything ----
    // The bot must never run on the machine's real IP, so refuse to start
    // unless at least one proxy actually works. Keep only the good ones.
    let proxies = [];
    if (fs.existsSync('proxies.txt')) {
        proxies = fs.readFileSync('proxies.txt', 'utf8').split('\n').map(p => p.trim()).filter(Boolean);
    }
    if (proxies.length === 0) {
        return res.json({ success: false, error: 'No proxies loaded — add at least one working proxy before starting.' });
    }

    io.emit('log', `[*] Pre-flight: validating ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'} before starting...\n`);
    const results = new Array(proxies.length);
    let next = 0;
    async function worker() {
        while (next < proxies.length) {
            const idx = next++;
            const line = proxies[idx];
            const url = parseProxyUrl(line);
            const r = url ? await validateProxy(url) : { ok: false, error: 'unparseable line' };
            results[idx] = { line, ok: r.ok };
            const tag = line.split('@').pop();
            io.emit('log', r.ok
                ? `[*]   OK  ${r.ip} ${[r.city, r.country].filter(Boolean).join(', ')}  (${tag})\n`
                : `[*]   BAD ${r.error}  (${tag})\n`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(5, proxies.length) }, worker));

    const good = results.filter(r => r.ok);
    if (good.length === 0) {
        const msg = 'All proxies failed validation — bot not started. Fix your proxies and try again.';
        io.emit('log', `[ERROR] ${msg}\n`);
        return res.json({ success: false, error: msg });
    }

    // Persist only the validated proxies so the bot runs on known-good IPs.
    fs.writeFileSync('proxies.txt', good.map(r => r.line).join('\n') + '\n');
    const want = parseInt(process.env.ACCOUNTS_TO_CREATE) || 1;
    if (good.length < want) {
        io.emit('log', `[!] Only ${good.length} working prox${good.length === 1 ? 'y' : 'ies'} for ${want} accounts — IPs will be reused (higher flag risk).\n`);
    }
    io.emit('log', `[+] ${good.length}/${proxies.length} proxies OK — starting bot.\n`);

    spawnBot();
    res.json({ success: true });
});

app.post('/api/bot/stop', (req, res) => {
    if (botProcess) {
        // Kill the whole process tree — botProcess.kill() alone leaves
        // Playwright's Chromium processes orphaned
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(botProcess.pid), '/T', '/F']);
        } else {
            try { process.kill(-botProcess.pid, 'SIGTERM'); }
            catch (e) { botProcess.kill('SIGTERM'); }
        }
        botProcess = null;
        io.emit('botStatus', false);
        return res.json({ success: true });
    }
    res.json({ success: false, error: 'Bot is not running.' });
});

app.get('/api/bot/status', (req, res) => {
    res.json({ running: !!botProcess });
});

// Endpoints for Accounts

// RFC 4180-style CSV line parser: handles quoted fields containing commas and escaped quotes
function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = false;
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            values.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}

app.get('/api/accounts', (req, res) => {
    if (!fs.existsSync('accounts.csv')) {
        return res.json([]);
    }
    const content = fs.readFileSync('accounts.csv', 'utf8').trim();
    if (!content) return res.json([]);

    const lines = content.split(/\r?\n/);
    const headers = parseCsvLine(lines[0]).map(h => h.trim());
    const results = lines.slice(1).filter(l => l.trim()).map(line => {
        const values = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] ? values[i].trim() : ''; });
        return obj;
    });
    res.json(results);
});

app.delete('/api/accounts', (req, res) => {
    const { email } = req.body;
    if (!fs.existsSync('accounts.csv')) return res.json({ success: false });

    let lines = fs.readFileSync('accounts.csv', 'utf8').trim().split(/\r?\n/);
    const newLines = lines.filter((line, idx) => {
        if (idx === 0) return true; // keep header
        return parseCsvLine(line)[0] !== email;
    });

    fs.writeFileSync('accounts.csv', newLines.join('\n') + '\n');
    res.json({ success: true });
});

// ---------------- Reel Scraper ----------------
let scraperProcess = null;
let scraperLastRun = null; // { startedAt, finishedAt, code }

function publicTokens() {
    const month = scraperTokens.currentMonth();
    return scraperTokens.loadTokens().map(t => ({
        label: t.label,
        masked: scraperTokens.maskToken(t.token),
        enabled: t.enabled,
        exhausted: scraperTokens.isExhausted(t, month)
    }));
}

// Shared wrapper: load -> mutate -> save -> respond. Token values never leave the server unmasked.
function mutateTokens(res, fn) {
    try {
        const tokens = scraperTokens.loadTokens();
        fn(tokens);
        scraperTokens.saveTokens(tokens);
        res.json({ success: true, tokens: publicTokens() });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
}

app.get('/api/scraper/tokens', (req, res) => res.json(publicTokens()));

app.post('/api/scraper/tokens', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.addToken(tokens, req.body || {})));

app.delete('/api/scraper/tokens', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.removeToken(tokens, (req.body || {}).label)));

app.post('/api/scraper/tokens/toggle', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.toggleToken(tokens, (req.body || {}).label)));

app.post('/api/scraper/tokens/move', (req, res) =>
    mutateTokens(res, tokens => scraperTokens.moveToken(tokens, (req.body || {}).label, (req.body || {}).direction)));

app.get('/api/scraper/config', (req, res) => {
    try {
        res.json(scraperConfig.loadConfig());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/scraper/config', (req, res) => {
    const result = scraperConfig.validateConfig(req.body);
    if (!result.ok) return res.json({ success: false, error: result.errors.join('; ') });
    scraperConfig.saveConfig(result.config);
    res.json({ success: true });
});

app.post('/api/scraper/run', (req, res) => {
    if (scraperProcess) {
        return res.json({ success: false, error: 'Scraper is already running.' });
    }
    scraperLastRun = { startedAt: new Date().toISOString(), finishedAt: null, code: null };
    scraperProcess = spawn('node', [path.join(__dirname, 'scraper', 'run.js')], {
        detached: process.platform !== 'win32'
    });
    scraperProcess.stdout.on('data', d => io.emit('scraperLog', d.toString()));
    scraperProcess.stderr.on('data', d => io.emit('scraperLog', `[ERROR] ${d.toString()}`));
    scraperProcess.on('close', (code) => {
        scraperLastRun.finishedAt = new Date().toISOString();
        scraperLastRun.code = code;
        io.emit('scraperLog', `\n[SYSTEM] Scraper finished with code ${code}\n`);
        scraperProcess = null;
        io.emit('scraperStatus', false);
    });
    io.emit('scraperStatus', true);
    res.json({ success: true });
});

app.get('/api/scraper/status', (req, res) => {
    res.json({ running: !!scraperProcess, lastRun: scraperLastRun });
});

app.get('/api/scraper/downloads', (req, res) => {
    const base = path.join(__dirname, 'downloads');
    const out = [];
    if (fs.existsSync(base)) {
        for (const niche of fs.readdirSync(base)) {
            const nicheDir = path.join(base, niche);
            if (!fs.statSync(nicheDir).isDirectory()) continue;
            for (const date of fs.readdirSync(nicheDir)) {
                const dateDir = path.join(nicheDir, date);
                if (!fs.statSync(dateDir).isDirectory()) continue;
                for (const f of fs.readdirSync(dateDir)) {
                    if (!f.endsWith('.json')) continue;
                    try {
                        const meta = JSON.parse(fs.readFileSync(path.join(dateDir, f), 'utf8'));
                        const mp4 = f.replace(/\.json$/, '.mp4');
                        out.push(Object.assign({
                            niche, date, file: mp4,
                            hasVideo: fs.existsSync(path.join(dateDir, mp4))
                        }, meta));
                    } catch (e) { /* skip unreadable sidecar */ }
                }
            }
        }
    }
    out.sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')));
    res.json(out.slice(0, 100));
});

// Socket connection
io.on('connection', (socket) => {
    socket.emit('botStatus', !!botProcess);
    socket.emit('scraperStatus', !!scraperProcess);
});

const PORT = process.env.PORT || 3000;
// Localhost-only by default; set HOST=0.0.0.0 (and DASHBOARD_PASSWORD) to expose on the network
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
    console.log(`Web UI running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '0.0.0.0' && !DASHBOARD_PASSWORD) {
        console.log('[!] WARNING: exposed on the network without DASHBOARD_PASSWORD set.');
    }
});
