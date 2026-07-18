const {
  makeWASocket,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const storage = require('./storage');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

async function pairWithWhiskey(phoneNumber, socket) {
  // Wipe any stale session first so pairing always starts fresh
  await storage.deleteAuthSession(phoneNumber).catch(() => {});

  // Resolve auth backend
  const { state, saveCreds } = await storage.useAuthState(phoneNumber);

  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    let resolved = false;
    let checkInterval = null;
    let conn;
    let currentCode = null;

    function startPairingSocket() {
      if (resolved) return;

      conn = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
      });

      conn.ev.on('creds.update', saveCreds);

      if (!conn.authState.creds.registered && phoneNumber && !currentCode) {
        setTimeout(async () => {
          try {
            let code = await conn.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join('-') || code;
            currentCode = code;
            socket.emit('pairing-code', code);
            console.log('[PAIR] code:', code);
          } catch (err) {
            console.error('[PAIR] failed to generate pairing code:', err);
          }
        }, 3000);
      }

      conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          console.log(`[PAIR] closed reason=${reason}`);

          try {
            conn.ev.removeAllListeners();
            if (conn.ws) await conn.ws.close();
            if (typeof conn.end === 'function') await conn.end();
          } catch (_) {}

          if (resolved) return;

          if (reason === 515) {
            console.log('[PAIR] 515 restart required, reconnecting with same code...');
            setTimeout(startPairingSocket, 3000);
            return;
          }

          if (reason === DisconnectReason.loggedOut) {
            socket.emit('logged-out', 'WhatsApp session logged out');
            await storage.deleteAuthSession(phoneNumber).catch(() => {});
            if (!resolved) { resolved = true; reject(new Error('Logged out')); }
          } else {
            socket.emit('error', 'Connection closed, please try again');
            if (!resolved) { resolved = true; reject(new Error('Connection closed')); }
          }

          if (checkInterval) clearInterval(checkInterval);
        }

        if (connection === 'open') {
          console.log('[PAIR] connection opened');
          socket.emit('connected', 'WhatsApp connected');

          checkInterval = setInterval(() => {
            if (conn.authState?.creds?.registered) {
              clearInterval(checkInterval);
              checkInterval = null;
              try { conn.ev.removeAllListeners(); } catch (_) {}
              try { if (conn.ws) conn.ws.close(); } catch (_) {}
              try { if (typeof conn.end === 'function') conn.end(); } catch (_) {}
              if (!resolved) { resolved = true; resolve({ state, saveCreds }); }
            }
          }, 2000);

          setTimeout(() => {
            if (checkInterval) clearInterval(checkInterval);
            try { conn.ev.removeAllListeners(); } catch (_) {}
            try { if (conn.ws) conn.ws.close(); } catch (_) {}
            try { if (typeof conn.end === 'function') conn.end(); } catch (_) {}
            if (!resolved) { resolved = true; reject(new Error('Pairing timeout (120s)')); }
          }, 120000);
        }
      });
    }

    startPairingSocket();
  });
}

module.exports = { pairWithWhiskey };
