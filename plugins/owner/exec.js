// ===================================================
//  NellsBotBase
//  Creator : NellsBotBase
//  Updated : 13 September 2026
// ===================================================

const util = require('util');
const { exec } = require('child_process');

module.exports = {
    name: "exec",
    category: "owner",
    owner: true,
    description: "Evaluasi kode JavaScript (=>) & eksekusi shell ($)",
    menu: ["=> <kode>", "$ <perintah>"],
    before: async (context) => {
        const { budy, isCreator, reply, q, isSimulation, sock, m, session } = context;

        // Strictly reject code evaluation and shell execution in simulation / testing contexts
        if (isSimulation || sock?.isSimulation || m?.isSimulation || session?.isSimulation) {
            if (budy && (budy.startsWith('=>') || budy.startsWith('$'))) {
                reply("*Akses ditolak: Operasi evaluasi/shell exec dilarang dalam mode simulasi.*");
                return true;
            }
            return false;
        }

        if (budy.startsWith('=>')) {
            if (!isCreator) return reply("*khusus owner*");
            try {
                let evaled = await eval(budy.slice(2));
                if (typeof evaled !== 'string') evaled = util.inspect(evaled);
                reply(evaled);
            } catch (err) {
                reply(String(err));
            }
            return true;
        }

        if (budy.startsWith('$')) {
            if (!isCreator) return reply("*khusus owner*");
            exec(q, (err, stdout) => {
                if (err) return reply(String(err));
                if (stdout) return reply(stdout);
            });
            return true;
        }

        return false;
    }
};
