const { getBot } = require('./bot');
const chalk = require('chalk');

const userStates = new Map();
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

        // Route events to Telegram
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
                           `⚡ *Status:* ${info.status}`;

                if (info.reason) {
                    text += `\nℹ️ *Keterangan:* ${info.reason}`;
                }

                if (info.status === 'PAIRING' && info.pairingCode) {
                    text += `\n\n🔢 *Pairing Code:* \`${info.pairingCode}\`\n` +
                            `_Masukkan kode ini di WhatsApp: Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon saja._`;
                } else if (info.status === 'LOGGED_OUT') {
                    text += `\n\n⚠️ _Sesi telah logout dari WhatsApp. Gunakan menu untuk Reset & Re-pair nomor._`;
                } else if (info.status === 'ONLINE') {
                    text += `\n\n🎉 _Bot WhatsApp berhasil terhubung dan siap menerima pesan!_`;
                }

                await bot.sendMessage(info.userId, text, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error('Failed to send status update to Telegram', err);
            }
        });

        bot.onText(/\/start/, (msg) => this.handleStart(msg));
        bot.onText(/\/status/, (msg) => this.handleStatus(msg));
        bot.on('message', (msg) => this.handleMessage(msg));
        bot.on('callback_query', (query) => this.handleCallbackQuery(query));
    }

    static async handleStart(msg) {
        const chatId = msg.chat.id;
        const text = `Selamat datang di NellsBotBase Dashboard!\n\nID Anda: ${chatId}\nSilahkan gunakan menu di bawah untuk mengatur WhatsApp session Anda.`;
        await this.bot.sendMessage(chatId, text, MAIN_KEYBOARD);
    }

    static async handleStatus(msg) {
        const chatId = msg.chat.id;
        await this.sendStatusDashboard(chatId);
    }

    static async sendStatusDashboard(chatId, messageId = null) {
        const sessions = this.sessionManager.getUserSessions(chatId);
        
        let text = `📊 WHATSAPP STATUS\nTotal Number: ${sessions.length}\n\n`;
        
        if (sessions.length === 0) {
            text += `Anda belum menambahkan nomor satupun.`;
        }

        sessions.forEach(sess => {
            let emoji = '🔴';
            if (sess.status === 'ONLINE') emoji = '🟢';
            else if (sess.status === 'CONNECTING') emoji = '🟡';
            else if (sess.status === 'PAIRING') emoji = '🔵';
            else if (sess.status === 'LOGGED_OUT') emoji = '⚠️';

            text += `${emoji} ${sess.phoneNumber} — ${sess.status}\n`;
        });

        if (messageId) {
            try {
                await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...MAIN_KEYBOARD });
            } catch (_) {}
        } else {
            await this.bot.sendMessage(chatId, text, MAIN_KEYBOARD);
        }
    }

    static async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        
        // Skip commands
        if (text.startsWith('/')) return;

        // Handle states
        const state = userStates.get(chatId);
        if (state === 'AWAITING_PHONE_NUMBER') {
            userStates.delete(chatId);
            return this.handleAddNumber(chatId, text);
        }

        // Handle keyboard buttons
        switch (text) {
            case '📱 Nomor Saya':
            case '🟢 Status Online':
                await this.sendDetailedSessions(chatId);
                break;
            case '➕ Tambah Nomor':
                userStates.set(chatId, 'AWAITING_PHONE_NUMBER');
                await this.bot.sendMessage(chatId, 'Masukkan nomor WhatsApp Anda (contoh: 628123456789):', {
                    reply_markup: {
                        force_reply: true,
                        input_field_placeholder: "628..."
                    }
                });
                break;
            case '🔄 Refresh':
                await this.handleStatus(msg);
                break;
            case '📊 Statistik':
                await this.sendStats(chatId);
                break;
            case '⚙️ Settings':
                await this.bot.sendMessage(chatId, 'Settings per session coming soon.', MAIN_KEYBOARD);
                break;
        }
    }

    static async sendDetailedSessions(chatId, messageId = null) {
        const sessions = this.sessionManager.getUserSessions(chatId);
        if (sessions.length === 0) {
            const txt = 'Anda belum menambahkan nomor. Silahkan klik ➕ Tambah Nomor.';
            if (messageId) {
                try {
                    await this.bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, ...MAIN_KEYBOARD });
                } catch(_) {}
            } else {
                await this.bot.sendMessage(chatId, txt, MAIN_KEYBOARD);
            }
            return;
        }

        for (const sess of sessions) {
            let emoji = '🔴';
            if (sess.status === 'ONLINE') emoji = '🟢';
            else if (sess.status === 'CONNECTING') emoji = '🟡';
            else if (sess.status === 'RECONNECTING') emoji = '🔄';
            else if (sess.status === 'PAIRING') emoji = '🔵';
            else if (sess.status === 'LOGGED_OUT') emoji = '⚠️';
            else if (sess.status === 'CONFLICT') emoji = '⛔';

            let text = `${emoji} Nomor: ${sess.phoneNumber}\nStatus: ${sess.status}`;
            
            const inlineKeyboard = [];
            
            if (sess.status === 'ONLINE' || sess.status === 'CONNECTING' || sess.status === 'RECONNECTING') {
                inlineKeyboard.push([
                    { text: '🔄 Refresh', callback_data: `refresh_${sess.sessionId}` },
                    { text: '🔌 Disconnect', callback_data: `disconnect_${sess.sessionId}` }
                ]);
            } else if (sess.status === 'LOGGED_OUT') {
                inlineKeyboard.push([
                    { text: '🔄 Reset & Re-pair', callback_data: `repair_${sess.sessionId}` }
                ]);
            } else if (sess.status === 'OFFLINE' || sess.status === 'CONFLICT') {
                inlineKeyboard.push([
                    { text: '🔌 Connect', callback_data: `connect_${sess.sessionId}` },
                ]);
            } else if (sess.status === 'PAIRING') {
                inlineKeyboard.push([
                    { text: '📋 Pairing Code', callback_data: `pairing_${sess.sessionId}` },
                    { text: '❌ Cancel', callback_data: `delete_${sess.sessionId}` }
                ]);
            }
            
            inlineKeyboard.push([
                { text: '🗑 Delete', callback_data: `delete_${sess.sessionId}` }
            ]);

            await this.bot.sendMessage(chatId, text, {
                reply_markup: {
                    inline_keyboard: inlineKeyboard
                }
            });
        }
    }

    static async handleAddNumber(chatId, text) {
        const phone = text.replace(/[^0-9]/g, '');
        if (!phone) {
            return this.bot.sendMessage(chatId, '❌ Nomor tidak valid. Dibatalkan.', MAIN_KEYBOARD);
        }

        if (activePairingLocks.has(phone)) {
            return this.bot.sendMessage(chatId, '⚠️ Sedang memproses nomor ini. Silahkan tunggu.', MAIN_KEYBOARD);
        }
        activePairingLocks.add(phone);

        try {
            await this.bot.sendMessage(chatId, `🔄 Sedang menyiapkan session untuk ${phone}...`);
            const session = await this.sessionManager.createSession(chatId, phone);
            
            // Give it some time to start connecting
            setTimeout(async () => {
                const code = await session.requestPairingCode();
                if (code) {
                    await this.bot.sendMessage(chatId, `🔵 PAIRING CODE\n\nNomor: ${phone}\nCode: \`${code}\`\n\nSilahkan masukkan di aplikasi WhatsApp Anda.`, { parse_mode: 'Markdown', ...MAIN_KEYBOARD });
                } else if (session.status === 'ONLINE') {
                    await this.bot.sendMessage(chatId, `🟢 Nomor ${phone} sudah ONLINE.`, MAIN_KEYBOARD);
                } else {
                    await this.bot.sendMessage(chatId, `⚠️ Gagal mendapatkan pairing code. Status: ${session.status}`, MAIN_KEYBOARD);
                }
                activePairingLocks.delete(phone);
            }, 5000);

        } catch (err) {
            activePairingLocks.delete(phone);
            await this.bot.sendMessage(chatId, `❌ Gagal menambahkan nomor: ${err.message}`, MAIN_KEYBOARD);
        }
    }

    static async handleCallbackQuery(query) {
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        if (!data) return;

        const separatorIndex = data.indexOf('_');
        if (separatorIndex === -1) return;
        const action = data.slice(0, separatorIndex);
        const sessionId = data.slice(separatorIndex + 1);
        
        if (action === 'refresh') {
            await this.bot.answerCallbackQuery(query.id, { text: 'Refreshing...' });
            await this.bot.deleteMessage(chatId, messageId).catch(()=>{});
            await this.sendDetailedSessions(chatId);
        } 
        else if (action === 'disconnect') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                session.disconnect();
                await this.bot.answerCallbackQuery(query.id, { text: 'Disconnected.' });
                await this.bot.deleteMessage(chatId, messageId).catch(()=>{});
                await this.sendDetailedSessions(chatId);
            }
        }
        else if (action === 'connect') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                session.connect();
                await this.bot.answerCallbackQuery(query.id, { text: 'Connecting...' });
                await this.bot.deleteMessage(chatId, messageId).catch(()=>{});
                await this.sendDetailedSessions(chatId);
            }
        }
        else if (action === 'repair') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Mereset kredensial dan menyiapkan pairing baru...' });
                session.resetAuthState();
                await session.connect();
                setTimeout(async () => {
                    const code = await session.requestPairingCode();
                    if (code) {
                        await this.bot.sendMessage(chatId, `🔵 *PAIRING CODE BARU*\n\nNomor: \`${session.phoneNumber}\`\nCode: \`${code}\`\n\nSilahkan masukkan di WhatsApp: *Perangkat Tertaut* > *Tautkan Perangkat* > *Tautkan dengan nomor telepon saja*.`, { parse_mode: 'Markdown', ...MAIN_KEYBOARD });
                    } else {
                        await this.bot.sendMessage(chatId, `⚠️ Gagal generate pairing code baru. Silakan coba lagi nanti.`, MAIN_KEYBOARD);
                    }
                }, 4000);
                await this.bot.deleteMessage(chatId, messageId).catch(()=>{});
                await this.sendDetailedSessions(chatId);
            }
        }
        else if (action === 'pairing') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                const code = await session.requestPairingCode();
                if (code) {
                    await this.bot.answerCallbackQuery(query.id, { text: `Code: ${code}`, show_alert: true });
                } else {
                    await this.bot.answerCallbackQuery(query.id, { text: 'Gagal generate code. Coba lagi.' });
                }
            }
        }
        else if (action === 'delete') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                await this.bot.editMessageText(`⚠️ Hapus session ${session.phoneNumber}?\nSeluruh data authentication akan dihapus permanen.`, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Ya, Hapus', callback_data: `confirmdelete_${sessionId}` }],
                            [{ text: '❌ Batal', callback_data: `refresh_${sessionId}` }]
                        ]
                    }
                });
                await this.bot.answerCallbackQuery(query.id);
            }
        }
        else if (action === 'confirmdelete') {
            const session = this.sessionManager.getSession(sessionId);
            if (session && session.userId === chatId.toString()) {
                await this.sessionManager.deleteSession(sessionId);
                await this.bot.answerCallbackQuery(query.id, { text: 'Session deleted.' });
                await this.bot.deleteMessage(chatId, messageId).catch(()=>{});
                await this.bot.sendMessage(chatId, '🗑 Session berhasil dihapus.', MAIN_KEYBOARD);
            }
        }
    }

    static async sendStats(chatId) {
        const allSessions = this.sessionManager.getAllSessions();
        const onlineCount = allSessions.filter(s => s.status === 'ONLINE').length;
        const offlineCount = allSessions.filter(s => s.status === 'OFFLINE' || s.status === 'LOGGED_OUT').length;
        const pairingCount = allSessions.filter(s => s.status === 'PAIRING').length;
        const connectingCount = allSessions.filter(s => s.status === 'CONNECTING').length;
        
        const memoryUsage = `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`;
        const uptime = formatUptime(process.uptime() * 1000);

        const text = `📊 STATISTIK SISTEM\n\n` +
                     `Total WhatsApp Sessions: ${allSessions.length}\n` +
                     `🟢 Online: ${onlineCount}\n` +
                     `🟡 Connecting: ${connectingCount}\n` +
                     `🔵 Pairing: ${pairingCount}\n` +
                     `🔴 Offline/Logged Out: ${offlineCount}\n\n` +
                     `💻 Uptime: ${uptime}\n` +
                     `💾 Memory: ${memoryUsage}`;
        
        await this.bot.sendMessage(chatId, text, MAIN_KEYBOARD);
    }
}

module.exports = TelegramHandlers;
