const socket = io();

// DOM Elements
const settingsForm = document.getElementById('settings-form');
const proxyInput = document.getElementById('proxy-input');
const proxyFile = document.getElementById('proxy-file');
const btnSaveProxies = document.getElementById('save-proxies');
const btnCheckProxies = document.getElementById('check-proxies');
const proxyList = document.getElementById('proxy-list');
const proxyCount = document.getElementById('proxy-count');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const terminal = document.getElementById('terminal');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

let proxies = [];

// Initialization
async function init() {
    // Load Settings
    const res = await fetch('/api/settings');
    const settings = await res.json();
    for (const key in settings) {
        const input = document.getElementById(key);
        if (input) input.value = settings[key];
    }

    // Load Proxies
    await loadProxies();
    
    // Load Accounts
    if (typeof loadAccounts === 'function') await loadAccounts();
}

// Settings
settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(settingsForm);
    const data = Object.fromEntries(formData.entries());
    
    const btn = settingsForm.querySelector('button');
    btn.textContent = 'Saving...';
    
    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    
    setTimeout(() => {
        btn.textContent = 'Saved!';
        setTimeout(() => btn.textContent = 'Save Settings', 2000);
    }, 500);
});

// Proxies
async function loadProxies() {
    const res = await fetch('/api/proxies');
    proxies = await res.json();
    renderProxies();
}

function renderProxies() {
    proxyCount.textContent = proxies.length;
    proxyList.innerHTML = '';
    proxies.forEach((p, idx) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${p}</span>
            <span class="proxy-status pending" id="proxy-status-${idx}">Pending</span>
        `;
        proxyList.appendChild(li);
    });
}

proxyFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('proxyFile', file);
    
    const res = await fetch('/api/proxies', {
        method: 'POST',
        body: formData
    });
    const data = await res.json();
    if (data.success) {
        proxyInput.value = '';
        await loadProxies();
    }
});

btnSaveProxies.addEventListener('click', async () => {
    const text = proxyInput.value.trim();
    if (!text) return;
    
    const res = await fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: text })
    });
    const data = await res.json();
    if (data.success) {
        proxyInput.value = '';
        await loadProxies();
    }
});

document.getElementById('clear-proxies').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to completely delete all saved proxies?')) return;
    await fetch('/api/proxies', {
        method: 'DELETE'
    });
    await loadProxies();
});

btnCheckProxies.addEventListener('click', async () => {
    btnCheckProxies.disabled = true;
    let workingProxies = [];
    
    for (let i = 0; i < proxies.length; i++) {
        const statusSpan = document.getElementById(`proxy-status-${i}`);
        statusSpan.className = 'proxy-status testing';
        statusSpan.textContent = 'Testing...';
        
        try {
            const res = await fetch('/api/check-proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ proxy: proxies[i] })
            });
            const data = await res.json();
            
            if (data.success) {
                statusSpan.className = 'proxy-status good';
                statusSpan.textContent = 'Working';
                workingProxies.push(proxies[i]);
            } else {
                statusSpan.className = 'proxy-status bad';
                statusSpan.textContent = 'Dead';
            }
        } catch (err) {
            statusSpan.className = 'proxy-status bad';
            statusSpan.textContent = 'Dead';
        }
    }
    
    // Auto-save only working proxies
    if (workingProxies.length > 0) {
        await fetch('/api/proxies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxies: workingProxies.join('\n') })
        });
        proxies = workingProxies;
        setTimeout(renderProxies, 2000);
    }
    
    btnCheckProxies.disabled = false;
});

// Bot Control
socket.on('botStatus', (isRunning) => {
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;
    
    if (isRunning) {
        statusDot.className = 'dot online';
        statusText.textContent = 'Bot Running';
    } else {
        statusDot.className = 'dot offline';
        statusText.textContent = 'Bot Offline';
    }
});

socket.on('log', (msg) => {
    terminal.textContent += msg + '\n';
    terminal.scrollTop = terminal.scrollHeight;
});

btnStart.addEventListener('click', async () => {
    terminal.textContent = '';
    await fetch('/api/bot/start', { method: 'POST' });
});

btnStop.addEventListener('click', async () => {
    await fetch('/api/bot/stop', { method: 'POST' });
});

// Accounts
const accountsBody = document.getElementById('accounts-body');
const btnRefreshAccounts = document.getElementById('refresh-accounts');

async function loadAccounts() {
    try {
        const res = await fetch('/api/accounts');
        const accounts = await res.json();
        accountsBody.innerHTML = '';
        if (accounts.length === 0) {
            accountsBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No accounts generated yet.</td></tr>';
            return;
        }
        
        accounts.forEach(acc => {
            const tr = document.createElement('tr');
            let statusClass = 'pending';
            if (acc.STATUS && acc.STATUS.includes('Failed')) statusClass = 'bad';
            else if (acc.STATUS && acc.STATUS.includes('Verified')) statusClass = 'good';
            
            tr.innerHTML = `
                <td>${acc.EMAIL || '-'}</td>
                <td style="font-family: monospace;">${acc.PASSWORD || '-'}</td>
                <td><span class="proxy-status ${statusClass}">${acc.STATUS || 'Pending'}</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteAccount('${acc.EMAIL}')">Delete</button></td>
            `;
            accountsBody.appendChild(tr);
        });
    } catch (e) {
        accountsBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--danger);">Failed to load accounts.</td></tr>';
    }
}

if (btnRefreshAccounts) {
    btnRefreshAccounts.addEventListener('click', loadAccounts);
}

// Auto-refresh when bot stops
socket.on('botStatus', (isRunning) => {
    if (!isRunning && typeof loadAccounts === 'function') {
        setTimeout(loadAccounts, 1000);
    }
});

window.deleteAccount = async function(email) {
    if(!confirm(`Are you sure you want to delete ${email}?`)) return;
    await fetch('/api/accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });
    await loadAccounts();
};

init();
