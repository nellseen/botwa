const fs = require('fs');
const cache = new Map();

function readJsonCached(filePath, fallback = null) {
    try {
        const now = Date.now();
        const current = cache.get(filePath);
        if (current && now - current.checkedAt < 1000) return current.value;
        const stat = fs.statSync(filePath);
        if (current && current.mtimeMs === stat.mtimeMs && current.size === stat.size) {
            current.checkedAt = now;
            return current.value;
        }
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now, value });
        return value;
    } catch (_) {
        cache.delete(filePath);
        return fallback;
    }
}

function invalidateJsonCache(filePath) {
    cache.delete(filePath);
}

module.exports = { readJsonCached, invalidateJsonCache };
