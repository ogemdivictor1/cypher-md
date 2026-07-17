require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startBot, connections = new Map(), sessions = new Map(), startTime, isConnecting } = require('./bot');
const { pairWithWhiskey } = require('./pair');

const ALLOWED_NUMBERS_FILE = path.join(__dirname, '..', 'allowed_numbers.json');
const MAX_ALLOWED_NUMBERS = 5;

function loadAllowedNumbers() {
  try {
    if (require('fs').existsSync(ALLOWED_NUMBERS_FILE)) {
      return JSON.parse(require('fs').readFileSync(ALLOWED_NUMBERS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[SRV] Failed to load allowed numbers:', e.message);
  }
  return [];
}

function saveAllowedNumbers(numbers) {
  try {
    require('fs').writeFileSync(ALLOWED_NUMBERS_FILE, JSON.stringify(numbers, null, 2));
  } catch (e) {
    console.error('[SRV] Failed to save allowed numbers:', e.message);
  }
}

let useDb = false;

async function main() {
  if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
    const { initRedis } = require('./redis');
    initRedis(process.env.UPSTASH_REDIS_URL, process.env.UPSTASH_REDIS_TOKEN);
    console.log('[SRV] Upstash Redis');
    useDb = 'upstash';
  } else if (process.env.DATABASE_URL) {
    const { initDb, setupTables } = require('./db');
    initDb(process.env.DATABASE_URL);
    try {
      await setupTables();
      console.log('[SRV] DB connected');
      useDb = true;
    } catch (err) {
      console.error('[SRV] DB failed:', err.message);
    }
  } else {
    console.log('[SRV] file-based auth');
  }

  // ─── Auto-restore saved sessions ───
  if (useDb === 'upstash') {
    const { getStoredPhoneNumbers } = require('./redis');
    try {
      const numbers = await getStoredPhoneNumbers();
      for (const num of numbers) {
        console.log('[SRV] auto-start', num);
        startBot(num, null, 'upstash').catch(err => console.error('[SRV] start failed', num, err.message));
      }
    } catch (err) {
      console.error('[SRV] load sessions failed:', err.message);
    }
  } else if (useDb) {
    const { getStoredPhoneNumbers } = require('./db');
    try {
      const numbers = await getStoredPhoneNumbers();
      for (const num of numbers) {
        console.log('[SRV] auto-start', num);
        startBot(num, null, true).catch(err => console.error('[SRV] start failed', num, err.message));
      }
    } catch (err) {
      console.error('[SRV] load sessions failed:', err.message);
    }
  }

  // Populate allowed numbers from existing stored sessions (e.g. after file deletion)
  const allowedNumbers = loadAllowedNumbers();
  if (allowedNumbers.length < MAX_ALLOWED_NUMBERS) {
    let storedNumbers = [];
    if (useDb === 'upstash') {
      try {
        const { getStoredPhoneNumbers } = require('./redis');
        storedNumbers = await getStoredPhoneNumbers();
      } catch (_) {}
    } else if (useDb) {
      try {
        const { getStoredPhoneNumbers } = require('./db');
        storedNumbers = await getStoredPhoneNumbers();
      } catch (_) {}
    } else {
      const authFolder = path.join(process.cwd(), 'auth_info');
      try {
        storedNumbers = require('fs').readdirSync(authFolder).filter(d => {
          try { return require('fs').existsSync(path.join(authFolder, d, 'creds.json')); }
          catch { return false; }
        });
      } catch (_) {}
    }
    for (const num of storedNumbers) {
      if (!allowedNumbers.includes(num) && allowedNumbers.length < MAX_ALLOWED_NUMBERS) {
        allowedNumbers.push(num);
      }
    }
    saveAllowedNumbers(allowedNumbers);
  }

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/status', (req, res) => {
    try {
      const connList = [];
      for (const [num, conn] of connections) {
        connList.push({ number: num, connected: !!(conn && conn.user) });
      }
      const botStart = startTime || Date.now();
      res.json({ uptime: Math.floor((Date.now() - botStart) / 1000) + 's', connections: connList });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  io.on('connection', (socket) => {
    console.log('[SRV] frontend connected');

    socket.on('request-code', async (phoneNumber) => {
      console.log('[SRV] pair request:', phoneNumber);
      const cleanNumber = phoneNumber.replace(/\D/g, '');

      if (!/^234\d{10}$/.test(cleanNumber)) {
        socket.emit('error', 'Invalid phone number (must be 234XXXXXXXXXX)');
        return;
      }

      if (connections.has(cleanNumber) || isConnecting?.has(cleanNumber)) {
        socket.emit('error', 'This number is already connected or connecting');
        return;
      }

      // First-5-numbers rule: only the first 5 unique paired numbers are ever allowed
      const allowedNumbers = loadAllowedNumbers();
      if (!allowedNumbers.includes(cleanNumber)) {
        if (allowedNumbers.length >= MAX_ALLOWED_NUMBERS) {
          socket.emit('error', `Only the first ${MAX_ALLOWED_NUMBERS} paired numbers are allowed. This number is not on the allowed list.`);
          return;
        }
        allowedNumbers.push(cleanNumber);
        saveAllowedNumbers(allowedNumbers);
      }

      try {
        const { state, saveCreds } = await pairWithWhiskey(cleanNumber, socket, useDb);
        await startBot(cleanNumber, socket, useDb, state, saveCreds);
        socket.emit('bot-started', 'Bot started successfully');
      } catch (error) {
        console.error('[SRV] pair error:', error.message);
        socket.emit('error', 'Pairing failed: ' + error.message);
      }
    });

    socket.on('disconnect', () => {
      console.log('[SRV] frontend disconnected');
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[SRV] listening on :${PORT}`);
  });
}

main();