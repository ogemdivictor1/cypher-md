process.on('unhandledRejection', (err) => {
  if (err?.message) console.error('[FATAL]', err.message);
});

// ── Diagnostic: resolve all JID variants for a given raw JID ──
async function resolveAllJids(rawJid, conn) {
  const results = { raw: rawJid, variants: {} };
  if (!rawJid) return results;
  const norm = normalizeJid(rawJid);
  results.variants[`normalized`] = norm;
  results.variants[`phone@s.whatsapp.net`] = norm + '@s.whatsapp.net';
  results.variants[`lid`] = norm + '@lid';
  if (rawJid.endsWith('@lid')) {
    results.variants[`rawLid`] = rawJid;
    results.variants[`rawLidNormalized`] = norm + '@lid';
  } else {
    results.variants[`rawJid`] = rawJid;
  }
  if (lidToPhone.has(norm)) {
    const phone = lidToPhone.get(norm);
    results.variants[`lidToPhone`] = phone + '@s.whatsapp.net';
    results.variants[`lidToPhone_lid`] = phone + '@lid';
  }
  if (lidToPhone.has(rawJid)) {
    results.variants[`lidToPhone_rawJid`] = lidToPhone.get(rawJid) + '@s.whatsapp.net';
  }
  // Try findUserId
  try {
    const ids = await conn.findUserId(rawJid);
    if (ids?.phoneNumber) {
      results.variants[`findUserId_phone`] = ids.phoneNumber;
      results.variants[`findUserId_phoneNorm`] = normalizeJid(ids.phoneNumber) + '@s.whatsapp.net';
    }
    if (ids?.lid) results.variants[`findUserId_lid`] = ids.lid;
  } catch (_) {}
  // Try onWhatsApp
  try {
    const [result] = await conn.onWhatsApp(norm);
    if (result?.jid) {
      results.variants[`onWhatsApp_jid`] = result.jid;
    }
  } catch (_) {}
  return results;
}

async function diagnosticSend(conn, rawJid, label) {
  const jids = await resolveAllJids(rawJid, conn);
  for (const [key, jid] of Object.entries(jids.variants)) {
    try {
      await conn.sendMessage(jid, { text: `🧪 Diagnostic ping from CYPHER MD [${key}]` });
    } catch (err) {}
  }
  return jids;
}

// ── Suppress noisy library logs ──
const suppressPatterns = [
  'Bad MAC', 'Session error', 'Failed to decrypt',
  'Closing session', 'Closing open session',
  'MessageCounterError', 'verifyMAC', 'decryptWhisperMessage',
  'SessionEntry', '_chains', 'registrationId',
  'currentRatchet', 'ephemeralKeyPair', 'lastRemoteEphemeralKey',
  'previousCounter', 'rootKey', 'indexInfo', 'baseKey',
  'baseKeyType', 'remoteIdentityKey', 'pendingPreKey',
  'signedKeyId', 'preKeyId'
];
const isNoise = (s) => suppressPatterns.some(p => s.includes(p));

const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => {
  const s = chunk.toString();
  if (s.trim() && !isNoise(s)) return _origStdoutWrite(s);
};
process.stderr.write = (chunk) => {
  const s = chunk.toString();
  if (s.trim() && !isNoise(s)) return _origStderrWrite(s);
};

const storage = require('./storage');
const ytSearch = require('yt-search');
const { execFile } = require('child_process');

const {
  makeWASocket,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  generateWAMessage,
  normalizeMessageContent,
  areJidsSameUser
} = require('@lordmega/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const sharp = require('sharp');
const { YOUTUBE_DL_PATH } = require('youtube-dl-exec/src/constants');

const ytDlpPath = process.env.YT_DLP_PATH || YOUTUBE_DL_PATH;

function audioMime(buf) {
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  if (buf[0] === 0x66 && buf[1] === 0x74 && buf[2] === 0x79 && buf[3] === 0x70) return 'audio/mp4';
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'audio/mp4';
  return 'audio/mpeg';
}

// ------------------------------------------------------------------
// State (all in‑memory, no database)
// ------------------------------------------------------------------
const connections = new Map();           // phoneNumber -> socket instance (EXPORTED)
const sessions = new Map();              // phoneNumber -> per-number state (EXPORTED)
const startTime = Date.now();
const connectedNumbers = new Set();
const reconnectAttempts = new Map();
const reconnectTimers = new Map();
const isConnecting = new Map();
const consecutive428 = new Map();
const lastStream515At = new Map();
const userGroups = new Set();
const currentGroups = new Set();
const processedMessages = new Set();
// Anti-link & anti-spam
const linkWhitelist = new Set(['youtube.com', 'youtu.be', 'google.com', 'github.com', 'wa.me']);
const spamTracker = new Map();
const SPAM_WINDOW_MS = 4000;
const SPAM_MAX_MSGS = 5;
const LINK_WARN_LIMIT = 5;

const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 30000;
const lidToPhone = new Map();
const pendingReveals = new Set();

function createSessionState(phoneNumber) {
  const ownerNumber = phoneNumber.replace(/\D/g, '');
  const dataFile = path.join(process.cwd(), `vv_data_${ownerNumber}.json`);
  const state = {
    phoneNumber,
    ownerNumber,
    dataFile,
    warnings: new Map(),
    antilinkEnabled: new Map(),
    antilinkWarnings: new Map(),
    antistatusEnabled: new Map(),
    antistatusCounts: new Map(),
    messageStore: new Map(),
    monitoredNumbers: new Set(),
    aiTargets: new Set(),
    aiGroups: new Set(),
    aiConversations: new Map(),
    groqApiKey: '',
    aiSystemPrompt: '',
    totalCommandsAttempted: 0,
    totalCommandsSucceeded: 0,
  };
  return state;
}

const normalizeJid = (jid) => { if (!jid) return ''; return jid.split(':')[0].split('@')[0].split('.')[0].replace(/[^0-9]/g, ''); };

const resolveJid = async (jid, conn) => {
  if (!jid) return jid;
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return jid;
  if (jid.endsWith('@lid')) {
    const norm = normalizeJid(jid);
    if (lidToPhone.has(norm)) return lidToPhone.get(norm) + '@s.whatsapp.net';
    try {
      const ids = await conn.findUserId(jid);
      if (ids?.phoneNumber) {
        const phoneNorm = normalizeJid(ids.phoneNumber);
        lidToPhone.set(norm, phoneNorm);
        lidToPhone.set(phoneNorm, norm);
        return ids.phoneNumber;
      }
    } catch (_) {}
    return jid;
  }
  return jid;
};

// ── Persistence (per-number) ──

function loadSessionData(state) {
  try {
    if (fs.existsSync(state.dataFile)) {
      const data = JSON.parse(fs.readFileSync(state.dataFile, 'utf-8'));
      if (Array.isArray(data.monitoredNumbers)) {
        for (const n of data.monitoredNumbers) state.monitoredNumbers.add(n);
      }
      if (Array.isArray(data.aiTargets)) {
        for (const t of data.aiTargets) state.aiTargets.add(t);
      }
      if (Array.isArray(data.aiGroups)) {
        for (const g of data.aiGroups) state.aiGroups.add(g);
      }
      if (data.groqApiKey) state.groqApiKey = data.groqApiKey;
      if (data.aiSystemPrompt) state.aiSystemPrompt = data.aiSystemPrompt;
      if (data.lidToPhone && typeof data.lidToPhone === 'object') {
        for (const [k, v] of Object.entries(data.lidToPhone)) lidToPhone.set(k, v);
      }
      if (Array.isArray(data.antilinkEnabled)) {
        for (const jid of data.antilinkEnabled) state.antilinkEnabled.set(jid, true);
      }
      if (data.antilinkWarnings && typeof data.antilinkWarnings === 'object') {
        for (const [k, v] of Object.entries(data.antilinkWarnings)) state.antilinkWarnings.set(k, v);
      }
      if (Array.isArray(data.antistatusEnabled)) {
        for (const jid of data.antistatusEnabled) state.antistatusEnabled.set(jid, true);
      }
      if (data.antistatusCounts && typeof data.antistatusCounts === 'object') {
        for (const [k, v] of Object.entries(data.antistatusCounts)) state.antistatusCounts.set(k, v);
      }
      if (data.warnings && typeof data.warnings === 'object') {
        for (const [k, v] of Object.entries(data.warnings)) state.warnings.set(k, v);
      }
      console.log(`[DATA] ${state.phoneNumber} loaded ${state.monitoredNumbers.size} monitored, ${state.aiTargets.size} AI targets, ${state.aiGroups.size} AI groups`);
    }
  } catch (err) {
    console.error(`[DATA] load failed for ${state.phoneNumber}:`, err.message);
  }
}

function saveSessionData(state) {
  try {
    const data = {
      monitoredNumbers: [...state.monitoredNumbers],
      lidToPhone: Object.fromEntries(lidToPhone),
      aiTargets: [...state.aiTargets],
      aiGroups: [...state.aiGroups],
      groqApiKey: state.groqApiKey,
      aiSystemPrompt: state.aiSystemPrompt,
      antilinkEnabled: [...state.antilinkEnabled.keys()],
      antilinkWarnings: Object.fromEntries(state.antilinkWarnings),
      antistatusEnabled: [...state.antistatusEnabled.keys()],
      antistatusCounts: Object.fromEntries(state.antistatusCounts),
      warnings: Object.fromEntries(state.warnings),
    };
    fs.writeFileSync(state.dataFile, JSON.stringify(data));
  } catch (err) {
    console.error(`[DATA] save failed for ${state.phoneNumber}:`, err.message);
  }
}

async function sendImageViaFile(conn, jid, buffer, caption) {
  const tmpFile = path.join(os.tmpdir(), `wa_mon_${Date.now()}.jpeg`);
  await fsPromises.writeFile(tmpFile, buffer);
  try {
    await conn.sendMessage(jid, { image: { url: tmpFile }, caption });
  } finally {
    try { await fsPromises.unlink(tmpFile); } catch {}
  }
}

const getGroupMeta = async (conn, groupId) => {
  const cached = groupMetaCache.get(groupId);
  if (cached && Date.now() - cached.ts < GROUP_CACHE_TTL) return cached.metadata;
  const metadata = await conn.groupMetadata(groupId);
  groupMetaCache.set(groupId, { metadata, ts: Date.now() });
  return metadata;
};

const hasLink = (text) => {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!lower.includes('http') && !lower.includes('www.') && !lower.includes('chat.whatsapp')) return false;
  const matches = text.match(/https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[^\s]+/gi);
  if (!matches) return false;
  for (const url of matches) {
    try {
      const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      const domain = hostname.replace(/^www\./, '');
      if (!linkWhitelist.has(domain)) return true;
    } catch { return true; }
  }
  return false;
};

