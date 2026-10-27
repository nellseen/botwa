// ===================================================
//  NellsBotBase
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

const config = require("../../lib/config");

module.exports = {
    name: "owner",
    category: "main",
    command: ["owner"],
    description: "Tampilkan informasi owner bot",
    run: async (context) => {
        const { reply, botDev, botName } = context;
        const ownerNumber = config.owners[0];
        const contact = ownerNumber ? `> Kontak : *wa.me/${ownerNumber}* (+${ownerNumber})` : '> Kontak owner belum dikonfigurasi';
        await reply(`\`「 Owner 」\`\n> Dev : *${botDev}*\n> Nama : *${botName}*\n${contact}`);
    }
};
