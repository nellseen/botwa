// ===================================================
//  NellsBotBase - Music Search & Audio Downloader
//  Creator : NellsBotBase
// ===================================================

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const yts = require("yt-search");

// Fallback SoundCloud client IDs that are known active
const KNOWN_SC_CLIENT_IDS = [
    "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo",
    "b8rF2QnNqVb9dF6ZpX8u4Q2W7Y3e1M5a",
    "iZIs9mchVcX5lhVRphQggOuUMDNTGWih"
];

let cachedClientId = null;
let lastClientIdCheck = 0;

/**
 * Dynamically gets an active SoundCloud Client ID or uses reliable fallbacks
 */
async function getSoundCloudClientId() {
    const now = Date.now();
    if (cachedClientId && (now - lastClientIdCheck < 3600000)) {
        return cachedClientId;
    }

    try {
        const scHtml = await axios.get("https://soundcloud.com", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            timeout: 5000
        });

        const scriptUrls = scHtml.data.match(/https:\/\/[a-zA-Z0-9-._~:\/?#\[\]@!$&'()*+,;=]+?\.js/g) || [];
        for (const scriptUrl of scriptUrls.slice(-6)) {
            try {
                const sRes = await axios.get(scriptUrl, { timeout: 4000 });
                const match = sRes.data.match(/client_id:"([a-zA-Z0-9]{32})"/);
                if (match && match[1]) {
                    cachedClientId = match[1];
                    lastClientIdCheck = now;
                    return cachedClientId;
                }
            } catch (_) {}
        }
    } catch (_) {}

    // Fallback to primary known client ID
    cachedClientId = KNOWN_SC_CLIENT_IDS[0];
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
 * Strategy 1: Pure Node.js Direct SoundCloud API v2
 * Ultra fast (~1s), direct CDN MP3 progressive stream, no external binary required.
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
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=5`,
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
        throw new Error("Format audio stream progressive tidak tersedia.");
    }

    const streamInfo = await axios.get(`${progressive.url}?client_id=${clientId}`, { timeout: 8000 });
    if (!streamInfo.data?.url) {
        throw new Error("URL stream audio tidak valid.");
    }

    const audioRes = await axios.get(streamInfo.data.url, {
        responseType: "arraybuffer",
        timeout: 25000,
        maxContentLength: 50 * 1024 * 1024
    });

    return {
        title: track.title || query,
        uploader: track.user?.username || "SoundCloud Artist",
        duration: formatDuration(track.duration),
        thumbnail: track.artwork_url || track.user?.avatar_url || null,
        url: track.permalink_url || query,
        buffer: Buffer.from(audioRes.data)
    };
}

/**
 * Strategy 2: Siputzx Public REST API (Indonesian WA Bot Community API)
 */
async function fetchFromSiputzx(query) {
    const searchRes = await axios.get(
        `https://api.siputzx.my.id/api/s/soundcloud?query=${encodeURIComponent(query)}`,
        { timeout: 8000 }
    );

    const first = searchRes.data?.data?.[0];
    if (!first || !first.permalink_url) {
        throw new Error("Lagu tidak ditemukan di Siputzx.");
    }

    const dlRes = await axios.get(
        `https://api.siputzx.my.id/api/d/soundcloud?url=${encodeURIComponent(first.permalink_url)}`,
        { timeout: 8000 }
    );

    const dlUrl = dlRes.data?.data?.url;
    if (!dlUrl) {
        throw new Error("Download link tidak tersedia di Siputzx.");
    }

    const audioRes = await axios.get(dlUrl, {
        responseType: "arraybuffer",
        timeout: 25000,
        maxContentLength: 50 * 1024 * 1024
    });

    return {
        title: dlRes.data?.data?.title || first.permalink || query,
        uploader: first.user?.username || "Artist",
        duration: formatDuration(first.duration),
        thumbnail: first.artwork_url || null,
        url: first.permalink_url,
        buffer: Buffer.from(audioRes.data)
    };
}

/**
 * Strategy 3: Local yt-dlp binary (if present, executable, and python is available)
 */
