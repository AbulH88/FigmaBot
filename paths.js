// paths.js — single source of truth for all writable data locations.
// Dev (DATA_DIR unset): everything resolves to the project root, exactly
// matching the pre-desktop layout. Electron sets DATA_DIR to Documents\FigmaBot.
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = __dirname;

function dataPaths(dir) {
    const base = dir || process.env.DATA_DIR || PROJECT_ROOT;
    return {
        dataDir: base,
        envPath: path.join(base, '.env'),
        accountsCsv: path.join(base, 'accounts.csv'),
        proxiesTxt: path.join(base, 'proxies.txt'),
        errorsDir: path.join(base, 'errors'),
        downloadsDir: path.join(base, 'downloads'),
        configJson: path.join(base, 'scraper', 'config.json'),
        tokensJson: path.join(base, 'scraper', 'apify_tokens.json'),
        stateDir: path.join(base, 'scraper', 'state')
    };
}

function ensureDirs(p = dataPaths()) {
    for (const d of [p.dataDir, path.dirname(p.configJson), p.downloadsDir, p.errorsDir]) {
        fs.mkdirSync(d, { recursive: true });
    }
    return p;
}

// Default singleton: resolved once from the environment at require time.
module.exports = Object.assign({ dataPaths, ensureDirs }, dataPaths());
