// ===================================================
//  NellsBotBase - Music Search & Audio Downloader
//  Creator : NellsBotBase
// ===================================================

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

/**
 * Downloads audio for a given query or URL using the bundled yt-dlp binary
 */
async function fetchMusic(query) {
    const ytdlpPath = path.join(__dirname, "../../bin/yt-dlp");
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
        execFile(ytdlpPath, args, { timeout: 45000 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error("Lagu tidak ditemukan atau server musik sedang sibuk."));
            }

            try {
                const lines = stdout.trim().split("\n");
                const jsonLine = lines.find(l => l.startsWith("{"));
                if (!jsonLine) {
                    return reject(new Error("Gagal mengekstrak informasi audio."));
                }
                const meta = JSON.parse(jsonLine);

                // Locate the downloaded audio file in /tmp
                const createdFiles = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                if (!createdFiles.length) {
                    return reject(new Error("File audio tidak berhasil disimpan."));
                }

                const filePath = path.join("/tmp", createdFiles[0]);
                const audioBuffer = fs.readFileSync(filePath);

                // Always clean up temp file
                try {
                    fs.unlinkSync(filePath);
                } catch (_) {}

                resolve({
                    title: meta.title || query,
                    uploader: meta.uploader || meta.artist || meta.channel || "Unknown Artist",
                    duration: meta.duration_string || "0:00",
                    thumbnail: meta.thumbnail || null,
                    url: meta.webpage_url || meta.url || "",
                    buffer: audioBuffer
                });
            } catch (parseErr) {
                // Ensure any temp files are cleaned up
                try {
                    const leftovers = fs.readdirSync("/tmp").filter(f => f.startsWith(tempPrefix));
                    for (const l of leftovers) fs.unlinkSync(path.join("/tmp", l));
                } catch (_) {}
                reject(parseErr);
            }
        });
    });
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

        await reply(`🔎 *Mencari dan memproses lagu:* "${query}"...\n_Mohon tunggu sebentar ya..._`);

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
            console.error("[Music Plugin Error]:", err);
            return reply(`❌ *Gagal memutar musik:* ${err.message || "Terjadi kesalahan sistem."}`);
        }
    }
};
