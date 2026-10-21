const { describe, it } = require('node:test');
const assert = require('node:assert');
const { containsAnyLink } = require('../../plugins/grup/antilink');

describe('Unit Test: plugins/grup/antilink.js Link Detection', () => {
    it('should detect http and https URLs', () => {
        assert.strictEqual(containsAnyLink('cek disini https://example.com/promo'), true);
        assert.strictEqual(containsAnyLink('http://test.org/login sekarang juga'), true);
    });

    it('should detect shortlinks (chat.whatsapp.com, wa.me, t.me, bit.ly)', () => {
        assert.strictEqual(containsAnyLink('gabung grup https://chat.whatsapp.com/AbcDeFgHiJkLm'), true);
        assert.strictEqual(containsAnyLink('chat saya di wa.me/628123456789'), true);
        assert.strictEqual(containsAnyLink('t.me/channel_keren'), true);
        assert.strictEqual(containsAnyLink('bit.ly/3xyz123'), true);
    });

    it('should detect bare domains with TLDs', () => {
        assert.strictEqual(containsAnyLink('kunjungi toko.xyz/produk kami'), true);
        assert.strictEqual(containsAnyLink('buka website.id'), true);
    });

    it('should NOT flag normal sentences', () => {
        assert.strictEqual(containsAnyLink('Halo semua apa kabar?'), false);
        assert.strictEqual(containsAnyLink('Selamat pagi bot, tolong bantu admin.'), false);
    });

    it('should NOT flag numbers, prices, or decimals', () => {
        assert.strictEqual(containsAnyLink('Harganya cuma 12.500 rupiah'), false);
        assert.strictEqual(containsAnyLink('Pertemuan jam 14.30 WIB'), false);
        assert.strictEqual(containsAnyLink('Versi aplikasi 1.0.0'), false);
    });

    it('should NOT flag ellipses (...) or punctuation', () => {
        assert.strictEqual(containsAnyLink('Wah seru banget ya... kapan lagi...'), false);
        assert.strictEqual(containsAnyLink('oke. siap.'), false);
    });
});
