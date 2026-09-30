// ===================================================
//  NellsBotBase - Antilink Group Protection
//  Creator : NellsBotBase
//  Updated : 29 September 2026
// ===================================================

const fs = require("fs");
const path = require("path");
const { generateWAMessageFromContent } = require("@itsliaaa/baileys");

const DATABASE = path.join(process.cwd(), "lib/database/antilink.json");

// Comprehensive URL & Domain Matchers
const URL_PROTOCOL_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s/$.?#].[^\s]*/i;
const SHORT_REGEX = /\b(?:wa\.me|t\.me|bit\.ly|s\.id|cutt\.ly|tinyurl\.com|shorturl\.at|linktr\.ee|chat\.whatsapp\.com|whatsapp\.com\/channel|discord\.gg|instagram\.com|tiktok\.com|youtu\.be|x\.com|fb\.watch|facebook\.com)\/[^\s]+/i;
const TLD_LIST = 'com|org|net|edu|gov|id|io|me|co|xyz|my|info|biz|top|live|site|online|app|dev|pro|ai|cc|gg|link|tv|club|store|tech|space|shop|click|icu|vip|work|win|mobi|fun|news|today|page|website|agency|life|world|cloud|group|zone|social|digital|network|center|games|ltd|media|pub|company|fit|solutions|asia|sg|us|uk|de|ru|in|br|fr|au|ca|cn|jp|to|ly|is|gd';
const DOMAIN_REGEX = new RegExp('\\b[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?\\.(?:' + TLD_LIST + ')(?:\\b|\\/|\\?|#)[^\\s]*', 'i');

/**
 * Accurately detects any link/URL in text while ignoring normal messages,
 * decimal numbers (12.5), clock time (12.30), versions (1.0.0), and ellipses (...).
 */
function containsAnyLink(text) {
    if (!text || typeof text !== "string") return false;
    const clean = text.trim();
    if (!clean) return false;

    if (URL_PROTOCOL_REGEX.test(clean)) return true;
    if (SHORT_REGEX.test(clean)) return true;
    if (DOMAIN_REGEX.test(clean)) return true;

    return false;
}

function readState() {
    try {
        if (!fs.existsSync(DATABASE)) {
            fs.mkdirSync(path.dirname(DATABASE), { recursive: true });
            fs.writeFileSync(DATABASE, "{}", "utf8");
            return {};
        }
        const data = JSON.parse(fs.readFileSync(DATABASE, "utf8"));
        return data && typeof data === "object" ? data : {};
    } catch (_) {
        return {};
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(path.dirname(DATABASE), { recursive: true });
        fs.writeFileSync(DATABASE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error("[ANTILINK] Error writing database:", err);
    }
}

async function menuReply(sock, m, context, title, lines) {
    const { botName, prefix, thumb } = context;
    try {
        const message = generateWAMessageFromContent(m.chat, {
            buttonsMessage: {
                buttons: [{
                    buttonId: `${prefix}antilink on`,
                    buttonText: { displayText: "On" },
                    type: 1
                }, {
                    buttonId: `${prefix}antilink off`,
                    buttonText: { displayText: "Off" },
                    type: 1
                }],
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: botName,
                    address: global.namaown || "WhatsApp Bot",
                    jpegThumbnail: thumb ? thumb.toString("base64") : ""
                },
                contentText: `\`「 ${botName} 」\``,
                footerText: `\`「 ${title} 」\`\n${lines.join("\n")}\n\n_*Pilih tombol di bawah untuk mengubah pengaturan*_`,
                headerType: 6
            }
        }, { userJid: m.chat, upload: sock.waUploadToServer });
        return await sock.relayMessage(m.chat, message.message, { messageId: message.key.id });
    } catch (_) {
        // Fallback to plain text reply if button message fails
        return context.reply(`\`「 ${title} 」\`\n\n${lines.join("\n")}`);
    }
}

