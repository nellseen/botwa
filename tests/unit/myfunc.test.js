const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runtime, formatp, isUrl, parseMention, tanggal } = require('../../lib/myfunc');

describe('Unit Test: lib/myfunc.js', () => {
    it('runtime should format seconds into days, hours, minutes, seconds', () => {
        assert.strictEqual(runtime(65), '1m 5s');
        assert.strictEqual(runtime(3665), '1h 1m 5s');
        assert.strictEqual(runtime(86400), '1d');
    });

    it('formatp should format byte size accurately', () => {
        const size1 = formatp(1024);
        assert.match(size1, /1(\.0+)?\s*KB/i);
        const size2 = formatp(1048576);
        assert.match(size2, /1(\.0+)?\s*MB/i);
    });

    it('isUrl should correctly identify valid URLs and reject non-URLs', () => {
        assert.ok(isUrl('https://google.com'));
        assert.ok(isUrl('http://github.com/itsliaaa/baileys'));
        assert.strictEqual(isUrl('hello world test'), null);
    });

    it('parseMention should extract mentions into WhatsApp JIDs', () => {
        const text = 'Halo @628123456789 dan @628987654321 tolong hadir.';
        const mentions = parseMention(text);
        assert.strictEqual(mentions.length, 2);
        assert.strictEqual(mentions[0], '628123456789@s.whatsapp.net');
        assert.strictEqual(mentions[1], '628987654321@s.whatsapp.net');
    });

    it('tanggal should format timestamps into Indonesian date strings', () => {
        const dateStr = tanggal(new Date(2026, 8, 29).getTime()); // September 2026
        assert.match(dateStr, /September/);
        assert.match(dateStr, /2026/);
    });
});
