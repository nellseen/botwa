// ===================================================
//  NellsBotBase - Modular Core Handler
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

require('./control/settings');
const config = require('./lib/config');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const util = require('util');
const { spawn, exec, execSync } = require('child_process');
const plugins = require('./lib/plugins');
const { resolveSenderJid } = require('./lib/target');
const logger = require('./lib/logger');
const { readJsonCached } = require('./lib/jsonCache');

// Cache group metadata for 2 minutes to prevent Baileys 429 rate limits
const groupMetaCache = new Map();
const socketCacheIds = new WeakMap();
let nextSocketCacheId = 1;
function parseJson(value, fallback = {}) {
    try { return JSON.parse(value || '{}'); } catch (_) { return fallback; }
}
async function getCachedGroupMetadata(sock, chatJid) {
    if (!sock || !chatJid) return null;
    let socketId = socketCacheIds.get(sock);
    if (!socketId) {
        socketId = nextSocketCacheId++;
        socketCacheIds.set(sock, socketId);
    }
    const cacheKey = `${socketId}:${chatJid}`;
    const cached = groupMetaCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp < 120000)) {
        groupMetaCache.delete(cacheKey);
        groupMetaCache.set(cacheKey, cached);
        return cached.data;
    }
    for (const [key, value] of groupMetaCache) {
        if (now - value.timestamp >= 120000) groupMetaCache.delete(key);
    }
    try {
        const meta = await sock.groupMetadata(chatJid);
        if (meta) {
            groupMetaCache.delete(cacheKey);
            groupMetaCache.set(cacheKey, { data: meta, timestamp: now });
            while (groupMetaCache.size > 5000) groupMetaCache.delete(groupMetaCache.keys().next().value);
        }
        return meta;
    } catch (_) {
        return cached ? cached.data : null;
    }
}

const {
    default: baileys,
    proto,
    generateWAMessage,
    generateWAMessageFromContent,
    getContentType,
    prepareWAMessageMedia,
    areJidsSameUser
} = require("@itsliaaa/baileys");

const { 
    smsg,
    sendGmail,
    formatSize,
    isUrl,
    generateMessageTag,
    getBuffer,
    getSizeMedia,
    runtime,
    fetchJson,
    sleep,
    processTime,
    getTime,
    tanggal,
    parseMention
} = require('./lib/myfunc');

plugins.initPlugins();

let cachedThumb = null;
async function getThumbnail() {
    try {
        if (!cachedThumb && fs.existsSync('./lib/media/menu.png')) {
            cachedThumb = await sharp('./lib/media/menu.png')
                .resize(300, 300)
                .jpeg({ quality: 80 })
                .toBuffer();
        }
        return cachedThumb;
    } catch (_) {
        return null;
    }
}

function formatSubs(count) {
    if (!count || count === 0) return '0';
    if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (count >= 1_000) return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(count);
}

