// scraper/tokens.js — ordered Apify token store with monthly-exhaustion rotation.
const fs = require('fs');

const TOKENS_PATH = require('../paths').tokensJson;

function loadTokens(file = TOKENS_PATH) {
    if (!fs.existsSync(file)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveTokens(tokens, file = TOKENS_PATH) {
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + '\n');
}

// Apify free credits reset each calendar month, so exhaustion is tagged by month.
function currentMonth(now = new Date()) {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isExhausted(token, month) {
    return token.exhaustedMonth === month;
}

function pickToken(tokens, month) {
    return tokens.find(t => t.enabled && !isExhausted(t, month)) || null;
}

// markExhausted/addToken/removeToken/moveToken/toggleToken all mutate `tokens`
// in place; the return value is the same array reference, not a copy.
function markExhausted(tokens, label, month) {
    const t = tokens.find(x => x.label === label);
    if (t) t.exhaustedMonth = month;
    return tokens;
}

function addToken(tokens, { label, token } = {}) {
    label = String(label || '').trim();
    token = String(token || '').trim();
    if (!label) throw new Error('label is required');
    if (!token) throw new Error('token is required');
    if (tokens.some(t => t.label === label)) throw new Error(`label already exists: ${label}`);
    tokens.push({ label, token, enabled: true, exhaustedMonth: null });
    return tokens;
}

function findIndexOrThrow(tokens, label) {
    const idx = tokens.findIndex(t => t.label === label);
    if (idx === -1) throw new Error(`no such token: ${label}`);
    return idx;
}

function removeToken(tokens, label) {
    tokens.splice(findIndexOrThrow(tokens, label), 1);
    return tokens;
}

function moveToken(tokens, label, direction) {
    const idx = findIndexOrThrow(tokens, label);
    const to = direction === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= tokens.length) return tokens;
    [tokens[idx], tokens[to]] = [tokens[to], tokens[idx]];
    return tokens;
}

function toggleToken(tokens, label) {
    const t = tokens[findIndexOrThrow(tokens, label)];
    t.enabled = !t.enabled;
    return tokens;
}

function maskToken(token) {
    const s = String(token);
    return (s.length <= 10 ? s.slice(0, 2) : s.slice(0, 10)) + '…';
}

module.exports = {
    TOKENS_PATH, loadTokens, saveTokens, currentMonth, isExhausted,
    pickToken, markExhausted, addToken, removeToken, moveToken, toggleToken, maskToken
};
