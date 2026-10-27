# NellsBotBase - Multi-Session WhatsApp Bot

NellsBotBase adalah base WhatsApp Bot modern dengan arsitektur **Multi-Session & Multi-User** berbasis Node.js dan Baileys. Bot ini dikendalikan menggunakan **Telegram Bot Dashboard**, memungkinkan pengelolaan beberapa nomor WhatsApp tanpa perlu merestart server. Batas default 100 sesi dapat diatur melalui `MAX_SESSIONS`.

Proyek ini telah dikonfigurasi penuh dan dioptimalkan menggunakan **PNPM** (`"packageManager": "pnpm@9.15.4"`) untuk instalasi dependensi yang jauh lebih cepat, hemat disk, dan deterministik.

---

## 🌟 Fitur Utama

- **⚡ Full PNPM Support**: Didukung oleh Corepack dan PNPM package manager untuk manajemen dependensi yang cepat dan stabil.
- **📱 Multi-Session & Multi-User**: Jalankan beberapa nomor WhatsApp secara bersamaan dengan batas sesi yang dapat dikonfigurasi.
- **🤖 Telegram Dashboard Control**: Tambah nomor baru via Pairing Code, hapus, putus (disconnect), dan pantau seluruh sesi WhatsApp melalui bot Telegram (Reply & Inline Keyboard).
- **🟢 Realtime Status Monitoring**: Dapatkan notifikasi status sesi WhatsApp secara langsung (🟢 Online, 🔵 Pairing, 🟡 Reconnecting, 🔴 Offline).
- **🎵 Built-in Fast Music Downloader (`/mp3`, `/play`, `/lagu`)**: Download & streaming audio cepat berbasis Pure Node.js (SoundCloud V2 API, Siputzx API, serta YouTube link parser) lengkap dengan thumbnail preview dan metadata artis.
- **🧩 Hot Plugin Auto-Reload**: Tambah, ubah, atau hapus plugin di folder `/plugins` secara langsung tanpa perlu restart bot.
- **🔒 Isolasi Sesi & Keamanan**: Setiap nomor WhatsApp memiliki *credentials state*, memory store, dan proses reconnect terisolasi di `/data/sessions`.
- **🛡️ Graceful Shutdown**: Menutup koneksi WhatsApp dan database secara aman saat server dimatikan sehingga sesi tidak mudah terputus/corrupt.
- **🌐 Web Status & REST API**: Dilengkapi landing page modern dan endpoint monitoring `/api/status` di port 3000 (siap deploy di VPS, Cloud Run, Heroku, Docker).

---

## 🛠 Panduan Instalasi & Setup Lengkap

