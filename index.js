// ===================================================
//  NellsBotBase - Core Web & Multi-Session Server
//  Creator : NellsBotBase
//  Updated : 2026
// ===================================================

const logger = require('./lib/logger');
logger.hookConsole();

require('./control/settings');
const path = require('path');
const fs = require('fs');
const express = require('express');

const { initTelegramBot, getBot } = require('./telegram/bot');
const TelegramHandlers = require('./telegram/handlers');
const SessionManager = require('./core/SessionManager');
const plugins = require('./lib/plugins');
const MessageRouter = require('./core/MessageRouter');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Session Manager
const sessionsDir = path.join(__dirname, 'data', 'sessions');
const sessionManager = new SessionManager(sessionsDir);

// Initialize plugins
plugins.initPlugins();

// Attach sessionManager to app for testing / modular access
app.locals.sessionManager = sessionManager;

// Web Landing Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Comprehensive Real-time System Status API
app.get('/api/status', (req, res) => {
    const allSessions = sessionManager.getAllSessions();
    const onlineCount = allSessions.filter(s => s.status === 'ONLINE').length;
    const connectingCount = allSessions.filter(s => s.status === 'CONNECTING').length;
    const pairingCount = allSessions.filter(s => s.status === 'PAIRING').length;
    const offlineCount = allSessions.filter(s => s.status === 'OFFLINE' || s.status === 'LOGGED_OUT' || s.status === 'CONFLICT').length;

    const telegramBot = getBot();
    const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const telegramPolling = Boolean(telegramBot && telegramBot.isPolling ? telegramBot.isPolling() : telegramBot);

    res.json({
        status: 'ONLINE',
        name: global.botname || 'NellsBotBase',
        version: global.botversion || 'v1.0',
        dev: global.botdev || 'NellsBotBase',
        prefix: global.prefix || '/',
        telegram: {
            configured: telegramConfigured,
            polling: telegramPolling,
            username: '@walogin1_bot',
            link: 'https://t.me/walogin1_bot'
        },
        sessions: {
            total: allSessions.length,
            online: onlineCount,
            connecting: connectingCount,
            pairing: pairingCount,
            offline: offlineCount
        },
        plugins: {
            total: plugins.count(),
            commands: plugins.countCommands(),
            categories: Object.keys(plugins.getCategories())
        },
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: Math.floor(process.uptime()),
            memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
        }
    });
});

// List all sessions
app.get('/api/sessions', (req, res) => {
    res.json({
        success: true,
        sessions: sessionManager.toJSON()
    });
});

