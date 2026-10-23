const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../../index');
const MessageRouter = require('../../core/MessageRouter');

describe('Regression Security Test: Message Simulation & Authorization Gates', () => {
    let server;
    const testPort = 3098;
    const baseUrl = `http://127.0.0.1:${testPort}`;
    const validKey = 'test-simulation-secret';
    const ownerJid = '62895400835519@s.whatsapp.net';
    const markerFile = path.join('/tmp', 'pwned_regression_marker.txt');

    before(async () => {
        process.env.SIMULATION_API_KEY = validKey;
        if (fs.existsSync(markerFile)) {
            fs.unlinkSync(markerFile);
        }
        server = await startServer(testPort, '127.0.0.1');
    });

    after(() => {
        if (server) server.close();
        if (fs.existsSync(markerFile)) {
            fs.unlinkSync(markerFile);
        }
    });

    async function sendSimulationRequest(body, headers = {}) {
        const res = await fetch(`${baseUrl}/api/simulate-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            body: JSON.stringify(body)
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, body: json };
    }

    it('1. Request tanpa autentikasi harus ditolak dengan 401 Unauthorized', async () => {
        // Request tanpa header autentikasi sama sekali
        const resNoAuth = await sendSimulationRequest({
            sender: ownerJid,
            text: '$ id'
        });
        assert.strictEqual(resNoAuth.status, 401, 'Request tanpa autentikasi harus menghasilkan status 401');
        assert.strictEqual(resNoAuth.body.success, false);
        assert.match(resNoAuth.body.error, /Unauthorized|Autentikasi/i);

        // Request dengan API key yang salah / invalid
        const resBadKey = await sendSimulationRequest(
            { sender: ownerJid, text: '$ id' },
            { 'x-api-key': 'attacker-invalid-key-999' }
        );
        assert.strictEqual(resBadKey.status, 401, 'Request dengan key invalid harus menghasilkan status 401');
        assert.strictEqual(resBadKey.body.success, false);
    });

    it('2. Endpoint simulasi harus dinonaktifkan di production secara default (403 Forbidden)', async () => {
        const originalEnv = process.env.NODE_ENV;
        const originalEnable = process.env.ENABLE_SIMULATION;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.ENABLE_SIMULATION;

            const res = await sendSimulationRequest(
                { sender: ownerJid, text: '/menu' },
                { 'x-api-key': validKey }
            );

            assert.strictEqual(res.status, 403, 'Di environment production, simulasi harus mengembalikan 403 Forbidden');
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.error, /dinonaktifkan|production/i);
        } finally {
            process.env.NODE_ENV = originalEnv;
            if (originalEnable !== undefined) {
                process.env.ENABLE_SIMULATION = originalEnable;
            } else {
                delete process.env.ENABLE_SIMULATION;
            }
        }
    });

    it('3. Sender palsu mengaku owner tidak boleh dapat mengeksekusi shell ($)', async () => {
        const canaryOutput = 'CANARY_PWN_CHECK_SUCCESS';
        const res = await sendSimulationRequest(
            {
                sender: ownerJid, // Mengaku sebagai JID owner
                fromMe: true,     // Mengaku pesan berasal dari bot/owner
                isCreator: true,  // Klaim otorisasi dari klien
                chat: ownerJid,
                text: `$ echo "${canaryOutput}" && touch ${markerFile}`
            },
            { 'x-api-key': validKey }
        );

        assert.strictEqual(res.status, 200);
        // Pastikan tidak ada file yang terbuat di disk melalui exec()
        assert.strictEqual(fs.existsSync(markerFile), false, 'Perintah shell TIDAK BOLEH dieksekusi di server');

        // Pastikan balasan tidak mengandung output shell canary
        const allRepliesText = (res.body.replies || [])
            .map(r => JSON.stringify(r.content || ''))
            .join(' ');
        assert.strictEqual(allRepliesText.includes(canaryOutput), false, 'Output shell tidak boleh ada di balasan');
        assert.match(allRepliesText, /Akses ditolak|dilarang/i, 'Harus menyatakan akses ditolak');
    });

    it('4. Pesan berisi kode JavaScript (=>) tidak boleh dievaluasi via eval()', async () => {
        const res = await sendSimulationRequest(
            {
                sender: ownerJid,
                fromMe: true,
                isCreator: true,
                text: '=> 12345 * 54321'
            },
            { 'x-api-key': validKey }
        );

        assert.strictEqual(res.status, 200);
        const evalCanary = String(12345 * 54321); // 670592745
        const allRepliesText = (res.body.replies || [])
            .map(r => JSON.stringify(r.content || ''))
            .join(' ');

        assert.strictEqual(allRepliesText.includes(evalCanary), false, 'Hasil eval() tidak boleh muncul');
        assert.match(allRepliesText, /Akses ditolak|dilarang/i);
    });

    it('5. Pesan berisi plugin owner (/addowner, /modebot) tidak boleh dieksekusi', async () => {
        const ownerDbPath = path.join(__dirname, '../../lib/database/owner.json');
        const beforeOwnerDb = fs.readFileSync(ownerDbPath, 'utf8');

        // Percobaan menambahkan nomor penyerang menjadi owner baru
        const attackerNumber = '6289999888877';
        const res = await sendSimulationRequest(
            {
                sender: ownerJid,
                fromMe: true,
                isCreator: true,
                text: `/addowner ${attackerNumber}`
            },
            { 'x-api-key': validKey }
        );

        assert.strictEqual(res.status, 200);

        // Database owner tidak boleh berubah
        const afterOwnerDb = fs.readFileSync(ownerDbPath, 'utf8');
        assert.strictEqual(afterOwnerDb, beforeOwnerDb, 'Database owner TIDAK BOLEH termodifikasi oleh simulasi');

        const allRepliesText = (res.body.replies || [])
            .map(r => JSON.stringify(r.content || ''))
            .join(' ');
        assert.strictEqual(allRepliesText.includes('TELAH MENJADI OWNER'), false);
        assert.match(allRepliesText, /Akses ditolak|dilarang/i);
    });

    it('6. Fitur bot publik (menu, info owner) tetap dapat berjalan normal di simulasi', async () => {
        const resMenu = await sendSimulationRequest(
            {
                sender: '628111222333@s.whatsapp.net',
                text: '/menu'
            },
            { 'x-api-key': validKey }
        );

        assert.strictEqual(resMenu.status, 200);
        assert.ok(resMenu.body.repliesCount >= 1, 'Menu harus memberikan respons');

        const resOwnerInfo = await sendSimulationRequest(
            {
                sender: '628111222333@s.whatsapp.net',
                text: '/owner'
            },
            { 'x-api-key': validKey }
        );

        assert.strictEqual(resOwnerInfo.status, 200);
        assert.ok(resOwnerInfo.body.repliesCount >= 1);
        const replyText = resOwnerInfo.body.replies[0]?.content?.text || '';
        assert.match(replyText, /Owner/i, 'Info kontak owner publik harus tetap tampil');
    });

    it('7. Jalur testing MessageRouter.handleSimulatedMessage memblokir eksekusi langsung', async () => {
        const replies = [];
        const mockSock = {
            user: { id: '62800000000000:1@s.whatsapp.net' },
            sendMessage: async (target, content, options) => {
                replies.push({ target, content, options });
                return { key: { id: 'TEST_' + Date.now() } };
            }
        };

        const mockMsg = {
            key: { remoteJid: 'test@s.whatsapp.net', fromMe: false },
            text: '$ id',
            sender: ownerJid,
            chat: 'test@s.whatsapp.net'
        };

        const result = await MessageRouter.handleSimulatedMessage(
            { sessionId: 'test', isSimulation: true },
            mockSock,
            mockMsg,
            null
        );

        assert.strictEqual(result.blocked, true);
        assert.strictEqual(result.reason, 'EXEC_DISALLOWED_IN_SIMULATION');
        assert.ok(replies.length >= 1);
        assert.match(replies[0].content.text, /Akses ditolak/i);
    });
});
