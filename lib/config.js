require('dotenv').config();

const owners = (process.env.OWNER_NUMBER || process.env.OWNER_NUMBERS || '')
    .split(',')
    .map(number => number.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);

module.exports = Object.freeze({
    ownerName: process.env.OWNER_NAME || 'NellsBotBase',
    prefix: process.env.PREFIX || '/',
    botName: process.env.BOT_NAME || 'NellsBotBase',
    botVersion: process.env.BOT_VERSION || 'v1.0',
    botDev: process.env.BOT_DEV || 'NellsBotBase',
    botCategory: 4,
    owners,
    sessionFolder: process.env.SESSION_FOLDER || 'sessions'
});
