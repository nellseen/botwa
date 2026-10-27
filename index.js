// ===================================================
//  NellsBotBase - Core Web & Multi-Session Server
//  Creator : NellsBotBase
//  Updated : 2026
// ===================================================

const logger = require('./lib/logger');
logger.hookConsole();

const config = require('./control/settings');
const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');

const { initTelegramBot, getBot } = require('./telegram/bot');
const TelegramHandlers = require('./telegram/handlers');
const SessionManager = require('./core/SessionManager');
const plugins = require('./lib/plugins');
const MessageRouter = require('./core/MessageRouter');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb', parameterLimit: 100 }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Session Manager
const sessionsDir = path.join(__dirname, 'data', 'sessions');
const sessionManager = new SessionManager(sessionsDir);

// Initialize plugins
plugins.initPlugins();

// Attach sessionManager to app for testing / modular access
app.locals.sessionManager = sessionManager;

function requireAdmin(req, res, next) {
    if (process.env.NODE_ENV === 'test') return next();
    const expected = process.env.API_ADMIN_TOKEN || '';
    if (!expected) {
        return res.status(503).json({ success: false, error: 'API admin belum dikonfigurasi.' });
    }
    const supplied = String(req.get('authorization') || req.get('x-api-key') || '')
        .replace(/^Bearer\s+/i, '').trim();
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(supplied);
    if (!supplied || expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        return res.status(401).json({ success: false, error: 'Autentikasi admin diperlukan.' });
    }
    return next();
}

const adminRequestWindows = new Map();
function limitAdminRequests(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let window = adminRequestWindows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
        window = { startedAt: now, count: 0 };
        adminRequestWindows.set(key, window);
    }
    window.count++;
    if (window.count > 60) return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan admin. Coba lagi sebentar.' });
    if (adminRequestWindows.size > 2000) {
        for (const [ip, item] of adminRequestWindows) {
            if (now - item.startedAt >= 60_000) adminRequestWindows.delete(ip);
        }
        while (adminRequestWindows.size > 2000) adminRequestWindows.delete(adminRequestWindows.keys().next().value);
    }
    return next();
}

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
        name: config.botName,
        version: config.botVersion,
        dev: config.botDev,
        prefix: config.prefix,
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
app.use('/api/sessions', limitAdminRequests, requireAdmin);
app.get('/api/sessions', (req, res) => {
    res.json({
        success: true,
        sessions: sessionManager.toJSON()
    });
});

