const socket = io();

// ---------- Toasts ----------
function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

async function api(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}

// ---------- Routing ----------
const VIEWS = ['dashboard', 'proxies', 'accounts', 'settings', 'scraper'];

function showView(name) {
    if (!VIEWS.includes(name)) name = 'dashboard';
    VIEWS.forEach(v => {
        document.getElementById(`view-${v}`).hidden = v !== name;
    });
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === name);
    });
    if (name === 'accounts' || name === 'dashboard') loadAccounts();
    if (name === 'proxies' || name === 'dashboard') loadProxies();
    if (name === 'scraper') { loadScraperTokens(); loadScraperConfig(); loadDownloads(); }
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ---------- Bot status / logs ----------
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const terminal = document.getElementById('terminal');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

socket.on('botStatus', (isRunning) => {
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;
    statusDot.className = isRunning ? 'dot online' : 'dot offline';
    statusText.textContent = isRunning ? 'Bot Running' : 'Bot Offline';
    if (!isRunning) setTimeout(loadAccounts, 1000); // refresh table after a run
});

socket.on('log', (msg) => {
    terminal.textContent += msg;
    terminal.scrollTop = terminal.scrollHeight;
});

btnStart.addEventListener('click', async () => {
    try {
        // Persist the dashboard run-count before launching
        const count = document.getElementById('run-accounts').value || '1';
        await api('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ACCOUNTS_TO_CREATE: count })
        });
        terminal.textContent = '';
        const data = await api('/api/bot/start', { method: 'POST' });
        if (!data.success) toast(data.error || 'Failed to start bot', 'error');
    } catch (err) {
        toast(`Failed to start bot: ${err.message}`, 'error');
    }
});

btnStop.addEventListener('click', async () => {
    try {
        const data = await api('/api/bot/stop', { method: 'POST' });
        if (!data.success) toast(data.error || 'Bot is not running', 'error');
    } catch (err) {
        toast(`Failed to stop bot: ${err.message}`, 'error');
    }
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
    terminal.textContent = '';
});

// ---------- Stats ----------
function updateStats(accounts, proxyTotal) {
    if (accounts) {
        document.getElementById('stat-total').textContent = accounts.length;
        document.getElementById('stat-verified').textContent =
            accounts.filter(a => (a.STATUS || '').includes('Verified')).length;
        document.getElementById('stat-failed').textContent =
            accounts.filter(a => (a.STATUS || '').includes('Failed')).length;
    }
    if (proxyTotal !== undefined) {
        document.getElementById('stat-proxies').textContent = proxyTotal;
    }
}

// ---------- Settings ----------
const settingsForm = document.getElementById('settings-form');

settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(settingsForm).entries());
    const btn = settingsForm.querySelector('button[type="submit"]');
    btn.textContent = 'Saving...';
    try {
        await api('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        toast('Settings saved', 'success');
        document.getElementById('run-accounts').value = data.ACCOUNTS_TO_CREATE || '1';
    } catch (err) {
        toast(`Failed to save settings: ${err.message}`, 'error');
    } finally {
        btn.textContent = 'Save Settings';
    }
});

async function loadSettings() {
    try {
        const settings = await api('/api/settings');
        for (const key in settings) {
            const input = document.getElementById(key);
            if (input) input.value = settings[key];
        }
        if (settings.ACCOUNTS_TO_CREATE) {
            document.getElementById('run-accounts').value = settings.ACCOUNTS_TO_CREATE;
        }
    } catch (err) {
        toast(`Failed to load settings: ${err.message}`, 'error');
    }
}

// ---------- Proxies ----------
const proxyInput = document.getElementById('proxy-input');
const proxyFile = document.getElementById('proxy-file');
const proxyList = document.getElementById('proxy-list');
const proxyCount = document.getElementById('proxy-count');
const btnCheckProxies = document.getElementById('check-proxies');

let proxies = [];

async function loadProxies() {
    try {
        proxies = await api('/api/proxies');
        renderProxies();
        updateStats(undefined, proxies.length);
    } catch (err) {
        toast(`Failed to load proxies: ${err.message}`, 'error');
    }
}

