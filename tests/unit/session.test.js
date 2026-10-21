const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const SessionManager = require('../../core/SessionManager');
const WhatsAppSession = require('../../core/WhatsAppSession');

describe('Unit Test: Session & Multi-Session Logic', () => {
    const testDir = path.join(__dirname, 'temp_sessions_unit');
    let sm;

    before(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
        fs.mkdirSync(testDir, { recursive: true });
        sm = new SessionManager(testDir);
    });

    after(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('WhatsAppSession should initialize with OFFLINE status and clean properties', () => {
        const session = new WhatsAppSession('test_sess_01', 'user123', '62812345678', path.join(testDir, 'test_sess_01'));
        assert.strictEqual(session.sessionId, 'test_sess_01');
        assert.strictEqual(session.userId, 'user123');
        assert.strictEqual(session.phoneNumber, '62812345678');
        assert.strictEqual(session.status, 'OFFLINE');
        assert.strictEqual(session.manualDisconnect, false);
    });

    it('WhatsAppSession updateStatus should emit status events', (t, done) => {
        const session = new WhatsAppSession('test_sess_02', 'user123', '62812345678', path.join(testDir, 'test_sess_02'));
        session.on('status', (info) => {
            assert.strictEqual(info.status, 'CONNECTING');
            assert.strictEqual(info.sessionId, 'test_sess_02');
            done();
        });
        session.updateStatus('CONNECTING');
    });

    it('WhatsAppSession disconnect should immediately set status to OFFLINE', () => {
        const session = new WhatsAppSession('test_sess_03', 'user123', '62812345678', path.join(testDir, 'test_sess_03'));
        session.status = 'ONLINE';
        session.disconnect();
        assert.strictEqual(session.status, 'OFFLINE');
        assert.strictEqual(session.manualDisconnect, true);
    });

    it('WhatsAppSession resetAuthState should clean auth folder and reset state', () => {
        const authPath = path.join(testDir, 'test_reset_auth');
        fs.mkdirSync(authPath, { recursive: true });
        fs.writeFileSync(path.join(authPath, 'creds.json'), '{"test":1}');

        const session = new WhatsAppSession('test_sess_04', 'user123', '62812345678', authPath);
        session.reconnectAttempts = 4;
        session.resetAuthState();

        assert.strictEqual(session.reconnectAttempts, 0);
        assert.strictEqual(session.status, 'OFFLINE');
        assert.strictEqual(fs.existsSync(path.join(authPath, 'creds.json')), false);
    });

    it('SessionManager should create distinct isolated sessions for different users', async () => {
        const s1 = await sm.createSession('user_A', '62811111111', 'sess_a1', false);
        const s2 = await sm.createSession('user_B', '62822222222', 'sess_b1', false);

        assert.strictEqual(s1.userId, 'user_A');
        assert.strictEqual(s2.userId, 'user_B');
        assert.strictEqual(sm.getAllSessions().length, 2);

        const userASessions = sm.getUserSessions('user_A');
        assert.strictEqual(userASessions.length, 1);
        assert.strictEqual(userASessions[0].sessionId, 'sess_a1');
    });

    it('SessionManager should reject duplicate phone numbers across sessions', async () => {
        await assert.rejects(
            async () => {
                await sm.createSession('user_C', '62811111111', null, false);
            },
            /sudah terdaftar/
        );
    });

    it('SessionManager resetSession should reset auth state safely', async () => {
        const s = await sm.resetSession('sess_a1', false);
        assert.strictEqual(s.status, 'OFFLINE');
        assert.strictEqual(s.reconnectAttempts, 0);
    });

    it('SessionManager deleteSession should remove session from memory and metadata', async () => {
        await sm.deleteSession('sess_a1');
        assert.strictEqual(sm.getSession('sess_a1'), null);
        assert.strictEqual(sm.metadata['sess_a1'], undefined);
    });
});