const isSpamming = (userId) => {
  const now = Date.now();
  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  const timestamps = spamTracker.get(userId);
  while (timestamps.length && now - timestamps[0] > SPAM_WINDOW_MS) timestamps.shift();
  timestamps.push(now);
  return timestamps.length > SPAM_MAX_MSGS;
};

async function deleteAuthFolder(phoneNumber) {
  try {
    await storage.deleteAuthSession(phoneNumber);
    connectedNumbers.delete(phoneNumber);
    console.log(`[AUTH] deleted session for ${phoneNumber}`);
  } catch (err) {
    console.error(`[AUTH] delete session failed for ${phoneNumber}:`, err.message);
  }
}

const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 10;
const RECONNECT_MAX_DELAY = 300;
const RECONNECT_COOLDOWN_AFTER = 60000;

const lastConnectedAt = new Map();

function scheduleReconnect(phoneNumber, socket) {
  if (reconnectTimers.has(phoneNumber)) {
    clearTimeout(reconnectTimers.get(phoneNumber));
    reconnectTimers.delete(phoneNumber);
  }
  const attempt = (reconnectAttempts.get(phoneNumber) || 0) + 1;
  reconnectAttempts.set(phoneNumber, attempt);

  if (attempt > RECONNECT_MAX_ATTEMPTS) {
    console.log(`[RECON] ${phoneNumber} max attempts (${RECONNECT_MAX_ATTEMPTS}) reached, purging stale session`);
    deleteAuthFolder(phoneNumber).catch(() => {});
    reconnectAttempts.delete(phoneNumber);
    consecutive428.delete(phoneNumber);
    return;
  }

  const lastOk = lastConnectedAt.get(phoneNumber) || 0;
  const sinceLastOk = Date.now() - lastOk;
  const delay = lastOk && sinceLastOk < RECONNECT_COOLDOWN_AFTER
    ? Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY)
    : RECONNECT_BASE_DELAY;

  const jitter = Math.random() * 0.3 * delay;
  const finalDelay = Math.round(delay + jitter);
  console.log(`[RECON] ${phoneNumber} in ${finalDelay}s (attempt ${attempt})`);
  const timer = setTimeout(async () => {
    if (!isConnecting.get(phoneNumber)) {
      try {
        await startBot(phoneNumber, socket);
      } catch (err) {
        console.error(`[RECON] failed for ${phoneNumber}:`, err.message);
        isConnecting.delete(phoneNumber);
        if (socket) socket.emit('reconnect-failed', err.message);
      }
    }
    reconnectTimers.delete(phoneNumber);
  }, finalDelay * 1000);
  reconnectTimers.set(phoneNumber, timer);
}

async function cleanupSocket(conn) {
  if (!conn) return;
  try {
    conn.ev.removeAllListeners();
    if (conn.ws) await conn.ws.close();
    if (typeof conn.end === 'function') await conn.end();
  } catch (err) {
    console.error('[SOCK] cleanup error:', err.message);
  }
}

