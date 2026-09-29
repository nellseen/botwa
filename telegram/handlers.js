// ===================================================
//  NellsBotBase - Telegram Command & Dashboard Handlers
//  Refactored with single-message status edits,
//  debouncing, and clean state tracking
// ===================================================

const { getBot } = require('./bot');
const chalk = require('chalk');
const statusManager = require('./TelegramStatusManager');

const userStates = new Map();
const userPromptMessages = new Map(); // chatId -> messageId (for cleaning temporary input prompts)
const activePairingLocks = new Set();

const MAIN_KEYBOARD = {
    reply_markup: {
        keyboard: [
            [{ text: '📱 Nomor Saya' }, { text: '➕ Tambah Nomor' }],
            [{ text: '🟢 Status Online' }, { text: '🔄 Refresh' }],
            [{ text: '📊 Statistik' }, { text: '⚙️ Settings' }]
        ],
        resize_keyboard: true
    }
};

function formatUptime(uptimeMs) {
    const totalSeconds = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

class TelegramHandlers {
    static init(sessionManager) {
        const bot = getBot();
        if (!bot) return;

        this.sessionManager = sessionManager;
        this.bot = bot;

        // Route session events to Telegram using the throttled status manager
        sessionManager.on('status', async (info) => {
            console.log(chalk.cyan(`[TELEGRAM EVENT] Session ${info.sessionId} status changed to ${info.status}`));
            try {
                let statusEmoji = '🔴';
                if (info.status === 'ONLINE') statusEmoji = '🟢';
                else if (info.status === 'CONNECTING') statusEmoji = '🟡';
                else if (info.status === 'RECONNECTING') statusEmoji = '🔄';
                else if (info.status === 'PAIRING') statusEmoji = '🔵';
                else if (info.status === 'LOGGED_OUT') statusEmoji = '⚠️';
                else if (info.status === 'CONFLICT') statusEmoji = '⛔';

                let text = `${statusEmoji} *WhatsApp Status Update*\n\n` +
                           `📱 *Nomor:* \`${info.phoneNumber || 'Belum diatur'}\`\n` +
                           `⚡ *Status:* *${info.status}*`;

                if (info.reason) {
                    text += `\nℹ️ *Keterangan:* ${info.reason}`;
                }

                if (info.status === 'PAIRING' && info.pairingCode) {
                    text += `\n\n🔢 *Pairing Code:* \`${info.pairingCode}\`\n` +
                            `_Masukkan kode ini di WhatsApp: Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon saja._`;
                } else if (info.status === 'LOGGED_OUT') {
                    text += `\n\n⚠️ _Sesi telah logout dari WhatsApp. Silakan gunakan menu Reset & Re-pair._`;
                } else if (info.status === 'ONLINE') {
                    text += `\n\n🎉 _Bot WhatsApp berhasil terhubung dan siap digunakan 24/7!_`;
                }

                // Update the status message in-place for this session
                await statusManager.setStatus(bot, info.userId, info.sessionId, text);
            } catch (err) {
                console.error('Failed to update status in TelegramHandlers:', err);
            }
        });

        bot.onText(/\/start/, (msg) => this.handleStart(msg));
        bot.onText(/\/status/, (msg) => this.handleStatus(msg));
        bot.on('message', (msg) => this.handleMessage(msg));
        bot.on('callback_query', (query) => this.handleCallbackQuery(query));
    }

    static async handleStart(msg) {
        const chatId = msg.chat.id;
        const text = `👋 *Selamat datang di NellsBotBase Dashboard!*\n\nID Anda: \`${chatId}\`\nSilahkan gunakan menu di bawah untuk mengelola sesi WhatsApp Anda dengan mudah.`;
        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...MAIN_KEYBOARD });
    }

    static async handleStatus(msg) {
        const chatId = msg.chat.id;
        await this.sendDetailedSessions(chatId);
    }

    static async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        
        // Skip slash commands
        if (text.startsWith('/')) return;

        // Handle states
        const state = userStates.get(chatId);
        if (state === 'AWAITING_PHONE_NUMBER') {
            userStates.delete(chatId);
            // Clean up user's typed phone number message to keep chat spotless
            try { await this.bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
            return this.handleAddNumber(chatId, text);
        }

        // Handle keyboard buttons
        switch (text) {
            case '📱 Nomor Saya':
            case '🟢 Status Online':
                await this.sendDetailedSessions(chatId);
                break;
            case '➕ Tambah Nomor': {
                userStates.set(chatId, 'AWAITING_PHONE_NUMBER');
                const promptMsg = await this.bot.sendMessage(
                    chatId,
                    'Masukkan nomor WhatsApp Anda (contoh: `628123456789`):',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            force_reply: true,
                            input_field_placeholder: "628..."
                        }
                    }
                );
                userPromptMessages.set(chatId, promptMsg.message_id);
                break;
            }
            case '🔄 Refresh':
                await this.sendDetailedSessions(chatId);
                break;
            case '📊 Statistik':
                await this.sendStats(chatId);
                break;
            case '⚙️ Settings':
                await this.bot.sendMessage(chatId, '⚙️ *Pengaturan Sesi WhatsApp*\nFitur pengaturan lanjutan per nomor segera hadir.', { parse_mode: 'Markdown', ...MAIN_KEYBOARD });
                break;
        }
    }

    /**
     * Renders detailed sessions inside a single editable message with clean navigation.
     */
    static async sendDetailedSessions(chatId, messageId = null, targetSessionId = null) {
        const sessions = this.sessionManager.getUserSessions(chatId);
        if (sessions.length === 0) {
            const txt = '📱 *Nomor Saya*\n\nAnda belum menambahkan nomor satupun.\nSilahkan klik menu *➕ Tambah Nomor*.';
            if (messageId) {
                try {
                    await this.bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                } catch(_) {}
            } else {
                await statusManager.setStatus(this.bot, chatId, 'dashboard', txt, { ...MAIN_KEYBOARD });
            }
            return;
        }

        // Detail view for a specific session
        if (targetSessionId) {
            const sess = this.sessionManager.getSession(targetSessionId);
            if (!sess) {
                return this.sendDetailedSessions(chatId, messageId, null);
            }

            let emoji = '🔴';
            if (sess.status === 'ONLINE') emoji = '🟢';
            else if (sess.status === 'CONNECTING') emoji = '🟡';
            else if (sess.status === 'RECONNECTING') emoji = '🔄';
            else if (sess.status === 'PAIRING') emoji = '🔵';
            else if (sess.status === 'LOGGED_OUT') emoji = '⚠️';
            else if (sess.status === 'CONFLICT') emoji = '⛔';

            let text = `${emoji} *KONTROL SESI WHATSAPP*\n\n` +
                       `📱 *Nomor:* \`${sess.phoneNumber || 'Belum diatur'}\`\n` +
                       `⚡ *Status:* *${sess.status}*\n` +
                       `🆔 *Session ID:* \`${sess.sessionId}\``;

            if (sess.status === 'PAIRING' && sess.pairingCode) {
                text += `\n🔢 *Pairing Code:* \`${sess.pairingCode}\``;
            }

            const inlineKeyboard = [];
            if (sess.status === 'ONLINE' || sess.status === 'CONNECTING' || sess.status === 'RECONNECTING') {
                inlineKeyboard.push([
                    { text: '🔄 Refresh Status', callback_data: `view_${sess.sessionId}` },
                    { text: '🔌 Putuskan (Disconnect)', callback_data: `disconnect_${sess.sessionId}` }
                ]);
            } else if (sess.status === 'LOGGED_OUT') {
                inlineKeyboard.push([
                    { text: '🔄 Reset & Re-pair', callback_data: `repair_${sess.sessionId}` }
                ]);
            } else if (sess.status === 'OFFLINE' || sess.status === 'CONFLICT') {
                inlineKeyboard.push([
                    { text: '🔌 Sambungkan (Connect)', callback_data: `connect_${sess.sessionId}` }
                ]);
            } else if (sess.status === 'PAIRING') {
                inlineKeyboard.push([
                    { text: '📋 Lihat Pairing Code', callback_data: `pairing_${sess.sessionId}` },
                    { text: '❌ Batalkan', callback_data: `delete_${sess.sessionId}` }
                ]);
            }

            inlineKeyboard.push([
                { text: '🗑 Hapus Nomor Ini', callback_data: `delete_${sess.sessionId}` }
            ]);
            inlineKeyboard.push([
                { text: '« Kembali ke Daftar Nomor', callback_data: `list_sessions` }
            ]);

            if (messageId) {
                try {
                    await this.bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                } catch (_) {}
            } else {
                await statusManager.setStatus(this.bot, chatId, 'dashboard', text, {
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            }
            return;
        }

        // Consolidated list of all sessions in a single message
        let text = `📱 *DAFTAR NOMOR WHATSAPP ANDA*\nTotal: *${sessions.length}* nomor terdaftar\n\n`;
        const inlineKeyboard = [];

        sessions.forEach((sess, idx) => {
            let emoji = '🔴';
            if (sess.status === 'ONLINE') emoji = '🟢';
            else if (sess.status === 'CONNECTING') emoji = '🟡';
            else if (sess.status === 'RECONNECTING') emoji = '🔄';
            else if (sess.status === 'PAIRING') emoji = '🔵';
            else if (sess.status === 'LOGGED_OUT') emoji = '⚠️';
            else if (sess.status === 'CONFLICT') emoji = '⛔';

            text += `${idx + 1}. ${emoji} \`${sess.phoneNumber || 'Belum diatur'}\` — *${sess.status}*\n`;
            inlineKeyboard.push([
                { text: `${emoji} ${sess.phoneNumber || sess.sessionId.slice(0, 10)} (Kontrol)`, callback_data: `view_${sess.sessionId}` }
            ]);
        });

        text += `\n_Pilih nomor di atas untuk melihat detail, putuskan, atau pairing ulang._`;
        inlineKeyboard.push([
            { text: '🔄 Refresh Semua', callback_data: `refresh_all` }
        ]);

        if (messageId) {
            try {
                await this.bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            } catch (_) {}
        } else {
            await statusManager.setStatus(this.bot, chatId, 'dashboard', text, {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }
    }

    static async handleAddNumber(chatId, text) {
        const phone = text.replace(/[^0-9]/g, '');
        if (!phone) {
            return this.bot.sendMessage(chatId, '❌ Nomor tidak valid. Silakan gunakan format angka seperti `628123456789`.', { parse_mode: 'Markdown', ...MAIN_KEYBOARD });
        }

        if (activePairingLocks.has(phone)) {
            return this.bot.sendMessage(chatId, '⚠️ Sedang memproses nomor ini. Silahkan tunggu beberapa saat.', MAIN_KEYBOARD);
        }
        activePairingLocks.add(phone);

        // Delete temporary input prompt to keep the conversation clean
        const promptMsgId = userPromptMessages.get(chatId);
        if (promptMsgId) {
            try { await this.bot.deleteMessage(chatId, promptMsgId); } catch (_) {}
            userPromptMessages.delete(chatId);
        }

        const operationKey = `add_${phone}`;

        try {
            await statusManager.setStatus(
                this.bot,
                chatId,
                operationKey,
                `🔄 *Menyiapkan Sesi Baru*\n\nNomor: \`${phone}\`\nStatus: *Inisialisasi koneksi...*\n_Mohon tunggu pairing code digenerate..._`,
                MAIN_KEYBOARD
            );

            const session = await this.sessionManager.createSession(chatId, phone);

            setTimeout(async () => {
                try {
                    const code = await session.requestPairingCode();
                    if (code) {
                        const pairText = `🔵 *PAIRING CODE WHATSAPP*\n\n` +
                                         `📱 *Nomor:* \`${phone}\`\n` +
                                         `🔢 *Pairing Code:* \`${code}\`\n\n` +
                                         `👉 *Langkah di HP:*\n` +
                                         `1. Buka WhatsApp > *Perangkat Tertaut*\n` +
                                         `2. Klik *Tautkan Perangkat*\n` +
                                         `3. Pilih *Tautkan dengan nomor telepon saja*\n` +
                                         `4. Masukkan kode 8 digit di atas.`;

                        await statusManager.setStatus(this.bot, chatId, operationKey, pairText);
                    } else if (session.status === 'ONLINE') {
                        const onlineText = `🟢 *Nomor \`${phone}\` sudah ONLINE dan siap digunakan!*`;
                        await statusManager.finishStatus(this.bot, chatId, operationKey, onlineText);
                    } else {
                        await statusManager.setStatus(
                            this.bot,
                            chatId,
                            operationKey,
                            `⚠️ Gagal generate pairing code untuk \`${phone}\`. Status: *${session.status}*`
                        );
                    }
                } catch (timeoutErr) {
                    console.error('Error generating pairing code in timeout:', timeoutErr);
                } finally {
                    activePairingLocks.delete(phone);
                }
            }, 4500);

        } catch (err) {
            activePairingLocks.delete(phone);
            await statusManager.setStatus(
                this.bot,
                chatId,
                operationKey,
                `❌ *Gagal menambahkan nomor:* ${err.message}`
            );
        }
    }

    static async handleCallbackQuery(query) {
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        if (!data) return;

        if (data === 'refresh_all' || data === 'list_sessions') {
            await this.bot.answerCallbackQuery(query.id, { text: 'Diperbarui' }).catch(()=>{});
            return this.sendDetailedSessions(chatId, messageId, null);
        }

        const separatorIndex = data.indexOf('_');
        if (separatorIndex === -1) return;
        const action = data.slice(0, separatorIndex);
        const sessionId = data.slice(separatorIndex + 1);
        
        if (action === 'view') {
            await this.bot.answerCallbackQuery(query.id).catch(()=>{});
            await this.sendDetailedSessions(chatId, messageId, sessionId);
        }
        else if (action === 'refresh') {
            await this.bot.answerCallbackQuery(query.id, { text: 'Refreshing...' }).catch(()=>{});
            await this.sendDetailedSessions(chatId, messageId, sessionId);
        } 
        else if (action === 'disconnect') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                session.disconnect();
                await this.bot.answerCallbackQuery(query.id, { text: 'Koneksi diputuskan.' }).catch(()=>{});
                await this.sendDetailedSessions(chatId, messageId, sessionId);
            }
        }
        else if (action === 'connect') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                session.connect();
                await this.bot.answerCallbackQuery(query.id, { text: 'Menghubungkan...' }).catch(()=>{});
                await this.sendDetailedSessions(chatId, messageId, sessionId);
            }
        }
        else if (action === 'repair') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Mereset & menyiapkan pairing baru...' }).catch(()=>{});
                try {
                    await this.bot.editMessageText(
                        `🔄 *Mereset Sesi WhatsApp*\nSedang membersihkan data lama dan meminta pairing code baru untuk \`${session.phoneNumber}\`...\n_Mohon tunggu beberapa detik..._`,
                        {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'Markdown'
                        }
                    );
                } catch (_) {}

                session.resetAuthState();
                await session.connect();

                setTimeout(async () => {
                    try {
                        const code = await session.requestPairingCode();
                        if (code) {
                            await this.bot.editMessageText(
                                `🔵 *PAIRING CODE BARU*\n\n` +
                                `📱 *Nomor:* \`${session.phoneNumber}\`\n` +
                                `🔢 *Code:* \`${code}\`\n\n` +
                                `👉 Masukkan di WhatsApp: *Perangkat Tertaut* > *Tautkan Perangkat* > *Tautkan dengan nomor telepon saja*.`,
                                {
                                    chat_id: chatId,
                                    message_id: messageId,
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                        inline_keyboard: [
                                            [{ text: '« Kembali ke Daftar Nomor', callback_data: `list_sessions` }]
                                        ]
                                    }
                                }
                            );
                        } else {
                            await this.bot.editMessageText(
                                `⚠️ Gagal generate pairing code baru untuk \`${session.phoneNumber}\`. Status: *${session.status}*`,
                                {
                                    chat_id: chatId,
                                    message_id: messageId,
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                        inline_keyboard: [
                                            [{ text: '« Kembali ke Daftar Nomor', callback_data: `list_sessions` }]
                                        ]
                                    }
                                }
                            );
                        }
                    } catch (err) {
                        console.error('Error repairing session in timeout:', err);
                    }
                }, 4000);
            }
        }
        else if (action === 'pairing') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                const code = await session.requestPairingCode();
                if (code) {
                    await this.bot.answerCallbackQuery(query.id, { text: `Kode: ${code}`, show_alert: true });
                } else {
                    await this.bot.answerCallbackQuery(query.id, { text: `Status: ${session.status}. Belum ada pairing code.` });
                }
            }
        }
        else if (action === 'delete') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                await this.bot.editMessageText(
                    `⚠️ *Hapus Sesi WhatsApp?*\n\nNomor: \`${session.phoneNumber}\`\nSemua data autentikasi nomor ini akan dihapus permanen dari server.`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Ya, Hapus Sekarang', callback_data: `confirmdelete_${sessionId}` }],
                                [{ text: '❌ Batal', callback_data: `view_${sessionId}` }]
                            ]
                        }
                    }
                );
                await this.bot.answerCallbackQuery(query.id).catch(()=>{});
            }
        }
        else if (action === 'confirmdelete') {
            const session = this.sessionManager.getSession(sessionId);
            const phone = session?.phoneNumber || sessionId;
            if (session && session.userId === chatId.toString()) {
                await this.sessionManager.deleteSession(sessionId);
                statusManager.clearSession(chatId, sessionId);
                await this.bot.answerCallbackQuery(query.id, { text: 'Sesi berhasil dihapus.' }).catch(()=>{});
                await this.bot.editMessageText(
                    `🗑 *Sesi \`${phone}\` telah dihapus.*\nData autentikasi berhasil dibersihkan dari server.`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '« Kembali ke Daftar Nomor', callback_data: `list_sessions` }]
                            ]
                        }
                    }
                );
            }
        }
    }

    static async sendStats(chatId, messageId = null) {
        const allSessions = this.sessionManager.getAllSessions();
        const onlineCount = allSessions.filter(s => s.status === 'ONLINE').length;
        const offlineCount = allSessions.filter(s => s.status === 'OFFLINE' || s.status === 'LOGGED_OUT').length;
        const pairingCount = allSessions.filter(s => s.status === 'PAIRING').length;
        const connectingCount = allSessions.filter(s => s.status === 'CONNECTING').length;
        
        const memoryUsage = `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`;
        const uptime = formatUptime(process.uptime() * 1000);

        const text = `📊 *STATISTIK SISTEM*\n\n` +
                     `Total WhatsApp Sessions: *${allSessions.length}*\n` +
                     `🟢 Online: *${onlineCount}*\n` +
                     `🟡 Connecting: *${connectingCount}*\n` +
                     `🔵 Pairing: *${pairingCount}*\n` +
                     `🔴 Offline/Logged Out: *${offlineCount}*\n\n` +
                     `💻 Uptime Server: *${uptime}*\n` +
                     `💾 Penggunaan Memori: *${memoryUsage}*`;
        
        if (messageId) {
            try {
                await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            } catch (_) {}
        } else {
            await statusManager.setStatus(this.bot, chatId, 'dashboard', text, { ...MAIN_KEYBOARD });
        }
    }
}

module.exports = TelegramHandlers;
