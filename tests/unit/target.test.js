const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeJid, readList, writeList } = require('../../lib/target');
const fs = require('fs');
const path = require('path');

describe('Unit Test: lib/target.js', () => {
    it('normalizeJid should format plain phone numbers with @s.whatsapp.net', () => {
        const jid = normalizeJid('628123456789');
        assert.strictEqual(jid, '628123456789@s.whatsapp.net');
    });

    it('normalizeJid should format Indonesian 08xx numbers to 628xx', () => {
        const jid = normalizeJid('08123456789');
        assert.strictEqual(jid, '628123456789@s.whatsapp.net');
    });

    it('normalizeJid should preserve group JIDs ending in @g.us', () => {
        const groupJid = '120363024849182394@g.us';
        assert.strictEqual(normalizeJid(groupJid), groupJid);
    });

    it('normalizeJid should preserve LID JIDs ending in @lid', () => {
        const lid = '9912345678@lid';
        assert.strictEqual(normalizeJid(lid), lid);
    });

    it('normalizeJid should return empty string for empty input', () => {
        assert.strictEqual(normalizeJid(''), '');
        assert.strictEqual(normalizeJid(null), '');
    });

    it('readList and writeList should write and read arrays deduplicated', () => {
        const testFile = path.join(__dirname, 'test-list.tmp.json');
        try {
            writeList(testFile, ['user1@s.whatsapp.net', 'user2@s.whatsapp.net', 'user1@s.whatsapp.net']);
            const list = readList(testFile);
            assert.strictEqual(list.length, 2);
            assert.strictEqual(list[0], 'user1@s.whatsapp.net');
            assert.strictEqual(list[1], 'user2@s.whatsapp.net');
        } finally {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        }
    });
});
