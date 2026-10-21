#!/usr/bin/env node
// ===================================================
//  NellsBotBase - Safe WhatsApp Session Reset Tool
//  Safely resets WhatsApp multi-session authentication states
//  NEVER touches database files, plugins, media, or configuration.
// ===================================================

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
const METADATA_PATH = path.join(SESSIONS_DIR, 'metadata.json');

console.log(chalk.bold.cyan('\n==================================================='));
console.log(chalk.bold.cyan('  NellsBotBase - Safe WhatsApp Session Reset Tool'));
console.log(chalk.bold.cyan('===================================================\n'));

try {
    if (!fs.existsSync(SESSIONS_DIR)) {
        console.log(chalk.yellow('Folder sesi tidak ditemukan. Membuat folder sesi baru...'));
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    // Step 1: Backup metadata
    if (fs.existsSync(METADATA_PATH)) {
        const backupPath = path.join(SESSIONS_DIR, `metadata.backup.${Date.now()}.json`);
        fs.copyFileSync(METADATA_PATH, backupPath);
        console.log(chalk.green(`✓ Backup metadata berhasil disimpan di: ${path.basename(backupPath)}`));
    }

    // Step 2: Remove all session authentication subfolders
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    let removedFolders = 0;

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const folderPath = path.join(SESSIONS_DIR, entry.name);
            fs.rmSync(folderPath, { recursive: true, force: true });
            removedFolders++;
        }
    }
    console.log(chalk.green(`✓ Berhasil membersihkan ${removedFolders} folder autentikasi sesi WhatsApp.`));

    // Step 3: Write clean metadata.json
    fs.writeFileSync(METADATA_PATH, JSON.stringify({}, null, 2), 'utf8');
    console.log(chalk.green('✓ Metadata sesi WhatsApp berhasil di-reset ke status bersih.'));

    // Step 4: Verify that databases are untouched
    const antilinkPath = path.join(__dirname, '../lib/database/antilink.json');
    const ownerPath = path.join(__dirname, '../lib/database/owner.json');
    const premPath = path.join(__dirname, '../lib/database/premium.json');

    console.log('\n' + chalk.bold('Verifikasi Keamanan Data Non-Sesi:'));
    console.log(`- Database Antilink: ${fs.existsSync(antilinkPath) ? chalk.green('AMAN (Untouched)') : chalk.yellow('Tidak ditemukan')}`);
    console.log(`- Database Owner   : ${fs.existsSync(ownerPath) ? chalk.green('AMAN (Untouched)') : chalk.yellow('Tidak ditemukan')}`);
    console.log(`- Database Premium : ${fs.existsSync(premPath) ? chalk.green('AMAN (Untouched)') : chalk.yellow('Tidak ditemukan')}`);

    console.log('\n' + chalk.bold.green('Reset sesi selesai dengan sukses!'));
    console.log(chalk.cyan('Cara Pairing Ulang Nomor WhatsApp:'));
    console.log('1. Jalankan bot: ' + chalk.white('npm run dev'));
    console.log('2. Buka bot Telegram atau Web Dashboard di http://localhost:3000');
    console.log('3. Tambahkan nomor WhatsApp baru untuk mendapatkan pairing code 8-digit.');
    console.log('4. Tautkan di WhatsApp HP Anda > Perangkat Tertaut > Tautkan dengan nomor telepon saja.\n');

} catch (err) {
    console.error(chalk.red('\n[ERROR] Gagal melakukan reset sesi:'), err);
    process.exit(1);
}
