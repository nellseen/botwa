// ===================================================
//  NellsBotBase - Music Search & Audio Downloader
//  Enhanced & Resilient Multi-Strategy Pipeline
// ===================================================

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const yts = require("yt-search");
const { resolveSenderJid } = require("../../lib/target");
const logger = require("../../lib/logger");

// Known active SoundCloud client IDs
const KNOWN_SC_CLIENT_IDS = [
    "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo",
    "b8rF2QnNqVb9dF6ZpX8u4Q2W7Y3e1M5a",
    "iZIs9mchVcX5lhVRphQggOuUMDNTGWih",
    "a3e059563d7fd3372b49b37f00a00bcf"
];

let cachedClientId = null;
let lastClientIdCheck = 0;

/**
 * Dynamically gets an active SoundCloud Client ID with cache and fallbacks
 */
async function getSoundCloudClientId() {
    const now = Date.now();
    if (cachedClientId && (now - lastClientIdCheck < 3600000)) {
        return cachedClientId;
    }

    try {
        const scHtml = await axios.get("https://soundcloud.com", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            },
            timeout: 5000
        });

        const scriptUrls = scHtml.data.match(/https:\/\/[a-zA-Z0-9-._~:\/?#\[\]@!$&'()*+,;=]+?\.js/g) || [];
        for (const scriptUrl of scriptUrls.slice(-8)) {
            try {
                const sRes = await axios.get(scriptUrl, { timeout: 3500 });
                const match = sRes.data.match(/client_id:"([a-zA-Z0-9]{32})"/);
                if (match && match[1]) {
                    cachedClientId = match[1];
                    lastClientIdCheck = now;
                    return cachedClientId;
                }
            } catch (_) {}
        }
    } catch (_) {}

    // Fallback to rotating client IDs
    cachedClientId = KNOWN_SC_CLIENT_IDS[Math.floor(Math.random() * KNOWN_SC_CLIENT_IDS.length)];
    lastClientIdCheck = now;
    return cachedClientId;
}

function formatDuration(ms) {
    if (!ms || isNaN(ms)) return "3:30";
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec < 10 ? "0" : ""}${sec}`;
}

/**
 * Strategy 1: Siputzx Public REST API (Fastest direct MP3 stream)
 */
async function fetchFromSiputzx(query) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    };

    const isUrl = /^https?:\/\/(?:m\.)?soundcloud\.com\//i.test(query);
    let targetUrl = query;

    if (!isUrl) {
        const searchRes = await axios.get(
            `https://api.siputzx.my.id/api/s/soundcloud?query=${encodeURIComponent(query)}`,
            { timeout: 10000, headers }
        );

        const list = searchRes.data?.data;
        if (!Array.isArray(list) || !list.length) {
            throw new Error("Lagu tidak ditemukan di direktori Siputzx.");
        }

        const validItem = list.find(item => item.permalink_url && item.duration > 30000) || list[0];
        if (!validItem || !validItem.permalink_url) {
            throw new Error("Data track Siputzx tidak valid.");
        }
        targetUrl = validItem.permalink_url;
    }

    const dlRes = await axios.get(
        `https://api.siputzx.my.id/api/d/soundcloud?url=${encodeURIComponent(targetUrl)}`,
        { timeout: 10000, headers }
    );

    const dlData = dlRes.data?.data;
    const dlUrl = dlData?.url;
    if (!dlUrl) {
        throw new Error("URL download tidak tersedia di Siputzx.");
    }

    const audioRes = await axios.get(dlUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        headers,
        maxContentLength: 70 * 1024 * 1024
    });

    const buffer = Buffer.from(audioRes.data);
    if (!buffer || buffer.length < 5000) {
        throw new Error("Ukuran audio buffer terlalu kecil.");
    }

    return {
        title: dlData.title || query,
        uploader: dlData.user || "SoundCloud Artist",
        duration: formatDuration(dlData.duration),
        thumbnail: dlData.thumbnail || null,
        url: targetUrl,
        buffer
    };
}

/**
 * Strategy 2: Direct SoundCloud API v2
 */
