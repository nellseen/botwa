#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'data', 'reports']);
const sources = [];

function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignored.has(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) sources.push(fullPath);
    }
}

collect(root);
for (const source of sources) {
    const result = spawnSync(process.execPath, ['--check', source], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write(`JavaScript syntax check passed for ${sources.length} files.\n`);
