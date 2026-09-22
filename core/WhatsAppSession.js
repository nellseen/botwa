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
const chalk = require("chalk");
const { smsg } = require('../lib/myfunc');

class WhatsAppSession extends EventEmitter {
    constructor(sessionId, userId, phoneNumber, authFolder) {
        super();
        this.sessionId = sessionId;
        this.userId = userId;
        this.phoneNumber = phoneNumber;
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
    }

    async connect() {
        if (this.status === 'CONNECTING' || this.status === 'ONLINE') return;
        this.manualDisconnect = false;
        this.socketGeneration++;
        const currentGen = this.socketGeneration;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.updateStatus('CONNECTING');

        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
        const { version } = await fetchLatestBaileysVersion();

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

        this.sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (currentGen !== this.socketGeneration) return;
            
            if (connection === 'open') {
                this.reconnectAttempts = 0;
                this.updateStatus('ONLINE');
                this.pairingCode = null;
                console.log(chalk.green(`[${this.sessionId}] WhatsApp connection established successfully.`));
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                let reasonText = 'Koneksi terputus';
                if (statusCode === DisconnectReason.loggedOut) reasonText = 'Sesi di-logout dari WhatsApp (401)';
                else if (statusCode === DisconnectReason.restartRequired) reasonText = 'WhatsApp meminta restart koneksi (515)';
                else if (statusCode === DisconnectReason.timedOut) reasonText = 'Koneksi timeout (408)';
                else if (statusCode === DisconnectReason.connectionLost) reasonText = 'Koneksi jaringan terputus';
                else if (statusCode === DisconnectReason.badSession) reasonText = 'Data sesi rusak / corrupt (500)';
                else if (statusCode === DisconnectReason.connectionReplaced) reasonText = 'Koneksi ditimpa sesi lain (440)';
                else if (statusCode === 429) reasonText = 'Terkena batasan frekuensi / rate limit (429)';
                else if (statusCode) reasonText = `Error Code ${statusCode}`;

                console.log(chalk.yellow(`[${this.sessionId}] Connection closed: ${reasonText}`));

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

        this.sock.ev.on('creds.update', (creds) => {
            if (currentGen !== this.socketGeneration) return;
            saveCreds(creds);
        });

        this.sock.ev.on('messages.upsert', async ({ messages }) => {
            if (currentGen !== this.socketGeneration) return;
            
            for (const mek of messages) {
                try {
                    if (!mek.message) continue;
                    if (mek.key.remoteJid === 'status@broadcast') continue;

                    const m = smsg(this.sock, mek, this.store);
                    if (!m) continue;

                    this.emit('message', { sock: this.sock, m, store: this.store });
                } catch (err) {
                    console.error(chalk.red(`[${this.sessionId}] Error handling message:`), err);
                }
            }
        });

        if (!this.sock.authState.creds.registered) {
            this.updateStatus('PAIRING');
        }
    }

    async requestPairingCode() {
        if (!this.sock) return null;
        if (this.sock.authState?.creds?.registered) return null;

        try {
            console.log(chalk.yellow(`[${this.sessionId}] Requesting pairing code for: ${this.phoneNumber}...`));
            let code;
            try {
                code = await this.sock.requestPairingCode(this.phoneNumber, "NELLSBOT");
            } catch (e) {
                code = await this.sock.requestPairingCode(this.phoneNumber);
            }
            if (code) {
                const formatted = code.match(/.{1,4}/g)?.join("-") || code;
                this.pairingCode = formatted;
                this.updateStatus('PAIRING', { pairingCode: formatted });
                return formatted;
            }
            return null;
        } catch (err) {
            console.error(chalk.red(`[${this.sessionId}] Failed to request pairing code:`), err);
            return null;
        }
    }

    resetAuthState() {
        console.log(chalk.blue(`[${this.sessionId}] Resetting auth state in ${this.authFolder}...`));
        try {
            if (fs.existsSync(this.authFolder)) {
                fs.rmSync(this.authFolder, { recursive: true, force: true });
                fs.mkdirSync(this.authFolder, { recursive: true });
            }
        } catch (err) {
            console.error(chalk.red(`[${this.sessionId}] Error clearing auth folder:`), err);
        }
        this.pairingCode = null;
        this.reconnectAttempts = 0;
        this.manualDisconnect = false;
    }

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

    handleReconnect(statusCode) {
        if (this.manualDisconnect) return;
        
        // Restart required (515) - reconnect immediately without consuming retry attempts
        if (statusCode === DisconnectReason.restartRequired) {
            console.log(chalk.cyan(`[${this.sessionId}] WhatsApp requested restart (515). Reconnecting in 500ms...`));
            this.reconnectTimer = setTimeout(() => this.connect(), 500);
            return;
        }

        // Rate limit (429) - wait 45-60 seconds to avoid WhatsApp IP/account block
        if (statusCode === 429) {
            const delay = 45000 + Math.floor(Math.random() * 15000);
            console.log(chalk.yellow(`[${this.sessionId}] WhatsApp rate limited (429). Waiting ${Math.round(delay / 1000)}s before retry...`));
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
            return;
        }

        if (this.reconnectAttempts < this.maxReconnect) {
            this.reconnectAttempts++;
            // Exponential backoff with jitter
            const baseDelay = Math.min(1500 * Math.pow(2, this.reconnectAttempts - 1), 60000);
            const jitter = Math.floor(Math.random() * 1000);
            const delay = baseDelay + jitter;
            
            console.log(chalk.yellow(`[${this.sessionId}] Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnect})`));
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        } else {
            console.log(chalk.red(`[${this.sessionId}] Max reconnect attempts reached.`));
            this.updateStatus('OFFLINE', { reason: 'Maksimum percobaan koneksi tercapai. Silakan coba sambungkan kembali manual.' });
        }
    }

    disconnect() {
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.sock) {
            this.sock.end(undefined);
            // Don't set null right away, let connection.update trigger offline
        } else {
            this.updateStatus('OFFLINE');
        }
    }

    cleanup() {
        this.disconnect();
        this.removeAllListeners();
    }
}

module.exports = WhatsAppSession;
