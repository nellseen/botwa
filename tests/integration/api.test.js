const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app, startServer } = require('../../index');

describe('Integration Test: Express API Endpoints', () => {
    let server;
    const testPort = 3099;
    const baseUrl = `http://127.0.0.1:${testPort}`;

    before(async () => {
        server = await startServer(testPort, '127.0.0.1');
    });

    after(() => {
        if (server) server.close();
    });

    async function req(url, options = {}) {
        const res = await fetch(`${baseUrl}${url}`, {
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            ...options
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, body: json };
    }

    it('GET /api/status should return 200 with complete system & session metadata', async () => {
        const res = await req('/api/status');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ONLINE');
        assert.ok(res.body.name, 'name should exist');
        assert.ok(res.body.sessions, 'sessions object should exist');
        assert.ok(typeof res.body.sessions.total === 'number');
        assert.ok(res.body.plugins, 'plugins object should exist');
        assert.ok(res.body.system.memory, 'memory should exist');
    });

    it('GET /api/plugins should return all registered plugins and categories', async () => {
        const res = await req('/api/plugins');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.total >= 12);
        assert.ok(Array.isArray(res.body.plugins));
    });

    it('POST /api/sessions/create should reject invalid phone numbers with 400', async () => {
        const res = await req('/api/sessions/create', {
            method: 'POST',
            body: JSON.stringify({ userId: 'test_user', phoneNumber: '123' })
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.success, false);
    });

    it('POST /api/sessions/create should succeed with valid phone number', async () => {
        const testPhone = '628999999901';
        const res = await req('/api/sessions/create', {
            method: 'POST',
            body: JSON.stringify({ userId: 'test_integration_user', phoneNumber: testPhone })
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.sessionId);
        assert.strictEqual(res.body.phoneNumber, testPhone);

        const sessionId = res.body.sessionId;

        // Disconnect session
        const dis = await req(`/api/sessions/${sessionId}/disconnect`, { method: 'POST' });
        assert.strictEqual(dis.status, 200);
        assert.strictEqual(dis.body.status, 'OFFLINE');

        // Reset session
        const resetRes = await req(`/api/sessions/${sessionId}/reset`, { method: 'POST' });
        assert.strictEqual(resetRes.status, 200);

        // Delete session
        const delRes = await req(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        assert.strictEqual(delRes.status, 200);
        assert.strictEqual(delRes.body.success, true);
    });

    it('POST /api/simulate-message should process incoming command and invoke MessageRouter', async () => {
        const res = await req('/api/simulate-message', {
            method: 'POST',
            body: JSON.stringify({
                sender: '62895400835519@s.whatsapp.net',
                chat: '62895400835519@s.whatsapp.net',
                text: '/menu',
                fromMe: false,
                isGroup: false
            })
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.repliesCount >= 1, 'Should produce at least 1 reply message');
    });

    it('POST /api/simulate-message should test owner command execution', async () => {
        const res = await req('/api/simulate-message', {
            method: 'POST',
            body: JSON.stringify({
                sender: '62895400835519@s.whatsapp.net',
                chat: '62895400835519@s.whatsapp.net',
                text: '/owner',
                fromMe: false,
                isGroup: false
            })
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.repliesCount >= 1);
        const replyText = res.body.replies[0]?.content?.text || '';
        assert.match(replyText, /Owner/i);
    });
});
