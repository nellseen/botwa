// ===================================================
//  NellsBotBase - WhatsApp Session
//  Powered by @itsliaaa/baileys
//  Full lifecycle, auto-reconnect, and pairing handling
// ===================================================

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidDecode,
    makeCacheableSignalKeyStore
} = require("@itsliaaa/baileys");
const pino = require('pino');
const EventEmitter = require('events');
const fs = require('fs');
const { smsg } = require('../lib/myfunc');
const logger = require('../lib/logger');

// Known stable Baileys web protocol version fallback
const FALLBACK_BAILEYS_VERSION = [2, 3000, 1041589577];

class WhatsAppSession extends EventEmitter {
    constructor(sessionId, userId, phoneNumber, authFolder) {
        super();
        this.sessionId = sessionId;
        this.userId = String(userId);
        this.phoneNumber = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : '';
        this.authFolder = authFolder;
        this.sock = null;
        this.store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
        this.status = 'OFFLINE';
        this.pairingCode = null;
        this.reconnectAttempts = 0;
        this.maxReconnect = 5;
        this.manualDisconnect = false;
        this.socketGeneration = 0;
        this.reconnectTimer = null;
        this.lastDisconnectReason = null;
    }

    /**
     * Resolves WhatsApp Web protocol version safely with offline fallback
     */
    async getVersion() {
        try {
            const fetched = await fetchLatestBaileysVersion();
            if (fetched && Array.isArray(fetched.version)) {
                return fetched.version;
            }
        } catch (err) {
            logger.warn('WHATSAPP', `[${this.sessionId}] Error fetching latest version, using fallback: ${err.message}`);
        }
        return FALLBACK_BAILEYS_VERSION;
    }

