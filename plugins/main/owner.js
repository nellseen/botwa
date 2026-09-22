// ===================================================
//  NellsBotBase
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

module.exports = {
    name: "owner",
    category: "main",
    command: ["owner"],
    description: "Tampilkan informasi owner bot",
    run: async (context) => {
        const { reply, botDev, botName } = context;
        const ownerNumber = (global.owner && global.owner[0]) || "62895400835519";
        await reply(`\`「 Owner 」\`\n> Dev : *${botDev}*\n> Nama : *${botName}*\n> Kontak : *wa.me/${ownerNumber}* (+${ownerNumber})`);
    }
};
