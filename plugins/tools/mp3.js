// ===================================================
//  NellsBotBase - Music Search & Audio Downloader
//  Enhanced Multi-Source Search & Interactive Song Selection Interface
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
    "so5r9Dsxv6jJRgHa5fGXfevkxr4VgNJf",
    "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo",
    "b8rF2QnNqVb9dF6ZpX8u4Q2W7Y3e1M5a",
    "iZIs9mchVcX5lhVRphQggOuUMDNTGWih",
    "a3e059563d7fd3372b49b37f00a00bcf"
];

let cachedClientId = null;
let lastClientIdCheck = 0;

// Active music search sessions
// Key: `${chat}:${userJid}` -> session object
const activeSearchSessions = new Map();
// Key: messageId -> session key
const activeMessageToSession = new Map();

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
            timeout: 6000
        });

        const scriptUrls = scHtml.data.match(/https:\/\/[a-zA-Z0-9-._~:\/?#\[\]@!$&*+,;=]+?\.js/g) || [];
        for (const scriptUrl of scriptUrls.slice(-10)) {
            try {
                const sRes = await axios.get(scriptUrl, { timeout: 3500 });
                const match = sRes.data.match(/client_id[:=]["']?([a-zA-Z0-9]{32})/);
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
    const progressive = transcodings.find(t => t.format?.protocol === "progressive");
    const hls = transcodings.find(t => t.format?.protocol === "hls");
    const selectedTranscoding = progressive || hls || transcodings[0];

    if (!selectedTranscoding) {
        throw new Error("Media transcoding tidak tersedia untuk lagu ini.");
    }

    const streamAuthRes = await axios.get(
        `${selectedTranscoding.url}?client_id=${clientId}&track_authorization=${track.track_authorization || ""}`,
        { timeout: 8000 }
    );

    const streamUrl = streamAuthRes.data?.url;
    if (!streamUrl) {
        throw new Error("Stream direct URL tidak dapat digenerate.");
    }

    const audioRes = await axios.get(streamUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: 70 * 1024 * 1024
    });

    const buffer = Buffer.from(audioRes.data);
    if (!buffer || buffer.length < 5000) {
        throw new Error("Buffer audio dari SoundCloud API v2 tidak valid.");
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

                const metadata = JSON.parse(jsonLine);
                const candidates = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix) && !f.endsWith(".json"));

                if (!candidates.length) {
                    cleanupTempFiles();
                    return reject(new Error("File hasil download yt-dlp tidak ditemukan di disk."));
                }

                const finalPath = path.join("/tmp", candidates[0]);
                const buffer = fs.readFileSync(finalPath);
                cleanupTempFiles();

                resolve({
                    title: metadata.title || query,
                    uploader: metadata.uploader || metadata.channel || "yt-dlp Artist",
                    duration: metadata.duration_string || formatDuration((metadata.duration || 0) * 1000),
                    thumbnail: metadata.thumbnail || null,
                    url: metadata.webpage_url || query,
                    buffer
                });
            } catch (parseErr) {
                cleanupTempFiles();
                reject(new Error(`Gagal memproses file audio yt-dlp: ${parseErr.message}`));
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
    if (!raw) return "";
    return raw
        .replace(/^(?:play|lagu|musik|music|mp3)\s+/i, "")
        .replace(/\b(?:lirik|lyrics|official\s+video|official\s+audio|audio|video|mp3|mv)\b/gi, "")
        .replace(/[()[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Multi-Source Search Engine for Song Selection Interface
 * Queries SoundCloud v2, Siputzx, and yt-search
 */
async function searchMusicList(query) {
    const cleanQuery = query.trim();
    const results = [];
    const seenUrls = new Set();

    // Source 1: SoundCloud API v2
    try {
        const clientId = await getSoundCloudClientId();
        const scRes = await axios.get(
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(cleanQuery)}&client_id=${clientId}&limit=8`,
            { timeout: 8000 }
        );
        const scTracks = scRes.data?.collection || [];
        for (const track of scTracks) {
            if (track.permalink_url && !seenUrls.has(track.permalink_url)) {
                seenUrls.add(track.permalink_url);
                results.push({
                    title: track.title,
                    artist: track.user?.username || "SoundCloud Artist",
                    duration: formatDuration(track.duration),
                    url: track.permalink_url,
                    thumbnail: track.artwork_url || track.user?.avatar_url || null,
                    source: "SoundCloud"
                });
            }
        }
    } catch (e1) {
        logger.warn('MP3', `[SEARCH_SC_WARN] ${e1.message}`);
    }

    // Source 2: Siputzx SoundCloud search API
    if (results.length < 5) {
        try {
            const sRes = await axios.get(
                `https://api.siputzx.my.id/api/s/soundcloud?query=${encodeURIComponent(cleanQuery)}`,
                { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }
            );
            const list = sRes.data?.data || [];
            for (const item of list) {
                if (item.permalink_url && !seenUrls.has(item.permalink_url)) {
                    seenUrls.add(item.permalink_url);
                    let rawTitle = (item.permalink || "").replace(/-/g, " ").trim();
                    if (!rawTitle || rawTitle.length < 3) rawTitle = cleanQuery;
                    const title = rawTitle.replace(/\b\w/g, l => l.toUpperCase());

                    results.push({
                        title,
                        artist: (item.permalink_url.split("/")[3] || "SoundCloud Artist").replace(/-/g, " "),
                        duration: formatDuration(item.duration),
                        url: item.permalink_url,
                        thumbnail: item.artwork_url || null,
                        source: "SoundCloud"
                    });
                }
            }
        } catch (e2) {
            logger.warn('MP3', `[SEARCH_SIPUTZX_WARN] ${e2.message}`);
        }
    }

    // Source 3: yt-search
    if (results.length < 5) {
        try {
            const yt = await yts(cleanQuery);
            for (const vid of (yt.videos || []).slice(0, 6)) {
                if (vid.url && !seenUrls.has(vid.url)) {
                    seenUrls.add(vid.url);
                    results.push({
                        title: vid.title,
                        artist: vid.author?.name || "YouTube",
                        duration: vid.timestamp || "3:30",
                        url: vid.url,
                        thumbnail: vid.thumbnail || null,
                        source: "YouTube"
                    });
                }
            }
        } catch (e3) {
            logger.warn('MP3', `[SEARCH_YTS_WARN] ${e3.message}`);
        }
    }

    return results.slice(0, 5);
}

/**
 * Builds the interactive song selection interface text
 */
function buildSearchInterface(query, results) {
    const listLines = results.map((item, idx) => {
        return (
            `│ [${idx + 1}] *${item.title}*\n` +
            `│     ⏱ *${item.duration}* • 👤 _${item.artist}_`
        );
    }).join("\n│\n");

    return (
        `╭───「 🎵 *PENCARIAN LAGU* 」\n` +
        `│ 🔎 *Query:* _${query}_\n` +
        `│ 📊 *Hasil:* ${results.length} lagu ditemukan\n` +
        `│ ⏱ *Batas Waktu:* 120 detik\n` +
        `├───\n` +
        `${listLines}\n` +
        `╰────────────────────────\n` +
        `📌 *Balas pesan ini dengan angka (1 - ${results.length}) untuk memutar lagu.*\n` +
        `💡 *Atau ketik *batal* untuk membatalkan pencarian.*`
    );
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
            const yt = await yts({ videoId: cleanQuery.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1] });
            if (yt && yt.title) {
                cleanQuery = `${yt.title} ${yt.author?.name || ""}`;
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

/**
 * Common delivery pipeline for sending audited audio to group & private user
 */
async function deliverAudio(context, data, opId) {
    const { sock, m, thumb, reply } = context;

    const safeTitle = (data.title || "audio")
        .replace(/[/\\?%*:|"<>]/g, "")
        .slice(0, 80)
        .trim();

    // Prepare thumbnail buffer if available
    let thumbBuf = thumb;
    if (data.thumbnail) {
        try {
            const tRes = await axios.get(data.thumbnail, { responseType: "arraybuffer", timeout: 8000 });
            if (tRes.data && tRes.data.length > 500) thumbBuf = Buffer.from(tRes.data);
        } catch (_) {}
    }

    const caption =
        `\`「 NellsBot Music 」\`\n\n` +
        `> 🎵 *Judul:* ${data.title}\n` +
        `> 👤 *Artis:* ${data.uploader}\n` +
        `> ⏱ *Durasi:* ${data.duration}\n` +
        `> 🌐 *Sumber:* ${data.url || "Online Audio"}\n\n` +
        `_Sedang mengirim file audio, mohon tunggu..._`;

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
}

module.exports = {
    name: "mp3",
    category: "tools",
    command: ["mp3", "play", "music", "lagu", "song", "playmp3"],
    description: "Cari musik dan tampilkan daftar lagu pilihan untuk diputar",
    before: async (context) => {
        const { m, body, budy, text, reply, isGroup, sock } = context;
        if (!m || !m.chat) return false;

        const rawText = (m.text || body || budy || text || "").trim();
        if (!rawText) return false;

        const resolved = await resolveSenderJid(sock, m, context.groupMetadata);
        const senderJid = context.senderJid || resolved.jid || m.sender;
        const chatJid = m.chat;

        // Find session by chat+sender OR by quoted message ID
        const quotedId = m.quoted?.id || m.quoted?.key?.id;
        let sessionKey = `${chatJid}:${senderJid}`;
        let session = activeSearchSessions.get(sessionKey);

        if (!session && quotedId && activeMessageToSession.has(quotedId)) {
            sessionKey = activeMessageToSession.get(quotedId);
            session = activeSearchSessions.get(sessionKey);
        }

        // Also check fallback using raw m.sender
        if (!session && m.sender) {
            const altKey = `${chatJid}:${m.sender}`;
            session = activeSearchSessions.get(altKey);
            if (session) sessionKey = altKey;
        }

        if (!session) return false;

        // Check if user requested cancellation
        if (/^(?:batal|cancel|stop|exit)$/i.test(rawText)) {
            clearTimeout(session.timer);
            if (session.interfaceMessageId) activeMessageToSession.delete(session.interfaceMessageId);
            activeSearchSessions.delete(sessionKey);
            logger.info('MP3', `[SESSION_CANCELLED] op=${session.opId} user=${senderJid}`);
            await reply(`❌ *Pencarian lagu telah dibatalkan.*`);
            return true;
        }

        // Match number selection: e.g. "1", "no 1", "lagu 1", "pilih 2", "#1"
        const numMatch = rawText.match(/^(?:no\.?|nomor|lagu|pilih|track)?\s*#?([1-9][0-9]?)$/i);
        if (!numMatch) return false;

        const choice = parseInt(numMatch[1], 10);
        if (choice < 1 || choice > session.results.length) {
            await reply(`⚠️ Pilihan tidak valid. Silakan balas dengan angka *1* sampai *${session.results.length}*, atau ketik *batal*.`);
            return true;
        }

        // Clean up session immediately so double-taps don't trigger multiple downloads
        clearTimeout(session.timer);
        if (session.interfaceMessageId) activeMessageToSession.delete(session.interfaceMessageId);
        activeSearchSessions.delete(sessionKey);

        const chosen = session.results[choice - 1];
        logger.info('MP3', `[SELECTION] op=${session.opId} choice=${choice} title="${chosen.title}" url="${chosen.url}"`);

        await reply(`⏳ *Mengunduh lagu pilihan [${choice}]:*\n*${chosen.title}* (${chosen.duration})\n_Mohon tunggu sebentar, sedang mengambil audio..._`);

        try {
            const data = await fetchMusic(chosen.url || chosen.title, session.opId);
            await deliverAudio(context, data, session.opId);
        } catch (err) {
            logger.error('MP3', `[SELECTION_ERROR] op=${session.opId} failed playing choice ${choice}`, err, session.opId);
            await reply(`❌ *Gagal memutar lagu pilihan:* ${err.message || "Terjadi kesalahan saat mengunduh audio."}`);
        }

        return true;
    },
    run: async (context) => {
        const { sock, m, text, q, prefix, reply } = context;

        // Generate unique operation ID for tracing the entire lifecycle of this command
        const opId = 'MP3-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

        const query = (text || q || "").trim();

        if (!query) {
            return reply(
                `\`「 NellsBot Music 」\`\n` +
                `> 🎵 *Format:* ${prefix}mp3 <judul lagu atau URL>\n` +
                `> 💡 *Contoh:* ${prefix}mp3 separuh aku\n` +
                `> ⚡ *Alias:* ${prefix}play, ${prefix}lagu, ${prefix}music\n` +
                `> 🎯 *Keterangan:* Ketik judul lagu untuk melihat daftar pilihan dan memilih lagu favoritmu!`
            );
        }

        logger.info('MP3', `[START] op=${opId} query="${query}" chat=${m.chat} sender=${m.sender}`);

        // Check if query has an explicit direct number index (e.g. "penjaga hati --2" or "penjaga hati #2")
        let directIndex = null;
        let cleanQuery = query;
        const directMatch = query.match(/^(.+?)\s*(?:--|#)(\d+)$/);
        if (directMatch) {
            cleanQuery = directMatch[1].trim();
            directIndex = parseInt(directMatch[2], 10);
        }

        // If query is an exact URL, download directly without showing search list
        const isDirectUrl = /^https?:\/\//i.test(cleanQuery);
        if (isDirectUrl) {
            await reply(`🔎 *Mengunduh langsung dari tautan...*\n_Mohon tunggu sebentar, sistem sedang memproses audio..._`);
            try {
                const data = await fetchMusic(cleanQuery, opId);
                await deliverAudio(context, data, opId);
            } catch (err) {
                logger.error('MP3', `op=${opId} Direct URL failed`, err, opId);
                return reply(`❌ *Gagal memutar audio:* ${err.message}`);
            }
            return;
        }

        // Perform enhanced multi-source search
        logger.info('MP3', `[SEARCH_START] op=${opId} query="${cleanQuery}"`);
        await reply(`🔎 *Mencari lagu:* "${cleanQuery}"...\n_Mohon tunggu sebentar..._`);

        let results = [];
        try {
            results = await searchMusicList(cleanQuery);
        } catch (searchErr) {
            logger.error('MP3', `[SEARCH_FAIL] op=${opId} query="${cleanQuery}"`, searchErr, opId);
        }

        if (!results || results.length === 0) {
            logger.warn('MP3', `[SEARCH_EMPTY] op=${opId} query="${cleanQuery}"`);
            return reply(`❌ *Lagu tidak ditemukan:* Tidak ada hasil untuk kata kunci "${cleanQuery}".\n_Coba kata kunci lain atau gunakan judul dan nama penyanyi yang lebih spesifik._`);
        }

        logger.info('MP3', `[SEARCH_RESULTS] op=${opId} count=${results.length}`);

        // If direct index was requested e.g. "penjaga hati --1"
        if (directIndex && directIndex >= 1 && directIndex <= results.length) {
            const chosen = results[directIndex - 1];
            await reply(`⏳ *Mengunduh lagu pilihan [${directIndex}]:* ${chosen.title}...`);
            try {
                const data = await fetchMusic(chosen.url || chosen.title, opId);
                await deliverAudio(context, data, opId);
            } catch (err) {
                logger.error('MP3', `op=${opId} Direct index download failed`, err, opId);
                return reply(`❌ *Gagal memutar musik:* ${err.message}`);
            }
            return;
        }

        // Send interactive interface list
        const interfaceText = buildSearchInterface(cleanQuery, results);
        const sentMenu = await reply(interfaceText);
        const interfaceMessageId = sentMenu?.key?.id;

        // Clear any previous active session for this user in this chat
        const resolved = await resolveSenderJid(sock, m, context.groupMetadata);
        const userTarget = context.senderJid || resolved.jid || m.sender;
        const sessionKey = `${m.chat}:${userTarget}`;

        if (activeSearchSessions.has(sessionKey)) {
            const old = activeSearchSessions.get(sessionKey);
            clearTimeout(old.timer);
            if (old.interfaceMessageId) activeMessageToSession.delete(old.interfaceMessageId);
            activeSearchSessions.delete(sessionKey);
        }

        // Setup session timeout (120 seconds)
        const sessionTimer = setTimeout(() => {
            if (activeSearchSessions.has(sessionKey)) {
                activeSearchSessions.delete(sessionKey);
                if (interfaceMessageId) activeMessageToSession.delete(interfaceMessageId);
                logger.info('MP3', `[SESSION_EXPIRED] op=${opId} user=${userTarget}`);
            }
        }, 120000);
        if (sessionTimer.unref) sessionTimer.unref();

        activeSearchSessions.set(sessionKey, {
            opId,
            chat: m.chat,
            senderJid: userTarget,
            query: cleanQuery,
            results,
            interfaceMessageId,
            createdAt: Date.now(),
            timer: sessionTimer
        });

        if (interfaceMessageId) {
            activeMessageToSession.set(interfaceMessageId, sessionKey);
        }
    }
};