// ------------------------------------------------------------------
// Command Registry (minimal, fast)
// ------------------------------------------------------------------
const commands = {
  clearsession: {
    handler: async (conn, from, args, msg, sender) => {
      const _s = conn.state;
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : normalizeJid(sender) + '@s.whatsapp.net';
      console.log(`[CS] clearing session for ${target}`);
      try {
        const deleted = await storage.deleteContactSession(_s.phoneNumber, target);
        if (deleted === 0) {
          const authFolder = path.join(process.cwd(), 'auth_info', _s.phoneNumber);
          if (fs.existsSync(authFolder)) {
            const files = fs.readdirSync(authFolder).filter(f => f.startsWith('session-') && f.includes(normalizeJid(target)));
            for (const f of files) fs.unlinkSync(path.join(authFolder, f));
          }
        }
        await conn.assertSessions([target], true);
        console.log(`[CS] session refreshed for ${target}`);
        await conn.sendMessage(from, { text: `✅ Cleared session for ${target} and re-established` });
      } catch (err) {
        console.error(`[CS] error:`, err.message);
        await conn.sendMessage(from, { text: `❌ Error: ${err.message}` });
      }
    },
    aliases: ['cs', 'clearsig'],
    args: ['optional'],
    groupAdminRequired: false,
  },
  cleardb: {
    handler: async (conn, from) => {
      const _s = conn.state;
      _s.monitoredNumbers.clear();
      _s.warnings.clear();
      _s.antilinkEnabled.clear();
      _s.antilinkWarnings.clear();
      _s.antistatusEnabled.clear();
      _s.antistatusCounts.clear();
      _s.messageStore.clear();
      _s.aiTargets.clear();
      _s.aiGroups.clear();
      _s.aiConversations.clear();
      _s.groqApiKey = '';
      _s.aiSystemPrompt = '';
      saveSessionData(_s);
      await conn.sendMessage(from, { text: '🗄️ Database wiped (all persistent data cleared).' });
    },
    aliases: ['wipedb', 'resetdb'],
    args: [],
    groupAdminRequired: false,
  },
  ping: {
    handler: async (conn, from, args, msg, sender) => {
      console.log(`[PING] from="${from}" sender="${sender}"`);
      if (args[0] === 'diag') {
        const jids = await resolveAllJids(from, conn);
        const senderJids = await resolveAllJids(sender, conn);
        await conn.sendMessage(from, { text: `🔍 Check server logs for JID diagnostic` });
        return;
      }
      if (args[0] === 'blast') {
        await diagnosticSend(conn, from, 'from');
        await diagnosticSend(conn, sender, 'sender');
        return;
      }
      if (args[0] === 'raw') {
        const target = args[1] || from;
        const phoneJid = '2348126159499@s.whatsapp.net';
        try { await conn.assertSessions([phoneJid], true); console.log('[PING] step1 OK'); } catch (e) { console.log('[PING] step1 FAIL', e.message); }
        try { await conn.assertSessions([target], true); console.log('[PING] step2 OK'); } catch (e) { console.log('[PING] step2 FAIL', e.message); }
        try { await conn.sendMessage(phoneJid, { text: '🧪 Step 3 test (after session refresh)' }); console.log('[PING] step3 OK'); } catch (e) { console.log('[PING] step3 FAIL', e.message); }
        try { await conn.sendMessage(target, { text: '🧪 Step 4 test (after session refresh)' }); console.log('[PING] step4 OK'); } catch (e) { console.log('[PING] step4 FAIL', e.message); }
        return;
      }
      await conn.sendMessage(from, { text: '🏓 Pong! CYPHER MD is still active!' });
    },
    aliases: ['p'],
    args: [],
    groupAdminRequired: false,
  },
  testimg: {
    handler: async (conn, from) => {
      console.log('[TEST] sending test image');
      try {
        const testBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        await conn.sendMessage(from, { image: testBuffer, caption: '🧪 Test image' });
      } catch (err) {
        console.error('[TEST] error:', err.message);
      }
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  time: {
    handler: async (conn, from) => {
      await conn.sendMessage(from, { text: `🕐 ${new Date().toLocaleString()}` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  reverse: {
    handler: async (conn, from, args) => {
      const text = args.join(' ');
      if (!text) throw new Error('❌ Provide text to reverse.');
      await conn.sendMessage(from, { text: `🔄 ${text.split('').reverse().join('')}` });
    },
    aliases: ['r'],
    args: ['text'],
    groupAdminRequired: false,
  },
  quote: {
    handler: async (conn, from) => {
      const quotes = [
        "The only way to do great work is to love what you do. — Steve Jobs",
        "In the middle of every difficulty lies opportunity. — Albert Einstein",
        "It does not matter how slowly you go as long as you do not stop. — Confucius",
        "Success is not final, failure is not fatal. — Winston Churchill",
        "Believe you can and you're halfway there. — Theodore Roosevelt",
        "Code is like humor. When you have to explain it, it's bad. — Cory House",
        "SEE IT, TOUCH IT, OBTAIN IT. — CYPHER MD 👑"
      ];
      const random = quotes[Math.floor(Math.random() * quotes.length)];
      await conn.sendMessage(from, { text: `💬 ${random}` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  bio: {
    handler: async (conn, from, args, msg, sender) => {
      const status = await conn.fetchStatus(sender);
      await conn.sendMessage(from, { text: `📝 ${status?.status || 'No bio set'}` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  getpp: {
    handler: async (conn, from, args, msg, sender) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      let target = ctx?.participant || sender;
      if (ctx?.stanzaId && ctx?.participant && ctx.participant.endsWith('@lid')) {
        try {
          const resolved = await resolveJid(ctx.participant, conn);
          if (resolved !== ctx.participant) target = resolved;
        } catch (_) {}
      }
      if (!ctx && args[0]) target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      try {
        const ppUrl = await conn.profilePictureUrl(target, 'image');
        await conn.sendMessage(from, { image: { url: ppUrl }, caption: '🖼️ Profile picture' });
      } catch {
        await conn.sendMessage(from, { text: '❌ No profile picture found.' });
      }
    },
    aliases: [],
    args: ['optional'],
    groupAdminRequired: false,
  },
  sticker: {
    handler: async (conn, from, args, msg) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage;
      const imageMsg = quoted?.imageMessage || msg.message?.imageMessage;
      if (!imageMsg) throw new Error('❌ Reply to an image.');
      let targetMsg;
      if (quoted?.imageMessage) {
        targetMsg = {
          key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
          message: { imageMessage: quoted.imageMessage }
        };
      } else {
        targetMsg = msg;
      }
      const buffer = await downloadMediaMessage(targetMsg, 'buffer', { logger: conn.logger });
      const webp = await sharp(buffer).webp().toBuffer();
      await conn.sendMessage(from, { sticker: webp });
    },
    aliases: ['s'],
    args: [],
    groupAdminRequired: false,
  },
  toimage: {
    handler: async (conn, from, args, msg) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage;
      const stickerMsg = quoted?.stickerMessage || msg.message?.stickerMessage;
      if (!stickerMsg) throw new Error('❌ Reply to a sticker.');
      let targetMsg;
      if (quoted?.stickerMessage) {
        targetMsg = {
          key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
          message: { stickerMessage: quoted.stickerMessage }
        };
      } else {
        targetMsg = msg;
      }
      const buffer = await downloadMediaMessage(targetMsg, 'buffer', { logger: conn.logger });
      const png = await sharp(buffer).png().toBuffer();
      await conn.sendMessage(from, { image: png, caption: '🖼️ I CYPHER MD has safely delivered your image!' });
    },
    aliases: ['ti'],
    args: [],
    groupAdminRequired: false,
  },
  runtime: {
    handler: async (conn, from) => {
      const uptime = Date.now() - startTime;
      const seconds = Math.floor((uptime / 1000) % 60);
      const minutes = Math.floor((uptime / (1000 * 60)) % 60);
      const hours = Math.floor((uptime / (1000 * 60 * 60)) % 24);
      const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
      await conn.sendMessage(from, { text: `⏱️ ${days}d ${hours}h ${minutes}m ${seconds}s` });
    },
    aliases: ['uptime'],
    args: [],
    groupAdminRequired: false,
  },
  stats: {
    handler: async (conn, from) => {
      const _s = conn.state;
      const mem = process.memoryUsage();
      await conn.sendMessage(from, {
        text: `📊 Commands: ${_s.totalCommandsAttempted}/${_s.totalCommandsSucceeded} | Groups: ${currentGroups.size} | Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s | Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`
      });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  kick: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      if (target === botJid) throw new Error('❌ Cannot kick myself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      await conn.groupParticipantsUpdate(from, [target], 'remove');
      await conn.sendMessage(from, { text: `👢 Kicked @${target.split('@')[0]} OTILO!`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  warn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const _s = conn.state;
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      if (target === botJid) throw new Error('❌ Cannot warn myself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      const key = `${from}:${target}`;
      const count = (_s.warnings.get(key) || 0) + 1;
      _s.warnings.set(key, count);
      await conn.sendMessage(from, { text: `⚔️ Warned @${target.split('@')[0]} (${count}/3)`, mentions: [target] });
      if (count >= 3) {
        await conn.groupParticipantsUpdate(from, [target], 'remove');
        await conn.sendMessage(from, { text: `🔨 Auto-kicked @${target.split('@')[0]} after 3 warnings OTILO!`, mentions: [target] });
        _s.warnings.delete(key);
      }
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  unwarn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const _s = conn.state;
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      const key = `${from}:${target}`;
      if (_s.warnings.has(key)) {
        _s.warnings.set(key, _s.warnings.get(key) - 1);
        if (_s.warnings.get(key) <= 0) _s.warnings.delete(key);
        await conn.sendMessage(from, { text: `🛡️ Removed a warning from @${target.split('@')[0]}`, mentions: [target] });
      } else {
        await conn.sendMessage(from, { text: `ℹ️ @${target.split('@')[0]} has no warnings.`, mentions: [target] });
      }
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  ban: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      if (target === botJid) throw new Error('❌ Cannot ban myself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      await conn.groupParticipantsUpdate(from, [target], 'remove');
      await conn.sendMessage(from, { text: `🔨 Banned @${target.split('@')[0]} OTILO!`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  promote: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      let target = ctx?.participant;
      if (!target && ctx?.mentionedJid?.length) {
        target = ctx.mentionedJid[0];  // @mention
      }
      if (!target) {
        const num = args[0]?.replace(/[^0-9]/g, '');
        if (num) target = num + '@s.whatsapp.net';  // raw number
      }
      if (!target) throw new Error('❌ Reply, mention, or provide a number.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      await conn.groupParticipantsUpdate(from, [target], 'promote');
      await conn.sendMessage(from, { text: `⬆️ Promoted @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: ['admin'],
    args: ['@user | number'],
    groupAdminRequired: true,
  },
  demote: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      let target = ctx?.participant;
      if (!target && ctx?.mentionedJid?.length) {
        target = ctx.mentionedJid[0];  // @mention
      }
      if (!target) {
        const num = args[0]?.replace(/[^0-9]/g, '');
        if (num) target = num + '@s.whatsapp.net';  // raw number
      }
      if (!target) throw new Error('❌ Reply, mention, or provide a number.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      await conn.groupParticipantsUpdate(from, [target], 'demote');
      await conn.sendMessage(from, { text: `⬇️ Demoted @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: [],
    args: ['@user | number'],
    groupAdminRequired: true,
  },
  delete: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) throw new Error('❌ Reply to a message.');
      const id = msg.message.extendedTextMessage.contextInfo.stanzaId;
      const participant = msg.message.extendedTextMessage.contextInfo.participant;
      if (!id) throw new Error('❌ Could not find message ID.');
      await conn.sendMessage(from, { delete: { remoteJid: from, id, participant: participant || from } });
      await conn.sendMessage(from, { text: '🗑️ Deleted.' });
    },
    aliases: ['del'],
    args: [],
    groupAdminRequired: true,
  },
  mute: {
    handler: async (conn, from) => {
      await conn.groupSettingUpdate(from, 'announcement');
      await conn.sendMessage(from, { text: '🔇 Muted.' });
    },
    aliases: [],
    args: [],
    groupAdminRequired: true,
  },
  unmute: {
    handler: async (conn, from) => {
      await conn.groupSettingUpdate(from, 'not_announcement');
      await conn.sendMessage(from, { text: '🔊 Unmuted.' });
    },
    aliases: [],
    args: [],
    groupAdminRequired: true,
  },
  vv: {
    handler: async (conn, from, args, msg, sender) => {
      try {
        // ── .vv reveal ──
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId) throw new Error('❌ Reply to a view-once message.');

        const targetJid = args[0]
          ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net'
          : (msg.key.remoteJid || from);
        console.log(`[VV] target=${targetJid}`);

        const quotedMsg = {
          key: { remoteJid: msg.key.remoteJid || from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
          message: ctx.quotedMessage
        };
        const mediaType = ctx.quotedMessage?.imageMessage ? 'image' : ctx.quotedMessage?.videoMessage ? 'video' : ctx.quotedMessage?.audioMessage ? 'audio' : 'unknown';

        const quoted = ctx.quotedMessage;
        const mediaMsg = quoted.imageMessage || quoted.videoMessage || quoted.audioMessage;
        if (!mediaMsg) throw new Error('Unsupported media type.');

        try {
          await conn.rvo(quotedMsg, targetJid);
          console.log('[VV] rvo OK');
        } catch (rvoErr) {
          console.log('[VV] rvo fallback');
          const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
          if (!buffer) throw new Error('Download failed.');
          if (quoted.imageMessage) {
            await conn.sendMessage(targetJid, { image: buffer, caption: '📸 View-once revealed!' });
          } else if (quoted.videoMessage) {
            await conn.sendMessage(targetJid, { video: buffer, caption: '🎬 View-once revealed!' });
          } else if (quoted.audioMessage) {
            await conn.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/ogg' });
          }
        }
      } catch (err) {
        throw new Error('Failed to reveal view-once message 😭😭');
      }
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  monitor: {
    handler: async (conn, from, args, msg, sender) => {
      if (from.endsWith('@g.us')) throw new Error('❌ Only in DMs.');
      const _s = conn.state;
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const sub = args[0]?.toLowerCase();
      if (sub === 'list') {
        const list = [..._s.monitoredNumbers].map(j => `• ${j}`).join('\n') || 'None';
        return conn.sendMessage(from, { text: `📋 Monitored:\n${list}` });
      }
      if (sub === 'clear') {
        _s.monitoredNumbers.clear();
        saveSessionData(_s);
        return conn.sendMessage(from, { text: '✅ Cleared.' });
      }
      if (sub === 'remove' && args[1]) {
        _s.monitoredNumbers.delete(args[1]);
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ Stopped monitoring ${args[1]}.` });
      }
      const num = args[0]?.replace(/[^0-9]/g, '');
      if (!num) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const repliedJid = ctx?.participant;
        if (repliedJid) {
          const normalized = normalizeJid(repliedJid);
          _s.monitoredNumbers.add(normalized);
          saveSessionData(_s);
          return conn.sendMessage(from, { text: `✅ Monitoring *${normalized}*.` });
        }
        throw new Error('❌ Usage: .monitor <number> or reply.');
      }
      if (num === botJid.split('@')[0]) throw new Error('❌ Cannot monitor yourself.');
      try {
        const ids = await conn.findUserId(num + '@s.whatsapp.net');
        if (ids?.phoneNumber) {
          const normalized = normalizeJid(ids.phoneNumber);
          _s.monitoredNumbers.add(num);
          if (normalized !== num) _s.monitoredNumbers.add(normalized);
          if (ids.lid) {
            const lidNum = normalizeJid(ids.lid);
            if (lidNum && lidNum !== num && lidNum !== normalized) {
              _s.monitoredNumbers.add(lidNum);
              lidToPhone.set(lidNum, num);
            }
          }
        } else {
          throw new Error('Number not found.');
        }
      } catch (err) {
        _s.monitoredNumbers.add(num);
      }
      saveSessionData(_s);
      return conn.sendMessage(from, { text: `✅ Monitoring *${num}*.` });
    },
    aliases: ['mon'],
    args: ['<number> | list | remove <number> | clear'],
    groupAdminRequired: false,
  },
  aichat: {
    handler: async (conn, from, args) => {
      const _s = conn.state;
      const sub = args[0]?.toLowerCase();
      if (sub === 'key') {
        const key = args.slice(1).join(' ').trim();
        if (!key) throw new Error('❌ Usage: .aichat key <your_groq_api_key>');
        try {
          const test = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: 'hi' }]
            })
          });
          if (!test.ok) throw new Error(`API returned ${test.status}`);
        } catch (e) {
          throw new Error(`❌ Invalid API key: ${e.message}`);
        }
        _s.groqApiKey = key;
        saveSessionData(_s);
        return conn.sendMessage(from, { text: '✅ Groq API key set and verified.' });
      }
      if (sub === 'add' && args[1]) {
        const num = args[1].replace(/[^0-9]/g, '');
        if (!num) throw new Error('❌ Invalid number.');
        _s.aiTargets.add(num);
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ AI target added: ${num}` });
      }
      if (sub === 'remove' && args[1]) {
        const num = args[1].replace(/[^0-9]/g, '');
        _s.aiTargets.delete(num);
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ Removed AI target: ${num}` });
      }
      if (sub === 'list') {
        const users = [..._s.aiTargets].map(n => `• ${n}`).join('\n') || 'None';
        const groups = [..._s.aiGroups].map(j => `• ${j}`).join('\n') || 'None';
        const prompt = _s.aiSystemPrompt ? _s.aiSystemPrompt.slice(0, 60) + (_s.aiSystemPrompt.length > 60 ? '...' : '') : '(none)';
        return conn.sendMessage(from, { text: `🎯 AI targets:\n${users}\n\n👥 AI groups:\n${groups}\n\n🧠 System prompt: ${prompt}` });
      }
      if (sub === 'addgc') {
        if (!from.endsWith('@g.us')) throw new Error('❌ Send this in the target group.');
        _s.aiGroups.add(from);
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ AI replies enabled for this group. Tag or reply to me to chat.` });
      }
      if (sub === 'removegc' && args[1]) {
        _s.aiGroups.delete(args[1]);
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ Removed AI group.` });
      }
      if ((sub === 'system' || sub === 'prompt') && args.slice(1).join(' ').trim()) {
        _s.aiSystemPrompt = args.slice(1).join(' ').trim();
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ AI system prompt set.` });
      }
      if ((sub === 'system' || sub === 'prompt') && args[1] === 'clear') {
        _s.aiSystemPrompt = '';
        saveSessionData(_s);
        return conn.sendMessage(from, { text: `✅ AI system prompt cleared.` });
      }
      if (sub === 'clear' || sub === 'reset' || sub === 'allclear') {
        _s.groqApiKey = '';
        _s.aiTargets.clear();
        _s.aiGroups.clear();
        _s.aiSystemPrompt = '';
        _s.aiConversations.clear();
        saveSessionData(_s);
        return conn.sendMessage(from, { text: '✅ All AI data cleared (key, targets, groups, prompt, conversations).' });
      }
      if (sub === 'addgc') throw new Error('❌ Send .aichat addgc in the target group.');
      throw new Error('❌ Usage: .aichat key <groq_key> | add <num> | remove <num> | list | addgc | removegc <jid> | system <prompt> | clear');
    },
    aliases: ['ai'],
    args: ['optional'],
    groupAdminRequired: false,
  },
  id: {
    handler: async (conn, from, args, msg, sender) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || sender;
      await conn.sendMessage(from, { text: `🆔 ${target}` });
    },
    aliases: ['jid'],
    args: [],
    groupAdminRequired: false,
  },
  ghost: {
    handler: async (conn, from, args, msg) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const targetNum = args[0]?.replace(/[^0-9]/g, '') || '';
      let target = ctx?.participant || from;
      let text;
      if (targetNum && targetNum.length > 6) {
        target = targetNum + '@s.whatsapp.net';
        text = args.slice(1).join(' ') || '👻';
      } else {
        text = args.join(' ');
        if (!text && ctx?.stanzaId) text = '👻';
      }
      if (!text) throw new Error('❌ Usage: .ghost [number] <text> or reply.');
      const words = text.split(' ');
      const lines = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > 40) { lines.push(cur.trim()); cur = w; }
        else cur += ' ' + w;
      }
      if (cur.trim()) lines.push(cur.trim());
      if (!lines.length) lines.push('👻');
      const lineHeight = 36;
      const padY = 30;
      const w = 500;
      const h = Math.max(120, lines.length * lineHeight + padY * 2);
      const tspan = lines.map((l, i) => `<tspan x="${w/2}" dy="${i === 0 ? 0 : lineHeight}">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</tspan>`).join('');
      const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" rx="16" fill="#0f172a"/>
        <rect x="2" y="2" width="${w-4}" height="${h-4}" rx="14" fill="none" stroke="#334155" stroke-width="1"/>
        <text x="${w/2}" y="${padY + 24}" text-anchor="middle" fill="#e2e8f0" font-size="22" font-family="sans-serif">${tspan}</text>
        <text x="${w - 14}" y="${h - 10}" text-anchor="end" fill="#475569" font-size="11" font-family="monospace">👻 ghost</text>
      </svg>`;
      try {
        const imgBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        await conn.sendMessage(target, { image: imgBuf, viewOnceV2Extension: true });
      } catch (err) {
        console.error('[GHOST] image render failed, falling back:', err.message);
        await conn.sendMessage(target, { text, viewOnceV2Extension: true });
      }
    },
    aliases: [],
    args: ['optional'],
    groupAdminRequired: false,
  },
  tagall: {
    handler: async (conn, from, args, msg, sender, groupMeta) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ Only in groups.');
      const meta = groupMeta || await getGroupMeta(conn, from);
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const participants = meta.participants.filter(p => p.id !== botJid);
      const allJids = participants.map(p => p.id);
      const text = args.join(' ');
      const msgText = text ? `\n\n${text}` : '';
      await conn.sendMessage(from, { text: `👥 *CYPHER MD* is calling everyone!${msgText}`, mentions: allJids });
    },
    aliases: ['tag', 'everyone'],
    args: ['message (optional)'],
    groupAdminRequired: false,
  },
  antilink: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ Only in groups.');
      if (!isAdmin) throw new Error('❌ Not admin.');
      const _s = conn.state;
      const isBotAdmin = groupMeta?.participants?.some(p => {
        if (!p.admin) return false;
        const botPn = conn.user?.id || '';
        const botLid = conn.user?.lid || null;
        return areJidsSameUser(p.id, botPn) || (botLid && areJidsSameUser(p.id, botLid));
      });
      if (!isBotAdmin) throw new Error('❌ I must be admin.');
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        _s.antilinkEnabled.set(from, true);
        await conn.sendMessage(from, { text: '🛡️ Anti-link ON.' });
        return;
      }
      if (sub === 'off') {
        _s.antilinkEnabled.delete(from);
        _s.antilinkWarnings.delete(from);
        await conn.sendMessage(from, { text: '🛡️ Anti-link OFF.' });
        return;
      }
      if (sub === 'whitelist') {
        const action = args[1]?.toLowerCase();
        const domain = args[2]?.toLowerCase();
        if (action === 'add' && domain) {
          linkWhitelist.add(domain);
          await conn.sendMessage(from, { text: `✅ Added ${domain}.` });
        } else if (action === 'remove' && domain) {
          linkWhitelist.delete(domain);
          await conn.sendMessage(from, { text: `✅ Removed ${domain}.` });
        } else {
          const list = [...linkWhitelist].join('\n• ');
          await conn.sendMessage(from, { text: `📋 Whitelisted:\n• ${list}` });
        }
        return;
      }
      const status = _s.antilinkEnabled.has(from) ? 'ON' : 'OFF';
      await conn.sendMessage(from, { text: `🛡️ Anti-link is ${status}.` });
    },
    aliases: ['al'],
    args: ['on|off|whitelist'],
    groupAdminRequired: true,
  },
  antistatus: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ Only in groups.');
      if (!isAdmin) throw new Error('❌ Not admin.');
      const _s = conn.state;
      const meta = groupMeta || await getGroupMeta(conn, from);
      const participants = meta.participants.filter(p => !areJidsSameUser(p.id, botJid) && !p.admin);
      const allJids = participants.map(p => p.id);
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        _s.antistatusEnabled.set(from, true);
        await conn.sendMessage(from, {
          text: `🚫 *ANTI-STATUS ACTIVATED*\n\n` +
            `From now on, each member may tag this group in their status only 3 times per day.\n` +
            `On the 3rd violation, the member will be automatically removed from the group.\n` +
            `\n*Rules:*\n` +
            `• Tagging this group in your status counts as 1 violation.\n` +
            `• After 3 violations in one day → you are kicked.\n` +
            `• The counter resets daily.\n\n` +
            `Be responsible. 🙏`,
          mentions: allJids
        });
        saveSessionData(_s);
        return;
      }
      if (sub === 'off') {
        _s.antistatusEnabled.delete(from);
        _s.antistatusCounts.clear();
        await conn.sendMessage(from, { text: '🚫 Anti-status OFF.' });
        saveSessionData(_s);
        return;
      }
      const status = _s.antistatusEnabled.has(from) ? 'ON' : 'OFF';
      await conn.sendMessage(from, { text: `🚫 Anti-status is ${status}.` });
    },
    aliases: ['as'],
    args: ['on|off'],
    groupAdminRequired: true,
  },
  help: {
    handler: async (conn, from) => {
      const helpText = `🤖 *Welcome to CYPHER MD* 🤖\n\n` +
        `Hi there! I'm CYPHER MD, a powerful WhatsApp bot crafted by *CYPHER.DEV*. ` +
        `Think of me as your personal assistant inside WhatsApp — I can manage groups, ` +
        `download media, monitor activity, reveal view-once messages, and much more. ` +
        `Below is a complete tour of everything I can do, how to use each command, ` +
        `and what to expect.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🔰 *GENERAL COMMANDS*\n\n` +
        `• *.ping* / *.p*\n  Checks if I'm online and responding. If I'm alive, I'll reply with "Pong!" — ` +
        `a quick way to test my connection.\n\n` +
        `• *.time*\n  Shows the current server time (the machine I'm running on). Useful if you're ` +
        `curious about my system clock.\n\n` +
        `• *.runtime* / *.uptime*\n  Tells you how long I've been running since my last restart. ` +
        `Handy for knowing if I just rebooted or if I've been online for days.\n\n` +
        `• *.stats*\n  Displays command usage statistics — how many commands have been attempted ` +
        `and how many succeeded. Gives you an idea of how active I've been.\n\n` +
        `• *.clearsession*\n  Deletes ALL data (auth sessions, settings, monitored numbers, ` +
        `AI targets, group lists). Resets the bot to a completely clean state. ` +
        `⚠️ You will need to re-pair after running this.\n\n` +
        `• *.testimg*\n  Tests the media pipeline by sending a simple test image. ` +
        `Useful to verify that media uploads are working correctly.\n\n` +
        `• *.play* / *.song* / *.yt* <name or URL>\n  Downloads audio from YouTube. ` +
        `Provide a song name to search or a direct YouTube URL. The audio is sent as an MP3.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛠️ *UTILITY COMMANDS*\n\n` +
        `• *.reverse* / *.r <text>*\n  Reverses the text you provide. Example: *.reverse hello* → "olleh". ` +
        `Works with any text. No weird characters will break it.\n\n` +
        `• *.quote*\n  Replies to a message to quote it with style. Not to be confused with the "?" ` +
        `view-once trick — this is just a fancy quote bot. Usage: reply to any message with .quote.\n\n` +
        `• *.bio*\n  Shows your current WhatsApp bio/status text. Just send .bio in any chat and I'll ` +
        `fetch the status of the person you reply to, or your own if no reply.\n\n` +
        `• *.getpp* [@user]\n  Gets the profile picture of a user. Reply to their message or mention ` +
        `them. If no user is specified, I'll grab your own profile picture.\n\n` +
        `• *.sticker* / *.s*\n  Converts an image or video into a WhatsApp sticker. Reply to an image ` +
        `or video with .sticker. Images become static stickers, short videos become animated ones. ` +
        `⚠️ Works best with images under 1MB.\n\n` +
        `• *.toimage* / *.ti*\n  Converts a sticker back into a regular image. Reply to any sticker ` +
        `with .toimage. Animated stickers will become a static image (first frame).\n\n` +
        `• *.id* / *.jid*\n  Shows the JID (WhatsApp ID) of a user or the current chat. Reply to a ` +
        `message to see that user's JID, or just send .id in a chat to see the chat JID. Useful ` +
        `for debugging or if you need to reference someone's exact ID.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👁️ *VIEW-ONCE & MONITORING*\n\n` +
        `• *.monitor* / *.mon <number>*\n  Adds a phone number to my watchlist. I will silently save ` +
        `every message that person sends in any group we share — including view-once media, text, images, and captions. ` +
        `View-once messages are forwarded to you immediately when captured. ` +
        `Deleted/recalled messages are also forwarded automatically. How to use:\n` +
        `  - *.monitor 2348012345678* — watch a number\n` +
        `  - *.monitor list* — show all monitored numbers\n` +
        `  - *.monitor remove 2348012345678* — stop watching\n` +
        `  - *.monitor clear* — remove all\n  ` +
        `⚠️ Only works in your message yourself interface. Cannot monitor my own number.\n\n` +
        `• *.vv* (reply to a view-once or recalled message)\n  Reveals a view-once message or a ` +
        `deleted message that was captured by .monitor. Reply to the view-once stub or the ` +
        `[Media] placeholder and I'll extract the content. How it handles the revealed content ` +
        `depends on whether you specify a target number after .vv — if not, it sends the reveal ` +
        `to the current chat. ⚠️ Only works if the VV has already been delivered with content ` +
        `(not all VVs arrive as stubs).\n\n` +
        `• *???* (reply to a view-once message)\n  A simpler, more private alternative to .vv. ` +
        `Reply to ANY view-once message with ??? (three question marks, no dot) and I'll extract ` +
        `the content and send it directly to YOUR DM — even if the VV is in a group chat. ` +
        `The sender never knows. If the VV is a stub (no content yet), I'll silently request ` +
        `a re-send and forward it to your DM when it arrives. ⚠️ Only works for you (the bot ` +
        `owner) — others can't use this.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛡️ *GROUP MANAGEMENT (Admin only)*\n\n` +
        `These commands only work in groups where I'm an admin, and only for you:\n\n` +
        `• *.kick* — Remove a member from the group. Reply to their message or use .kick @mention.\n` +
        `• *.warn* — Issue a warning to a member. 3 warnings = auto-kick.\n` +
        `• *.unwarn* — Remove a warning from a member. Resets their warning count.\n` +
        `• *.ban* — Ban a member. Alias for remove. Same as .kick.\n` +
        `• *.delete* — Delete a message I sent. Reply to my message with .delete.\n` +
        `• *.mute* — Mute a member (restrict from sending messages in the group).\n` +
        `• *.unmute* — Unmute a previously muted member.\n` +
        `• *.antilink on|off* — Toggle anti-link protection. When on, I'll delete messages ` +
        `containing links and warn the sender. 3 warnings = auto-kick. '.antilink' toggles ` +
        `for the current group only.\n` +
        `• *.antistatus on|off* — Toggle anti-status protection. Members who tag this group ` +
        `in their WhatsApp status get 3 warnings per day; on the 3rd they are auto-kicked.\n` +
        `• *.tagall* / *.tag* — Mention all group members in a message. Use with a message ` +
        `to broadcast an announcement.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🤖 *AI CHAT*\n\n` +
        `• *.aichat key <groq_key>*\n  Sets a Groq API key for AI chat features. ` +
        `The key is verified immediately — if it's invalid, you'll get an error. ` +
        `Once set, the bot can respond to messages from target numbers.\n\n` +
        `• *.aichat add <number>*\n  Add a phone number as an AI target. When that ` +
        `person sends any message, the bot will auto-reply using Groq AI.\n\n` +
        `• *.aichat remove <number>*\n  Remove a number from AI targets.\n\n` +
        `• *.aichat list*\n  Show all AI targets, AI-enabled groups, and the current ` +
        `system prompt.\n\n` +
        `• *.aichat system <prompt>*\n  Set a custom system prompt for the AI. ` +
        `This changes the bot's personality and behavior in all AI replies.\n\n` +
        `• *.aichat system clear*\n  Clears the custom system prompt.\n\n` +
        `• *.aichat addgc*\n  Send this in a group to enable AI replies there. ` +
        `When someone tags or replies to the bot, it will respond with Groq AI.\n\n` +
        `• *.aichat removegc <jid>*\n  Remove a group from AI-enabled groups.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👻 *GHOST COMMAND*\n\n` +
        `• *.ghost [number] <text>*\n  Sends a message as a view-once (disappearing) ` +
        `message. If a number is provided, it sends to that number; otherwise ` +
        `it sends to the current chat.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💡 *TIPS & NOTES*\n\n` +
        `• All commands start with a dot (.). The only exception is ??? which is a bare command.\n` +
        `• You can use aliases — e.g. .p for .ping, .mon for .monitor, .s for .sticker.\n` +
        `• Most commands work in both DMs and groups unless stated otherwise.\n` +
        `• .antilink, .tagall, .kick, .warn, etc. only work in groups and require me to be admin.\n` +
        `• .monitor and ??? are owner-only commands.\n` +
        `• View-once reveal (???) sends the content to your DM silently — no trace in the original chat.\n` +
        `• If a command doesn't work, make sure you're using the correct format and that I have ` +
        `the necessary permissions (admin in groups).\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Thank you for using CYPHER MD! 🙏\n\n` +
        `I hope I serve you well. If you encounter any issues or have feature requests, ` +
        `please reach out to my creator, *CYPHER.DEV*. Enjoy the ride! 🚀\n\n` +
        `*— >CYPHER MD, built by CYPHER.DEV*`;
      await conn.sendMessage(from, { text: helpText });
    },
    aliases: ['h'],
    args: [],
    groupAdminRequired: false,
  },
  play: {
    handler: async (conn, from, args) => {
      if (!args.length) throw new Error('❌ Usage: .play <song name or YouTube URL>');
      const query = args.join(' ');
      let url = query;
      let title = query;

      try {
        if (!query.startsWith('http')) {
          const searchResult = await ytSearch(query);
          if (!searchResult?.videos?.length) throw new Error('❌ No results found');
          url = searchResult.videos[0].url;
          title = searchResult.videos[0].title;
        }

        await conn.sendMessage(from, { text: `⏳ Downloading *${title.replace(/\*/g, '')}*...` });

        const cookiesSrc = process.env.COOKIES_PATH || '/etc/secrets/cookies.txt';
        const cookiesFile = '/tmp/yt-cookies.txt';

        const getCookiesPath = () => {
          if (fs.existsSync(cookiesSrc)) {
            try {
              fs.copyFileSync(cookiesSrc, cookiesFile);
              return cookiesFile;
            } catch (_) { /* fallthrough */ }
          }
          return null;
        };

        const buildArgs = (url, useCookies) => {
          const a = ['--no-check-certificates', '--no-warnings', '--quiet',
            '--extractor-args', 'youtube:player_client=android_vr,ios_downgraded',
            '--force-ipv4', '-S', 'res:360', '-o', '-'];
          const cp = useCookies ? getCookiesPath() : null;
          if (cp) a.push('--cookies', cp);
          const proxy = process.env.YT_PROXY;
          if (proxy) a.push('--proxy', proxy);
          a.push(url);
          return a;
        };

        const exec = (args, useCookies) => new Promise((resolve, reject) => {
          execFile(ytDlpPath, args, { maxBuffer: 100 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
            if (err && !stdout?.length) {
              const msg = stderr?.toString()?.split('\n')?.filter(l => l && !l.includes('WARNING'))?.pop() || err.message;
              reject({ error: new Error(msg), args, useCookies, stderr: stderr?.toString() });
            } else {
              resolve(stdout);
            }
          });
        });

        if (fs.existsSync(cookiesSrc)) {
          const stat = fs.statSync(cookiesSrc);
          console.log('[play] cookies file size:', stat.size, 'bytes');
        }

        let buffer;

        for (const useCookies of [true, false]) {
          const cookieFileExists = fs.existsSync(cookiesSrc);
          if (useCookies && !cookieFileExists) {
            console.log('[play] no cookies file at', cookiesSrc);
            continue;
          }
          console.log('[play] attempt useCookies=%s cookiesExist=%s', useCookies, cookieFileExists);
          const a = buildArgs(url, useCookies);
          try {
            buffer = await exec(a, useCookies);
            console.log('[play] success with useCookies=%s', useCookies);
            break;
          } catch (e) {
            const msg = e.error?.message || '';
            console.log('[play] failed useCookies=%s error=%s', useCookies, msg);
            const isRetryable = /sign in|confirm you.*bot|requested format.*not available/i.test(msg);
            if (!isRetryable || !useCookies) throw e.error;
          }
        }

        if (buffer.length === 0) throw new Error('Empty audio');
        await conn.sendMessage(from, { audio: buffer, mimetype: audioMime(buffer), ptt: false });
      } catch (err) {
        const ytErr = err.message || '';
        console.log('[play] yt-dlp failed, trying cobalt...');
        try {
          const cobaltRes = await fetch(process.env.COBALT_API || 'https://api.cobalt.tools/', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, downloadMode: 'audio', audioFormat: 'best', filenameStyle: 'basic' }),
            signal: AbortSignal.timeout(30000)
          });
          if (!cobaltRes.ok) throw new Error(`Cobalt API ${cobaltRes.status}`);
          const data = await cobaltRes.json();
          if (data.status === 'tunnel' || data.status === 'redirect') {
            const audioRes = await fetch(data.url, { signal: AbortSignal.timeout(60000) });
            if (!audioRes.ok) throw new Error(`Cobalt download ${audioRes.status}`);
            const audioBuf = Buffer.from(await audioRes.arrayBuffer());
            if (audioBuf.length > 0) {
              await conn.sendMessage(from, { audio: audioBuf, mimetype: audioMime(audioBuf), ptt: false });
              return;
            }
          }
          throw new Error('Cobalt: no audio returned');
        } catch (cobaltErr) {
          console.log('[play] cobalt also failed:', cobaltErr.message);
          throw new Error(`❌ Playback failed: ${ytErr}`);
        }
      }
    },
    aliases: ['song', 'yt', 'audio'],
    args: ['<song name or URL>'],
    groupAdminRequired: false,
  },
  menu: {
    handler: async (conn, from) => {
      const menuText = `*📋 CYPHER MD Commands*\n\n` +
        `🏓 .ping / .p\n🕐 .time\n🔄 .reverse / .r <text>\n💬 .quote\n📝 .bio\n🖼️ .getpp [@user]\n🎭 .sticker / .s\n🖼️ .toimage / .ti\n⏱️ .runtime / .uptime\n📊 .stats\n🧹 .clearsession\n🧪 .testimg\n🎵 .play / .song <name>\n🆔 .id / .jid\n\n` +
        `🤖 *AI & MEDIA*\n👻 .ghost [num] <text>\n📸 .vv (reply to VV)\n❓ ??? (reply to VV → DM)\n👁️ .monitor / .mon <number>\n\n` +
        `🤖 *AI CHAT*\n.aichat key <groq_key>\n.aichat add <num>\n.aichat remove <num>\n.aichat list\n.aichat system <prompt>\n.aichat addgc (in group)\n\n` +
        `🛡️ *GROUP (Admin)*\n.kick .warn .unwarn .ban .delete .mute .unmute\n.antilink on|off .antistatus on|off .tagall / .tag\n\n` +
        `_Send .help for a detailed guide_`;
      await conn.sendMessage(from, { text: menuText });
    },
    aliases: ['m'],
    args: [],
    groupAdminRequired: false,
  }
};

const aliasMap = new Map();
for (const [cmdName, cmd] of Object.entries(commands)) {
  aliasMap.set(cmdName, cmdName);
  for (const alias of cmd.aliases) aliasMap.set(alias, cmdName);
}

async function executeCommand(conn, from, commandName, args, msg, sender, groupMeta, isAdmin, botJid) {
  const _s = conn.state;
  _s.totalCommandsAttempted++;
  const cmd = commands[commandName];
  if (!cmd) { console.error(`[CMD] Command "${commandName}" not found in registry`); return false; }
  console.log(`[CMD] Executing "${commandName}" args=[${args.join(', ')}] admin=${isAdmin}`);
  try {
    if (cmd.args.length > 0 && !args.length && cmd.args[0] !== 'optional') {
      throw new Error(`❌ Missing argument: ${cmd.args[0]}`);
    }
    await cmd.handler(conn, from, args, msg, sender, groupMeta, isAdmin, botJid);
    _s.totalCommandsSucceeded++;
    console.log(`[CMD] "${commandName}" succeeded`);
    return true;
  } catch (err) {
    console.error(`[CMD] "${commandName}" error:`, err.message);
    console.error(`[CMD] Stack:`, err.stack);
    await conn.sendMessage(from, { text: err.message || '❌ Error.' });
    return false;
  }
}

function addGroupIfNew(groupJid) {
  if (!userGroups.has(groupJid)) userGroups.add(groupJid);
  currentGroups.add(groupJid);
}
function removeGroup(groupJid) { currentGroups.delete(groupJid); }

// ────────────────────────────────────────────────────────────────────
// Main bot start function
// ────────────────────────────────────────────────────────────────────
async function startBot(phoneNumber, socket, _useDbIgnored, preloadedState, preloadedSaveCreds) {
  if (isConnecting.get(phoneNumber)) {
    return;
  }
  isConnecting.set(phoneNumber, true);

  let state, saveCreds;
  if (preloadedState) {
    state = preloadedState;
    saveCreds = preloadedSaveCreds || (() => {});
  } else {
    const result = await storage.useAuthState(phoneNumber);
    state = result.state;
    saveCreds = result.saveCreds;
  }
  const { version } = await fetchLatestWaWebVersion();

  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Desktop', ''],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    shouldIgnoreViewOnce: false
  });

  connections.set(phoneNumber, conn);
  const sessionState = createSessionState(phoneNumber);
  sessions.set(phoneNumber, sessionState);
  conn.state = sessionState;
  loadSessionData(sessionState);
  let welcomeTimeout = null;
  let isConnected = false;
  const ownerNumber = phoneNumber.replace(/\D/g, '');

  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[CONN] closed reason=${reason}`);
      isConnected = false;
      if (welcomeTimeout) clearTimeout(welcomeTimeout);
      await cleanupSocket(conn);
      connections.delete(phoneNumber);
      isConnecting.delete(phoneNumber);
      if (reconnectTimers.has(phoneNumber)) {
        clearTimeout(reconnectTimers.get(phoneNumber));
        reconnectTimers.delete(phoneNumber);
      }
      if (reason === 428) {
        const count = (consecutive428.get(phoneNumber) || 0) + 1;
        consecutive428.set(phoneNumber, count);
        if (count >= 3) {
          await deleteAuthFolder(phoneNumber);
          reconnectAttempts.delete(phoneNumber);
          consecutive428.delete(phoneNumber);
        }
      } else {
        consecutive428.delete(phoneNumber);
      }
      if (reason === DisconnectReason.connectionReplaced) {
        console.log(`[CONN] ${phoneNumber} connectionReplaced — stepping aside, session stays in shared storage`);
        reconnectAttempts.delete(phoneNumber);
        return;
      }
      if (reason === 408 || reason === 503) {
        console.log(`[CONN] ${phoneNumber} ${reason} — transient stream error, reconnecting`);
        // Do not purge the session — 408/503 are temporary network issues
      }
      if (reason === 515) lastStream515At.set(phoneNumber, Date.now());
      if (reason === DisconnectReason.loggedOut) {
        const recent515 = Date.now() - (lastStream515At.get(phoneNumber) || 0) < 30000;
        if (recent515) {
          scheduleReconnect(phoneNumber, socket);
        } else {
          console.log(`[CONN] loggedOut, purging session`);
          if (socket) socket.emit('logged-out', 'Logged out');
          await deleteAuthFolder(phoneNumber);
          reconnectAttempts.delete(phoneNumber);
        }
      } else {
        scheduleReconnect(phoneNumber, socket);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      if (socket) socket.emit('connected', 'Connected');
      reconnectAttempts.delete(phoneNumber);
      isConnecting.delete(phoneNumber);
      lastConnectedAt.set(phoneNumber, Date.now());
      if (conn.user?.lid) {
        const lidNorm = normalizeJid(conn.user.lid);
        lidToPhone.set(lidNorm, ownerNumber);
      }
      // Debug: log ws events
      if (conn.ws && !conn.ws._dbgAttached) {
        conn.ws._dbgAttached = true;
      }
      consecutive428.delete(phoneNumber);
      if (reconnectTimers.has(phoneNumber)) {
        clearTimeout(reconnectTimers.get(phoneNumber));
        reconnectTimers.delete(phoneNumber);
      }
      if (socket && !connectedNumbers.has(phoneNumber)) {
        welcomeTimeout = setTimeout(async () => {
          if (connections.get(phoneNumber) === conn && !connectedNumbers.has(phoneNumber)) {
            try {
              await conn.sendMessage(phoneNumber + '@s.whatsapp.net', {
                text: `WELCOME TO CYPHER MD 👑\n THE BOT THAT MAKES A DIFFERENCE\n`
              });
              connectedNumbers.add(phoneNumber);
            } catch (_) {}
          }
          welcomeTimeout = null;
        }, 10000);
      }
      console.log(`[CONN] ✅ ${phoneNumber} ready — listening for commands`);
    }
  });

  conn.ev.on('creds.update', saveCreds);

  // ── Message handler ──
  conn.ev.on('messages.upsert', async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg?.key) return;
    const _s = conn.state;

    // ── Fast path: owner commands (no checks) ──
    const normalizedContent = normalizeMessageContent(msg.message);
    const body = normalizedContent?.conversation || normalizedContent?.extendedTextMessage?.text || '';
    if (body.startsWith('.')) {
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const sender = isGroup ? (msg.key.participant || msg.participant || from) : from;
      const senderNorm = normalizeJid(sender);
      const isOwner = (msg.key.fromMe) || (senderNorm === ownerNumber);
      if (isOwner) {
        const args = body.slice(1).trim().split(/\s+/).filter(a => a.length);
        const rawCmd = args.shift().toLowerCase();
        const cmdName = aliasMap.get(rawCmd);
        if (cmdName) {
          if (isGroup) addGroupIfNew(from);
          const botJid = conn.user?.id || conn.user?.lid || '';
          let groupMeta = null;
          let isUserAdmin = false;
          let isBotAdmin = false;
          if (isGroup && commands[cmdName]?.groupAdminRequired) {
            try {
              groupMeta = await getGroupMeta(conn, from);
              const botPn = conn.user?.id || '';
              const botLid = conn.user?.lid || null;
              const checkAdmin = (p) => {
                if (!p.admin) return false;
                return areJidsSameUser(p.id, botPn) || (botLid && areJidsSameUser(p.id, botLid));
              };
              isBotAdmin = groupMeta.participants.some(checkAdmin);
              isUserAdmin = isBotAdmin;
            } catch (err) {
              console.error(`[CMD] Permission check failed:`, err.message);
              await conn.sendMessage(from, { text: '❌ Could not verify permissions.' });
              return;
            }
          }
          await executeCommand(conn, from, cmdName, args, msg, sender, groupMeta, isUserAdmin, botJid);
          return;
        }
        console.log(`[CMD] Unknown command "${rawCmd}"`);
        return;
      }
    }

    // ── ??? reveal view-once to owner DM ──
    if (body === '???') {
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const sender = isGroup ? (msg.key.participant || msg.participant || from) : from;
      if ((msg.key.fromMe) || (normalizeJid(sender) === ownerNumber)) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (ctx?.stanzaId && ctx?.quotedMessage) {
          const isVV = !!(ctx.quotedMessage?.viewOnceMessageV2 || ctx.quotedMessage?.viewOnceMessage || ctx.quotedMessage?.viewOnceMessageV2Extension
            || ctx.quotedMessage?.imageMessage || ctx.quotedMessage?.videoMessage || ctx.quotedMessage?.audioMessage);
          if (!isVV) return;
          const ownerJid = ownerNumber + '@s.whatsapp.net';
          const quotedKey = {
            key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
            message: ctx.quotedMessage
          };
          const innerMsg = ctx.quotedMessage?.viewOnceMessageV2?.message
            || ctx.quotedMessage?.viewOnceMessage?.message
            || ctx.quotedMessage?.viewOnceMessageV2Extension?.message
            || ctx.quotedMessage;
          if (innerMsg && (innerMsg.imageMessage || innerMsg.videoMessage || innerMsg.audioMessage)) {
            try {
              const buffer = await downloadMediaMessage(quotedKey, 'buffer', {}, { logger: pino({ level: 'silent' }) });
              if (buffer) {
                if (innerMsg.imageMessage) await conn.sendMessage(ownerJid, { image: buffer, caption: '👁️ VV revealed' });
                else if (innerMsg.videoMessage) await conn.sendMessage(ownerJid, { video: buffer, caption: '👁️ VV revealed' });
                else if (innerMsg.audioMessage) await conn.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/ogg' });
              }
            } catch (e) {
              console.error('[???] download failed:', e.message);
            }
            return;
          }
          await conn.sendMessage(from, { text: '?' }, {
            quoted: { key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: { conversation: '' } }
          });
          pendingReveals.add(ctx.stanzaId);
          console.log('[???] "?" sent for stub, waiting for re-send');
        }
        return;
      }
    }

    // ── "?" quotes: just pass through — the re-sent VV is caught below ──
    if (msg.key?.fromMe && body === '?') {
      console.log('[VV] "?" sent, waiting for re-sent VV from target');
      return;
    }

    // ── View-once re-send interception (handles "???") ──
    if (msg?.key && !msg.key.fromMe && pendingReveals.has(msg.key.id)) {
      pendingReveals.delete(msg.key.id);
      const remoteJid = msg.key.remoteJid;
      const hasContent = !!(msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2Extension);
      console.log('[VV] re-send for key=%s hasContent=%s', msg.key.id, hasContent);
      if (hasContent) {
        const ownerJid = ownerNumber + '@s.whatsapp.net';
        try {
          await conn.rvo(msg, ownerJid);
          console.log('[VV] rvo OK');
        } catch (rvoErr) {
          console.log('[VV] rvo fallback');
          try {
            const inner = msg.message?.viewOnceMessageV2?.message
              || msg.message?.viewOnceMessage?.message
              || msg.message?.viewOnceMessageV2Extension?.message;
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            if (buffer && inner?.imageMessage) await conn.sendMessage(ownerJid, { image: buffer, caption: '👀👀 you asked for this view once' });
            else if (buffer && inner?.videoMessage) await conn.sendMessage(ownerJid, { video: buffer, caption: '👀👀 you asked for this view once' });
            else if (buffer && inner?.audioMessage) await conn.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/ogg' });
          } catch (_) {}
        }
      }
      return;
    }

    // Non-owner: protocol messages (delete detection)
    const proto = msg?.message?.protocolMessage;
    if (proto?.type === 0) {
      const revokedKey = proto.key;
      const stored = _s.messageStore.get(revokedKey.id);
      if (stored) {
        const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const caption = `🔍 Deleted from ${stored.displayNumber || stored.fromJid.split('@')[0]}: ${stored.content}`;
        try {
          if (stored.mediaBuffer && stored.mediaType === 'image') {
            await sendImageViaFile(conn, botJid, stored.mediaBuffer, caption);
          } else {
            await conn.sendMessage(botJid, { text: caption });
          }
        } catch (_) {}
        _s.messageStore.delete(revokedKey.id);
      }
      return;
    }

    // Dedup
    if (!msg?.message) return;
    if (processedMessages.has(msg.key.id)) { return; }
    processedMessages.add(msg.key.id);

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    if (isGroup) addGroupIfNew(from);
    const sender = isGroup ? (msg.key.participant || msg.participant || from) : from;
    // JIDS2 removed
    if (type !== 'notify') { return; }
    if (msg.key?.fromMe && !body.startsWith('.')) { return; }

    const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';

    // ── AI auto-reply for targets and groups ──
    if (_s.groqApiKey && (_s.aiTargets.size || (_s.aiGroups.size && isGroup))) {
      const norm = normalizeJid(sender);
      let shouldAI = _s.aiTargets.has(norm) || (lidToPhone.has(norm) && _s.aiTargets.has(lidToPhone.get(norm)));
      if (!shouldAI && isGroup && _s.aiGroups.has(from)) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const mentioned = ctx?.mentionedJid || [];
        const botNorm = normalizeJid(botJid);
        const botLid = conn.user?.lid ? normalizeJid(conn.user.lid) : null;
        shouldAI = mentioned.some(j => normalizeJid(j) === botNorm || (botLid && normalizeJid(j) === botLid)) || normalizeJid(ctx?.participant) === botNorm || (botLid && normalizeJid(ctx?.participant) === botLid);
      }
      if (!shouldAI && sender.endsWith('@lid') && !lidToPhone.has(norm)) {
        try {
          const ids = await conn.findUserId(sender);
          if (ids?.phoneNumber) {
            const phoneNorm = normalizeJid(ids.phoneNumber);
            lidToPhone.set(norm, phoneNorm);
            lidToPhone.set(phoneNorm, norm);
            shouldAI = _s.aiTargets.has(phoneNorm);
            saveSessionData(_s);
          }
        } catch (_) {}
      }
      if (shouldAI && body) {
        try {
          const convKey = isGroup ? `${from}:${sender}` : sender;
          const history = _s.aiConversations.get(convKey) || [];
          history.push({ role: 'user', content: body });
          if (history.length > 20) history.splice(0, history.length - 20);
          const messages = _s.aiSystemPrompt
            ? [{ role: 'system', content: _s.aiSystemPrompt }, ...history]
            : history;
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${_s.groqApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages
            })
          });
          const json = await res.json();
          const reply = json?.choices?.[0]?.message?.content || '(no response)';
          history.push({ role: 'assistant', content: reply });
          _s.aiConversations.set(convKey, history);
          await conn.sendMessage(from, { text: reply }, { quoted: msg });
        } catch (e) {
          console.error('[AI] error:', e.message);
          await conn.sendMessage(from, { text: '⚠️ AI error: ' + e.message }, { quoted: msg });
        }
      }
      if (shouldAI) return;
    }

    // Monitor deleted messages
    if (_s.monitoredNumbers.size) {
      let norm = normalizeJid(sender);
      let match = norm && _s.monitoredNumbers.has(norm);
      if (!match && norm) {
        const viaCache = lidToPhone.has(norm) && _s.monitoredNumbers.has(lidToPhone.get(norm));
        if (viaCache) match = true;
        if (!match && sender.endsWith('@lid')) {
          try {
            const [result] = await conn.onWhatsApp(norm);
            if (result?.exists && result.jid) {
              const resolved = normalizeJid(result.jid);
              if (resolved !== norm) {
                lidToPhone.set(norm, resolved);
                lidToPhone.set(resolved, norm);
              }
              match = _s.monitoredNumbers.has(resolved) || _s.monitoredNumbers.has(norm);
              if (match && resolved !== norm) {
                _s.monitoredNumbers.add(resolved);
              }
            }
          } catch (_) {}
        }
      }
      if (match) {
        const displayNumber = lidToPhone.get(norm) || norm;
        const storeEntry = { content: body || '[media]', fromJid: from, displayNumber, timestamp: Date.now() };
        if (normalizedContent?.imageMessage) {
          storeEntry.content = normalizedContent.imageMessage.caption || '[Image]';
          try {
            const stream = await downloadMediaMessage(msg, 'stream', { logger: conn.logger });
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const raw = Buffer.concat(chunks);
            storeEntry.mediaBuffer = await sharp(raw).jpeg({ quality: 90 }).toBuffer();
            storeEntry.mediaType = 'image';
          } catch (_) {}
        }
        _s.messageStore.set(msg.key.id, storeEntry);
        if (_s.messageStore.size > 5000) _s.messageStore.delete(_s.messageStore.keys().next().value);
        // Auto-forward view-once content from monitored numbers immediately
        const vvRaw = msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2Extension;
        if (vvRaw) {
          const owner = ownerNumber + '@s.whatsapp.net';
          console.log(`[MON] VV from monitored ${norm}, forwarding immediately`);
          try {
            await conn.rvo(msg, owner);
            console.log('[MON] VV forwarded via rvo');
          } catch (e) {
            console.log('[MON] rvo failed, direct download', e.message);
            try {
              const inner = vvRaw?.message;
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                logger: pino({ level: 'silent' }),
                reuploadRequest: conn.updateMediaMessage
              });
              if (buffer && inner?.imageMessage) await conn.sendMessage(owner, { image: buffer, caption: `👁️ VV from ${displayNumber}` });
              else if (buffer && inner?.videoMessage) await conn.sendMessage(owner, { video: buffer, caption: `👁️ VV from ${displayNumber}` });
              else if (buffer && inner?.audioMessage) await conn.sendMessage(owner, { audio: buffer, mimetype: 'audio/ogg' });
            } catch (e2) {
              console.log('[MON] VV download failed', e2.message);
            }
          }
        }
      }
    }

    // Anti-link
    if (!msg.key?.fromMe && isGroup && _s.antilinkEnabled.has(from) && hasLink(body)) {
      if (normalizeJid(sender) === ownerNumber || groupMetaCache.get(from)?.metadata?.participants?.some(p => p.admin && areJidsSameUser(p.id, sender))) {
        return;
      }
      try {
        await conn.sendMessage(from, { delete: { remoteJid: from, id: msg.key.id, participant: msg.key.participant } });
        const key = `${from}:${sender}`;
        const count = (_s.antilinkWarnings.get(key) || 0) + 1;
        _s.antilinkWarnings.set(key, count);
        if (count >= LINK_WARN_LIMIT) {
          await conn.groupParticipantsUpdate(from, [sender], 'remove');
          await conn.sendMessage(from, { text: `🔨 Kicked @${sender.split('@')[0]} for links OTILO!`, mentions: [sender] });
          _s.antilinkWarnings.delete(key);
        } else {
          await conn.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} no links! (${count}/${LINK_WARN_LIMIT})`, mentions: [sender] });
        }
      } catch (_) {}
      return;
    }

    // Anti-status
    if (isGroup && _s.antistatusEnabled.has(from) && msg.message?.groupStatusMentionMessage) {
      const today = new Date().toISOString().slice(0, 10);
      const statKey = `${from}:${sender}:${today}`;
      const count = (_s.antistatusCounts.get(statKey) || 0) + 1;
      _s.antistatusCounts.set(statKey, count);
      if (count >= 3) {
        try {
          await conn.groupParticipantsUpdate(from, [sender], 'remove');
          await conn.sendMessage(from, { text: `🔨 @${sender.split('@')[0]} kicked for tagging the group in status 3 times today OTILO!`, mentions: [sender] });
        } catch (_) {}
        _s.antistatusCounts.delete(statKey);
      } else {
        const left = 3 - count;
        await conn.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} do not tag this group in your status! (${count}/3) — ${left} ${left === 1 ? 'mention' : 'mentions'} left today.`, mentions: [sender] });
      }
      saveSessionData(_s);
      return;
    }

    // Anti-spam
    if (!msg.key?.fromMe && body && isSpamming(sender)) {
      try {
        if (!isGroup) {
          await conn.blockUser(sender, 'block');
          await conn.sendMessage(botJid, { text: `⚠️ Blocked spammer: ${sender.split('@')[0]}` });
        } else {
          const spamKey = `${from}:${sender}:spam`;
          const count = (_s.antilinkWarnings.get(spamKey) || 0) + 1;
          _s.antilinkWarnings.set(spamKey, count);
          if (count >= LINK_WARN_LIMIT) {
            await conn.groupParticipantsUpdate(from, [sender], 'remove');
            await conn.sendMessage(from, { text: `🔨 Kicked @${sender.split('@')[0]} for spamming OTILO!`, mentions: [sender] });
            _s.antilinkWarnings.delete(spamKey);
          } else {
            await conn.sendMessage(from, { text: `🐢 @${sender.split('@')[0]} slow down!`, mentions: [sender] });
          }
        }
      } catch (_) {}
      return;
    }
  });

  // Group participants update
  conn.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
    groupMetaCache.delete(id);
    addGroupIfNew(id);
    if (action === 'remove' && participants.includes(botJid)) removeGroup(id);
    if (action === 'add') {
      for (const p of participants) {
        if (p === botJid) continue;
        try {
          await conn.sendMessage(id, { text: `👋 Welcome @${p.split('@')[0]}!`, mentions: [p] });
        } catch (_) {}
      }
    } else if (action === 'remove') {
      for (const p of participants) {
        if (p === botJid) continue;
        try {
          await conn.sendMessage(id, { text: `🚪 @${p.split('@')[0]} left.`, mentions: [p] });
        } catch (_) {}
      }
    }
  });
}

// ── Quick cache pruning (every 5 min) ──
setInterval(() => {
  const cutoff = Date.now() - 60000;
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const [key, val] of spamTracker) {
    const recent = val.filter(t => t > cutoff);
    if (recent.length) spamTracker.set(key, recent); else spamTracker.delete(key);
  }
  for (const [key, val] of groupMetaCache) {
    if (Date.now() - val.ts > GROUP_CACHE_TTL) groupMetaCache.delete(key);
  }
  const expire = Date.now() - 86400000;
  for (const [, s] of sessions) {
    for (const [key, val] of s.messageStore) {
      if (val.timestamp < expire) s.messageStore.delete(key);
    }
    for (const [key] of s.antistatusCounts) {
      const date = key.split(':').pop();
      if (date < todayStr) s.antistatusCounts.delete(key);
    }
    // Prune aiConversations — keep last 20 per conversation key
    for (const [convKey, history] of s.aiConversations) {
      if (history.length > 20) s.aiConversations.set(convKey, history.slice(-20));
    }
  }
  if (processedMessages.size > 2000) {
    const toDelete = [...processedMessages].slice(0, 1000);
    for (const id of toDelete) processedMessages.delete(id);
  }
}, 300000);

// ── Deep stale cleanup (every 6 hours) ──
const STALE_FILE_DAYS = 3;
const STALE_FILE_MS = STALE_FILE_DAYS * 24 * 60 * 60 * 1000;
setInterval(async () => {
  const activeNumbers = new Set(connections.keys());

  // 1. Clean auth_info/ folders for unconnected numbers older than 3 days
  const authDir = path.join(process.cwd(), 'auth_info');
  try {
    const entries = fs.readdirSync(authDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const num = entry.name;
      if (activeNumbers.has(num)) continue;
      const folderPath = path.join(authDir, num);
      const stat = fs.statSync(folderPath);
      if (Date.now() - stat.mtimeMs > STALE_FILE_MS) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`[CLEANUP] removed stale auth folder: ${num}`);
      }
    }
  } catch (_) {}

  // 2. Clean vv_data_*.json files for unconnected numbers older than 3 days
  try {
    const files = fs.readdirSync(process.cwd()).filter(f => /^vv_data_\d+\.json$/.test(f));
    for (const f of files) {
      const num = f.replace('vv_data_', '').replace('.json', '');
      if (activeNumbers.has(num)) continue;
      const filePath = path.join(process.cwd(), f);
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > STALE_FILE_MS) {
        fs.unlinkSync(filePath);
        console.log(`[CLEANUP] removed stale data file: ${f}`);
      }
    }
  } catch (_) {}

  // 3. Clean stale lidToPhone entries (not linked to any active number)
  for (const [k, v] of lidToPhone) {
    const jid = k.includes('@') ? k.split('@')[0] : k;
    if (!activeNumbers.has(jid) && !activeNumbers.has(v)) {
      lidToPhone.delete(k);
    }
  }

  // 4. Clean stale DB/Redis auth sessions for unconnected numbers
  try {
    await storage.cleanupStaleSessions([...activeNumbers]);
  } catch (err) {
    console.error(`[CLEANUP] DB session cleanup failed:`, err.message);
  }
}, 6 * 60 * 60 * 1000);

module.exports = { startBot, connections, sessions, startTime, isConnecting };