function renderProxies() {
    proxyCount.textContent = proxies.length;
    proxyList.innerHTML = '';
    proxies.forEach((p, idx) => {
        const li = document.createElement('li');
        const addrSpan = document.createElement('span');
        addrSpan.textContent = p;
        const statusSpan = document.createElement('span');
        statusSpan.className = 'proxy-status pending';
        statusSpan.id = `proxy-status-${idx}`;
        statusSpan.textContent = 'Pending';
        li.append(addrSpan, statusSpan);
        proxyList.appendChild(li);
    });
}

proxyFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('proxyFile', file);
    try {
        const data = await api('/api/proxies', { method: 'POST', body: formData });
        if (data.success) {
            proxyInput.value = '';
            toast(`Uploaded ${data.count} proxies`, 'success');
            await loadProxies();
        }
    } catch (err) {
        toast(`Upload failed: ${err.message}`, 'error');
    } finally {
        proxyFile.value = '';
    }
});

document.getElementById('save-proxies').addEventListener('click', async () => {
    const text = proxyInput.value.trim();
    if (!text) return;
    try {
        const data = await api('/api/proxies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxies: text })
        });
        if (data.success) {
            proxyInput.value = '';
            toast(`Saved ${data.count} proxies`, 'success');
            await loadProxies();
        }
    } catch (err) {
        toast(`Failed to save proxies: ${err.message}`, 'error');
    }
});

document.getElementById('clear-proxies').addEventListener('click', async () => {
    if (!confirm('Delete all saved proxies?')) return;
    try {
        await api('/api/proxies', { method: 'DELETE' });
        toast('Proxies cleared', 'success');
        await loadProxies();
    } catch (err) {
        toast(`Failed to clear proxies: ${err.message}`, 'error');
    }
});

btnCheckProxies.addEventListener('click', async () => {
    if (proxies.length === 0) return toast('No proxies to check');
    btnCheckProxies.disabled = true;
    const results = new Array(proxies.length).fill(false);

    async function checkOne(i) {
        const statusSpan = document.getElementById(`proxy-status-${i}`);
        statusSpan.className = 'proxy-status testing';
        statusSpan.textContent = 'Testing...';
        try {
            const data = await api('/api/check-proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ proxy: proxies[i] })
            });
            results[i] = data.success;
            statusSpan.dataset.ip = data.ip || '';
            statusSpan.dataset.loc = data.location || '';
            statusSpan.dataset.err = data.error || '';
        } catch (err) {
            results[i] = false;
        }
        statusSpan.className = `proxy-status ${results[i] ? 'good' : 'bad'}`;
        if (results[i]) {
            const loc = statusSpan.dataset.loc ? ` — ${statusSpan.dataset.loc}` : '';
            statusSpan.textContent = statusSpan.dataset.ip ? `Working (${statusSpan.dataset.ip}${loc})` : 'Working';
        } else {
            statusSpan.textContent = 'Dead';
        }
    }

    // Check 5 at a time
    let nextIdx = 0;
    async function worker() {
        while (nextIdx < proxies.length) await checkOne(nextIdx++);
    }
    await Promise.all(Array.from({ length: Math.min(5, proxies.length) }, worker));

    const workingProxies = proxies.filter((_, i) => results[i]);

    // Keep only working proxies
    if (workingProxies.length > 0 && workingProxies.length < proxies.length) {
        await api('/api/proxies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxies: workingProxies.join('\n') })
        });
        toast(`Kept ${workingProxies.length} working ${workingProxies.length === 1 ? 'proxy' : 'proxies'}`, 'success');
        proxies = workingProxies;
        setTimeout(renderProxies, 2000);
        updateStats(undefined, proxies.length);
    } else if (workingProxies.length === 0) {
        toast('No working proxies found', 'error');
    }

    btnCheckProxies.disabled = false;
});

// ---------- Accounts ----------
const accountsBody = document.getElementById('accounts-body');

let accountsCache = [];

function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text)
        .then(() => toast(`${label} copied`, 'success'))
        .catch(() => toast('Copy failed', 'error'));
}

async function loadAccounts() {
    try {
        accountsCache = await api('/api/accounts');
        updateStats(accountsCache);
        renderAccounts();
    } catch (err) {
        accountsBody.innerHTML =
            '<tr><td colspan="4" style="text-align: center; color: var(--danger);">Failed to load accounts.</td></tr>';
    }
}

