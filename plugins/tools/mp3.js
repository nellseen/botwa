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
 * Master multi-strategy music retriever
 */
async function fetchMusic(query) {
    let cleanQuery = query.trim();

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
        return await fetchFromSiputzx(cleanQuery);
    } catch (e1) {
        errors.push(`Siputzx: ${e1.message}`);
    }

    // Attempt 2: Direct SoundCloud API v2
    try {
        return await fetchFromSoundCloudV2(cleanQuery);
    } catch (e2) {
        errors.push(`SoundCloud v2: ${e2.message}`);
    }

    // Attempt 3: Local yt-dlp binary with scsearch
    try {
        return await fetchFromYtDlp(cleanQuery);
    } catch (e3) {
        errors.push(`yt-dlp (scsearch): ${e3.message}`);
    }

    // Attempt 4: Cleaned query fallback
    const refinedQuery = cleanSongQuery(cleanQuery);
    if (refinedQuery && refinedQuery !== cleanQuery) {
        try {
            return await fetchFromSiputzx(refinedQuery);
        } catch (_) {}

        try {
            return await fetchFromYtDlp(refinedQuery);
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

        const query = (text || q || "").trim();

        if (!query) {
            return reply(
                `\`「 NellsBot Music 」\`\n` +
                `> 🎵 *Format:* ${prefix}mp3 <judul lagu atau URL>\n` +
                `> 💡 *Contoh:* ${prefix}mp3 separuh aku\n` +
                `> ⚡ *Alias:* ${prefix}play, ${prefix}lagu, ${prefix}music`
            );
        }

        await reply(`🔎 *Mencari dan memproses:* "${query}"...\n_Mohon tunggu sebentar, sistem sedang mengunduh audio..._`);

        try {
            const data = await fetchMusic(query);

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

            // Accurately resolve genuine user target across private, group, and LID sessions
            const resolved = await resolveSenderJid(sock, m, context.groupMetadata);
            const userTarget = context.senderJid || resolved.jid;
            const chatJid = m.chat;

            console.log(`[MP3][TARGET] chat=${chatJid} isGroup=${context.isGroup || false}`);
            console.log(`[MP3][SENDER] sender=${m.sender} participant=${m.key?.participant} fromMe=${m.key?.fromMe}`);
            console.log(`[MP3][RESOLVED_USER] resolved_user=${userTarget} source=${resolved.source}`);

            // Reusable helper to send audio message safely
            const sendAudioTo = async (targetJid, quotedMsg = null) => {
                if (!targetJid) return false;
                try {
                    await sock.sendMessage(targetJid, {
                        audio: data.buffer,
                        mimetype: "audio/mp4",
                        ptt: false,
                        fileName: `${safeTitle}.mp3`,
                        contextInfo: {
                            externalAdReply: {
                                title: data.title.slice(0, 50),
                                body: `${data.uploader} • NellsBot Music`,
                                thumbnail: thumbBuf,
                                sourceUrl: data.url || "https://t.me/walogin1_bot",
                                mediaType: 2,
                                renderLargerThumbnail: true
                            }
                        }
                    }, quotedMsg ? { quoted: quotedMsg } : {});
                    return true;
                } catch (sendErr) {
                    // Fallback without rich contextInfo if WhatsApp client rejects externalAdReply
                    await sock.sendMessage(targetJid, {
                        audio: data.buffer,
                        mimetype: "audio/mp4",
                        ptt: false,
                        fileName: `${safeTitle}.mp3`
                    }, quotedMsg ? { quoted: quotedMsg } : {});
                    return true;
                }
            };

            // 1. Send audio to m.chat (group / channel / chat where command was executed)
            console.log(`[MP3][SEND_GROUP] Delivering audio to chat: ${chatJid}...`);
            try {
                await sendAudioTo(chatJid, m);
                console.log(`[MP3][SUCCESS] Audio delivered to chat ${chatJid}`);
            } catch (chatSendErr) {
                console.error(`[MP3][ERROR] Failed delivering audio to chat ${chatJid}:`, chatSendErr.message);
            }

            // 2. If command was run in a group or channel where m.chat !== userTarget,
            // deliver audio directly to the user who requested it!
            if (userTarget && userTarget !== chatJid) {
                console.log(`[MP3][SEND_PRIVATE] Delivering audio to user PM: ${userTarget}...`);
                try {
                    await sendAudioTo(userTarget, null);
                    console.log(`[MP3][SUCCESS] Direct private audio successfully delivered to ${userTarget}`);
                } catch (userSendErr) {
                    console.error(`[MP3][ERROR] Direct private send to ${userTarget} failed:`, userSendErr);
                    await reply(`⚠️ _Pemberitahuan: Audio gagal dikirimkan ke chat pribadi kamu (${userSendErr.message}). Pastikan chat bot tidak kamu blokir._`);
                }
            }

        } catch (err) {
            console.error("[Music Plugin Error]:", err.message);
            return reply(`❌ *Gagal memutar musik:* ${err.message || "Lagu tidak ditemukan atau server sedang sibuk."}`);
        }
    }
};
