const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { devices } = require('playwright');
chromium.use(stealth);
const fs = require('fs');

async function debug() {
    console.log("Launching browser...");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true
    });
    const page = await context.newPage();

    try {
        console.log("Navigating to app.weavy.ai/signin...");
        await page.goto('https://app.weavy.ai/signin', { waitUntil: 'networkidle' });
        
        console.log("Clicking 'Log in with Figma'...");
        await page.waitForSelector('text="Log in with Figma"');
        await page.click('text="Log in with Figma"');

        console.log("Waiting for Figma login page to load...");
        await page.waitForTimeout(8000);

        console.log("Figma Login URL is:", page.url());
        console.log("REFRESHING the page (User tip: 'swith to mobile view and refrees it will show create option')...");
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        
        console.log("Taking screenshot of refreshed page...");
        await page.screenshot({ path: 'debug8_refreshed.png', fullPage: true });
        
        console.log("Dumping HTML...");
        const html = await page.content();
        fs.writeFileSync('debug8_refreshed.html', html);
        console.log("Done! Analyzing refreshed DOM...");
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await browser.close();
    }
}
debug();
