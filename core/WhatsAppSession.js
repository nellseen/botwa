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
    makeCacheableSignalKeyStore,
    Browsers
} = require("@itsliaaa/baileys");
const pino = require('pino');
const EventEmitter = require('events');
const fs = require('fs');
const { smsg } = require('../lib/myfunc');
const logger = require('../lib/logger');

// Keep Baileys warnings and errors visible while suppressing verbose protocol logs.
const baileysLogger = pino({ level: 'warn' });
const DEFAULT_CUSTOM_PAIRING_CODE = 'NELLSBOT';

// Known stable Baileys web protocol version fallback (latest active build)
const FALLBACK_BAILEYS_VERSION = [2, 3000, 1043857760];

class WhatsAppSession extends EventEmitter {
    constructor(sessionId, userId, phoneNumber, authFolder) {
        super();
        this.sessionId = sessionId;
        this.userId = String(userId);
        this.phoneNumber = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : '';
        this.authFolder = authFolder;
        this.sock = null;
        this.store = makeInMemoryStore({ logger: baileysLogger });
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
     * Resolves WhatsApp Web protocol version safely with multi-tiered fallback
     */
    async getVersion() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            try {
                const res = await fetch('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json', {
                    signal: controller.signal
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data?.version) && data.version.length === 3) {
                        return data.version;
                    }
                }
            } finally {
                clearTimeout(timer);
            }
        } catch (_) {}

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
                browser: Browsers ? Browsers.ubuntu('Chrome') : ["Ubuntu", "Chrome", "22.04.4"],
                logger: baileysLogger,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
                },
                connectTimeoutMs: process.env.NODE_ENV === 'test' ? 3000 : 60000,
                defaultQueryTimeoutMs: process.env.NODE_ENV === 'test' ? 3000 : 60000,
                keepAliveIntervalMs: process.env.NODE_ENV === 'test' ? 5000 : 30000,
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
                    else if (statusCode === 405) reasonText = 'Versi protokol WhatsApp kedaluwarsa atau ditolak server (405)';
                    else if (statusCode) reasonText = `Error Code ${statusCode}`;

                    this.lastDisconnectReason = { reason: reasonText, statusCode };
                    logger.warn('WHATSAPP', `[${this.sessionId}] Connection closed: ${reasonText} (statusCode=${statusCode || 'unknown'})`);

                    if (statusCode === DisconnectReason.loggedOut) {
                        this.updateStatus('LOGGED_OUT', { reason: reasonText, statusCode });
                        this.cleanup();
                    } else if (statusCode === DisconnectReason.connectionReplaced) {
                        this.updateStatus('CONFLICT', { reason: reasonText, statusCode });
                        this.disconnect({ updateStatus: false });
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
     * Waits for WebSocket handshake to complete and socket to open
     */
    async waitForSocketOpen(timeoutMs = (process.env.NODE_ENV === 'test' ? 800 : 8000)) {
        if (this.sock?.ws?.isOpen) return true;
        const start = Date.now();
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                if (this.sock?.ws?.isOpen) {
                    clearInterval(interval);
                    resolve(true);
                } else if (!this.sock || Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    resolve(false);
                }
            }, 100);
            if (interval && interval.unref) interval.unref();
        });
    }

    /**
     * Requests pairing code for phone number
     */
    async requestPairingCode() {
        const cleanPhone = this.phoneNumber ? String(this.phoneNumber).replace(/[^0-9]/g, '') : '';
        if (!cleanPhone || cleanPhone.length < 8) {
            logger.warn('WHATSAPP', `[${this.sessionId}] Invalid phone number for pairing: "${this.phoneNumber}"`);
            return null;
        }

        if (!this.sock || !this.sock.ws?.isOpen) {
            if (!this.sock) {
                await this.connect();
            }
            const isReady = await this.waitForSocketOpen(8000);
            if (!isReady || !this.sock?.ws?.isOpen) {
                logger.warn('WHATSAPP', `[${this.sessionId}] Socket connection is not open yet; pairing code request deferred.`);
                return null;
            }
        }

        if (this.sock.authState?.creds?.registered) return null;

        try {
            logger.info('WHATSAPP', `[${this.sessionId}] Requesting pairing code for: ${cleanPhone}...`);
            let code;
            try {
                // Custom code Baileys harus tepat 8 karakter alfanumerik.
                const configuredCode = process.env.PAIRING_CODE?.trim().toUpperCase();
                const customCode = /^[A-Z0-9]{8}$/.test(configuredCode || '')
                    ? configuredCode
                    : DEFAULT_CUSTOM_PAIRING_CODE;

                if (configuredCode && customCode !== configuredCode) {
                    logger.warn('WHATSAPP', 'PAIRING_CODE harus tepat 8 karakter alfanumerik; memakai kode default.');
                }

                code = await this.sock.requestPairingCode(cleanPhone, customCode);
            } catch (_) {
                // Fallback ke kode acak standar jika custom code tidak diterima
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
            if (err?.message?.includes('Connection Closed') || err?.output?.statusCode === 428) {
                logger.warn('WHATSAPP', `[${this.sessionId}] Connection closed during pairing request. Socket will reconnect automatically.`);
            } else {
                logger.error('WHATSAPP', `[${this.sessionId}] Failed to request pairing code`, err);
            }
            return null;
        }
    }

    /**
     * Safely resets authentication state for this session without touching others
     */
    resetAuthState() {
        logger.info('WHATSAPP', `[${this.sessionId}] Resetting auth state in ${this.authFolder}...`);
        this.disconnect({ updateStatus: false });
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

        // WhatsApp rejected protocol version (405) - wait 5s then reconnect with refreshed version
        if (statusCode === 405) {
            logger.warn('WHATSAPP', `[${this.sessionId}] WhatsApp rejected protocol version (405). Waiting 5s before reconnecting...`);
            this.reconnectTimer = setTimeout(() => this.connect(), 5000);
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
    disconnect({ updateStatus = true } = {}) {
        this.manualDisconnect = true;
        this.socketGeneration++;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        let closePromise = Promise.resolve();
        if (this.sock) {
            const ws = this.sock.ws;
            if (ws && typeof ws.once === 'function') {
                closePromise = new Promise(resolve => {
                    const onClose = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    const timer = setTimeout(() => {
                        if (typeof ws.removeListener === 'function') ws.removeListener('close', onClose);
                        resolve();
                    }, 1500);
                    ws.once('close', onClose);
                });
            }
            try {
                this.sock.ev.removeAllListeners();
                if (ws) {
                    try { ws.close(); } catch (_) {}
                }
                this.sock.end(undefined);
            } catch (_) {}
            this.sock = null;
        }
        if (updateStatus) this.updateStatus('OFFLINE');
        return closePromise;
    }

    /**
     * Full cleanup
     */
    cleanup() {
        this.disconnect({ updateStatus: false });
        this.removeAllListeners();
    }
}

module.exports = WhatsAppSession;
