require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { ProxyAgent } = require('proxy-agent');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
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
    const { proxy } = req.body;
    try {
        let proxyStr = proxy.trim();
        let proxyObj;

        if (proxyStr.includes('://')) {
            try {
                const url = new URL(proxyStr);
                proxyObj = { server: `${url.protocol}//${url.hostname}:${url.port}` };
                if (url.username) proxyObj.username = decodeURIComponent(url.username);
                if (url.password) proxyObj.password = decodeURIComponent(url.password);
            } catch (e) {
                return res.json({ success: false, error: 'Invalid proxy URL' });
            }
        } else {
            const parts = proxyStr.split(':');
            if (parts.length === 4) {
                proxyObj = { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
            } else if (parts.length === 2) {
                proxyObj = { server: `http://${parts[0]}:${parts[1]}` };
            } else {
                return res.json({ success: false, error: 'Invalid proxy format' });
            }
        }

        // Test with Playwright (same engine as the bot) to guarantee real compatibility
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            proxy: proxyObj
        });
        const page = await context.newPage();

        try {
            await page.goto('https://www.figma.com/', { timeout: 15000, waitUntil: 'domcontentloaded' });
            const status = page.url().includes('figma.com');
            await browser.close();
            if (status) {
                res.json({ success: true });
            } else {
                res.json({ success: false, error: 'Did not reach Figma' });
            }
        } catch (navError) {
            await browser.close();
            res.json({ success: false, error: navError.message.split('\n')[0] });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Endpoints for Bot Control
app.post('/api/bot/start', (req, res) => {
    if (botProcess) {
        return res.json({ success: false, error: 'Bot is already running.' });
    }

    botProcess = spawn('node', ['bot.js']);

    botProcess.stdout.on('data', (data) => {
        io.emit('log', data.toString());
    });

    botProcess.stderr.on('data', (data) => {
        io.emit('log', `[ERROR] ${data.toString()}`);
    });

    botProcess.on('close', (code) => {
        io.emit('log', `\n[SYSTEM] Bot stopped with code ${code}\n`);
        botProcess = null;
        io.emit('botStatus', false);
    });

    io.emit('botStatus', true);
    res.json({ success: true });
});

app.post('/api/bot/stop', (req, res) => {
    if (botProcess) {
        // Kill the whole process tree — botProcess.kill() alone leaves
        // Playwright's Chromium processes orphaned on Windows
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(botProcess.pid), '/T', '/F']);
        } else {
            botProcess.kill('SIGTERM');
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

// Socket connection
io.on('connection', (socket) => {
    socket.emit('botStatus', !!botProcess);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Web UI running on http://localhost:${PORT}`);
});
