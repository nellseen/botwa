// ===================================================
//  NellsBotBase - Full Logging & Debug System
//  Writes to terminal and daily log file: ./logs/app-YYYY-MM-DD.log
//  Zero secret leakage, unhandled exception catching,
//  and message ACK / delivery tracking
// ===================================================

const fs = require('fs');
const path = require('path');
const util = require('util');

const LOGS_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Track operations for ACK / delivery correlation
// messageId -> { opId, tag, target, timestamp }
const activeMessageOps = new Map();

function pad(n) {
    return String(n).padStart(2, '0');
}

function getFormattedDate(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getTimestamp(d = new Date()) {
    return `${getFormattedDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getLogFilePath() {
    return path.join(LOGS_DIR, `app-${getFormattedDate()}.log`);
}

// Strip ANSI colors and sanitize sensitive info
function sanitize(input) {
    if (typeof input !== 'string') {
        input = util.format(input);
    }
    // Remove terminal ANSI color escape codes
    let text = input.replace(/\u001b\[[0-9;]*m/g, '');

    // Redact libsignal / crypto SessionEntry dumps
    if (text.includes('SessionEntry {') || text.includes('_chains:') || text.includes('currentRatchet:')) {
        const match = text.match(/registrationId:\s*(\d+)/);
        const reg = match ? `#${match[1]}` : '';
        text = text.replace(/Closing session:\s*SessionEntry\s*\{[\s\S]*?\}/g, `[SESSION] Closing session ${reg}`.trim());
    }

    // Redact private tokens/passwords if matched
    text = text.replace(/(token|password|rootKey|privKey|chainKey)=([^\s&]+)/gi, '$1=***REDACTED***');

    return text;
}

