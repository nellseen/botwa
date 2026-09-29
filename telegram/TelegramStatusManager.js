// ===================================================
//  NellsBotBase - Telegram Status Message Manager
//  Handles single-message status edits, throttling,
//  deduplication, and anti-spam cleanup
// ===================================================

const chalk = require('chalk');

class TelegramStatusManager {
    constructor() {
        // Map key format: `${chatId}:${operationOrSessionKey}` -> { messageId, lastText, lastEditTime, timer, pendingText, pendingOptions }
        this.statusMap = new Map();
        this.minEditIntervalMs = 1200; // Minimum 1.2s between edits to stay well clear of Telegram 429
    }

    _getKey(chatId, key) {
        return `${chatId}:${key}`;
    }

    /**
     * Creates a new status message or updates an existing one in-place
     */
    async setStatus(bot, chatId, key, text, options = {}) {
        if (!bot || !chatId || !key) return null;

        const mapKey = this._getKey(chatId, key);
        const current = this.statusMap.get(mapKey);

        // Deduplication: if text hasn't changed, skip completely
        if (current && current.lastText === text && !options.force) {
            return current.messageId;
        }

        const now = Date.now();

        // If message already exists and is within cooldown, queue the update (throttle/debounce)
        if (current && current.messageId) {
            const timeSinceLastEdit = now - (current.lastEditTime || 0);

            if (timeSinceLastEdit < this.minEditIntervalMs) {
                current.pendingText = text;
                current.pendingOptions = options;

                if (!current.timer) {
                    const delay = this.minEditIntervalMs - timeSinceLastEdit;
                    current.timer = setTimeout(async () => {
                        current.timer = null;
                        if (current.pendingText) {
                            const pText = current.pendingText;
                            const pOpts = current.pendingOptions || {};
                            current.pendingText = null;
                            current.pendingOptions = null;
                            await this.setStatus(bot, chatId, key, pText, { ...pOpts, force: true });
                        }
                    }, delay);
                }
                return current.messageId;
            }

            // Perform edit in place
            try {
                current.lastEditTime = now;
                current.lastText = text;
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: current.messageId,
                    parse_mode: options.parse_mode || 'Markdown',
                    reply_markup: options.reply_markup
                });
                return current.messageId;
            } catch (err) {
                const errMsg = err?.response?.body?.description || err?.message || '';
                // "message is not modified" is a normal Telegram API no-op response
                if (errMsg.includes('message is not modified')) {
                    return current.messageId;
                }

                // If message to edit was deleted by user or expired, fallback to sending a new one
                console.warn(chalk.yellow(`[TelegramStatusManager] Edit failed (${errMsg}), sending new message for ${mapKey}`));
            }
        }

        // Send a new status message if none exists or edit failed
        try {
            const sent = await bot.sendMessage(chatId, text, {
                parse_mode: options.parse_mode || 'Markdown',
                reply_markup: options.reply_markup
            });

            this.statusMap.set(mapKey, {
                messageId: sent.message_id,
                lastText: text,
                lastEditTime: now,
                timer: null,
                pendingText: null,
                pendingOptions: null
            });

            return sent.message_id;
        } catch (sendErr) {
            console.error(`[TelegramStatusManager] Send failed for ${mapKey}:`, sendErr.message);
            return null;
        }
    }

    /**
     * Finishes a status operation (edits to final text, optionally auto-deleting after a delay)
     */
    async finishStatus(bot, chatId, key, text, options = {}, autoDeleteMs = null) {
        const messageId = await this.setStatus(bot, chatId, key, text, { ...options, force: true });
        const mapKey = this._getKey(chatId, key);

        if (autoDeleteMs && messageId) {
            setTimeout(async () => {
                await this.deleteStatus(bot, chatId, key);
            }, autoDeleteMs);
        } else {
            // Keep the final status tracked or clean up timer
            const entry = this.statusMap.get(mapKey);
            if (entry && entry.timer) {
                clearTimeout(entry.timer);
                entry.timer = null;
            }
        }

        return messageId;
    }

    /**
     * Deletes the tracked status message from Telegram and removes from tracking
     */
    async deleteStatus(bot, chatId, key) {
        const mapKey = this._getKey(chatId, key);
        const entry = this.statusMap.get(mapKey);
        if (!entry) return;

        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }

        try {
            if (entry.messageId && bot) {
                await bot.deleteMessage(chatId, entry.messageId);
            }
        } catch (_) {}

        this.statusMap.delete(mapKey);
    }

    /**
     * Clear all tracking for a specific session or user
     */
    clearSession(chatId, sessionId) {
        const mapKey = this._getKey(chatId, sessionId);
        const entry = this.statusMap.get(mapKey);
        if (entry?.timer) clearTimeout(entry.timer);
        this.statusMap.delete(mapKey);
    }
}

module.exports = new TelegramStatusManager();
