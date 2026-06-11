require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const axios = require('axios');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const { createObjectCsvWriter } = require('csv-writer');
const crypto = require('crypto');
const fs = require('fs');

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
            auth: {
                username: process.env.DA_USERNAME,
                password: process.env.DA_PASSWORD
            },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.includes('error=1')) {
            throw new Error(`DirectAdmin API Error: ${response.data}`);
        }
        console.log(`[+] Successfully created email.`);
        return `${emailPrefix}@${process.env.EMAIL_DOMAIN}`;
    } catch (error) {
        console.error(`[-] Failed to create email: ${error.message}`);
        throw error;
    }
}

async function deleteDirectAdminEmail(emailPrefix) {
    console.log(`[+] Deleting email ${emailPrefix}@${process.env.EMAIL_DOMAIN} from DirectAdmin...`);
    try {
        const payload = new URLSearchParams({
            action: 'delete',
            domain: process.env.EMAIL_DOMAIN,
            user: emailPrefix
        }).toString();

        const response = await axios.post(`${process.env.DA_URL}/CMD_API_POP`, payload, {
            auth: {
                username: process.env.DA_USERNAME,
                password: process.env.DA_PASSWORD
            }
        });

        if (response.data.includes('error=1')) {
            throw new Error(`DirectAdmin API Error: ${response.data}`);
        }
        console.log(`[+] Successfully deleted email.`);
    } catch (error) {
        console.error(`[-] Failed to delete email: ${error.message}`);
    }
}

async function waitForFigmaVerificationEmail(emailAddress, password, timeoutMs = 300000) {
    console.log(`[+] Waiting for Figma verification email for ${emailAddress}...`);
    const config = {
        imap: {
            user: emailAddress,
            password: password,
            host: process.env.IMAP_HOST,
            port: parseInt(process.env.IMAP_PORT),
            tls: true,
            authTimeout: 10000
        }
    };

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const connection = await imaps.connect(config);
            await connection.openBox('INBOX');
            
            // Search for ALL emails (in case it gets marked as read instantly)
            const searchCriteria = ['ALL'];
            const fetchOptions = { bodies: [''], markSeen: true };
            const results = await connection.search(searchCriteria, fetchOptions);

            for (let i = results.length - 1; i >= 0; i--) {
                const result = results[i];
                const body = result.parts.find(part => part.which === '');
                const parsed = await simpleParser(body.body);
                
                if (parsed.from && parsed.from.text.toLowerCase().includes('figma')) {
                    const textToSearch = (parsed.text || '') + ' ' + (parsed.html || '') + ' ' + (parsed.textAsHtml || '');
                    // Extract URL (Figma verification links usually look like this)
                    const urlMatch = textToSearch.match(/https:\/\/(www\.)?figma\.com\/(verify|v|email\/link_redirect)[^\s"'<]+/i);
                    if (urlMatch) {
                        connection.end();
                        console.log(`[+] Found verification link!`);
                        return urlMatch[0].replace(/&amp;/g, '&');
                    } else {
                        require('fs').writeFileSync('debug_email.html', textToSearch);
                        console.log(`[!] Dumped email to debug_email.html`);
                        connection.end();
                        throw new Error("Failed to match URL. Dumped to debug_email.html");
                    }
                }
            }
            connection.end();
        } catch (error) {
            console.log(`[-] IMAP check error (retrying): ${error.message}`);
        }
        // Wait 5 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Timeout waiting for verification email.');
}

async function createFigmaAccount(page, email, password) {
    console.log(`[+] Navigating to Figma signup page...`);
    await page.goto('https://www.figma.com/signup', { waitUntil: 'domcontentloaded' });

    console.log(`[+] Waiting for the email field to appear (Solve any initial Captchas if they appear!)...`);
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 0 });

    console.log(`[+] Filling in credentials...`);
    await page.fill('input[type="email"], input[name="email"]', email);
    
    let hasPassword = await page.isVisible('input[type="password"], input[name="password"]').catch(() => false);
    if (!hasPassword) {
        console.log(`[+] Multi-step form detected. Clicking continue...`);
        const btn = await page.$('button[type="submit"]');
        if (btn) await btn.click();
        await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 10000 }).catch(() => {});
    }

    try {
        await page.fill('input[type="password"], input[name="password"]', password);
        console.log(`[+] Clicking Create Account...`);
        await page.click('button[type="submit"]');
    } catch (e) {
        throw new Error(`Failed to fill password. Captcha might be blocking the form from loading. Error: ${e.message}`);
    }

    console.log(`[+] Waiting for you to solve the Captcha if it appears (Take your time, no time limit)...`);
    try {
        // Wait for the URL to change away from /signup, meaning the form successfully went through
        await page.waitForFunction(() => window.location.pathname !== '/signup', { timeout: 0 });
        console.log(`[+] Signup successful! Proceeding to check email...`);
        return true;
    } catch (e) {
        await page.screenshot({ path: 'debug_figma.png', fullPage: true });
        throw new Error(`Timed out waiting for you to solve the Captcha (or signup failed).`);
    }
}

