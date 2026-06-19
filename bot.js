const paths = require('./paths');
require('dotenv').config({ path: paths.envPath });
const { chromium } = require('playwright');
const { newInjectedContext } = require('fingerprint-injector');
const axios = require('axios');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseProxyUrl, proxyUrlToPlaywright, validateProxy } = require('./proxyCheck');

const ACCOUNTS_CSV = paths.accountsCsv;
const CSV_HEADER = 'EMAIL,PASSWORD,STATUS\n';

function csvEscape(value) {
    const str = String(value ?? '');
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function appendAccountRecord({ email, password, status }) {
    if (!fs.existsSync(ACCOUNTS_CSV) || !fs.readFileSync(ACCOUNTS_CSV, 'utf8').trim()) {
        fs.writeFileSync(ACCOUNTS_CSV, CSV_HEADER);
    } else if (!fs.readFileSync(ACCOUNTS_CSV, 'utf8').endsWith('\n')) {
        fs.appendFileSync(ACCOUNTS_CSV, '\n');
    }
    fs.appendFileSync(ACCOUNTS_CSV, [email, password, status].map(csvEscape).join(',') + '\n');
}

function generateRandomString(length) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

async function createDirectAdminEmail(emailPrefix, emailPassword) {
    console.log(`[+] Creating email ${emailPrefix}@${process.env.EMAIL_DOMAIN} on DirectAdmin...`);
    try {
        const payload = new URLSearchParams({
            action: 'create',
            domain: process.env.EMAIL_DOMAIN,
            user: emailPrefix,
            passwd: emailPassword,
            quota: 0
        }).toString();

        const response = await axios.post(`${process.env.DA_URL}/CMD_API_POP`, payload, {
            auth: { username: process.env.DA_USERNAME, password: process.env.DA_PASSWORD },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.includes('error=1')) throw new Error(`DirectAdmin API Error: ${response.data}`);
        console.log(`[+] Successfully created email.`);
        return `${emailPrefix}@${process.env.EMAIL_DOMAIN}`;
    } catch (error) {
        console.error(`[-] Failed to create email: ${error.message}`);
        throw error;
    }
}

async function deleteDirectAdminEmail(emailPrefix) {
    console.log(`[+] Deleting email ${emailPrefix}@${process.env.EMAIL_DOMAIN}...`);
    try {
        const payload = new URLSearchParams({ action: 'delete', domain: process.env.EMAIL_DOMAIN, user: emailPrefix }).toString();
        await axios.post(`${process.env.DA_URL}/CMD_API_POP`, payload, { auth: { username: process.env.DA_USERNAME, password: process.env.DA_PASSWORD } });
    } catch (error) {}
}

async function waitForFigmaVerificationEmail(emailAddress, password, timeoutMs = parseInt(process.env.VERIFICATION_TIMEOUT_MS) || 180000) {
    // A clean signup's email lands within ~60-90s. A flagged one never sends,
    // so there's no point waiting 5 min on it — default 3 min, env-tunable.
    console.log(`[+] Waiting up to ${Math.round(timeoutMs / 1000)}s for Figma verification email for ${emailAddress}...`);
    const config = {
        imap: { user: emailAddress, password: password, host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT), tls: true, authTimeout: 10000 }
    };
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const connection = await imaps.connect(config);
            await connection.openBox('INBOX');
            const results = await connection.search(['ALL'], { bodies: [''], markSeen: false });
            for (let i = results.length - 1; i >= 0; i--) {
                const body = results[i].parts.find(part => part.which === '');
                const parsed = await simpleParser(body.body);
                if (parsed.from && parsed.from.text.toLowerCase().includes('figma')) {
                    const textToSearch = (parsed.text || '') + ' ' + (parsed.html || '') + ' ' + (parsed.textAsHtml || '');
                    const urlMatch = textToSearch.match(/https:\/\/(www\.)?figma\.com\/(verify|v|email\/link_redirect)[^\s"'<]+/i);
                    if (urlMatch) {
                        connection.end();
                        return urlMatch[0].replace(/&amp;/g, '&');
                    }
                }
            }
            connection.end();
        } catch (error) {
            console.log(`[-] IMAP check error: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error(`No verification email after ${Math.round(timeoutMs / 1000)}s — likely a flagged proxy (Figma sends no email when a signup is flagged).`);
}

async function run() {
    const numAccounts = parseInt(process.env.ACCOUNTS_TO_CREATE) || 1;
    let proxies = [];
    if (fs.existsSync(paths.proxiesTxt)) {
        proxies = fs.readFileSync(paths.proxiesTxt, 'utf8').split('\n').map(p => p.trim()).filter(p => p);
    }
    console.log(`[+] Loaded ${proxies.length} proxies.`);

    // Local mode: skip proxies and run on this machine's connection (the user
    // routes the server through their own router/VPN, so the real IP is safe).
    const localMode = (process.env.PROXY_MODE || 'list').toLowerCase() === 'local';
    if (localMode) console.log('[+] PROXY_MODE=local — running without proxies (server/router IP).');

    // Timezone pool (rotated per account). The rest of the fingerprint —
    // user-agent, screen, navigator props, WebGL/canvas — is generated fresh
    // per account by fingerprint-generator so every account is internally
    // consistent (e.g. an iPhone UA reports an Apple GPU) and distinct.
    const timezones = [
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Phoenix', 'America/Detroit', 'America/Indiana/Indianapolis',
        'America/Boise', 'America/Anchorage', 'Pacific/Honolulu'
    ];
    const locales = ['en-US', 'en-GB', 'en-CA', 'en-AU'];

    for (let i = 0; i < numAccounts; i++) {
        const prefix = generateRandomString(10);
        const password = generateRandomString(12) + 'A1!';
        let email = '';
        let browser = null;
        let context = null;
        let page = null;
        let verified = false;

        try {
            console.log(`\n--- Starting Account ${i + 1}/${numAccounts} ---`);

            // --- Connection: local mode, or proxy fail-closed --------------
            // Local mode runs with no proxy (server/router IP). Otherwise never
            // create an account on the machine's real IP: parse the proxy, make
            // a REAL request through it, and only continue if it returns a
            // genuine exit IP. A missing, malformed, or locked proxy (e.g.
            // ProxyJet "423 Locked") skips the account instead of silently
            // falling back to the direct connection.
            let proxyObj = undefined;
            let proxyTz = null;
            if (!localMode) {
                const proxyUrl = proxies.length > 0 ? parseProxyUrl(proxies[i % proxies.length]) : null;
                proxyObj = proxyUrl ? proxyUrlToPlaywright(proxyUrl) : undefined;
                if (!proxyObj || !proxyUrl) {
                    console.error(`[ERROR] [-] No usable proxy for account ${i + 1} — skipping (refusing to run on the real IP).`);
                    appendAccountRecord({ email: prefix, password, status: 'Skipped: no proxy configured' });
                    continue;
                }
                console.log(`[+] Validating proxy ${proxyObj.server} before signup...`);
                const proxyResult = await validateProxy(proxyUrl);
                if (!proxyResult.ok) {
                    console.error(`[ERROR] [-] Proxy failed (${proxyResult.error}) — skipping account, NOT creating on the real IP.`);
                    appendAccountRecord({ email: prefix, password, status: `Skipped: proxy failed (${proxyResult.error})` });
                    continue;
                }
                console.log(`[+] Proxy OK — exit IP ${proxyResult.ip} (${[proxyResult.city, proxyResult.region, proxyResult.country].filter(Boolean).join(', ') || 'geo unknown'})`);
                proxyTz = proxyResult.timezone;
            }

            // Connection settled — now it's safe to create the mailbox.
            email = await createDirectAdminEmail(prefix, password);

            // Match the browser timezone to the proxy's REAL exit location so an
            // AU/US/etc. IP isn't paired with a mismatched timezone (a bot tell).
            // Local mode has no proxy geo, so use the random US pool.
            const tz = proxyTz || timezones[Math.floor(Math.random() * timezones.length)];

            // Fresh browser per account = completely isolated fingerprint.
            // newInjectedContext generates a real mobile device fingerprint
            // (UA, screen, navigator, WebGL/canvas) and injects it consistently.
            browser = await chromium.launch({ headless: true });
            context = await newInjectedContext(browser, {
                fingerprintOptions: {
                    devices: ['mobile'],
                    operatingSystems: ['android', 'ios'],
                    locales: locales,
                },
                newContextOptions: {
                    timezoneId: tz,
                    proxy: proxyObj,
                },
            });
            page = await context.newPage();
            const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'unknown');
            console.log(`[+] Fingerprint: ${tz} | ${ua}`);

            console.log(`[+] Navigating directly to Weavy Sign-in...`);
            await page.goto('https://app.weavy.ai/signin', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('text="Log in with Figma"');
            await page.click('text="Log in with Figma"');
            await page.waitForTimeout(5000);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);
            await page.waitForSelector('text="Create one"');
            await page.click('text="Create one"');
            await page.waitForSelector('input[name="email"]', { timeout: 15000 });
            await page.fill('input[name="email"]', email);
            await page.click('button[type="submit"]');
            await page.waitForSelector('input[name="password"]', { timeout: 15000 });
            await page.fill('input[name="password"]', password);
            await page.click('button[type="submit"]');
            await page.waitForFunction(() => !window.location.pathname.includes('/signup') || document.querySelector('input[name="first_name"]'), { timeout: 90000 });
            if (await page.isVisible('input[name="first_name"]').catch(()=>false)) {
                await page.fill('input[name="first_name"]', 'Weave User');
                await page.click('button[type="submit"]');
                await page.waitForFunction(() => !window.location.pathname.includes('/signup'), { timeout: 90000 });
            }
            // Flagged sessions get the OAuth-only wall and Figma sends NO
            // verification email — detect that here instead of hanging for the
            // full email-wait timeout on an account that will never verify.
            const pageText = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
            if (/sign in with Google or Microsoft|isn't available|is not available/i.test(pageText)) {
                throw new Error('Blocked: email signup disabled for this session (flagged — OAuth-only wall)');
            }
            console.log(`[+] Signup passed! (post-signup URL: ${page.url()})`);
            const verificationLink = await waitForFigmaVerificationEmail(email, password);
            console.log(`[+] Visiting verification link...`);
            await page.goto(verificationLink, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);
            appendAccountRecord({ email, password, status: 'Verified via Weave' });
            verified = true;
        } catch (error) {
            const cleanError = error.message.replace(/\n/g, ' | ').replace(/\[\d+m/g, '');
            console.error(`\n[ERROR] [-] Error during creation of ${email || prefix}: ${cleanError}`);
            appendAccountRecord({ email: email || prefix, password, status: `Failed: ${cleanError}` });
            if (context && page) {
                const dateStamp = new Date().toISOString().split('T')[0];
                const errDir = path.join(paths.errorsDir, dateStamp);
                if (!fs.existsSync(errDir)) fs.mkdirSync(errDir, { recursive: true });
                await page.screenshot({ path: path.join(errDir, `error_${prefix}_${Date.now()}.png`), fullPage: true }).catch(()=>{});
            }
        } finally {
            if (email && verified) await deleteDirectAdminEmail(prefix);
            if (browser) await browser.close().catch(() => {});
        }

        // Randomized pause between accounts so a batch isn't an obvious
        // back-to-back burst (a velocity signal Figma watches for). Tunable
        // via ACCOUNT_DELAY_MIN_SEC / ACCOUNT_DELAY_MAX_SEC; skipped after the
        // last account. (Bad-proxy accounts `continue` before this and so move
        // on immediately — no point pacing a signup that never happened.)
        if (i < numAccounts - 1) {
            const minSec = parseInt(process.env.ACCOUNT_DELAY_MIN_SEC) || 30;
            const maxSec = parseInt(process.env.ACCOUNT_DELAY_MAX_SEC) || 90;
            const waitSec = minSec + Math.floor(Math.random() * Math.max(1, maxSec - minSec + 1));
            console.log(`[+] Waiting ${waitSec}s before next account...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
        }
    }
    console.log(`\n[+] Automation complete!`);
}

run().catch(console.error);
