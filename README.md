# NellsBotBase - Multi-Session WhatsApp Bot

NellsBotBase adalah base WhatsApp Bot tingkat lanjut dengan arsitektur **Multi-Session & Multi-User** berbasis Node.js dan Baileys. Bot ini kini sepenuhnya dikendalikan menggunakan **Telegram Bot Dashboard**, memungkinkan Anda untuk mengelola banyak nomor WhatsApp sekaligus (Unlimited Sessions) tanpa harus melakukan restart.

## 🌟 Fitur Utama

- **Multi-Session & Multi-User**: Jalankan puluhan hingga ratusan nomor WhatsApp secara bersamaan dalam satu backend.
- **Telegram Dashboard Control**: Setup, hapus, dan pantau seluruh status sesi WhatsApp Anda melalui bot Telegram (Reply Keyboard & Inline Keyboard).
- **Realtime Status**: Dapatkan notifikasi dan pantau status nomor WhatsApp secara real-time (🟢 Online, 🔵 Pairing, 🔴 Offline, dll).
- **Plugin System Auto-Reload**: Tambah, ubah, atau hapus plugin (`/plugins`) tanpa perlu merestart backend bot.
- **Isolasi Nomor & Keamanan**: Setiap nomor WhatsApp memiliki *authentication state*, memory store, dan proses reconnect yang terisolasi. Disconnect di satu nomor tidak akan memengaruhi nomor lain.
- **Graceful Shutdown**: Melindungi data koneksi WhatsApp agar tidak corrupt saat server dimatikan.

## 🛠 Instalasi & Setup

### 1. Persiapan
- Pastikan Anda sudah menginstal **Node.js** (v18+ direkomendasikan).
- Buat bot Telegram baru melalui [BotFather](https://t.me/BotFather) dan dapatkan **Bot Token**.

### 2. Clone & Install
```bash
git clone https://github.com/glarceny/NellsBotBaseBotBase.git
cd NellsBotBaseBotBase
npm install
```

### 3. Konfigurasi Environment
Buat file `.env` di folder utama aplikasi (sudah ada `.env.example` sebagai referensi), lalu isi dengan Telegram Bot Token Anda:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ
```

### 4. Menjalankan Bot
```bash
npm run dev
# atau
npm start
```
*HTTP Server akan berjalan di port 3000.*

## 📱 Cara Penggunaan (Telegram Dashboard)

1. Buka Bot Telegram yang sudah Anda buat.
2. Kirim perintah `/start` untuk memunculkan **Menu Dashboard**.
3. Klik tombol **➕ Tambah Nomor** pada Reply Keyboard.
4. Masukkan nomor WhatsApp yang ingin dihubungkan (contoh: `628123456789`).
5. Sistem akan mengirimkan **Pairing Code** secara real-time ke Telegram Anda.
6. Masukkan Pairing Code tersebut ke aplikasi WhatsApp Anda (Linked Devices / Perangkat Tertaut).
7. Selesai! Anda bisa menambah nomor lain dengan mengulangi langkah di atas.

Gunakan menu **🟢 Status Online** atau **📱 Nomor Saya** untuk melihat, refresh, memutus (disconnect), atau menghapus (delete) sesi WhatsApp yang aktif.

## 🧩 Membuat Plugin

Plugin berada di folder `plugins/`. Sistem plugin secara otomatis mendukung multi-session. Pesan yang masuk akan selalu di-routing menggunakan konteks (`context`) yang spesifik untuk session terkait.

Contoh plugin sederhana (`plugins/info/contoh.js`):

```javascript
module.exports = {
    name: "contoh",
    category: "info",
    command: ["contoh"],
    run: async ({ reply, args, session, phoneNumber }) => {
        await reply(`Halo! Anda memanggil bot dari nomor tujuan: ${phoneNumber}\nPesan Anda: ${args.join(" ")}`);
    }
};
```
*Tidak perlu restart server saat membuat file plugin baru. Watcher akan memuat plugin tersebut secara otomatis.*

## 📁 Struktur Direktori

```text
├── core/
│   ├── SessionManager.js   # Pengelola lifecycle seluruh session WA
│   ├── WhatsAppSession.js  # Class instance untuk masing-masing session WA
│   └── MessageRouter.js    # Mengarahkan pesan ke bot core (nellsbot.js)
├── telegram/
│   ├── bot.js              # Inisialisasi bot Telegram API
│   └── handlers.js         # Handler command, keyboard & interaksi Telegram
├── plugins/                # Folder plugin/fitur WhatsApp
├── lib/
│   └── plugins.js          # Plugin loader & auto-reload
├── data/
│   └── sessions/           # Penyimpanan state otentikasi Baileys secara terisolasi per user/session
├── control/settings.js     # Konfigurasi owner & global setting
├── nellsbot.js             # Core message handler untuk eksekusi fitur plugin WA
├── index.js                # Entry point aplikasi
└── package.json            # Daftar dependencies
```

## ⚠️ Troubleshooting & Catatan

- **Telegram Dashboard Tidak Merespons**: Pastikan `TELEGRAM_BOT_TOKEN` di file `.env` sudah benar dan bot tidak dijalankan dua kali di tab/server yang berbeda.
- **Port 3000**: Backend menggunakan library `express` di port 3000 sebagai syarat agar aplikasi tetap berjalan pada container / cloud hosting (seperti Google Cloud Run).
- **Session Legacy**: Jika Anda melakukan upgrade dari versi lama (yang memakai folder `./session`), bot akan bermigrasi secara otomatis saat *startup* dan tidak akan menghapus data koneksi Anda sebelumnya.

## 📜 Lisensi
Proyek ini dirilis di bawah lisensi **MIT**. Anda bebas untuk mengembangkan, memodifikasi, dan mendistribusikannya.