async function verifyAccountLink(context, verificationUrl) {
    console.log(`[+] Visiting verification link...`);
    const page = await context.newPage();
    await page.goto(verificationUrl, { waitUntil: 'domcontentloaded' });
    console.log(`[+] Account verified!`);
    await page.close();
}

async function run() {
    // Validate required env vars
    const requiredEnvVars = ['DA_URL', 'DA_USERNAME', 'DA_PASSWORD', 'EMAIL_DOMAIN', 'IMAP_HOST', 'IMAP_PORT'];
    for (const req of requiredEnvVars) {
        if (!process.env[req]) {
            console.error(`[!] Missing required environment variable: ${req}`);
            process.exit(1);
        }
    }

    const numAccounts = parseInt(process.env.ACCOUNTS_TO_CREATE) || 1;
    // Note: To make the bot less detectable, you can change headless: false,
    // but since this is on a VPS, we'll keep it true. Consider using playwright-extra and stealth plugin if needed.
    const browser = await chromium.launch({ headless: true }); 

    for (let i = 0; i < numAccounts; i++) {
        const prefix = 'weaveuser' + generateRandomString(6);
        const password = generateRandomString(12) + 'A1!'; // Ensure strong password
        let email = '';
        let context;
        let verified = false;

        try {
            console.log(`\n--- Starting Account ${i + 1}/${numAccounts} ---`);
            email = await createDirectAdminEmail(prefix, password);

            context = await browser.newContext({
                // Add user agent to look slightly more legitimate
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
            const page = await context.newPage();

            await createFigmaAccount(page, email, password);
            
            const verificationLink = await waitForFigmaVerificationEmail(email, password);
            await verifyAccountLink(context, verificationLink);

            console.log(`[+] Initializing Weave profile at weave.figma.com...`);
            const weavePage = await context.newPage();
            await weavePage.goto('https://weave.figma.com/', { waitUntil: 'domcontentloaded' });
            await weavePage.waitForTimeout(3000); 
            await weavePage.close();

            console.log(`[+] Saving to accounts.csv...`);
            await csvWriter.writeRecords([{ email, password, status: 'Verified' }]);
            verified = true;
        } catch (error) {
            console.error(`[-] Error during creation of ${email || prefix}: ${error.message}`);
            await csvWriter.writeRecords([{ email: email || prefix, password, status: `Failed: ${error.message}` }]);
        } finally {
            if (email && verified) {
                await deleteDirectAdminEmail(prefix);
            }
            if (context) {
                await context.close().catch(() => {});
            }
        }
    }

    await browser.close();
    console.log(`\n[+] Automation complete! Check accounts.csv for results.`);
}

run().catch(console.error);
