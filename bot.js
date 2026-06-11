require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { devices } = require('playwright');
chromium.use(stealth);
const axios = require('axios');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const { createObjectCsvWriter } = require('csv-writer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const csvWriter = createObjectCsvWriter({
    path: 'accounts.csv',
    header: [
        { id: 'email', title: 'EMAIL' },
        { id: 'password', title: 'PASSWORD' },
        { id: 'status', title: 'STATUS' }
    ],
    append: fs.existsSync('accounts.csv')
});

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

async function waitForFigmaVerificationEmail(emailAddress, password, timeoutMs = 300000) {
    console.log(`[+] Waiting for Figma verification email for ${emailAddress}...`);
    const config = {
        imap: { user: emailAddress, password: password, host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT), tls: true, authTimeout: 10000 }
    };
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const connection = await imaps.connect(config);
            await connection.openBox('INBOX');
            const results = await connection.search(['ALL'], { bodies: [''], markSeen: true });
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
    throw new Error('Timeout waiting for verification email.');
}

async function run() {
    const numAccounts = parseInt(process.env.ACCOUNTS_TO_CREATE) || 1;
    let proxies = [];
    if (fs.existsSync('proxies.txt')) {
        proxies = fs.readFileSync('proxies.txt', 'utf8').split('\n').map(p => p.trim()).filter(p => p);
    }
    console.log(`[+] Loaded ${proxies.length} proxies.`);

    // Fingerprint pools for randomization
    const timezones = [
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Phoenix', 'America/Detroit', 'America/Indiana/Indianapolis',
        'America/Boise', 'America/Anchorage', 'Pacific/Honolulu'
    ];
    const locales = ['en-US', 'en-GB', 'en-CA', 'en-AU'];
    const mobileWidths = [360, 375, 390, 393, 412, 414];
    const mobileHeights = [640, 667, 720, 780, 812, 844, 851, 869, 915, 932];
    const scaleFactors = [2, 2.625, 3, 3.5];

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
            email = await createDirectAdminEmail(prefix, password);

            // Parse proxy
            let proxyObj = undefined;
            if (proxies.length > 0) {
                const proxyStr = proxies[i % proxies.length];
                if (proxyStr.includes('://')) {
                    try {
                        const url = new URL(proxyStr);
                        proxyObj = { server: `${url.protocol}//${url.hostname}:${url.port}` };
                        if (url.username) proxyObj.username = decodeURIComponent(url.username);
                        if (url.password) proxyObj.password = decodeURIComponent(url.password);
                    } catch (e) { console.log('[-] Invalid proxy URL'); }
                } else {
                    const parts = proxyStr.split(':');
                    if (parts.length === 4) {
                        proxyObj = { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
                    } else if (parts.length === 2) {
                        proxyObj = { server: `http://${parts[0]}:${parts[1]}` };
                    }
                }
                console.log(`[+] Using Proxy: ${proxyObj ? proxyObj.server : 'Invalid'}`);
            } else {
                console.log(`[!] No proxies loaded. Running without proxy.`);
            }

            // Randomize fingerprint for this account
            const fp = {
                width: mobileWidths[Math.floor(Math.random() * mobileWidths.length)],
                height: mobileHeights[Math.floor(Math.random() * mobileHeights.length)],
                scale: scaleFactors[Math.floor(Math.random() * scaleFactors.length)],
                tz: timezones[Math.floor(Math.random() * timezones.length)],
                locale: locales[Math.floor(Math.random() * locales.length)]
            };
            console.log(`[+] Fingerprint: ${fp.width}x${fp.height} @${fp.scale}x | ${fp.tz} | ${fp.locale}`);

            // Fresh browser per account = completely isolated fingerprint
            browser = await chromium.launch({ headless: true });
            context = await browser.newContext({
                viewport: { width: fp.width, height: fp.height },
                deviceScaleFactor: fp.scale,
                timezoneId: fp.tz,
                locale: fp.locale,
                proxy: proxyObj
            });
            page = await context.newPage();

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
            await page.waitForFunction(() => !window.location.pathname.includes('/signup') || document.querySelector('input[name="first_name"]'), { timeout: 0 });
            if (await page.isVisible('input[name="first_name"]').catch(()=>false)) {
                await page.fill('input[name="first_name"]', 'Weave User');
                await page.click('button[type="submit"]');
                await page.waitForFunction(() => !window.location.pathname.includes('/signup'), { timeout: 0 });
            }
            console.log(`[+] Signup passed!`);
            const verificationLink = await waitForFigmaVerificationEmail(email, password);
            console.log(`[+] Visiting verification link...`);
            await page.goto(verificationLink, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);
            await csvWriter.writeRecords([{ email, password, status: 'Verified via Weave' }]);
            verified = true;
        } catch (error) {
            const cleanError = error.message.replace(/\n/g, ' | ').replace(/\[\d+m/g, '');
            console.error(`\n[ERROR] [-] Error during creation of ${email || prefix}: ${cleanError}`);
            await csvWriter.writeRecords([{ email: email || prefix, password, status: `Failed: ${cleanError}` }]);
            if (context && page) {
                const dateStamp = new Date().toISOString().split('T')[0];
                const errDir = path.join(__dirname, 'errors', dateStamp);
                if (!fs.existsSync(errDir)) fs.mkdirSync(errDir, { recursive: true });
                await page.screenshot({ path: path.join(errDir, `error_${prefix}_${Date.now()}.png`), fullPage: true }).catch(()=>{});
            }
        } finally {
            if (email && verified) await deleteDirectAdminEmail(prefix);
            if (browser) await browser.close().catch(() => {});
        }
    }
    console.log(`\n[+] Automation complete!`);
}

run().catch(console.error);
