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
        this.metadataPath = path.join(sessionsDir, 'metadata.json');
        this.metadataBackupPath = path.join(sessionsDir, 'metadata.json.bak');

        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        this.loadMetadata();
    }

    loadMetadata() {
        if (fs.existsSync(this.metadataPath)) {
            try {
                this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
            } catch (err) {
                logger.error('SESSION_MANAGER', 'Corrupt metadata.json, attempting backup restore', err);
                if (fs.existsSync(this.metadataBackupPath)) {
                    try {
                        this.metadata = JSON.parse(fs.readFileSync(this.metadataBackupPath, 'utf8'));
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
            // Write to backup first for atomic safety
            fs.writeFileSync(this.metadataBackupPath, data, 'utf8');
            fs.writeFileSync(this.metadataPath, data, 'utf8');
        } catch (err) {
            logger.error('SESSION_MANAGER', 'Failed to save session metadata', err);
        }
    }

    async restoreSessions() {
        logger.info('SESSION_MANAGER', 'Restoring saved sessions...');
        this.migrateLegacySession();

        for (const [sessionId, data] of Object.entries(this.metadata)) {
            try {
                // Restore session object in memory with shouldConnect=false so sessions aren't forcibly spun up all at once
                await this.createSession(data.userId, data.phoneNumber, sessionId, false);
            } catch (err) {
                logger.warn('SESSION_MANAGER', `Skipping session ${sessionId}: ${err.message}`);
            }
        }
        logger.info('SESSION_MANAGER', `Restored ${this.sessions.size} active sessions.`);
    }

    migrateLegacySession() {
        const legacyPath = path.join(process.cwd(), 'session');
        if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isDirectory()) {
            logger.info('SESSION_MANAGER', 'Legacy ./session folder found. Migrating to session pool...');
            const legacyUserId = "999999999";
            const sessionId = `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
            const newAuthFolder = path.join(this.sessionsDir, legacyUserId, sessionId);

            try {
                fs.mkdirSync(path.dirname(newAuthFolder), { recursive: true });
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

        // Prevent duplicate numbers across different sessions
        if (cleanPhone) {
            for (const [sId, sess] of this.sessions.entries()) {
                if (sess.phoneNumber === cleanPhone && (!explicitSessionId || sId !== explicitSessionId)) {
                    throw new Error(`Nomor ${cleanPhone} sudah terdaftar pada sesi lain (${sId}).`);
                }
            }
        }

        const sessionId = explicitSessionId || `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
        const authFolder = path.join(this.sessionsDir, userStr, sessionId);

        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }

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
            if (fs.existsSync(session.authFolder)) {
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