module.exports = {
    name: "antilink",
    category: "grup",
    command: ["antilink"],
    admin: true,
    group: true,
    description: "Hapus otomatis setiap link atau tautan yang dikirim di grup",
    before: async context => {
        const { body, budy, prefix, isGroup, isBotAdmins, isGroupAdmins, isOwner, isCreator, m, sock } = context;

        // Antilink only operates in groups and never deletes the bot's own messages
        if (!isGroup || m.key.fromMe) return false;

        const state = readState();
        if (!state[m.chat]?.enabled) return false;

        // Skip antilink command invocations
        const rawBody = (body || "").trim();
        if (prefix && rawBody.startsWith(prefix + "antilink")) return false;

        // Check all potential message text containers for links
        const textToCheck = [
            m.text,
            body,
            budy,
            m.message?.conversation,
            m.message?.extendedTextMessage?.text,
            m.message?.imageMessage?.caption,
            m.message?.videoMessage?.caption,
            m.message?.documentMessage?.caption
        ].filter(Boolean).join(" ");

        if (!containsAnyLink(textToCheck)) return false;

        // Group admins, bot owner, and creator are exempt from antilink deletion
        if (isGroupAdmins || isOwner || isCreator) {
            return false;
        }

        // Verify bot has group admin permissions to delete other participants' messages
        if (!isBotAdmins) {
            console.warn(`[ANTILINK][PERMISSION_DENIED]
chat: ${m.chat}
message: ${m.key.id}
participant: ${m.key.participant || m.sender}
reason: Bot is not an admin in this group and lacks delete permissions`);
            return false;
        }

        const deleteKey = {
            remoteJid: m.chat,
            fromMe: false,
            id: m.key.id,
            participant: m.key.participant || m.sender
        };

        try {
            await sock.sendMessage(m.chat, { delete: deleteKey });
            console.log(`[ANTILINK][DELETE_SUCCESS] chat=${m.chat} id=${m.key.id} participant=${deleteKey.participant}`);
        } catch (deleteError) {
            console.error(`[ANTILINK][DELETE_ERROR]
chat: ${m.chat}
message: ${m.key.id}
participant: ${deleteKey.participant}
id: ${m.key.id}
error: ${deleteError.message}`);
            // Fallback attempt with m.key directly
            try {
                await sock.sendMessage(m.chat, { delete: m.key });
            } catch (_) {}
        }

        // Send a brief notification that auto-deletes in 3.5 seconds to prevent chat clutter
        try {
            const senderTag = (context.senderJid || m.sender || "").split("@")[0].replace(/[^0-9]/g, "");
            const warn = await sock.sendMessage(m.chat, {
                text: `⚠️ *Antilink Aktif:* Pesan dari @${senderTag} dihapus karena mengandung tautan/link.`,
                mentions: [m.sender, context.senderJid].filter(Boolean)
            });
            if (warn?.key) {
                setTimeout(() => {
                    sock.sendMessage(m.chat, { delete: warn.key }).catch(() => {});
                }, 3500);
            }
        } catch (_) {}

        return true;
    },
    run: async context => {
        const { sock, m, args, isGroup, isBotAdmins, isGroupAdmins, isOwner, isCreator, reply, groupName, prefix } = context;

        if (!isGroup) return reply("*Command ini hanya bisa dipakai di dalam grup.*");

        if (!isGroupAdmins && !isOwner && !isCreator) {
            return reply("*Fitur ini khusus untuk admin grup dan owner bot!*");
        }

        const action = String(args[0] || "").toLowerCase();
        if (!["on", "off"].includes(action)) {
            const state = readState();
            const isCurrentlyOn = !!state[m.chat]?.enabled;
            return menuReply(sock, m, context, "Antilink Grup", [
                `> Status Saat Ini : *${isCurrentlyOn ? "AKTIF (ON)" : "NONAKTIF (OFF)"}*`,
                `> Format : *${prefix}antilink on* atau *${prefix}antilink off*`,
                `> Keterangan : *Menghapus semua link/URL apa pun dari grup otomatis*`
            ]);
        }

        if (action === "on" && !isBotAdmins) {
            return reply("⚠️ *Gagal Mengaktifkan Antilink!*\nBot harus menjadi *Admin Grup* terlebih dahulu agar memiliki izin untuk menghapus pesan anggota lain.");
        }

        const state = readState();
        state[m.chat] = {
            enabled: action === "on",
            updatedAt: new Date().toISOString()
        };
        writeState(state);

        return menuReply(sock, m, context, "Antilink Grup", [
            `> Grup : *${groupName || m.chat}*`,
            `> Status : *${action === "on" ? "AKTIF (ON)" : "NONAKTIF (OFF)"}*`,
            `> Tindakan : *Semua format link (http, https, www, domain, shortlink) ${action === "on" ? "akan langsung dihapus seketika" : "dibiarkan"}*`
        ]);
    }
};
