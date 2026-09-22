const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

let bot;

function initTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn('TELEGRAM_BOT_TOKEN is not defined in .env. Telegram dashboard will not start.');
        return null;
    }
    bot = new TelegramBot(token, { polling: true });
    
    bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
            console.warn('[TELEGRAM] ⚠️ Peringatan: Bot token ini sedang digunakan oleh instance lain (misalnya bot production yang sudah di-deploy). Menghentikan polling di development agar tidak bentrok.');
            bot.stopPolling();
        } else {
            console.error('[TELEGRAM] Polling error:', error.message);
        }
    });

    console.log('[TELEGRAM] Bot started polling.');
    return bot;
}

function getBot() {
    return bot;
}

module.exports = {
    initTelegramBot,
    getBot
};
