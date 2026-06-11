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
const VIEWS = ['dashboard', 'proxies', 'accounts', 'settings'];

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

// ---------- Init ----------
async function init() {
    showView(location.hash.slice(1) || 'dashboard');
    await Promise.all([loadSettings(), loadProxies(), loadAccounts()]);
}

init();
