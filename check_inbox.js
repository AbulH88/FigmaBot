require('dotenv').config();
const imaps = require('imap-simple');

const config = {
    imap: {
        user: 'weaveuser204108@futureworldsports.com',
        password: '05d7cdd52c66A1!',
        host: process.env.IMAP_HOST,
        port: process.env.IMAP_PORT,
        tls: process.env.IMAP_PORT == '993',
        authTimeout: 10000
    }
};

(async () => {
    try {
        const connection = await imaps.connect(config);
        const boxes = await connection.getBoxes();
        console.log("Mailboxes:", Object.keys(boxes));

        await connection.openBox('INBOX');
        const searchCriteria = ['ALL'];
        const fetchOptions = { bodies: ['HEADER'], markSeen: false };
        const messages = await connection.search(searchCriteria, fetchOptions);
        console.log(`Found ${messages.length} messages in INBOX`);
        
        messages.forEach(item => {
            const header = item.parts.find(part => part.which === 'HEADER');
            console.log("From:", header.body.from);
            console.log("Subject:", header.body.subject);
        });

        // Try Spam folder if it exists
        const spamBox = Object.keys(boxes).find(b => b.toLowerCase().includes('spam') || b.toLowerCase().includes('junk'));
        if (spamBox) {
            await connection.openBox(spamBox);
            const spamMessages = await connection.search(['ALL'], fetchOptions);
            console.log(`Found ${spamMessages.length} messages in ${spamBox}`);
            spamMessages.forEach(item => {
                const header = item.parts.find(part => part.which === 'HEADER');
                console.log("From:", header.body.from);
                console.log("Subject:", header.body.subject);
            });
        }
        
        connection.end();
    } catch (e) {
        console.error(e);
    }
})();