// Create a new WhatsApp session and optionally request pairing code
app.post('/api/sessions/create', async (req, res) => {
    const { phoneNumber } = req.body;
    const cleanPhone = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : '';

    if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
        return res.status(400).json({
            success: false,
            error: 'Nomor WhatsApp tidak valid. Masukkan nomor lengkap dengan kode negara, contoh: 628123456789'
        });
    }

    try {
        const session = await sessionManager.createSession('web_dashboard', cleanPhone, null, true);
        
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
app.use('/api/plugins', limitAdminRequests, requireAdmin);
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
app.use('/api/logs', limitAdminRequests, requireAdmin);
app.get('/api/logs', async (req, res) => {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
        return res.json({ success: true, logs: [] });
    }

    try {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort().reverse();
        if (files.length === 0) {
            return res.json({ success: true, logs: [] });
        }

        const latestFile = path.join(logsDir, files[0]);
        const handle = await fs.promises.open(latestFile, 'r');
        let content;
        try {
            const stat = await handle.stat();
            const length = Math.min(stat.size, 64 * 1024);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
            content = buffer.toString('utf8');
        } finally {
            await handle.close();
        }
        const lines = content.trim().split('\n').slice(-100);

        res.json({
            success: true,
            file: files[0],
            count: lines.length,
            logs: lines
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Gagal membaca log.' });
    }
});

// Message Simulation endpoint for automated testing of MessageRouter and plugins
app.post('/api/simulate-message', async (req, res) => {
    // 1. Nonaktifkan endpoint simulasi di production secara default
    const isProduction = process.env.NODE_ENV === 'production';
    const isSimulationEnabled = process.env.ENABLE_SIMULATION === 'true';
    if (isProduction && !isSimulationEnabled) {
        return res.status(403).json({
            success: false,
            error: 'Forbidden: Endpoint simulasi dinonaktifkan di environment production secara default.'
        });
    }

    // 2. Autentikasi wajib untuk endpoint simulasi
    const configuredKey = process.env.SIMULATION_API_KEY || (process.env.NODE_ENV === 'test' ? 'test-simulation-secret' : null);
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    const token = authHeader
        ? (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim())
        : null;

    if (!configuredKey || !token || token !== configuredKey) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Autentikasi valid diperlukan untuk mengakses endpoint simulasi.'
        });
    }

    // 3. Sanitasi input: Jangan pernah mempercayai sender, isCreator, atau fromMe yang diberikan klien
    const {
        sender = '6281234567890@s.whatsapp.net',
        chat = '6281234567890@s.whatsapp.net',
        text = '/menu',
        isGroup = false
    } = req.body || {};

    const cleanSender = String(sender || '').trim() || '6281234567890@s.whatsapp.net';
    const cleanText = typeof text === 'string' ? text : '';

    const replies = [];
    const mockSock = {
        user: { id: '62800000000000:1@s.whatsapp.net' },
        public: true,
        isSimulation: true,
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
            participants: [{ id: cleanSender, admin: null }]
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
            fromMe: false, // Jangan pernah percaya fromMe dari klien
            id: 'SIM_MSG_' + Date.now(),
            participant: isGroup ? cleanSender : undefined
        },
        message: {
            conversation: cleanText
        },
        mtype: 'conversation',
        text: cleanText,
        sender: cleanSender,
        chat,
        isSimulation: true // Penanda tegas isolasi simulasi
    };

    const mockSession = {
        sessionId: 'simulated_session',
        userId: 'simulation_user',
        phoneNumber: '62800000000000',
        status: 'ONLINE',
        isSimulation: true
    };

    try {
        // Pisahkan ke jalur testing/simulasi terisolasi
        const result = await MessageRouter.handleSimulatedMessage(mockSession, mockSock, mockMessage, null);
        res.json({
            success: true,
            simulatedInput: { sender: cleanSender, chat, text: cleanText },
            repliesCount: replies.length,
            replies,
            result
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
        error: 'Internal Server Error'
    });
});

let server = null;

function printStartupBanner() {
    const { name, version } = require('./package.json');
    const esc = '\u001b[';
    const reset = `${esc}0m`;
    const cyan = `${esc}36m`;
    const magenta = `${esc}35m`;
    const yellow = `${esc}33m`;
    const green = `${esc}32m`;
    const runtime = `Node.js ${process.version} | ${process.platform}/${process.arch} | PID ${process.pid}`;

    console.log(`${magenta} _   _ ____  _     _     ____  ${reset}`);
    console.log(`${cyan}| \\ | |  _ \\| |   | |   / ___| ${reset}`);
    console.log(`${cyan}|  \\| | |_) | |   | |   \\___ \\ ${reset}`);
    console.log(`${cyan}| |\\  |  __/| |___| |___ ___) |${reset}`);
    console.log(`${magenta}|_| \\_|_|   |_____|_____|____/ ${reset}`);
    console.log(`${yellow}${name}${reset} ${green}v${version}${reset}`);
    console.log(`${cyan}${runtime}${reset}`);
}

// Start server
function startServer(port = 3000, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
        const parsedPort = Number(port);
        if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
            return reject(new Error(`PORT tidak valid: ${port}`));
        }
        server = app.listen(parsedPort, host, () => {
            logger.info('STARTUP', `HTTP Server listening on http://${host}:${port}`);
            resolve(server);
        }).on('error', reject);
    });
}

async function bootstrap() {
    printStartupBanner();
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
    let shuttingDown = false;
    const gracefulShutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('SHUTDOWN', 'Shutting down gracefully...');
        TelegramHandlers.setServerStatus('OFF');
        if (bot && typeof bot.stopPolling === 'function') {
            try { bot.stopPolling(); } catch (_) {}
        }
        const sessionStops = [];
        for (const session of sessionManager.getAllSessions()) {
            logger.info('SHUTDOWN', `Disconnecting session ${session.phoneNumber || session.sessionId}...`);
            sessionStops.push(Promise.resolve(session.disconnect()));
        }
        if (server) {
            server.close(async () => {
                await Promise.allSettled(sessionStops);
                await TelegramHandlers.waitForStatusUpdates();
                logger.info('SHUTDOWN', 'HTTP server closed.');
                await logger.close();
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