function renderAccounts() {
    accountsBody.innerHTML = '';
    // Show only good (verified) accounts in the table. Failed/Skipped/Blocked
    // rows stay in the CSV and the stats cards, but aren't listed here.
    const goodAccounts = accountsCache.filter(a => (a.STATUS || '').includes('Verified'));
    if (goodAccounts.length === 0) {
        accountsBody.innerHTML =
            '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No verified accounts yet.</td></tr>';
        return;
    }

    goodAccounts.forEach(acc => {
        const tr = document.createElement('tr');
        const statusClass = 'good';

        const tdEmail = document.createElement('td');
        tdEmail.className = 'cell-copy';
        tdEmail.title = 'Click to copy';
        tdEmail.textContent = acc.EMAIL || '-';
        tdEmail.addEventListener('click', () => copyToClipboard(acc.EMAIL, 'Email'));

        const tdPassword = document.createElement('td');
        const pwWrap = document.createElement('span');
        pwWrap.className = 'password-cell';
        const pwText = document.createElement('span');
        pwText.className = 'cell-copy';
        pwText.title = 'Click to copy';
        pwText.textContent = '••••••••';
        pwText.addEventListener('click', () => copyToClipboard(acc.PASSWORD, 'Password'));
        const revealBtn = document.createElement('button');
        revealBtn.className = 'reveal-btn';
        revealBtn.type = 'button';
        revealBtn.textContent = '👁';
        revealBtn.title = 'Show/hide password';
        let revealed = false;
        revealBtn.addEventListener('click', () => {
            revealed = !revealed;
            pwText.textContent = revealed ? (acc.PASSWORD || '-') : '••••••••';
        });
        pwWrap.append(pwText, revealBtn);
        tdPassword.appendChild(pwWrap);

        const tdStatus = document.createElement('td');
        const statusSpan = document.createElement('span');
        statusSpan.className = `proxy-status ${statusClass}`;
        statusSpan.textContent = acc.STATUS || 'Pending';
        statusSpan.title = acc.STATUS || '';
        tdStatus.appendChild(statusSpan);

        const tdAction = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteAccount(acc.EMAIL));
        tdAction.appendChild(delBtn);

        tr.append(tdEmail, tdPassword, tdStatus, tdAction);
        accountsBody.appendChild(tr);
    });
}

