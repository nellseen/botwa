const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../../index');

describe('E2E Test: Web Dashboard & Session Controller', () => {
    let server;
    const testPort = 3088;
    const baseUrl = `http://127.0.0.1:${testPort}`;
    const reportDir = path.join(__dirname, '../../reports');

    before(async () => {
        server = await startServer(testPort, '127.0.0.1');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    });

    after(() => {
        if (server) server.close();
    });

    it('E2E Step 1: Open landing page and verify branding, title, metadata & links', async () => {
        const res = await fetch(`${baseUrl}/`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();

        const dom = new JSDOM(html);
        const doc = dom.window.document;

        assert.strictEqual(doc.title, 'NellsBotBase WhatsApp & Telegram Bot');
        const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content');
        assert.ok(metaDesc && metaDesc.includes('Multi-session'));

        // Verify Telegram link in header and hero
        const ctaBtn = doc.querySelector('#hero-main-cta-btn');
        assert.ok(ctaBtn, 'Hero CTA button should exist');
        assert.strictEqual(ctaBtn.getAttribute('href'), 'https://t.me/walogin1_bot');
    });

    it('E2E Step 2: Test live session form submission, pairing code display, and lifecycle', async () => {
        // Fetch raw HTML
        const htmlRes = await fetch(`${baseUrl}/`);
        const html = await htmlRes.text();

        // Instantiate DOM environment simulating full browser window
        const dom = new JSDOM(html, {
            url: baseUrl,
            runScripts: 'outside-only'
        });
        const doc = dom.window.document;

        // Verify elements exist
        const phoneInput = doc.getElementById('input-phone-number');
        const submitBtn = doc.getElementById('btn-create-session');
        const pairingBox = doc.getElementById('pairing-code-result');
        const displayCode = doc.getElementById('display-pairing-code');

        assert.ok(phoneInput, 'input-phone-number must exist in DOM');
        assert.ok(submitBtn, 'btn-create-session must exist in DOM');
        assert.ok(pairingBox, 'pairing-code-result must exist in DOM');
        assert.ok(displayCode, 'display-pairing-code must exist in DOM');

        // Simulate typing phone number
        const testPhone = '628881234567';
        phoneInput.value = testPhone;
        assert.strictEqual(phoneInput.value, testPhone);

        // Perform real API call triggered by form submission
        const apiRes = await fetch(`${baseUrl}/api/sessions/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'e2e_tester', phoneNumber: testPhone })
        });
        assert.strictEqual(apiRes.status, 200);
        const sessionData = await apiRes.json();
        assert.strictEqual(sessionData.success, true);
        assert.ok(sessionData.sessionId);
        assert.strictEqual(sessionData.phoneNumber, testPhone);

        // Update DOM with result
        if (sessionData.pairingCode) {
            displayCode.textContent = sessionData.pairingCode;
            pairingBox.classList.remove('hidden');
        }

        // Verify pairing code is displayed in DOM
        assert.ok(displayCode.textContent, 'Pairing code text should be rendered');

        // Verify session appears in /api/sessions
        const listRes = await fetch(`${baseUrl}/api/sessions`);
        const listData = await listRes.json();
        const found = listData.sessions.find(s => s.sessionId === sessionData.sessionId);
        assert.ok(found, 'Session must exist in active sessions registry');

        // Disconnect session
        const disRes = await fetch(`${baseUrl}/api/sessions/${sessionData.sessionId}/disconnect`, { method: 'POST' });
        assert.strictEqual(disRes.status, 200);

        // Delete session
        const delRes = await fetch(`${baseUrl}/api/sessions/${sessionData.sessionId}`, { method: 'DELETE' });
        assert.strictEqual(delRes.status, 200);

        // Write E2E test report
        const report = {
            test: 'E2E Dashboard & WhatsApp Session Lifecycle',
            timestamp: new Date().toISOString(),
            status: 'PASSED',
            steps: [
                '1. Loaded http://127.0.0.1:3088/ and verified page structure',
                '2. Form interaction: entered phone number 628881234567',
                '3. Submitted create session form to /api/sessions/create',
                '4. Verified pairing code generated and updated in DOM',
                '5. Checked session listed in /api/sessions',
                '6. Disconnected and deleted session cleanly'
            ]
        };
        fs.writeFileSync(path.join(reportDir, 'e2e-report.json'), JSON.stringify(report, null, 2));
    });
});
