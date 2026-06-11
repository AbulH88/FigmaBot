require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

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
            console.error(`[-] DirectAdmin API Error: ${response.data}`);
        } else {
            console.log(`[+] Successfully deleted email.`);
        }
    } catch (error) {
        console.error(`[-] Failed to delete email: ${error.message}`);
    }
}

async function run() {
    console.log("[+] Starting bulk cleanup of existing test accounts...");
    if (!fs.existsSync('accounts.csv')) {
        console.log("No accounts.csv found.");
        return;
    }
    const data = fs.readFileSync('accounts.csv', 'utf8');
    const lines = data.split('\n');
    const prefixes = new Set();
    
    for (const line of lines) {
        if (!line || line.startsWith('EMAIL')) continue;
        const parts = line.split(',');
        if (parts.length > 0) {
            let email = parts[0];
            if (email.includes('@')) {
                email = email.split('@')[0];
            }
            if (email.startsWith('weaveuser')) {
                prefixes.add(email);
            }
        }
    }

    for (const prefix of prefixes) {
        await deleteDirectAdminEmail(prefix);
    }
    
    console.log("[+] Cleanup complete! All previous test accounts have been deleted from MXroute.");
}

run();