async function deleteAccount(email) {
    if (!confirm(`Delete ${email}?`)) return;
    try {
        await api('/api/accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        toast('Account deleted', 'success');
        await loadAccounts();
    } catch (err) {
        toast(`Failed to delete: ${err.message}`, 'error');
    }
}

document.getElementById('refresh-accounts').addEventListener('click', loadAccounts);

document.getElementById('export-accounts').addEventListener('click', () => {
    // Export only the good (verified) accounts — the usable credentials.
    const good = accountsCache.filter(a => (a.STATUS || '').includes('Verified'));
    if (good.length === 0) return toast('No verified accounts to export');
    const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const rows = ['EMAIL,PASSWORD,STATUS',
        ...good.map(a => [a.EMAIL, a.PASSWORD, a.STATUS].map(v => esc(v || '')).join(','))];
    const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
});

// ---------- Reel Scraper ----------
const scraperTerminal = document.getElementById('scraper-terminal');
const btnScraperRun = document.getElementById('scraper-run');
const tokenList = document.getElementById('token-list');
const nicheList = document.getElementById('niche-list');
const downloadsBody = document.getElementById('downloads-body');

socket.on('scraperStatus', (running) => {
    btnScraperRun.disabled = running;
    btnScraperRun.textContent = running ? '⏳ Running…' : '▶ Run Now';
    if (!running) setTimeout(() => { loadDownloads(); loadScraperTokens(); }, 1500);
});

socket.on('scraperLog', (msg) => {
    scraperTerminal.textContent += msg;
    scraperTerminal.scrollTop = scraperTerminal.scrollHeight;
});

btnScraperRun.addEventListener('click', async () => {
    try {
        scraperTerminal.textContent = '';
        const data = await api('/api/scraper/run', { method: 'POST' });
        if (!data.success) toast(data.error || 'Failed to start scraper', 'error');
    } catch (err) {
        toast(`Failed to start scraper: ${err.message}`, 'error');
    }
});

document.getElementById('scraper-clear-logs').addEventListener('click', () => {
    scraperTerminal.textContent = '';
});

// --- Tokens ---
function renderTokens(tokens) {
    document.getElementById('token-count').textContent = tokens.length;
    tokenList.innerHTML = '';
    tokens.forEach((t, idx) => {
        const li = document.createElement('li');

        const name = document.createElement('span');
        name.textContent = `${t.label} (${t.masked})`;

        const right = document.createElement('span');
        right.className = 'token-actions';

        const badge = document.createElement('span');
        badge.className = `proxy-status ${!t.enabled ? 'pending' : t.exhausted ? 'bad' : 'good'}`;
        badge.textContent = !t.enabled ? 'Disabled' : t.exhausted ? 'Exhausted' : 'Active';

        const mk = (txt, title, fn, disabled = false) => {
            const b = document.createElement('button');
            b.className = 'btn btn-ghost btn-sm';
            b.textContent = txt;
            b.title = title;
            b.disabled = disabled;
            b.addEventListener('click', fn);
            return b;
        };
        right.append(
            badge,
            mk('↑', 'Move up', () => tokenAction('/api/scraper/tokens/move', { label: t.label, direction: 'up' }), idx === 0),
            mk('↓', 'Move down', () => tokenAction('/api/scraper/tokens/move', { label: t.label, direction: 'down' }), idx === tokens.length - 1),
            mk(t.enabled ? '⏸' : '▶', t.enabled ? 'Disable' : 'Enable', () => tokenAction('/api/scraper/tokens/toggle', { label: t.label })),
            mk('✕', 'Delete', () => {
                if (confirm(`Delete token "${t.label}"?`)) tokenAction('/api/scraper/tokens', { label: t.label }, 'DELETE');
            })
        );
        li.append(name, right);
        tokenList.appendChild(li);
    });
}

async function tokenAction(url, body, method = 'POST') {
    try {
        const data = await api(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!data.success) return toast(data.error || 'Token action failed', 'error');
        renderTokens(data.tokens);
    } catch (err) {
        toast(`Token action failed: ${err.message}`, 'error');
    }
}

async function loadScraperTokens() {
    try {
        renderTokens(await api('/api/scraper/tokens'));
    } catch (err) {
        toast(`Failed to load tokens: ${err.message}`, 'error');
    }
}

document.getElementById('token-add').addEventListener('click', async () => {
    const label = document.getElementById('token-label').value.trim();
    const token = document.getElementById('token-value').value.trim();
    if (!label || !token) return toast('Label and token are both required', 'error');
    await tokenAction('/api/scraper/tokens', { label, token });
    document.getElementById('token-label').value = '';
    document.getElementById('token-value').value = '';
});

// --- Config (niches + filters) ---
let scraperCfg = null;

function renderNiches() {
    nicheList.innerHTML = '';
    Object.entries(scraperCfg.niches).forEach(([name, niche]) => {
        const row = document.createElement('div');
        row.className = 'niche-row';
        row.dataset.niche = name;

        const label = document.createElement('span');
        label.className = 'niche-name';
        label.textContent = name;

        const tags = document.createElement('input');
        tags.type = 'text';
        tags.className = 'niche-hashtags';
        tags.value = niche.hashtags.join(', ');
        tags.placeholder = 'hashtags, comma separated';

        const creators = document.createElement('input');
        creators.type = 'text';
        creators.className = 'niche-creators';
        creators.value = (niche.creators || []).join(', ');
        creators.placeholder = 'creators (@user, comma separated) — overrides hashtags';
        creators.title = 'When set, reels come from these accounts instead of hashtag discovery';

        const quota = document.createElement('input');
        quota.type = 'number';
        quota.className = 'niche-quota';
        quota.min = '1';
        quota.value = niche.dailyQuota;
        quota.title = 'Daily download quota';

        const del = document.createElement('button');
        del.className = 'btn btn-danger btn-sm';
        del.textContent = '✕';
        del.addEventListener('click', () => {
            // Sync current DOM edits into scraperCfg before re-rendering so
            // unsaved hashtag/quota edits on other rows aren't lost
            collectNichesFromDom();
            delete scraperCfg.niches[name];
            renderNiches();
        });

        row.append(label, tags, creators, quota, del);
        nicheList.appendChild(row);
    });
}

function collectNichesFromDom() {
    const niches = {};
    nicheList.querySelectorAll('.niche-row').forEach(row => {
        niches[row.dataset.niche] = {
            hashtags: row.querySelector('.niche-hashtags').value.split(',').map(s => s.trim()).filter(Boolean),
            creators: row.querySelector('.niche-creators').value.split(',').map(s => s.trim()).filter(Boolean),
            dailyQuota: parseInt(row.querySelector('.niche-quota').value, 10)
        };
    });
    scraperCfg.niches = niches;
    return niches;
}

async function loadScraperConfig() {
    try {
        scraperCfg = await api('/api/scraper/config');
        renderNiches();
        document.getElementById('f-minPlays').value = scraperCfg.filters.minPlays;
        document.getElementById('f-maxAgeDays').value = scraperCfg.filters.maxAgeDays;
        document.getElementById('f-maxDurationSec').value = scraperCfg.filters.maxDurationSec;
        document.getElementById('f-resultsPerHashtag').value = scraperCfg.resultsPerHashtag;
        document.getElementById('f-maxResultsPerRun').value = scraperCfg.maxResultsPerRun;
        document.getElementById('f-retentionDays').value = scraperCfg.retentionDays;
        document.getElementById('f-downloadVideos').checked = scraperCfg.downloadVideos !== false;
    } catch (err) {
        toast(`Failed to load scraper config: ${err.message}`, 'error');
    }
}

document.getElementById('niche-add').addEventListener('click', () => {
    const name = document.getElementById('niche-name').value.trim().toLowerCase();
    if (!name) return;
    if (!/^[a-z0-9_-]+$/.test(name)) return toast('Niche name: letters/numbers/dashes only', 'error');
    if (scraperCfg.niches[name]) return toast('Niche already exists', 'error');
    collectNichesFromDom();
    scraperCfg.niches[name] = { hashtags: [], creators: [], dailyQuota: 5 };
    document.getElementById('niche-name').value = '';
    renderNiches();
});

document.getElementById('scraper-save-config').addEventListener('click', async () => {
    const body = {
        niches: collectNichesFromDom(),
        resultsPerHashtag: parseInt(document.getElementById('f-resultsPerHashtag').value, 10),
        maxResultsPerRun: parseInt(document.getElementById('f-maxResultsPerRun').value, 10),
        retentionDays: parseInt(document.getElementById('f-retentionDays').value, 10),
        downloadVideos: document.getElementById('f-downloadVideos').checked,
        filters: {
            minPlays: parseInt(document.getElementById('f-minPlays').value, 10),
            maxAgeDays: parseInt(document.getElementById('f-maxAgeDays').value, 10),
            maxDurationSec: parseInt(document.getElementById('f-maxDurationSec').value, 10)
        }
    };
    try {
        const data = await api('/api/scraper/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!data.success) return toast(data.error || 'Invalid config', 'error');
        toast('Scraper config saved', 'success');
        await loadScraperConfig();
    } catch (err) {
        toast(`Failed to save config: ${err.message}`, 'error');
    }
});

// --- Downloads ---
async function loadDownloads() {
    try {
        const items = await api('/api/scraper/downloads');
        document.getElementById('download-count').textContent = items.length;
        downloadsBody.innerHTML = '';
        if (items.length === 0) {
            downloadsBody.innerHTML =
                '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No downloads yet.</td></tr>';
            return;
        }
        items.forEach(it => {
            const tr = document.createElement('tr');
            [it.niche, it.creator, (it.plays || 0).toLocaleString(), it.date].forEach(v => {
                const td = document.createElement('td');
                td.textContent = v == null ? '-' : v;
                tr.appendChild(td);
            });
            // Reel column: link to the Instagram page (permanent), plus the
            // local filename when the MP4 was downloaded to the server.
            const tdReel = document.createElement('td');
            if (it.pageUrl) {
                const a = document.createElement('a');
                a.href = it.pageUrl;
                a.target = '_blank';
                a.rel = 'noopener';
                a.className = 'reel-link';
                a.textContent = it.hasVideo ? it.file : 'Open reel ↗';
                tdReel.appendChild(a);
            } else {
                tdReel.textContent = it.file || '-';
            }
            tr.appendChild(tdReel);
            downloadsBody.appendChild(tr);
        });
    } catch (err) {
        downloadsBody.innerHTML =
            '<tr><td colspan="5" style="text-align: center; color: var(--danger);">Failed to load downloads.</td></tr>';
    }
}

// ---------- Init ----------
async function init() {
    showView(location.hash.slice(1) || 'dashboard');
    await Promise.all([loadSettings(), loadProxies(), loadAccounts()]);
}

init();
