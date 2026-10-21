const { describe, it } = require('node:test');
const assert = require('node:assert');
const statusManager = require('../../telegram/TelegramStatusManager');

describe('Integration Test: Telegram Management & Status Manager', () => {
    it('TelegramStatusManager should record status updates and debounce rapid calls', async () => {
        const sentMessages = [];
        const editedMessages = [];

        const mockBot = {
            sendMessage: async (chatId, text, options) => {
                const msg = { message_id: 1001, text, options };
                sentMessages.push(msg);
                return msg;
            },
            editMessageText: async (text, options) => {
                editedMessages.push({ text, options });
                return true;
            },
            deleteMessage: async (chatId, msgId) => true
        };

        const chatId = '999123';
        const key = 'test_session_status';

        // 1. Initial status send
        const msgId = await statusManager.setStatus(mockBot, chatId, key, 'Status 1: OFFLINE');
        assert.strictEqual(msgId, 1001);
        assert.strictEqual(sentMessages.length, 1);

        // 2. Immediate same text deduplication should not resend
        const dupId = await statusManager.setStatus(mockBot, chatId, key, 'Status 1: OFFLINE');
        assert.strictEqual(dupId, 1001);
        assert.strictEqual(sentMessages.length, 1);

        // 3. Clear session
        statusManager.clearSession(chatId, key);
        assert.strictEqual(statusManager.statusMap.has(`${chatId}:${key}`), false);
    });
});
