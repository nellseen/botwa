// ===================================================
//  NellsBotBase - Multi-Session Manager
//  Handles session registry, isolation, persistence,
//  and secure session resets without wiping databases
// ===================================================

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const WhatsAppSession = require('./WhatsAppSession');
const MessageRouter = require('./MessageRouter');
const EventEmitter = require('events');
const logger = require('../lib/logger');

class SessionManager extends EventEmitter {
    constructor(sessionsDir) {
        super();
        this.sessionsDir = sessionsDir;
        this.sessions = new Map(); // sessionId -> WhatsAppSession
        const configuredMaxSessions = Number(process.env.MAX_SESSIONS);
        this.maxSessions = Number.isInteger(configuredMaxSessions) && configuredMaxSessions > 0
            ? Math.min(configuredMaxSessions, 1000)
            : 100;
        this.metadataPath = path.join(sessionsDir, 'metadata.json');
        this.metadataBackupPath = path.join(sessionsDir, 'metadata.json.bak');

        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        }
        this.sessionsRoot = fs.realpathSync(sessionsDir);
        try { fs.chmodSync(this.sessionsRoot, 0o700); } catch (_) {}
        this.loadMetadata();
    }

    loadMetadata() {
        if (fs.existsSync(this.metadataPath)) {
            try {
                this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
                if (!this.metadata || typeof this.metadata !== 'object' || Array.isArray(this.metadata)) this.metadata = {};
            } catch (err) {
                logger.error('SESSION_MANAGER', 'Corrupt metadata.json, attempting backup restore', err);
                if (fs.existsSync(this.metadataBackupPath)) {
                    try {
                        this.metadata = JSON.parse(fs.readFileSync(this.metadataBackupPath, 'utf8'));
                        if (!this.metadata || typeof this.metadata !== 'object' || Array.isArray(this.metadata)) this.metadata = {};
                        logger.info('SESSION_MANAGER', 'Metadata restored from backup successfully');
                    } catch (_) {
                        this.metadata = {};
                    }
                } else {
                    this.metadata = {};
                }
            }
        } else {
            this.metadata = {};
        }
    }

    saveMetadata() {
        try {
            const data = JSON.stringify(this.metadata, null, 2);
            const tempPath = `${this.metadataPath}.${process.pid}.tmp`;
            const backupTemp = `${this.metadataBackupPath}.${process.pid}.tmp`;
            fs.writeFileSync(tempPath, data, { encoding: 'utf8', mode: 0o600 });
            fs.writeFileSync(backupTemp, data, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(backupTemp, this.metadataBackupPath);
            fs.renameSync(tempPath, this.metadataPath);
        } catch (err) {
            logger.error('SESSION_MANAGER', 'Failed to save session metadata', err);
        }
    }

    async restoreSessions() {
        logger.info('SESSION_MANAGER', 'Restoring saved sessions...');
        this.migrateLegacySession();

        const entries = Object.entries(this.metadata);
        const configuredConcurrency = Number(process.env.SESSION_RESTORE_CONCURRENCY);
        const concurrency = Math.max(1, Math.min(10, Number.isFinite(configuredConcurrency) && configuredConcurrency > 0 ? Math.floor(configuredConcurrency) : 3));
        for (let index = 0; index < entries.length; index += concurrency) {
            if (this.sessions.size >= this.maxSessions) {
                logger.warn('SESSION_MANAGER', `Session restore stopped at configured limit (${this.maxSessions}).`);
                break;
            }
            const batch = entries.slice(index, index + concurrency);
            await Promise.all(batch.map(async ([sessionId, data]) => {
                try {
                    const userId = String(data.userId || 'default_user');
                    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId) || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
                        throw new Error('ID user atau sesi tidak valid.');
                    }
                    const authFolder = path.resolve(this.sessionsRoot, userId, sessionId);
                    if (!this.isWithinSessionsDir(authFolder) || !fs.existsSync(authFolder)) {
                        logger.warn('SESSION_MANAGER', `Skipping session ${sessionId}: folder autentikasi tidak ditemukan.`);
                        return;
                    }
                    await this.createSession(data.userId, data.phoneNumber, sessionId, true);
                } catch (err) {
                    logger.warn('SESSION_MANAGER', `Skipping session ${sessionId}: ${err.message}`);
                }
            }));
        }
        logger.info('SESSION_MANAGER', `Restored ${this.sessions.size} active sessions.`);
    }

    migrateLegacySession() {
        const legacyPath = path.join(__dirname, '..', 'session');
        if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isDirectory()) {
            logger.info('SESSION_MANAGER', 'Legacy ./session folder found. Migrating to session pool...');
            const legacyUserId = "999999999";
            const sessionId = `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
            const newAuthFolder = path.join(this.sessionsRoot, legacyUserId, sessionId);

            try {
                fs.mkdirSync(path.dirname(newAuthFolder), { recursive: true, mode: 0o700 });
                fs.renameSync(legacyPath, newAuthFolder);

                this.metadata[sessionId] = {
                    sessionId,
                    userId: legacyUserId,
                    phoneNumber: "",
                    createdAt: new Date().toISOString()
                };
                this.saveMetadata();
                logger.info('SESSION_MANAGER', `Legacy session migrated to ${sessionId} under user ${legacyUserId}`);
            } catch (err) {
                logger.error('SESSION_MANAGER', 'Failed to migrate legacy session', err);
            }
        }
    }

    /**
     * Creates a new session with isolation per user and number
     */
    async createSession(userId, phoneNumber = '', explicitSessionId = null, shouldConnect = true) {
        const cleanPhone = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : '';
        const userStr = String(userId || 'default_user');
        const sessionId = explicitSessionId || `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
        if (cleanPhone && (cleanPhone.length < 8 || cleanPhone.length > 15)) throw new Error('Nomor WhatsApp harus berisi 8 sampai 15 digit.');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(userStr) || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
            throw new Error('ID user atau sesi tidak valid.');
        }
        if (this.sessions.has(sessionId)) throw new Error(`Sesi ${sessionId} sudah aktif.`);
        if (this.sessions.size >= this.maxSessions) throw new Error(`Batas sesi tercapai (${this.maxSessions}).`);

        // Prevent duplicate numbers across different sessions
        if (cleanPhone) {
            for (const [sId, sess] of this.sessions.entries()) {
                if (sess.phoneNumber === cleanPhone && (!explicitSessionId || sId !== explicitSessionId)) {
                    throw new Error(`Nomor ${cleanPhone} sudah terdaftar pada sesi lain (${sId}).`);
                }
            }
        }

        const userFolder = path.resolve(this.sessionsRoot, userStr);
        if (!this.isWithinSessionsDir(userFolder)) throw new Error('Lokasi sesi di luar direktori yang diizinkan.');
        if (!fs.existsSync(userFolder)) fs.mkdirSync(userFolder, { recursive: true, mode: 0o700 });
        if (!this.isWithinSessionsDir(fs.realpathSync(userFolder))) throw new Error('Lokasi sesi di luar direktori yang diizinkan.');
        try { fs.chmodSync(userFolder, 0o700); } catch (_) {}
        const authFolder = path.resolve(userFolder, sessionId);
        if (!this.isWithinSessionsDir(authFolder)) throw new Error('Lokasi sesi di luar direktori yang diizinkan.');

        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true, mode: 0o700 });
        }
        if (!this.isWithinSessionsDir(fs.realpathSync(authFolder))) throw new Error('Lokasi sesi di luar direktori yang diizinkan.');
        try { fs.chmodSync(authFolder, 0o700); } catch (_) {}

        this.metadata[sessionId] = {
            sessionId,
            userId: userStr,
            phoneNumber: cleanPhone,
            createdAt: this.metadata[sessionId]?.createdAt || new Date().toISOString()
        };
        this.saveMetadata();

        const session = new WhatsAppSession(sessionId, userStr, cleanPhone, authFolder);

        session.on('status', (info) => {
            this.emit('status', info);
        });

        session.on('message', (data) => {
            MessageRouter.handleMessage(session, data.sock, data.m, data.store);
        });

        this.sessions.set(sessionId, session);

        if (shouldConnect) {
            await session.connect();
        }

        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    isWithinSessionsDir(candidate) {
        const relative = path.relative(this.sessionsRoot, path.resolve(candidate));
        return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }

    getUserSessions(userId) {
        const userStr = String(userId);
        const result = [];
        for (const session of this.sessions.values()) {
            if (session.userId === userStr) {
                result.push(session);
            }
        }
        return result;
    }

    getAllSessions() {
        return Array.from(this.sessions.values());
    }

    /**
     * Resets authentication state for a specific session without affecting databases or other sessions
     */
    async resetSession(sessionId, reconnect = true) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Sesi ${sessionId} tidak ditemukan.`);
        }

        session.resetAuthState();

        if (this.metadata[sessionId]) {
            this.metadata[sessionId].updatedAt = new Date().toISOString();
            this.saveMetadata();
        }

        if (reconnect) {
            await session.connect();
        }

        return session;
    }

    /**
     * Resets all sessions for a specific user or globally
     */
    async resetAllSessions(userId = null) {
        const sessionsToReset = userId ? this.getUserSessions(userId) : this.getAllSessions();
        logger.info('SESSION_MANAGER', `Resetting ${sessionsToReset.length} sessions...`);

        for (const session of sessionsToReset) {
            session.resetAuthState();
        }
        this.saveMetadata();
        return { count: sessionsToReset.length };
    }

    /**
     * Cleanly deletes a session and its authentication directory
     */
    async deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.cleanup();
            this.sessions.delete(sessionId);

            // Delete auth folder safely
            if (fs.existsSync(session.authFolder) && this.isWithinSessionsDir(fs.realpathSync(session.authFolder))) {
                try {
                    fs.rmSync(session.authFolder, { recursive: true, force: true });
                } catch (err) {
                    logger.error('SESSION_MANAGER', `Error removing authFolder for ${sessionId}`, err);
                }
            }
        }

        if (this.metadata[sessionId]) {
            delete this.metadata[sessionId];
            this.saveMetadata();
        }

        return true;
    }

    /**
     * Serializes sessions for API responses (safely omitting sensitive keys)
     */
    toJSON() {
        return this.getAllSessions().map(s => ({
            sessionId: s.sessionId,
            userId: s.userId,
            phoneNumber: s.phoneNumber,
            status: s.status,
            pairingCode: s.pairingCode,
            reconnectAttempts: s.reconnectAttempts,
            createdAt: this.metadata[s.sessionId]?.createdAt || null
        }));
    }
}

module.exports = SessionManager;
