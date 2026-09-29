const fs = require("fs");
const { areJidsSameUser } = require("@itsliaaa/baileys");

function normalizeJid(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.endsWith("@lid")) return raw.replace(/:\d+(?=@)/, "");
    if (raw.includes("@")) {
        const cleaned = raw.replace(/:\d+(?=@)/, "");
        if (cleaned.endsWith("@s.whatsapp.net")) return cleaned;
        if (cleaned.endsWith("@g.us") || cleaned.endsWith("@newsletter")) return cleaned;
    }
    const digits = raw.replace(/[^0-9]/g, "");
    if (!digits) return "";
    return (digits.startsWith("0") ? `62${digits.slice(1)}` : digits) + "@s.whatsapp.net";
}

function getMentionedJids(m) {
    const context = m?.msg?.contextInfo || {};
    const messageContext = m?.message?.extendedTextMessage?.contextInfo || {};
    return [
        ...(Array.isArray(m?.mentionedJid) ? m.mentionedJid : []),
        ...(Array.isArray(context.mentionedJid) ? context.mentionedJid : []),
        ...(Array.isArray(messageContext.mentionedJid) ? messageContext.mentionedJid : [])
    ];
}

async function resolveTarget(sock, m, args, text, groupMetadata) {
    const mentioned = getMentionedJids(m);
    if (mentioned.length) {
        const mentionedJid = normalizeJid(mentioned[0]);
        if (mentionedJid.endsWith("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                const mapped = await sock.signalRepository.lidMapping.getPNForLID(mentionedJid);
                if (mapped) return normalizeJid(mapped);
            } catch (_) {}
        }
        const participant = groupMetadata?.participants?.find(item => {
            return normalizeJid(item.id) === mentionedJid || normalizeJid(item.phoneNumber) === mentionedJid;
        });
        if (participant) return normalizeJid(participant.phoneNumber || participant.id);

        if (mentionedJid.endsWith("@s.whatsapp.net")) return mentionedJid;
    }
    const rawText = String(text || "");
    const mentionText = rawText.match(/@(\d{8,16})/);
    if (mentionText && sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const mapped = await sock.signalRepository.lidMapping.getPNForLID(`${mentionText[1]}@lid`);
            if (mapped) return normalizeJid(mapped);
        } catch (_) {}
    }
    const token = args?.[0] || mentionText?.[1] || rawText.trim().split(/\s+/)[0];
    return normalizeJid(token);
}

/**
 * Resolves the genuine user JID who triggered the command across private & group chats,
 * correctly mapping LID -> Phone Number JID (@s.whatsapp.net) with Baileys signalRepository
 * and groupMetadata fallbacks.
 */
async function resolveSenderJid(sock, m, groupMetadata = null) {
    // 1. If message is sent from the connected device itself (fromMe)
    if (m?.key?.fromMe) {
        const botId = sock?.user?.id || "";
        const cleanBot = sock?.decodeJid ? sock.decodeJid(botId) : botId;
        const resolved = normalizeJid(cleanBot);
        return { jid: resolved, source: "bot_self" };
    }

    // 2. Candidate JIDs in priority order
    const candidates = [
        m?.key?.participant,
        m?.participant,
        m?.sender,
        m?.key?.remoteJid
    ].filter(Boolean);

    for (const raw of candidates) {
        const clean = normalizeJid(raw);

        // If candidate is already a valid phone number JID
        if (clean.endsWith("@s.whatsapp.net") && !clean.includes(":")) {
            return { jid: clean, source: "direct_pn" };
        }

        // If candidate is a Privacy LID (@lid), resolve to actual phone number
        if (clean.endsWith("@lid") || raw.includes("@lid")) {
            const lid = clean.endsWith("@lid") ? clean : raw;

            // Strategy A: Query Baileys Signal Repository LID mapping
            if (sock?.signalRepository?.lidMapping?.getPNForLID) {
                try {
                    const mappedPn = await sock.signalRepository.lidMapping.getPNForLID(lid);
                    if (mappedPn) {
                        return { jid: normalizeJid(mappedPn), source: "lid_mapping" };
                    }
                } catch (_) {}
            }

            // Strategy B: Match with Group Metadata participants
            if (groupMetadata?.participants?.length) {
                const match = groupMetadata.participants.find(p => {
                    const pid = String(p.id || "");
                    const plid = String(p.lid || "");
                    const pphone = String(p.phoneNumber || "");
                    return pid === clean || plid === clean || pid === raw || plid === raw ||
                        areJidsSameUser(pid, clean) || areJidsSameUser(plid, clean);
                });

                if (match) {
                    const pn = match.phoneNumber || match.id;
                    if (pn && !pn.endsWith("@lid")) {
                        return { jid: normalizeJid(pn), source: "group_participant_meta" };
                    }
                }
            }
        }
    }

    // Fallback: decode and normalize first non-empty candidate
    const fallback = candidates[0] || m?.chat || "";
    const cleanFallback = sock?.decodeJid ? sock.decodeJid(fallback) : fallback;
    return { jid: normalizeJid(cleanFallback), source: "fallback" };
}

function readList(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(value) ? value : [];
    } catch (_) {
        return [];
    }
}

function writeList(filePath, values) {
    fs.writeFileSync(filePath, JSON.stringify([...new Set(values)], null, 2));
}

async function verifyWhatsAppNumber(sock, jid) {
    if (!jid) return false;
    try {
        const result = await sock.onWhatsApp(jid);
        return Array.isArray(result) && result.some(item => item?.exists === true || item?.jid);
    } catch (_) {
        return false;
    }
}

module.exports = {
    normalizeJid,
    resolveTarget,
    resolveSenderJid,
    readList,
    writeList,
    verifyWhatsAppNumber
};
