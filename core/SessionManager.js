const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const chalk = require('chalk');
const WhatsAppSession = require('./WhatsAppSession');
const MessageRouter = require('./MessageRouter');
const EventEmitter = require('events');

class SessionManager extends EventEmitter {
    constructor(sessionsDir) {
        super();
        this.sessionsDir = sessionsDir;
        this.sessions = new Map(); // sessionId -> WhatsAppSession
        this.metadataPath = path.join(sessionsDir, 'metadata.json');
        
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
                this.metadata = {};
            }
        } else {
            this.metadata = {};
        }
    }

    saveMetadata() {
        fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2));
    }

    async restoreSessions() {
        console.log('[SESSION MANAGER] Restoring sessions...');
        this.migrateLegacySession();
        
        for (const [sessionId, data] of Object.entries(this.metadata)) {
            try {
                await this.createSession(data.userId, data.phoneNumber, sessionId, false);
            } catch (err) {
                console.warn(chalk.yellow(`[SESSION MANAGER] Skipping session ${sessionId}: ${err.message}`));
            }
        }
    }

    migrateLegacySession() {
        const legacyPath = path.join(process.cwd(), 'session');
        if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isDirectory()) {
            console.log(chalk.blue('[SESSION MANAGER] Legacy ./session folder found. Migrating...'));
            // Create a default user ID for legacy session if not exists
            const legacyUserId = "999999999"; 
            const sessionId = `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
            const newAuthFolder = path.join(this.sessionsDir, legacyUserId, sessionId);
            
            try {
                fs.mkdirSync(path.dirname(newAuthFolder), { recursive: true });
                fs.renameSync(legacyPath, newAuthFolder);
                
                this.metadata[sessionId] = {
                    sessionId,
                    userId: legacyUserId,
                    phoneNumber: "Legacy_Number",
                    createdAt: new Date().toISOString()
                };
                this.saveMetadata();
                console.log(chalk.green(`[SESSION MANAGER] Legacy session migrated to ${sessionId} under user ${legacyUserId}`));
            } catch (err) {
                console.error(chalk.red('[SESSION MANAGER] Failed to migrate legacy session:'), err);
            }
        }
    }

    async createSession(userId, phoneNumber, explicitSessionId = null, shouldConnect = true) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        // Prevent duplicate numbers across all sessions (if phone number is set)
        if (cleanPhone) {
            for (const sess of this.sessions.values()) {
                if (sess.phoneNumber === cleanPhone) {
                    throw new Error('Number already registered in another session.');
                }
            }
        }

        const sessionId = explicitSessionId || `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
        const authFolder = path.join(this.sessionsDir, userId.toString(), sessionId);
        
        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }

        this.metadata[sessionId] = {
            sessionId,
            userId: userId.toString(),
            phoneNumber: cleanPhone,
            createdAt: this.metadata[sessionId]?.createdAt || new Date().toISOString()
        };
        this.saveMetadata();

        const session = new WhatsAppSession(sessionId, userId.toString(), cleanPhone, authFolder);
        
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
        return this.sessions.get(sessionId);
    }

    getUserSessions(userId) {
        const result = [];
        for (const session of this.sessions.values()) {
            if (session.userId === userId.toString()) {
                result.push(session);
            }
        }
        return result;
    }

    getAllSessions() {
        return Array.from(this.sessions.values());
    }

    async deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.cleanup();
            this.sessions.delete(sessionId);
            
            // Delete auth folder
            if (fs.existsSync(session.authFolder)) {
                fs.rmSync(session.authFolder, { recursive: true, force: true });
            }
        }

        if (this.metadata[sessionId]) {
            delete this.metadata[sessionId];
            this.saveMetadata();
        }
    }
}

module.exports = SessionManager;
