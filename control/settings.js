// Keep legacy globals available for third-party plugins while application code
// imports explicit configuration from lib/config.js.
const config = require('../lib/config');

Object.assign(global, {
    namaown: config.ownerName,
    prefix: config.prefix,
    botname: config.botName,
    botversion: config.botVersion,
    botdev: config.botDev,
    botcategory: config.botCategory,
    owner: [...config.owners],
    session: config.sessionFolder
});

module.exports = config;
