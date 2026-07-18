require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
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

const storage = require('./storage');

// ─── Admin auth ───
const ADMIN_USER = 'cypher2dwrld';
const ADMIN_PASS = '4265803791';
const adminTokens = new Set();

function genToken() { return crypto.randomBytes(32).toString('hex'); }

function getAdminToken(req) {
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  for (const c of cookies) {
    if (c.startsWith('admin_token=')) return c.slice('admin_token='.length);
  }
  return null;
}

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  if (!token || !adminTokens.has(token)) {
    if (req.path.startsWith('/admin/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/admin/login');
  }
  next();
}

async function main() {
  await storage.initBackend();

  // ─── Auto-restore saved sessions (up to MAX_ALLOWED_NUMBERS) ───
  const preAllowed = loadAllowedNumbers();
  const maxRestore = MAX_ALLOWED_NUMBERS;
  try {
    const numbers = await storage.getStoredPhoneNumbers();
    let restored = 0;
    for (const num of numbers) {
      if (restored >= maxRestore) break;
      if (preAllowed.includes(num) || restored < maxRestore) {
        console.log('[SRV] auto-start', num);
        startBot(num, null, storage.getType()).catch(err => console.error('[SRV] start failed', num, err.message));
        restored++;
      }
    }
  } catch (err) {
    console.error('[SRV] load sessions failed:', err.message);
  }

  // Populate allowed numbers from existing stored sessions (e.g. after file deletion)
  const allowedNumbers = loadAllowedNumbers();
  if (allowedNumbers.length < MAX_ALLOWED_NUMBERS) {
    let storedNumbers = [];
    try { storedNumbers = await storage.getStoredPhoneNumbers(); } catch (_) {}
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
  app.use(express.json());

  // ─── Admin routes (before static to prevent unauthed file access) ───
  app.post('/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = genToken();
      adminTokens.add(token);
      res.cookie('admin_token', token, { httpOnly: true, sameSite: 'strict', maxAge: 86400000 });
      return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  });

  app.post('/admin/logout', (req, res) => {
    const token = getAdminToken(req);
    if (token) adminTokens.delete(token);
    res.clearCookie('admin_token');
    res.json({ success: true });
  });

  app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });

  app.get('/admin/login', (req, res) => {
    const token = getAdminToken(req);
    if (token && adminTokens.has(token)) return res.redirect('/admin');
    res.sendFile(path.join(__dirname, '../public/admin-login.html'));
  });

  app.get('/admin/api/numbers', requireAdmin, (req, res) => {
    const numbers = [];
    for (const [num, conn] of connections) {
      numbers.push({ number: num, connected: !!(conn && conn.user) });
    }
    res.json({ numbers, allowed: loadAllowedNumbers(), maxAllowed: MAX_ALLOWED_NUMBERS });
  });

  app.post('/admin/api/unpair/:number', requireAdmin, async (req, res) => {
    const number = req.params.number.replace(/\D/g, '');
    if (!number) return res.status(400).json({ error: 'Invalid number' });

    // Remove from allowed list
    const allowed = loadAllowedNumbers().filter(n => n !== number);
    saveAllowedNumbers(allowed);

    // Disconnect socket
    const conn = connections.get(number);
    if (conn) {
      try {
        conn.ev.removeAllListeners();
        if (conn.ws) conn.ws.close();
        if (typeof conn.end === 'function') conn.end();
      } catch (_) {}
      connections.delete(number);
      sessions.delete(number);
    }
    isConnecting?.delete(number);

    // Delete auth from storage
    try { await storage.deleteAuthSession(number); } catch (_) {}

    res.json({ success: true, message: `Unpaired ${number}` });
  });

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
        const { state, saveCreds } = await pairWithWhiskey(cleanNumber, socket);
        await startBot(cleanNumber, socket, storage.getType(), state, saveCreds);
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