 
// ===================================================
//  NellsBotBase
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

require('./control/settings');
const path = require('path');
const express = require('express');
const chalk = require('chalk');

const { initTelegramBot } = require('./telegram/bot');
const TelegramHandlers = require('./telegram/handlers');
const SessionManager = require('./core/SessionManager');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'ONLINE',
        name: 'NellsBotBase',
        telegram: 'https://t.me/walogin1_bot',
        uptime: Math.floor(process.uptime()),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log(chalk.cyan('HTTP Server listening on http://0.0.0.0:3000'));
});

async function bootstrap() {
    console.log(chalk.bold.green('Starting NellsBotBase...'));
    
    // Initialize Telegram Bot
    const bot = initTelegramBot();
    
    // Initialize Session Manager
    const sessionsDir = path.join(__dirname, 'data', 'sessions');
    const sessionManager = new SessionManager(sessionsDir);
    
    if (bot) {
        TelegramHandlers.init(sessionManager);
    }

    // Restore saved sessions
    await sessionManager.restoreSessions();

    // Graceful Shutdown
    const gracefulShutdown = () => {
        console.log(chalk.yellow('\n[SHUTDOWN] Shutting down gracefully...'));
        if (bot) bot.stopPolling();
        for (const session of sessionManager.getAllSessions()) {
            console.log(chalk.yellow(`[SHUTDOWN] Disconnecting session ${session.phoneNumber}...`));
            session.disconnect();
        }
        process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

bootstrap().catch(err => {
    console.error(chalk.red('Failed to bootstrap application:'), err);
});
