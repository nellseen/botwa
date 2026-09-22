const nellsbot = require('../nellsbot');

class MessageRouter {
    static async handleMessage(session, sock, m, store) {
        try {
            const isCreator = [sock?.user?.id, ...(global.owner || [])]
                .map(v => v ? v.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '')
                .includes(m.sender);

            if (!sock.public && !m.key.fromMe && !isCreator) return;
            if (m.key.id.startsWith('BAE5') && m.key.id.length === 16) return;
            if (m.key.id.startsWith('NellsBotBase')) return;

            // Pass the specific socket and session information to the core handler
            await nellsbot(sock, m, null, store, session);
        } catch (e) {
            console.error(`[MessageRouter Error] [${session.sessionId}]`, e);
        }
    }
}

module.exports = MessageRouter;