async function fetchFromSoundCloudV2(query) {
    const clientId = await getSoundCloudClientId();
    const isUrl = /^https?:\/\/(?:m\.)?soundcloud\.com\//i.test(query);

    let track = null;

    if (isUrl) {
        const resolveRes = await axios.get(
            `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(query)}&client_id=${clientId}`,
            { timeout: 8000 }
        );
        track = resolveRes.data;
    } else {
        const searchRes = await axios.get(
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=6`,
            { timeout: 8000 }
        );
        track = searchRes.data?.collection?.[0];
    }

    if (!track) {
        throw new Error("Musik tidak ditemukan di server SoundCloud.");
    }

    const transcodings = track.media?.transcodings || [];
    // Prefer progressive mp3 audio stream
    const progressive = transcodings.find(m => m.format?.protocol === "progressive");

    if (!progressive) {
        // If progressive not available, delegate to yt-dlp with the direct track permalink
        if (track.permalink_url) {
            return await fetchFromYtDlp(track.permalink_url);
        }
        throw new Error("Format audio stream progressive tidak tersedia.");
    }

    const streamInfo = await axios.get(`${progressive.url}?client_id=${clientId}`, { timeout: 8000 });
    if (!streamInfo.data?.url) {
        throw new Error("URL stream audio tidak valid.");
    }

    const audioRes = await axios.get(streamInfo.data.url, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: 70 * 1024 * 1024
    });

    const buffer = Buffer.from(audioRes.data);
    if (!buffer || buffer.length < 5000) {
        throw new Error("Ukuran audio buffer terlalu kecil.");
    }

    return {
        title: track.title || query,
        uploader: track.user?.username || "SoundCloud Artist",
        duration: formatDuration(track.duration),
        thumbnail: track.artwork_url || track.user?.avatar_url || null,
        url: track.permalink_url || query,
        buffer
    };
}

/**
 * Strategy 3: Local yt-dlp binary with Python3
 * Rock-solid fallback supporting HLS, adaptive streams, and direct extraction
 */
async function fetchFromYtDlp(query) {
    const ytdlpPath = path.join(__dirname, "../../bin/yt-dlp");

    if (!fs.existsSync(ytdlpPath)) {
        throw new Error("yt-dlp binary tidak ditemukan.");
    }

    try {
        fs.chmodSync(ytdlpPath, 0o755);
    } catch (_) {}

    const pythonBin = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
    const tempPrefix = `music_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tempBase = path.join("/tmp", tempPrefix);
    const isUrl = /^https?:\/\//i.test(query);
    const searchTarget = isUrl ? query : `scsearch1:${query}`;

    const args = [
        searchTarget,
        "--print-json",
        "-f", "bestaudio/best",
        "-o", `${tempBase}.%(ext)s`,
        "--no-playlist",
        "--socket-timeout", "20",
        "--no-warnings"
    ];

    return new Promise((resolve, reject) => {
        execFile(pythonBin, [ytdlpPath, ...args], { timeout: 45000 }, (err, stdout) => {
            const cleanupTempFiles = () => {
                try {
                    const leftovers = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                    for (const file of leftovers) {
                        try { fs.unlinkSync(path.join("/tmp", file)); } catch (_) {}
                    }
                } catch (_) {}
            };

            if (err) {
                cleanupTempFiles();
                return reject(new Error(`yt-dlp error: ${err.message}`));
            }

            try {
                const lines = stdout.trim().split("\n");
                const jsonLine = lines.find(l => l.startsWith("{"));
                if (!jsonLine) {
                    cleanupTempFiles();
                    return reject(new Error("Gagal membaca metadata JSON dari yt-dlp."));
                }

                const meta = JSON.parse(jsonLine);
                const createdFiles = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                if (!createdFiles.length) {
                    cleanupTempFiles();
                    return reject(new Error("File audio tidak tersimpan oleh yt-dlp."));
                }

                const filePath = path.join("/tmp", createdFiles[0]);
                const audioBuffer = fs.readFileSync(filePath);
                cleanupTempFiles();

                if (!audioBuffer || audioBuffer.length < 5000) {
                    return reject(new Error("Hasil audio yt-dlp kosong atau corrupt."));
                }

                resolve({
                    title: meta.title || query,
                    uploader: meta.uploader || meta.artist || "Artist",
                    duration: meta.duration_string || "3:30",
                    thumbnail: meta.thumbnail || null,
                    url: meta.webpage_url || meta.url || "",
                    buffer: audioBuffer
                });
            } catch (parseErr) {
                cleanupTempFiles();
                reject(parseErr);
            }
        });
    });
}

/**
 * Inspects audio file validity and codec with ffprobe
 */
function inspectAudio(filePath) {
    return new Promise((resolve) => {
        execFile("ffprobe", [
            "-v", "error",
            "-show_entries", "format=duration,format_name,size:stream=codec_name,codec_type",
            "-of", "json",
            filePath
        ], (err, stdout) => {
            if (err) return resolve({ valid: false, error: err.message });
            try {
                const info = JSON.parse(stdout);
                const format = info.format || {};
                const stream = (info.streams || []).find(s => s.codec_type === "audio") || {};
                resolve({
                    valid: true,
                    duration: parseFloat(format.duration || 0),
                    codec: stream.codec_name || "unknown",
                    formatName: format.format_name || "unknown",
                    size: parseInt(format.size || 0, 10)
                });
            } catch (parseErr) {
                resolve({ valid: false, error: parseErr.message });
            }
        });
    });
}

/**
 * Cleans query for better search accuracy
 */
function cleanSongQuery(raw) {
    return raw
        .replace(/\[.*?\]|\(.*?\)/g, " ") // remove brackets
        .replace(/(?:official\s*(?:video|audio|music\s*video|lyric\s*video)?|lirik|lyrics|hd|4k|mv)/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Master multi-strategy music retriever with operation logging
 */
async function fetchMusic(query, opId = 'MP3-SYS') {
    let cleanQuery = query.trim();

    logger.info('MP3', `[SEARCH] op=${opId} query="${cleanQuery}"`);

    // If query is a YouTube URL, extract title first with yt-search
    if (/youtu\.?be/i.test(cleanQuery)) {
        try {
            const ytMatch = cleanQuery.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
            if (ytMatch && ytMatch[1]) {
                const ytData = await yts({ videoId: ytMatch[1] });
                if (ytData && ytData.title) {
                    cleanQuery = cleanSongQuery(ytData.title);
                }
            }
        } catch (_) {}
    }

    const errors = [];

    // Attempt 1: Siputzx Public REST API (Fastest direct MP3 stream)
    try {
        logger.info('MP3', `[DOWNLOAD] op=${opId} provider=Siputzx query="${cleanQuery}"`);
        const res = await fetchFromSiputzx(cleanQuery);
        logger.info('MP3', `[DOWNLOAD_SUCCESS] op=${opId} provider=Siputzx title="${res.title}"`);
        return res;
    } catch (e1) {
        errors.push(`Siputzx: ${e1.message}`);
        logger.warn('MP3', `[DOWNLOAD_FAIL] op=${opId} provider=Siputzx error=${e1.message}`);
    }

    // Attempt 2: Direct SoundCloud API v2
    try {
        logger.info('MP3', `[DOWNLOAD] op=${opId} provider=SoundCloudV2 query="${cleanQuery}"`);
        const res = await fetchFromSoundCloudV2(cleanQuery);
        logger.info('MP3', `[DOWNLOAD_SUCCESS] op=${opId} provider=SoundCloudV2 title="${res.title}"`);
        return res;
    } catch (e2) {
        errors.push(`SoundCloud v2: ${e2.message}`);
        logger.warn('MP3', `[DOWNLOAD_FAIL] op=${opId} provider=SoundCloudV2 error=${e2.message}`);
    }

    // Attempt 3: Local yt-dlp binary with scsearch
    try {
        logger.info('MP3', `[DOWNLOAD] op=${opId} provider=yt-dlp query="${cleanQuery}"`);
        const res = await fetchFromYtDlp(cleanQuery);
        logger.info('MP3', `[DOWNLOAD_SUCCESS] op=${opId} provider=yt-dlp title="${res.title}"`);
        return res;
    } catch (e3) {
        errors.push(`yt-dlp (scsearch): ${e3.message}`);
        logger.warn('MP3', `[DOWNLOAD_FAIL] op=${opId} provider=yt-dlp error=${e3.message}`);
    }

    // Attempt 4: Cleaned query fallback
    const refinedQuery = cleanSongQuery(cleanQuery);
    if (refinedQuery && refinedQuery !== cleanQuery) {
        logger.info('MP3', `[REFINED_SEARCH] op=${opId} refined="${refinedQuery}"`);
        try {
            const res = await fetchFromSiputzx(refinedQuery);
            logger.info('MP3', `[DOWNLOAD_SUCCESS] op=${opId} provider=Siputzx-Refined title="${res.title}"`);
            return res;
        } catch (_) {}

        try {
            const res = await fetchFromYtDlp(refinedQuery);
            logger.info('MP3', `[DOWNLOAD_SUCCESS] op=${opId} provider=yt-dlp-Refined title="${res.title}"`);
            return res;
        } catch (_) {}
    }

    throw new Error(`Semua server musik gagal merespon (${errors.join("; ")})`);
}

module.exports = {
    name: "mp3",
    category: "tools",
    command: ["mp3", "play", "music", "lagu"],
    description: "Cari dan download musik/lagu audio ke WhatsApp",
    run: async (context) => {
        const { sock, m, text, q, prefix, botName, thumb, reply } = context;

        // Generate unique operation ID for tracing the entire lifecycle of this command
        const opId = 'MP3-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

        const query = (text || q || "").trim();

        if (!query) {
            return reply(
                `\`「 NellsBot Music 」\`\n` +
                `> 🎵 *Format:* ${prefix}mp3 <judul lagu atau URL>\n` +
                `> 💡 *Contoh:* ${prefix}mp3 separuh aku\n` +
                `> ⚡ *Alias:* ${prefix}play, ${prefix}lagu, ${prefix}music`
            );
        }

        logger.info('MP3', `[START] op=${opId} query="${query}" chat=${m.chat} sender=${m.sender}`);
        await reply(`🔎 *Mencari dan memproses:* "${query}"...\n_Mohon tunggu sebentar, sistem sedang mengunduh audio..._`);

        try {
            const data = await fetchMusic(query, opId);

            const safeTitle = (data.title || "audio")
                .replace(/[/\\?%*:|"<>]/g, "")
                .slice(0, 80)
                .trim();
            const sizeMb = (data.buffer.length / (1024 * 1024)).toFixed(2);

            let thumbBuf = null;
            if (data.thumbnail) {
                try {
                    const res = await axios.get(data.thumbnail, {
                        responseType: "arraybuffer",
                        timeout: 5000
                    });
                    thumbBuf = Buffer.from(res.data);
                } catch (_) {
                    thumbBuf = thumb;
                }
            } else {
                thumbBuf = thumb;
            }

            const caption =
                `\`「 ${botName} Music 」\`\n` +
                `> 🎵 *Judul:* ${data.title}\n` +
                `> 👤 *Artis:* ${data.uploader}\n` +
                `> ⏱️ *Durasi:* ${data.duration}\n` +
                `> 📁 *Ukuran:* ${sizeMb} MB\n\n` +
                `_*Mengirim file audio... Selamat mendengarkan!*_`;

            await reply(caption);

            // Save audio to absolute temporary file on disk for streaming upload
            const tempAudioPath = path.join("/tmp", `music_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
            await fs.promises.writeFile(tempAudioPath, data.buffer);

            // Audit audio file with ffprobe to determine exact codec, container, duration, and MIME type
            const audioProbe = await inspectAudio(tempAudioPath);
            let resolvedMime = "audio/mpeg";
            if (audioProbe.valid) {
                if (audioProbe.codec === "mp3" || (audioProbe.formatName && audioProbe.formatName.includes("mp3"))) {
                    resolvedMime = "audio/mpeg";
                } else if (audioProbe.codec === "aac" || audioProbe.codec === "m4a") {
                    resolvedMime = "audio/mp4";
                } else if (audioProbe.codec === "opus" || audioProbe.codec === "vorbis") {
                    resolvedMime = "audio/ogg; codecs=opus";
                }
            }

            const stat = await fs.promises.stat(tempAudioPath);
            if (!stat || stat.size === 0) {
                throw new Error(`File audio kosong di disk: ${tempAudioPath}`);
            }

            // Accurately resolve genuine user target across private, group, and LID sessions
            const resolved = await resolveSenderJid(sock, m, context.groupMetadata);
            const userTarget = context.senderJid || resolved.jid;
            const chatJid = m.chat;

            logger.info('MP3', `[METADATA] op=${opId} title="${data.title}" uploader="${data.uploader}" duration="${data.duration}"`);
            logger.info('MP3', `[FILE] op=${opId} path=${tempAudioPath} exists=true size=${stat.size} mimetype=${resolvedMime} codec=${audioProbe.codec} duration=${audioProbe.duration}s`);
            logger.info('MP3', `[TARGET] op=${opId} chat=${chatJid} isGroup=${context.isGroup || false}`);
            logger.info('MP3', `[RESOLVED_USER] op=${opId} raw_sender=${m.sender} resolved_user=${userTarget} (source=${resolved.source})`);

            // Reusable helper to send audio message safely with returned key verification and stage tracking
            const sendAudioTo = async (targetJid, quotedMsg = null, targetLabel = 'CHAT') => {
                if (!targetJid) {
                    logger.warn('MP3', `[SEND_SKIPPED] op=${opId} targetJid is empty`);
                    return null;
                }

                logger.info('MP3', `[SEND] op=${opId} target=${targetJid} target_type=${targetLabel} stage=SEND_STARTED`);

                try {
                    const payload = {
                        audio: { url: tempAudioPath },
                        mimetype: resolvedMime,
                        fileName: `${safeTitle}.mp3`,
                        ptt: false
                    };

                    const sent = await sock.sendMessage(targetJid, payload, quotedMsg ? { quoted: quotedMsg } : {});
                    logger.info('MP3', `[SEND] op=${opId} target=${targetJid} stage=SEND_RESOLVED`);

                    const hasValidKey = Boolean(sent?.key?.id && sent?.key?.remoteJid);

                    if (hasValidKey) {
                        logger.info('MP3', `[SEND] op=${opId} target=${sent.key.remoteJid} stage=MESSAGE_KEY_RECEIVED message_id=${sent.key.id}`);
                        // Register message for automatic ACK / delivery tracking
                        logger.registerMessageOp(sent.key.id, opId, 'MP3', targetJid);
                        return sent;
                    } else {
                        logger.error('MP3', `[SEND_FAIL] op=${opId} target=${targetJid} reason="returned message key is empty"`, null, opId);
                        return null;
                    }
                } catch (sendErr) {
                    logger.error('MP3', `[SEND_ERROR] op=${opId} target=${targetJid} stage=SEND_FAILED`, sendErr, opId);
                    throw sendErr;
                }
            };

            // Schedule cleanup of temporary audio file
            const cleanupTimer = setTimeout(() => {
                try {
                    if (fs.existsSync(tempAudioPath)) {
                        fs.unlinkSync(tempAudioPath);
                        logger.info('MP3', `[CLEANUP] op=${opId} removed temporary file ${tempAudioPath}`);
                    }
                } catch (_) {}
            }, 60000);
            if (cleanupTimer && cleanupTimer.unref) cleanupTimer.unref();

            if (context.isGroup) {
                // TARGET 1: Group
                try {
                    const sentGroup = await sendAudioTo(chatJid, m, 'GROUP');
                    if (sentGroup) {
                        logger.info('MP3', `[SEND_GROUP] op=${opId} status=SENT message_id=${sentGroup.key?.id}`);
                    } else {
                        logger.warn('MP3', `[SEND_GROUP] op=${opId} status=FAILED`);
                    }
                } catch (groupErr) {
                    logger.error('MP3', `[SEND_GROUP] op=${opId} status=ERROR`, groupErr, opId);
                }

                // TARGET 2: Private user who ran the command
                if (userTarget && userTarget !== chatJid) {
                    try {
                        const sentPrivate = await sendAudioTo(userTarget, null, 'PRIVATE_USER');
                        if (sentPrivate) {
                            logger.info('MP3', `[SEND_PRIVATE] op=${opId} status=SENT message_id=${sentPrivate.key?.id}`);
                        } else {
                            logger.warn('MP3', `[SEND_PRIVATE] op=${opId} status=FAILED`);
                        }
                    } catch (userErr) {
                        logger.error('MP3', `[SEND_PRIVATE] op=${opId} status=ERROR`, userErr, opId);
                        await reply(`⚠️ _Catatan: Audio gagal dikirimkan ke chat pribadi kamu (${userErr.message})._`);
                    }
                }
            } else {
                // Private chat execution
                try {
                    const sentPrivate = await sendAudioTo(chatJid, m, 'PRIVATE_CHAT');
                    if (sentPrivate) {
                        logger.info('MP3', `[SEND_PRIVATE] op=${opId} status=SENT message_id=${sentPrivate.key?.id}`);
                    } else {
                        logger.warn('MP3', `[SEND_PRIVATE] op=${opId} status=FAILED`);
                    }
                } catch (privateErr) {
                    logger.error('MP3', `[SEND_PRIVATE] op=${opId} status=ERROR`, privateErr, opId);
                }
            }

        } catch (err) {
            logger.error('MP3', `op=${opId} Download/Send failed for query="${query}"`, err, opId);
            return reply(`❌ *Gagal memutar musik:* ${err.message || "Lagu tidak ditemukan atau server sedang sibuk."}`);
        }
    }
};
