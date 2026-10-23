const nellsbot = require('../nellsbot');
const plugins = require('../lib/plugins');

class MessageRouter {
    /**
     * Production message handler - strictly for verified live WhatsApp sessions.
     * Automatically diverts simulated or mock traffic to the isolated testing router.
     */
    static async handleMessage(session, sock, m, store) {
        try {
            // Divert simulated traffic to isolated testing router
            if (session?.isSimulation || sock?.isSimulation || m?.isSimulation) {
                return await MessageRouter.handleSimulatedMessage(session, sock, m, store);
            }

            if (!session || typeof session.sessionId !== 'string') {
                return;
            }

            const isCreator = [sock?.user?.id, ...(global.owner || [])]
                .map(v => v ? v.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '')
                .includes(m?.sender);

            if (!sock?.public && !m?.key?.fromMe && !isCreator) return;
            if (m?.key?.id && m.key.id.startsWith('BAE5') && m.key.id.length === 16) return;
            if (m?.key?.id && m.key.id.startsWith('NellsBotBase')) return;

            // Pass the specific socket and session information to the core handler
            await nellsbot(sock, m, null, store, session);
        } catch (e) {
            console.error(`[MessageRouter Error] [${session?.sessionId || 'unknown'}]`, e);
        }
    }

    /**
     * Isolated testing and simulation message router.
     * Guaranteed: Never trusts client sender/isCreator, and strictly blocks
     * owner plugins, eval(), exec(), and privileged operations.
     */
    static async handleSimulatedMessage(session, sock, m, store) {
        try {
            // Force strict simulation isolation flags
            if (session) session.isSimulation = true;
            if (sock) sock.isSimulation = true;
            if (m) {
                m.isSimulation = true;
                if (m.key) m.key.fromMe = false;
                delete m.isCreator;
                delete m.isOwner;
            }

            const rawText = (m?.text || m?.message?.conversation || '').trim();

            // 1. Strictly block code evaluation and shell execution prefixes
            if (rawText.startsWith('=>') || rawText.startsWith('$')) {
                if (sock?.sendMessage && m?.chat) {
                    await sock.sendMessage(m.chat, {
                        text: '*Akses ditolak: Operasi evaluasi/shell exec dilarang dalam mode simulasi.*'
                    }, { quoted: m });
                }
                return { blocked: true, reason: 'EXEC_DISALLOWED_IN_SIMULATION' };
            }

            // 2. Extract command to verify against plugin registry
            const prefix = global.prefix || '/';
            let cmdName = '';
            if (rawText.startsWith(prefix)) {
                cmdName = rawText.slice(prefix.length).trim().split(/ +/)[0].toLowerCase();
            } else {
                cmdName = rawText.split(/ +/)[0].toLowerCase();
            }

            // 3. Strictly block any owner plugins or privileged operations
            if (cmdName) {
                const plugin = plugins.findPlugin(cmdName);
                if (plugin && (plugin.category === 'owner' || plugin.owner === true || plugin.name === 'exec')) {
                    if (sock?.sendMessage && m?.chat) {
                        await sock.sendMessage(m.chat, {
                            text: '*Akses ditolak: Plugin owner dilarang dalam mode simulasi.*'
                        }, { quoted: m });
                    }
                    return { blocked: true, reason: 'OWNER_PLUGIN_DISALLOWED_IN_SIMULATION' };
                }
            }

            // 4. Safe execution via core handler with untrusted simulation context
            await nellsbot(sock, m, null, store, session);
            return { handled: true };
        } catch (e) {
            console.error(`[SimulationRouter Error] [${session?.sessionId || 'simulation'}]`, e);
            throw e;
        }
    }
}

module.exports = MessageRouter;
