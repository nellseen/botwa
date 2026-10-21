#!/usr/bin/env node
// ===================================================
//  NellsBotBase - Clean Release Packager
//  Produces clean release-app.zip excluding node_modules,
//  sessions, logs, and sensitive credentials
// ===================================================

const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

const ROOT_DIR = path.join(__dirname, '..');
const OUTPUT_ZIP = path.join(ROOT_DIR, 'release-app.zip');

console.log('Packaging clean release zip...');

const IGNORE_PATTERNS = [
    'node_modules',
    '.git',
    'logs',
    '.env',
    'bun.lock',
    'pnpm-workspace.yaml',
    'release-app.zip'
];

function shouldInclude(relPath) {
    for (const pat of IGNORE_PATTERNS) {
        if (relPath === pat || relPath.startsWith(`${pat}/`) || relPath.startsWith(`${pat}\\`)) {
            return false;
        }
    }
    // Don't include personal session auth folders inside data/sessions/
    if (relPath.startsWith('data/sessions/') && !relPath.endsWith('metadata.json')) {
        return false;
    }
    return true;
}

function collectFiles(dir, baseDir = ROOT_DIR, fileMap = {}) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

        if (!shouldInclude(relPath)) continue;

        if (entry.isDirectory()) {
            collectFiles(fullPath, baseDir, fileMap);
        } else if (entry.isFile()) {
            fileMap[relPath] = fs.readFileSync(fullPath);
        }
    }
    return fileMap;
}

try {
    const files = collectFiles(ROOT_DIR);
    const zipped = zipSync(files, { level: 9 });
    fs.writeFileSync(OUTPUT_ZIP, Buffer.from(zipped));
    const sizeMb = (zipped.length / 1024 / 1024).toFixed(2);
    console.log(`✓ Successfully created ${OUTPUT_ZIP} (${sizeMb} MB, ${Object.keys(files).length} files packaged)`);
} catch (err) {
    console.error('Packaging failed:', err);
    process.exit(1);
}