function formatDate(timestamp) {
    if (!timestamp) return '—';
    const d = new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = async (sock, m, chatUpdate, store, session) => {
    try {
        const body = (
            m.mtype === "conversation" ? m.message.conversation :
            m.mtype === "imageMessage" ? m.message.imageMessage.caption :
            m.mtype === "videoMessage" ? m.message.videoMessage.caption :
            m.mtype === "extendedTextMessage" ? m.message.extendedTextMessage.text :
            m.mtype === "buttonsResponseMessage" ? m.message.buttonsResponseMessage.selectedButtonId :
            m.mtype === "listResponseMessage" ? m.message.listResponseMessage.singleSelectReply.selectedRowId :
            m.mtype === "templateButtonReplyMessage" ? m.message.templateButtonReplyMessage.selectedId :
            m.mtype === "interactiveResponseMessage" ? parseJson(m.msg?.nativeFlowResponseMessage?.paramsJson).id :
            m.mtype === "templateButtonReplyMessage" ? m.msg.selectedId :
            m.mtype === "messageContextInfo" ? m.message.buttonsResponseMessage?.selectedButtonId || m.message.listResponseMessage?.singleSelectReply.selectedRowId || m.text : ""
        ) || "";

        const premium = readJsonCached(path.join(__dirname, 'lib/database/premium.json'), []);
        const OWNER_PATH = path.join(__dirname, 'lib/database/owner.json');
        const sender = m.key.fromMe
            ? sock.user.id.split(":")[0] || sock.user.id
            : m.key.participant || m.key.remoteJid;
        const normalizeAccessJid = value => {
            const jid = String(value || "").replace(/:\d+(?=@)/, "");
            if (jid.endsWith("@lid")) return jid;
            if (jid.includes("@")) return jid;
            const number = jid.replace(/[^0-9]/g, "");
            return number ? `${number}@s.whatsapp.net` : "";
        };
        let accessSender = normalizeAccessJid(sender);
        if (accessSender.endsWith("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                accessSender = normalizeAccessJid(await sock.signalRepository.lidMapping.getPNForLID(accessSender) || accessSender);
            } catch (_) {}
        }
        const senderNumber = sender.split('@')[0];
        const budy = (typeof m.text === 'string' ? m.text : '');
        const prefix = config.prefix;
        const from = m.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const isChannel = from.endsWith("@newsletter");
        const botNumber = await sock.decodeJid(sock.user.id);
        const normalizeJid = jid => sock.decodeJid(String(jid || '')).replace(/:\d+(?=@)/, '');
        const jidUser = jid => normalizeJid(jid).split('@')[0].replace(/[^0-9]/g, '');
        const asUserJid = value => {
            const clean = normalizeJid(value);
            if (!clean) return '';
            if (clean.includes('@')) return clean;
            const number = clean.replace(/[^0-9]/g, '');
            return number ? number + '@s.whatsapp.net' : '';
        };

        const ownerbot = readJsonCached(OWNER_PATH, []);
        const sameAccessJid = value => normalizeAccessJid(value) === accessSender;
        const isSimulation = Boolean(m?.isSimulation || sock?.isSimulation || session?.isSimulation);
        const isPremium = isSimulation ? false : premium.some(sameAccessJid);
        const isOwner = isSimulation ? false : ownerbot.some(sameAccessJid);
        const isCreator = isSimulation ? false : [botNumber, ...config.owners].some(sameAccessJid);
        const bodyTrim = (body || '').trim();
        const prefixMatch = bodyTrim.startsWith(prefix) ? prefix : null;
        let command = '';
        let args = [];

        if (prefixMatch) {
            const prefixChar = prefixMatch[0];
            const withoutPrefix = bodyTrim.slice(prefixChar.length).trim();
            const parts = withoutPrefix.split(/ +/);
            command = parts.shift().toLowerCase() || '';
            args = parts;
        } else {
            const parts = bodyTrim.split(/ +/);
            command = parts.shift().toLowerCase() || '';
            args = parts;
        }

        const pushname = m.pushName || "no name";
        const text = args.join(" ");
        const q = text;
        const quoted = m.quoted ? m.quoted : m;
        const mime = (quoted.msg || quoted).mimetype || '';
        const qmsg = (quoted.msg || quoted);
        const isMedia = /image|video|sticker|audio/.test(mime);
        const groupMetadata = isGroup ? await getCachedGroupMetadata(sock, m.chat) : null;
        const groupOwner = isGroup ? groupMetadata?.owner : "";
        const groupName = isGroup ? groupMetadata?.subject : "";
        const participants = isGroup ? (groupMetadata?.participants || []) : [];
        const groupAdminParticipants = isGroup ? participants.filter((v) => v.admin !== null) : [];
        const groupAdmins = groupAdminParticipants.map(v => v.id);
        const groupMembers = isGroup ? groupMetadata?.participants : [];

        // Accurately resolve genuine sender JID and LID mapping
        const senderResolution = await resolveSenderJid(sock, m, groupMetadata);
        const senderJid = senderResolution.jid || normalizeAccessJid(sender);
        m.senderJid = senderJid;

        logger.info('ROUTER', `target_resolution chat=${m.chat} raw=${m.sender} -> resolved=${senderJid} (source=${senderResolution.source})`);

        if (command) {
            logger.info('COMMAND', `cmd="${command}" args="${text}" chat=${m.chat} sender=${senderJid} isGroup=${isGroup}`);
        }

        const sameUser = (a, b) => {
            if (!a || !b) return false;
            try {
                return areJidsSameUser(a, b);
            } catch (_) {
                return false;
            }
        };

        const isGroupAdmins = isGroup ? groupAdminParticipants.some(p => {
            const pid = String(p.id || "");
            const pphone = String(p.phoneNumber || "");
            const plid = String(p.lid || "");
            return sameUser(pid, senderJid) || sameUser(pphone, senderJid) ||
                   sameUser(plid, senderJid) || sameUser(pid, m.sender) ||
                   sameUser(pphone, m.sender) || sameUser(plid, m.sender);
        }) : false;

        const botLid = isGroup ? sock.user?.lid : "";
        const cleanBotDigits = botNumber.replace(/[^0-9]/g, '');
        const isBotGroupAdmins = isGroup ? groupAdminParticipants.some(participant => {
            const pid = String(participant.id || "");
            const pphone = String(participant.phoneNumber || "");
            const plid = String(participant.lid || "");
            return sameUser(pid, botNumber) ||
                sameUser(pphone, botNumber) ||
                sameUser(plid, botLid) ||
                sameUser(pid, botLid) ||
                (cleanBotDigits && pid.replace(/[^0-9]/g, '') === cleanBotDigits) ||
                (cleanBotDigits && pphone.replace(/[^0-9]/g, '') === cleanBotDigits);
        }) : false;
        const isBotAdmins = isBotGroupAdmins;
        const isAdmins = isGroupAdmins;

        const reply = (teks) => {
            return sock.sendMessage(m.chat, { text: teks }, { quoted: m });
        };

        if (!sock.public && !isCreator) return;

        const thumb = await getThumbnail();
        const botName = config.botName;
        const botVersion = config.botVersion;
        const botDev = config.botDev;
        const botCategory = config.botCategory;
        const totalCommands = plugins.countCommands();
        const memoryUsage = `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`;

        const context = {
            session,
            sessionId: session ? session.sessionId : null,
            userId: session ? session.userId : null,
            phoneNumber: session ? session.phoneNumber : null,
            sock,
            m,
            chatUpdate,
            store,
            body,
            budy,
            prefix,
            command,
            args,
            text,
            q,
            quoted,
            mime,
            qmsg,
            isMedia,
            from,
            sender,
            senderJid,
            senderNumber,
            botNumber,
            pushname,
            isGroup,
            isChannel,
            groupMetadata,
            groupOwner,
            groupName,
            participants,
            groupAdmins,
            groupMembers,
            isGroupAdmins,
            isBotGroupAdmins,
            isBotAdmins,
            isAdmins,
            isOwner,
            isCreator,
            isPremium,
            isSimulation,
            logger,
            reply,
            thumb,
            botName,
            botVersion,
            botDev,
            botCategory,
            totalCommands,
            memoryUsage,
            formatSubs,
            formatDate,
            runtime,
            getBuffer,
            getSizeMedia,
            fetchJson,
            sleep,
            processTime,
            getTime,
            tanggal,
            parseMention,
            sendGmail,
            isUrl,
            generateMessageTag,
            baileys,
            proto,
            generateWAMessage,
            generateWAMessageFromContent,
            getContentType,
            prepareWAMessageMedia,
            sharp,
            exec,
            spawn,
            fs,
            plugins
        };

        const handledBefore = await plugins.runBefore(context);
        if (handledBefore) return;

        if (command) {
            const plugin = plugins.findPlugin(command);
            if (plugin && typeof plugin.run === 'function') {
                if (isSimulation && (plugin.category === 'owner' || plugin.owner === true || plugin.name === 'exec')) {
                    return reply("*Akses ditolak: Plugin owner dilarang dalam mode simulasi!*");
                }
                if (plugin.premium && !isPremium && !isCreator && !isOwner) {
                    return reply("*Fitur ini khusus user premium dan owner!*");
                }
                if (plugin.owner && !plugin.premium && !isCreator && !isOwner) {
                    return reply("*khusus owner!*");
                }
                if (plugin.group && !isGroup) {
                    return reply("*khusus grup!*");
                }
                if (plugin.admin && !isGroupAdmins && !isOwner && !isCreator) {
                    return reply("*khusus admin grup!*");
                }
                await plugin.run(context);
            }
        }
    } catch (err) {
        console.error(util.format(err));
    }
};

if (process.env.NODE_ENV !== 'test') {
    const file = require.resolve(__filename);
    fs.watchFile(file, { interval: 5000 }, () => {
        fs.unwatchFile(file);
        console.log('\x1b[0;32m' + __filename + ' \x1b[1;32mupdated!\x1b[0m');
        delete require.cache[file];
        require(file);
    });
}
