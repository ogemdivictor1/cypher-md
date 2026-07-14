const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

async function pairWithWhiskey(phoneNumber, socket, useDb = false) {
  // Resolve auth backend
  let state, saveCreds;
  if (useDb === 'upstash') {
    const { useUpstashAuthState } = require('./redis');
    const result = await useUpstashAuthState(phoneNumber);
    state = result.state;
    saveCreds = result.saveCreds;
  } else if (useDb) {
    const { usePostgresAuthState } = require('./db');
    const result = await usePostgresAuthState(phoneNumber);
    state = result.state;
    saveCreds = result.saveCreds;
  } else {
    const authFolder = path.join(process.cwd(), 'auth_info', phoneNumber);
    await fsPromises.mkdir(authFolder, { recursive: true });
    const result = await useMultiFileAuthState(authFolder);
    state = result.state;
    saveCreds = result.saveCreds;
  }

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
            // Purge session from whichever backend
            if (useDb === 'upstash') {
              const { deleteAuthSession } = require('./redis');
              await deleteAuthSession(phoneNumber).catch(() => {});
            } else if (useDb) {
              const { deleteAuthSession } = require('./db');
              await deleteAuthSession(phoneNumber).catch(() => {});
            } else {
              const folder = path.join(process.cwd(), 'auth_info', phoneNumber);
              try { fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {}
            }
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