// Create a new WhatsApp session and optionally request pairing code
app.post('/api/sessions/create', async (req, res) => {
    const { userId = 'web_dashboard', phoneNumber } = req.body;
    const cleanPhone = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : '';

    if (!cleanPhone || cleanPhone.length < 8) {
        return res.status(400).json({
            success: false,
            error: 'Nomor WhatsApp tidak valid. Masukkan nomor lengkap dengan kode negara, contoh: 628123456789'
        });
    }

    try {
        const session = await sessionManager.createSession(userId, cleanPhone, null, true);
        
        // Wait briefly for socket handshake to generate pairing code
        let pairingCode = null;
        try {
            pairingCode = await session.requestPairingCode();
        } catch (_) {}

        res.json({
            success: true,
            sessionId: session.sessionId,
            phoneNumber: session.phoneNumber,
            status: session.status,
            pairingCode: pairingCode || session.pairingCode
        });
    } catch (err) {
        logger.error('API', 'Error creating session', err);
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// Request pairing code for an existing session
app.post('/api/sessions/:id/pair', async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Sesi tidak ditemukan' });
    }

    try {
        const code = await session.requestPairingCode();
        res.json({
            success: true,
            sessionId: session.sessionId,
            status: session.status,
            pairingCode: code || session.pairingCode
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Connect an existing session
app.post('/api/sessions/:id/connect', async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Sesi tidak ditemukan' });
    }

    try {
        await session.connect();
        res.json({
            success: true,
            sessionId: session.sessionId,
            status: session.status
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Disconnect a session
app.post('/api/sessions/:id/disconnect', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Sesi tidak ditemukan' });
    }

    session.disconnect();
    res.json({
        success: true,
        sessionId: session.sessionId,
        status: session.status
    });
});

// Reset session authentication state (clean re-pair)
app.post('/api/sessions/:id/reset', async (req, res) => {
    try {
        const session = await sessionManager.resetSession(req.params.id, true);
        let code = null;
        try {
            code = await session.requestPairingCode();
        } catch (_) {}

        res.json({
            success: true,
            sessionId: session.sessionId,
            status: session.status,
            pairingCode: code || session.pairingCode
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete a session permanently
app.delete('/api/sessions/:id', async (req, res) => {
    try {
        await sessionManager.deleteSession(req.params.id);
        res.json({ success: true, message: `Sesi ${req.params.id} berhasil dihapus.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Reset all sessions safely (preserves database & plugins)
app.post('/api/sessions/reset-all', async (req, res) => {
    try {
        const result = await sessionManager.resetAllSessions();
        res.json({
            success: true,
            message: `Semua sesi (${result.count}) berhasil di-reset. Data database dan plugin tetap aman.`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// List all plugins
app.get('/api/plugins', (req, res) => {
    const list = plugins.getAll().map(p => ({
        name: p.name || 'unnamed',
        category: p.category || 'other',
        command: p.command || [],
        description: p.description || '',
        admin: Boolean(p.admin),
        group: Boolean(p.group),
        owner: Boolean(p.owner),
        premium: Boolean(p.premium)
    }));

    res.json({
        success: true,
        total: list.length,
        categories: plugins.getCategories(),
        plugins: list
    });
});

// Recent system logs (sanitized)
app.get('/api/logs', (req, res) => {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        return res.json({ success: true, logs: [] });
    }

    try {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort().reverse();
        if (files.length === 0) {
            return res.json({ success: true, logs: [] });
        }

        const latestFile = path.join(logsDir, files[0]);
        const content = fs.readFileSync(latestFile, 'utf8');
        const lines = content.trim().split('\n').slice(-100);

        res.json({
            success: true,
            file: files[0],
            count: lines.length,
            logs: lines
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Message Simulation endpoint for automated testing of MessageRouter and plugins
app.post('/api/simulate-message', async (req, res) => {
    const {
        sender = '6281234567890@s.whatsapp.net',
        chat = '6281234567890@s.whatsapp.net',
        text = '/menu',
        fromMe = false,
        isGroup = false
    } = req.body;

    const replies = [];
    const mockSock = {
        user: { id: '62895400835519:1@s.whatsapp.net' },
        public: true,
        decodeJid: (jid) => jid ? jid.replace(/:\d+@/g, '@') : jid,
        sendMessage: async (target, content, options = {}) => {
            replies.push({ target, content, options });
            return { key: { id: 'SIM_' + Date.now(), remoteJid: target } };
        },
        relayMessage: async (target, message, options = {}) => {
            replies.push({ target, message, options, isRelay: true });
            return { key: { id: 'SIM_RELAY_' + Date.now(), remoteJid: target } };
        },
        groupMetadata: async () => ({
            id: chat,
            subject: 'Test Group',
            participants: [{ id: sender, admin: 'admin' }]
        }),
        signalRepository: {
            lidMapping: {
                getPNForLID: async (lid) => lid.replace('@lid', '@s.whatsapp.net')
            }
        }
    };

    const mockMessage = {
        key: {
            remoteJid: chat,
            fromMe,
            id: 'SIM_MSG_' + Date.now(),
            participant: isGroup ? sender : undefined
        },
        message: {
            conversation: text
        },
        mtype: 'conversation',
        text,
        sender,
        chat
    };

    const mockSession = {
        sessionId: 'simulated_session',
        userId: 'simulation_user',
        phoneNumber: '62895400835519',
        status: 'ONLINE'
    };

    try {
        await MessageRouter.handleMessage(mockSession, mockSock, mockMessage, null);
        res.json({
            success: true,
            simulatedInput: { sender, chat, text },
            repliesCount: replies.length,
            replies
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error('EXPRESS', 'Unhandled request error', err);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: err.message
    });
});

let server = null;

// Start server
function startServer(port = 3000, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
        server = app.listen(port, host, () => {
            logger.info('STARTUP', `HTTP Server listening on http://${host}:${port}`);
            resolve(server);
        }).on('error', reject);
    });
}

async function bootstrap() {
    logger.info('STARTUP', 'Starting NellsBotBase Multi-Session System...');

    // Start HTTP Server
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    await startServer(port, '0.0.0.0');

    // Initialize Telegram Bot
    const bot = initTelegramBot();

    if (bot) {
        TelegramHandlers.init(sessionManager);
        logger.info('TELEGRAM', 'Telegram Bot handlers initialized successfully');
    }

    // Restore saved sessions
    await sessionManager.restoreSessions();

    // Graceful Shutdown
    const gracefulShutdown = () => {
        logger.info('SHUTDOWN', 'Shutting down gracefully...');
        if (bot && typeof bot.stopPolling === 'function') {
            try { bot.stopPolling(); } catch (_) {}
        }
        for (const session of sessionManager.getAllSessions()) {
            logger.info('SHUTDOWN', `Disconnecting session ${session.phoneNumber || session.sessionId}...`);
            session.disconnect();
        }
        if (server) {
            server.close(() => {
                logger.info('SHUTDOWN', 'HTTP server closed.');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

if (require.main === module) {
    bootstrap().catch(err => {
        logger.error('STARTUP', 'Failed to bootstrap application', err, 'BOOTSTRAP_ERROR');
    });
}

module.exports = {
    app,
    sessionManager,
    startServer,
    bootstrap
};