### 1. Kebutuhan Sistem (Prerequisites)
- **Node.js**: Versi `18.0.0` atau yang lebih baru (disarankan v20+ / v22 LTS).
- **PNPM**: Versi 9+ (direkomendasikan) atau npm/yarn.
- **Telegram Bot Token**: Didapatkan gratis melalui [@BotFather](https://t.me/BotFather).

#### Mengaktifkan PNPM via Corepack (Bawaan Node.js):
```bash
# Aktifkan corepack bawaan Node.js
corepack enable

# Atau instal pnpm secara global jika belum ada
npm install -g pnpm
```

---

### 2. Clone Repositori
```bash
git clone https://github.com/glarceny/NellsBotBaseBotBase.git
cd NellsBotBaseBotBase
```

---

### 3. Instalasi Dependensi Menggunakan PNPM

Jalankan perintah berikut untuk menginstal seluruh dependensi:

```bash
pnpm install
```

*(Catatan: Jika Anda masih ingin menggunakan npm konvensional, Anda tetap dapat menjalankan `npm install`).*

---

### 4. Konfigurasi Environment (`.env`)

Salin template file `.env.example` menjadi `.env`:

```bash
cp .env.example .env
```

Buka file `.env` dan masukkan Telegram Bot Token Anda:

```env
# Telegram Bot Token dari @BotFather
TELEGRAM_BOT_TOKEN=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ
API_ADMIN_TOKEN=buat-secret-acak-minimal-32-karakter
```

`API_ADMIN_TOKEN` wajib diisi untuk mengakses endpoint pengelolaan sesi, daftar plugin, dan log. Dashboard web meminta token ini dan menyimpannya di `sessionStorage` tab browser aktif; token hilang saat tab ditutup. Endpoint status ringkas tetap dapat dibaca publik. Jangan gunakan contoh token atau kirim token melalui URL.

Buat nilai acak dengan `openssl rand -hex 32`, lalu masukkan hasilnya ke `.env`. `MAX_SESSIONS` membatasi jumlah sesi aktif yang ditampung server (default 100, maksimum 1000).

---

### 5. Konfigurasi Owner & Bot (`.env`)

Atur nomor owner melalui `OWNER_NUMBER` atau `OWNER_NUMBERS` (format angka dengan kode negara). Tidak ada nomor owner bawaan; akun bot tetap dapat menjalankan perintah owner pada sesi miliknya.

```env
BOT_NAME=NellsBotBase
BOT_VERSION=v1.0
OWNER_NUMBER=628123456789
SESSION_FOLDER=sessions
PAIRING_CODE=NELLSBOT
```

`PAIRING_CODE` mengatur kode pairing custom WhatsApp. Gunakan tepat 8 karakter alfanumerik (A–Z dan 0–9), tanpa tanda hubung; bot akan menambahkan pemisah saat menampilkan kode. Jika variabel ini tidak diatur, bot memakai `NELLSBOT`. Jika formatnya tidak valid, bot memberi peringatan dan kembali memakai nilai default.

---

### 6. Menjalankan Bot

#### Mode Development (Auto-restart file changes):
```bash
pnpm run dev
```

#### Mode Production:
```bash
pnpm start
```

Backend web server dan dashboard WhatsApp akan aktif di port **3000** (URL: `http://localhost:3000`).

---

## 📱 Panduan Pairing Nomor via Telegram Dashboard

1. Buka Bot Telegram Anda di aplikasi Telegram.
2. Kirim perintah `/start` untuk membuka **Dashboard Menu**.
3. Klik menu **➕ Tambah Nomor** pada keyboard.
4. Masukkan nomor WhatsApp yang ingin Anda tautkan (format angka dengan kode negara, tanpa spasi atau tanda `+`).
5. Bot Telegram akan langsung mengirimkan **8-digit Pairing Code**.
6. Buka aplikasi WhatsApp di HP Anda:
   - Pilih menu **Titik Tiga (⋮) / Pengaturan** > **Perangkat Tertaut (Linked Devices)**.
   - Pilih **Tautkan Perangkat** > **Tautkan dengan nomor telepon saja**.
   - Masukkan 8 digit kode pairing yang dikirim dari Telegram.
7. Setelah tersambung, nomor tersebut langsung aktif menjadi bot WhatsApp!
8. Anda dapat menambahkan nomor lain hingga batas `MAX_SESSIONS` yang diatur server.

Untuk dashboard web, masukkan nilai `API_ADMIN_TOKEN` pada kolom token admin di panel kontrol. Simpan hanya pada browser perangkat admin; gunakan HTTPS melalui reverse proxy saat dashboard diakses dari jaringan.

Gunakan menu **🟢 Status Online** atau **📱 Nomor Saya** di Telegram untuk memeriksa status, restart sesi, memutus koneksi (disconnect), atau menghapus sesi.

---

## 🎵 Fitur Musik (`/mp3`, `/play`, `/lagu`, `/music`)

Bot dilengkapi dengan modul downloader & player audio berkecepatan tinggi:
- **Perintah**: `/mp3 <judul lagu atau URL>`, `/play <judul>`, `/lagu <judul>`, `/music <judul>`
- **Contoh**: `/mp3 separuh aku noah`
- **Fitur Otomatis**:
  - Mengunduh stream audio MP3 berkualitas jernih langsung via HTTP.
  - Mengirim audio lengkap dengan cover art (thumbnail), nama artis, durasi, dan file audio MP3.
  - Multi-tier fallback (SoundCloud Direct V2 -> Siputzx REST API -> yt-search & yt-dlp) untuk menjamin lagu selalu dapat diputar tanpa error.

---

## 🧩 Menambahkan Plugin Baru

Folder plugin berada di `./plugins/`. Semua plugin langsung kompatibel dengan arsitektur multi-session. Saat file baru disimpan, sistem akan langsung memuatnya tanpa restart server.

Contoh struktur plugin sederhana (`plugins/tools/halo.js`):

```javascript
module.exports = {
    name: "halo",
    category: "tools",
    command: ["halo", "hi", "hai"],
    description: "Menyapa pengguna bot",
    run: async (context) => {
        const { reply, sender, botName } = context;
        await reply(`Halo @${sender.split("@")[0]}! Saya adalah *${botName}*. Ada yang bisa saya bantu?`);
    }
};
```

---

## 📁 Struktur Direktori

```text
├── core/
│   ├── SessionManager.js       # Pengelola lifecycle & isolated state semua nomor WA
│   ├── WhatsAppSession.js      # Class instance untuk masing-masing session Baileys
│   └── MessageRouter.js        # Routing pesan masuk ke bot handler
├── telegram/
│   ├── bot.js                  # Inisialisasi bot Telegram API
│   └── handlers.js             # Menu dashboard, keyboard, dan pairing handler
├── plugins/                    # Direktori fitur WhatsApp (Hot-Reloaded)
│   ├── main/                   # Menu, owner, ping
│   ├── tools/                  # MP3 player, CRM / auto-tagging, utilitas
│   └── owner/                  # Add owner, add premium, kelola database
├── lib/
│   ├── plugins.js              # Plugin registry & file watcher
│   └── database/               # Database lokal (owner.json, premium.json, contacts.json)
├── data/
│   └── sessions/               # Folder penyimpanan session WhatsApp yang terisolasi
├── control/
│   └── settings.js             # Konfigurasi owner & global variables
├── public/                     # Landing page dan visual dashboard
├── index.js                    # Entry point aplikasi & Express HTTP Server (Port 3000)
├── package.json                # Manifest dependensi & deklarasi packageManager pnpm
└── pnpm-lock.yaml / .env       # File konfigurasi dependensi & environment
```

---

## 🚀 Menjalankan di Server Production (VPS / PM2)

Untuk menjalankan bot secara background terus menerus di server VPS:

```bash
# Instal PM2 secara global
pnpm add -g pm2

# Jalankan bot dengan PM2
pm2 start index.js --name "nellsbot"

# Simpan proses agar otomatis berjalan saat reboot
pm2 save
pm2 startup
```

Untuk memantau log bot:
```bash
pm2 logs nellsbot
```

---

## 📜 Lisensi

Proyek ini dirilis di bawah lisensi **MIT**. Bebas dikembangkan dan dimodifikasi untuk kebutuhan pribadi maupun komersial.
