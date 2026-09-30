// ===================================================
//  NellsBotBase - Global Configuration
//  Loads from .env / process.env with robust defaults
// ===================================================

const fs = require('fs');
require('dotenv').config();

// Parse owner numbers from environment (comma-separated or single)
const envOwnerRaw = process.env.OWNER_NUMBER || process.env.OWNER_NUMBERS || '';
const envOwners = envOwnerRaw
    .split(',')
    .map(n => n.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);

global.namaown = process.env.OWNER_NAME || "NellsBotBase";
global.prefix = process.env.PREFIX || "/";
global.botname = process.env.BOT_NAME || "NellsBotBase";
global.botversion = process.env.BOT_VERSION || "v1.0";
global.botdev = process.env.BOT_DEV || "NellsBotBase";
global.botcategory = 4;
global.owner = envOwners.length > 0 ? envOwners : ["62895400835519"];
global.session = process.env.SESSION_FOLDER || "sessions";
