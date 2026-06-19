// electron-main.js — desktop shell. Hosts the existing Express app in-process
// and shows it in a window. All data lives in Documents\FigmaBot.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'Documents', 'FigmaBot');
process.env.DATA_DIR = DATA_DIR;

if (app.isPackaged) {
    process.env.FIGMABOT_PACKAGED = '1';
    // Bundled Chromium lives in resources/ms-playwright (see electron-builder config).
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
}

let win = null;

async function createWindow() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // Seed local mode (4G dongle IP) on first launch.
        const envPath = path.join(DATA_DIR, '.env');
        if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, 'PROXY_MODE=local\n');
    } catch (err) {
        dialog.showErrorBox('FigmaBot — cannot write data folder', `${DATA_DIR}\n\n${err.message}`);
        app.quit();
        return;
    }

    const { start } = require('./server');
    const port = await start({ port: 0 }); // any free port — avoids conflicts

    win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'FigmaBot',
        autoHideMenuBar: true
    });
    win.loadURL(`http://127.0.0.1:${port}`);
    win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow).catch(err => {
    dialog.showErrorBox('FigmaBot failed to start', err && err.message ? err.message : String(err));
    app.quit();
});

app.on('before-quit', () => {
    try { require('./server').stopChildren(); } catch (e) { /* server may not have started */ }
});

app.on('window-all-closed', () => app.quit());