async function fetchFromYtDlp(query) {
    const ytdlpPath = path.join(__dirname, "../../bin/yt-dlp");

    // Pre-flight check: ensure binary exists and is executable
    if (!fs.existsSync(ytdlpPath)) {
        throw new Error("yt-dlp binary not installed");
    }

    try {
        fs.accessSync(ytdlpPath, fs.constants.X_OK);
    } catch (_) {
        // Attempt chmod +x if missing permission
        try {
            fs.chmodSync(ytdlpPath, 0o755);
        } catch (_) {
            throw new Error("yt-dlp binary is not executable");
        }
    }

    const tempPrefix = `music_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tempBase = path.join("/tmp", tempPrefix);
    const isUrl = /^https?:\/\//i.test(query);
    const searchTarget = isUrl ? query : `scsearch1:${query}`;

    const args = [
        searchTarget,
        "--print-json",
        "-f", "bestaudio",
        "-o", `${tempBase}.%(ext)s`,
        "--no-playlist",
        "--socket-timeout", "15"
    ];

    return new Promise((resolve, reject) => {
        execFile(ytdlpPath, args, { timeout: 35000 }, (err, stdout) => {
            if (err) return reject(err);

            try {
                const lines = stdout.trim().split("\n");
                const jsonLine = lines.find(l => l.startsWith("{"));
                if (!jsonLine) return reject(new Error("Gagal membaca metadata JSON."));
                const meta = JSON.parse(jsonLine);

                const createdFiles = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                if (!createdFiles.length) return reject(new Error("File audio tidak tersimpan."));

                const filePath = path.join("/tmp", createdFiles[0]);
                const audioBuffer = fs.readFileSync(filePath);

                try { fs.unlinkSync(filePath); } catch (_) {}

                resolve({
                    title: meta.title || query,
                    uploader: meta.uploader || meta.artist || "Artist",
                    duration: meta.duration_string || "3:30",
                    thumbnail: meta.thumbnail || null,
                    url: meta.webpage_url || meta.url || "",
                    buffer: audioBuffer
                });
            } catch (parseErr) {
                try {
                    const leftovers = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                    for (const l of leftovers) fs.unlinkSync(path.join("/tmp", l));
                } catch (_) {}
                reject(parseErr);
            }
        });
    });
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
                    cleanQuery = ytData.title.replace(/\[.*?\]|\(.*?\)/g, "").trim();
                }
            }
        } catch (_) {}
    }

    const errors = [];

    // Attempt 1: SoundCloud V2 direct API (Fastest, zero-binary dependency)
    try {
        return await fetchFromSoundCloudV2(cleanQuery);
    } catch (e1) {
        errors.push(`SoundCloud v2: ${e1.message}`);
    }

    // Attempt 2: Siputzx Public REST API
    try {
        return await fetchFromSiputzx(cleanQuery);
    } catch (e2) {
        errors.push(`Siputzx API: ${e2.message}`);
    }

    // Attempt 3: Local yt-dlp binary (if installed on server)
    try {
        return await fetchFromYtDlp(cleanQuery);
    } catch (e3) {
        errors.push(`yt-dlp: ${e3.message}`);
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

        await reply(`🔎 *Mencari dan memproses:* "${query}"...\n_Mohon tunggu beberapa detik ya..._`);

        try {
            const data = await fetchMusic(query);

            const safeTitle = data.title.replace(/[/\\?%*:|"<>]/g, "").slice(0, 80);
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

            // Send audio message with cover art preview
            try {
                await sock.sendMessage(m.chat, {
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
                }, { quoted: m });
            } catch (sendErr) {
                // Fallback without rich contextInfo if WhatsApp client rejects externalAdReply
                await sock.sendMessage(m.chat, {
                    audio: data.buffer,
                    mimetype: "audio/mp4",
                    ptt: false,
                    fileName: `${safeTitle}.mp3`
                }, { quoted: m });
            }

        } catch (err) {
            console.error("[Music Plugin Error]:", err.message);
            return reply(`❌ *Gagal memutar musik:* ${err.message || "Lagu tidak ditemukan atau server sedang sibuk."}`);
        }
    }
};
