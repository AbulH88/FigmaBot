// Shared proxy parsing + validation used by the dashboard (server.js) and the
// bot (bot.js). validateProxy makes a REAL request through the proxy and
// confirms a genuine exit IP, so a locked/denied proxy (e.g. ProxyJet
// "423 Locked", a 403, or a 407 auth failure) is reported as FAILED instead of
// being treated as "working". Both callers fail-closed on a bad result.
const axios = require('axios');
const { ProxyAgent } = require('proxy-agent');

// Turn a proxies.txt line into a proxy URL string, or null if unparseable.
// Accepts, in order: "scheme://user:pass@host:port", "user:pass@host:port"
// (ProxyJet's default output — no scheme), "host:port:user:pass", "host:port".
function parseProxyUrl(proxyStr) {
    proxyStr = String(proxyStr || '').trim();
    if (!proxyStr) return null;
    if (proxyStr.includes('://')) {
        try { new URL(proxyStr); return proxyStr; } catch (e) { return null; }
    }
    // user:pass@host:port — no scheme. This is what ProxyJet hands you by
    // default; assume HTTP and let the URL parser split it.
    if (proxyStr.includes('@')) {
        try { new URL('http://' + proxyStr); return 'http://' + proxyStr; } catch (e) { return null; }
    }
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
        return `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
    }
    if (parts.length === 2) {
        return `http://${parts[0]}:${parts[1]}`;
    }
    return null;
}

// Build a Playwright launch proxy object ({ server, username, password }) from
// a normalized proxy URL, or null if it can't be parsed.
function proxyUrlToPlaywright(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        const obj = { server: `${u.protocol}//${u.hostname}:${u.port}` };
        if (u.username) obj.username = decodeURIComponent(u.username);
        if (u.password) obj.password = decodeURIComponent(u.password);
        return obj;
    } catch (e) { return null; }
}

// Exercise the proxy end-to-end. Resolves to { ok:true, ip, timezone, country,
// city, region } only when the proxy returns a real exit IP over HTTP 200;
// otherwise { ok:false, error }. Anything that is not a clean 200-with-IP
// (4xx/5xx, timeout, tunnel refused) is a failure — a locked proxy must never
// look like a working one. The geo fields let the bot match the browser
// timezone to the proxy's real exit location.
async function validateProxy(proxyUrl, timeout = 15000) {
    try {
        const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
        const res = await axios.get('https://ipinfo.io/json', {
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            timeout,
            validateStatus: (s) => s === 200,
        });
        const d = res && res.data ? res.data : {};
        const ip = d.ip;
        if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) {
            return { ok: false, error: 'No valid exit IP returned' };
        }
        return {
            ok: true,
            ip: String(ip),
            timezone: d.timezone || null,   // e.g. "Australia/Sydney"
            country: d.country || null,     // e.g. "AU"
            region: d.region || null,
            city: d.city || null,
        };
    } catch (err) {
        const status = err.response && err.response.status;
        return { ok: false, error: status ? `HTTP ${status}` : String(err.message || err).split('\n')[0] };
    }
}

module.exports = { parseProxyUrl, proxyUrlToPlaywright, validateProxy };