    /**
     * Connects or reconnects the WhatsApp socket
     */
    async connect() {
        if (this.status === 'CONNECTING' || this.status === 'ONLINE') {
            logger.warn('WHATSAPP', `[${this.sessionId}] Connect ignored, already in status=${this.status}`);
            return;
        }

        this.manualDisconnect = false;
        this.socketGeneration++;
        const currentGen = this.socketGeneration;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Clean up any stale socket and listeners from previous attempts
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(undefined);
            } catch (_) {}
            this.sock = null;
        }

        this.updateStatus('CONNECTING');

        try {
            if (!fs.existsSync(this.authFolder)) {
                fs.mkdirSync(this.authFolder, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
            const version = await this.getVersion();

            this.sock = makeWASocket({
                version,
                printQRInTerminal: false,
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                logger: pino({ level: 'silent' }),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                },
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                emitOwnEvents: false,
                retryRequestDelayMs: 250
            });

            this.sock.decodeJid = (jid) => {
                if (!jid) return jid;
                if (/:\d+@/gi.test(jid)) {
                    const decode = jidDecode(jid) || {};
                    return decode.user && decode.server ? decode.user + '@' + decode.server : jid;
                }
                return jid;
            };

            this.store.bind(this.sock.ev);
            this.sock.public = true;

            // Connection update listener
            this.sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (currentGen !== this.socketGeneration) return;

                if (connection === 'open') {
                    this.reconnectAttempts = 0;
                    this.pairingCode = null;
                    this.lastDisconnectReason = null;
                    this.updateStatus('ONLINE');
                    logger.info('WHATSAPP', `[${this.sessionId}] Connection established successfully (status=ONLINE phone=${this.phoneNumber || 'unregistered'})`);
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    let reasonText = 'Koneksi terputus';

                    if (statusCode === DisconnectReason.loggedOut) reasonText = 'Sesi di-logout dari WhatsApp (401)';
                    else if (statusCode === DisconnectReason.restartRequired) reasonText = 'WhatsApp meminta restart koneksi (515)';
                    else if (statusCode === DisconnectReason.timedOut) reasonText = 'Koneksi timeout (408)';
                    else if (statusCode === DisconnectReason.connectionLost) reasonText = 'Koneksi jaringan terputus';
                    else if (statusCode === DisconnectReason.badSession) reasonText = 'Data sesi corrupt (500)';
                    else if (statusCode === DisconnectReason.connectionReplaced) reasonText = 'Koneksi ditimpa sesi lain (440)';
                    else if (statusCode === 429) reasonText = 'Terkena batasan frekuensi / rate limit (429)';
                    else if (statusCode) reasonText = `Error Code ${statusCode}`;

                    this.lastDisconnectReason = { reason: reasonText, statusCode };
                    logger.warn('WHATSAPP', `[${this.sessionId}] Connection closed: ${reasonText} (statusCode=${statusCode || 'unknown'})`);

                    if (statusCode === DisconnectReason.loggedOut) {
                        this.updateStatus('LOGGED_OUT', { reason: reasonText, statusCode });
                        this.cleanup();
                    } else if (statusCode === DisconnectReason.connectionReplaced) {
                        this.updateStatus('CONFLICT', { reason: reasonText, statusCode });
                        this.disconnect();
                    } else if (this.manualDisconnect) {
                        this.updateStatus('OFFLINE', { reason: 'Disconnect manual' });
                    } else {
                        this.updateStatus('RECONNECTING', { reason: reasonText, statusCode });
                        this.handleReconnect(statusCode);
                    }
                }
            });

            // Creds update listener
            this.sock.ev.on('creds.update', (creds) => {
                if (currentGen !== this.socketGeneration) return;
                saveCreds(creds);
            });

            // Incoming messages
            this.sock.ev.on('messages.upsert', async ({ messages }) => {
                if (currentGen !== this.socketGeneration) return;

                for (const mek of messages) {
                    try {
                        if (!mek.message) continue;
                        if (mek.key.remoteJid === 'status@broadcast') continue;

                        const m = smsg(this.sock, mek, this.store);
                        if (!m) continue;

                        logger.info('INCOMING', `[${this.sessionId}] id=${m.id} chat=${m.chat} sender=${m.sender} fromMe=${m.fromMe}`);
                        this.emit('message', { sock: this.sock, m, store: this.store });
                    } catch (err) {
                        logger.error('WHATSAPP', `[${this.sessionId}] Error handling incoming message`, err);
                    }
                }
            });

            // Outgoing message status update
            this.sock.ev.on('messages.update', (updates) => {
                if (currentGen !== this.socketGeneration) return;
                for (const item of updates) {
                    if (item?.key && item?.update?.status) {
                        logger.handleMessageStatusUpdate(item.key, item.update.status);
                    }
                }
            });

            // Message delivery receipt
            this.sock.ev.on('message-receipt.update', (receipts) => {
                if (currentGen !== this.socketGeneration) return;
                for (const item of receipts) {
                    if (item?.key) {
                        logger.handleMessageStatusUpdate(item.key, 3);
                    }
                }
            });

            // Check if pairing needed
            if (!this.sock.authState.creds.registered) {
                this.updateStatus('PAIRING');
            }
        } catch (err) {
            logger.error('WHATSAPP', `[${this.sessionId}] Failed during connect setup`, err);
            this.updateStatus('OFFLINE', { reason: err.message });
        }
    }

    /**
     * Requests pairing code for phone number
     */
    async requestPairingCode() {
        if (!this.sock) {
            await this.connect();
        }
        if (!this.sock) return null;
        if (this.sock.authState?.creds?.registered) return null;

        const cleanPhone = this.phoneNumber ? String(this.phoneNumber).replace(/[^0-9]/g, '') : '';
        if (!cleanPhone || cleanPhone.length < 8) {
            logger.warn('WHATSAPP', `[${this.sessionId}] Invalid phone number for pairing: "${this.phoneNumber}"`);
            return null;
        }

        try {
            logger.info('WHATSAPP', `[${this.sessionId}] Requesting pairing code for: ${cleanPhone}...`);
            let code;
            try {
                code = await this.sock.requestPairingCode(cleanPhone, "NELLSBOT");
            } catch (_) {
                code = await this.sock.requestPairingCode(cleanPhone);
            }

            if (code) {
                const formatted = code.match(/.{1,4}/g)?.join("-") || code;
                this.pairingCode = formatted;
                this.updateStatus('PAIRING', { pairingCode: formatted });
                return formatted;
            }
            return null;
        } catch (err) {
            logger.error('WHATSAPP', `[${this.sessionId}] Failed to request pairing code`, err);
            return null;
        }
    }

    /**
     * Safely resets authentication state for this session without touching others
     */
    resetAuthState() {
        logger.info('WHATSAPP', `[${this.sessionId}] Resetting auth state in ${this.authFolder}...`);
        try {
            if (fs.existsSync(this.authFolder)) {
                fs.rmSync(this.authFolder, { recursive: true, force: true });
                fs.mkdirSync(this.authFolder, { recursive: true });
            }
        } catch (err) {
            logger.error('WHATSAPP', `[${this.sessionId}] Error clearing auth folder`, err);
        }
        this.pairingCode = null;
        this.reconnectAttempts = 0;
        this.manualDisconnect = false;
        this.lastDisconnectReason = null;
        this.updateStatus('OFFLINE', { reason: 'Auth state reset' });
    }

    /**
     * Updates and broadcasts session status
     */
    updateStatus(newStatus, meta = {}) {
        this.status = newStatus;
        this.emit('status', {
            sessionId: this.sessionId,
            userId: this.userId,
            status: newStatus,
            phoneNumber: this.phoneNumber,
            ...meta
        });
    }

    /**
     * Handles reconnecting with exponential backoff and jitter
     */
    handleReconnect(statusCode) {
        if (this.manualDisconnect) return;

        // Restart required (515) - reconnect immediately without consuming retry attempts
        if (statusCode === DisconnectReason.restartRequired) {
            logger.info('WHATSAPP', `[${this.sessionId}] WhatsApp requested restart (515). Reconnecting in 500ms...`);
            this.reconnectTimer = setTimeout(() => this.connect(), 500);
            return;
        }

        // Rate limit (429) - wait 45-60 seconds to avoid WhatsApp IP/account block
        if (statusCode === 429) {
            const delay = 45000 + Math.floor(Math.random() * 15000);
            logger.warn('WHATSAPP', `[${this.sessionId}] WhatsApp rate limited (429). Waiting ${Math.round(delay / 1000)}s before retry...`);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
            return;
        }

        if (this.reconnectAttempts < this.maxReconnect) {
            this.reconnectAttempts++;
            const baseDelay = Math.min(1500 * Math.pow(2, this.reconnectAttempts - 1), 60000);
            const jitter = Math.floor(Math.random() * 1000);
            const delay = baseDelay + jitter;

            logger.info('WHATSAPP', `[${this.sessionId}] Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnect})`);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        } else {
            logger.warn('WHATSAPP', `[${this.sessionId}] Max reconnect attempts reached.`);
            this.updateStatus('OFFLINE', { reason: 'Maksimum percobaan koneksi tercapai. Silakan coba sambungkan kembali manual.' });
        }
    }

    /**
     * Cleanly disconnects the session
     */
    disconnect() {
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(undefined);
            } catch (_) {}
            this.sock = null;
        }
        this.updateStatus('OFFLINE');
    }

    /**
     * Full cleanup
     */
    cleanup() {
        this.disconnect();
        this.removeAllListeners();
    }
}

module.exports = WhatsAppSession;