class AppLogger {
    constructor() {
        this.originalConsole = {
            log: console.log.bind(console),
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console)
        };
        this._isWriting = false;
    }

    _appendToFile(line) {
        try {
            const cleanLine = sanitize(line);
            fs.appendFileSync(getLogFilePath(), cleanLine + '\n', 'utf8');
        } catch (e) {
            this.originalConsole.error('Failed writing to log file:', e.message);
        }
    }

    write(level, tag, message, meta = null) {
        const ts = getTimestamp();
        const tagPrefix = tag ? `[${tag}] ` : '';
        let fullMessage = `${tagPrefix}${typeof message === 'string' ? message : util.inspect(message, { depth: 3 })}`;

        if (meta && typeof meta === 'object') {
            const metaStr = Object.entries(meta)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join(' ');
            if (metaStr) fullMessage += ` ${metaStr}`;
        }

        const logLine = `[${ts}] [${level}] ${fullMessage}`;

        // Terminal output with original console method
        if (level === 'ERROR') {
            this.originalConsole.error(logLine);
        } else if (level === 'WARN') {
            this.originalConsole.warn(logLine);
        } else {
            this.originalConsole.log(logLine);
        }

        // File output
        this._appendToFile(logLine);
    }

    info(tag, message, meta = null) {
        this.write('INFO', tag, message, meta);
    }

    warn(tag, message, meta = null) {
        this.write('WARN', tag, message, meta);
    }

    error(tag, message, error = null, operation = null) {
        const ts = getTimestamp();
        const tagPrefix = tag ? `[${tag}] ` : '';
        const opPrefix = operation ? `[op=${operation}] ` : '';

        const mainLine = `[${ts}] [ERROR] ${tagPrefix}${opPrefix}${message}`;
        this.originalConsole.error(mainLine);
        this._appendToFile(mainLine);

        if (error) {
            const errType = error.name || typeof error;
            const errMsg = error.message || String(error);
            const detailLine = `[${ts}] [ERROR] ${tagPrefix}ErrorType: ${errType} | Operation: ${operation || 'N/A'} | Message: ${errMsg}`;
            this.originalConsole.error(detailLine);
            this._appendToFile(detailLine);

            if (error.stack) {
                const stackLine = `[${ts}] [ERROR] ${tagPrefix}StackTrace:\n${error.stack}`;
                this.originalConsole.error(stackLine);
                this._appendToFile(stackLine);
            }
        }
    }

    debug(tag, message, meta = null) {
        this.write('DEBUG', tag, message, meta);
    }

    // Register an outgoing message for ACK / delivery receipt correlation
    registerMessageOp(messageId, opId, tag, target) {
        if (!messageId) return;
        activeMessageOps.set(messageId, {
            opId,
            tag: tag || 'MESSAGE',
            target: target || 'UNKNOWN',
            timestamp: Date.now()
        });

        // Prune after 10 minutes to prevent unbounded memory growth
        setTimeout(() => {
            activeMessageOps.delete(messageId);
        }, 10 * 60 * 1000).unref();
    }

    // Handle ACK from Baileys message status updates (status 2 = SERVER_ACK, 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED)
    handleMessageStatusUpdate(key, status) {
        if (!key || !key.id) return;
        const opData = activeMessageOps.get(key.id);
        if (!opData) return;

        let statusName = 'UNKNOWN';
        let stage = 'ACK_RECEIVED';

        if (status === 2) {
            statusName = 'SERVER_ACK';
            stage = 'ACK_RECEIVED';
        } else if (status === 3) {
            statusName = 'DELIVERY_ACK';
            stage = 'DELIVERY_CONFIRMED';
        } else if (status === 4) {
            statusName = 'READ';
            stage = 'DELIVERY_CONFIRMED';
        } else if (status === 5) {
            statusName = 'PLAYED';
            stage = 'DELIVERY_CONFIRMED';
        }

        this.info(`${opData.tag}][ACK`, `op=${opData.opId} stage=${stage} message_id=${key.id} target=${opData.target} status=${statusName}`);
    }

    // Intercept standard console calls to ensure 100% of terminal messages enter the log file
    hookConsole() {
        const self = this;

        console.log = function (...args) {
            if (self._isWriting) return self.originalConsole.log(...args);
            self._isWriting = true;
            try {
                const msg = util.format(...args);
                self.originalConsole.log(...args);
                // Check if already formatted with timestamp
                if (msg.startsWith('[20')) {
                    self._appendToFile(msg);
                } else {
                    const ts = getTimestamp();
                    self._appendToFile(`[${ts}] [INFO] ${msg}`);
                }
            } finally {
                self._isWriting = false;
            }
        };

        console.info = function (...args) {
            if (self._isWriting) return self.originalConsole.info(...args);
            self._isWriting = true;
            try {
                const msg = util.format(...args);
                self.originalConsole.info(...args);
                if (msg.startsWith('[20')) {
                    self._appendToFile(msg);
                } else {
                    const ts = getTimestamp();
                    self._appendToFile(`[${ts}] [INFO] ${msg}`);
                }
            } finally {
                self._isWriting = false;
            }
        };

        console.warn = function (...args) {
            if (self._isWriting) return self.originalConsole.warn(...args);
            self._isWriting = true;
            try {
                const msg = util.format(...args);
                self.originalConsole.warn(...args);
                if (msg.startsWith('[20')) {
                    self._appendToFile(msg);
                } else {
                    const ts = getTimestamp();
                    self._appendToFile(`[${ts}] [WARN] ${msg}`);
                }
            } finally {
                self._isWriting = false;
            }
        };

        console.error = function (...args) {
            if (self._isWriting) return self.originalConsole.error(...args);
            self._isWriting = true;
            try {
                const msg = util.format(...args);
                self.originalConsole.error(...args);
                if (msg.startsWith('[20')) {
                    self._appendToFile(msg);
                } else {
                    const ts = getTimestamp();
                    self._appendToFile(`[${ts}] [ERROR] ${msg}`);
                }
            } finally {
                self._isWriting = false;
            }
        };

        // Global unhandled exceptions & process lifecycle hooks
        process.on('uncaughtException', (err) => {
            self.error('SYSTEM', 'Uncaught Exception detected in runtime', err, 'GLOBAL_UNCAUGHT_EXCEPTION');
        });

        process.on('unhandledRejection', (reason, promise) => {
            const err = reason instanceof Error ? reason : new Error(String(reason));
            self.error('SYSTEM', 'Unhandled Promise Rejection detected', err, 'GLOBAL_UNHANDLED_REJECTION');
        });

        process.on('exit', (code) => {
            const ts = getTimestamp();
            self._appendToFile(`[${ts}] [INFO] [SYSTEM] Process exiting with code: ${code}`);
        });

        this.info('SYSTEM', 'Logging and debug system initialized successfully. Daily log active.');
    }
}

const logger = new AppLogger();
module.exports = logger;
