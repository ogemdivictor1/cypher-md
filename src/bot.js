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

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  generateWAMessage,
  normalizeMessageContent
} = require('@lordmega/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

// ------------------------------------------------------------------
// State (all in‑memory, no database)
// ------------------------------------------------------------------
const connections = new Map();           // phoneNumber -> socket instance (EXPORTED)
const warnings = new Map();              // "groupId:targetJid" -> count
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
let totalCommandsAttempted = 0;
let totalCommandsSucceeded = 0;

// Anti-link & anti-spam
const antilinkEnabled = new Map();
const antilinkWarnings = new Map();
const linkWhitelist = new Set(['youtube.com', 'youtu.be', 'google.com', 'github.com', 'wa.me']);
const spamTracker = new Map();
const SPAM_WINDOW_MS = 4000;
const SPAM_MAX_MSGS = 5;
const LINK_WARN_LIMIT = 5;

const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 30000;
const lidToPhone = new Map();
const messageStore = new Map();
const pendingReveals = new Set();
const monitoredNumbers = new Set();

const normalizeJid = (jid) => { if (!jid) return ''; return jid.split(':')[0].replace(/[^0-9]/g, ''); };

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

// ── Persistence ──
const VV_DATA_FILE = path.join(process.cwd(), 'vv_data.json');

function loadPersistentData() {
  try {
    if (fs.existsSync(VV_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(VV_DATA_FILE, 'utf-8'));
      if (Array.isArray(data.monitoredNumbers)) {
        for (const n of data.monitoredNumbers) monitoredNumbers.add(n);
      }
      if (data.lidToPhone && typeof data.lidToPhone === 'object') {
        for (const [k, v] of Object.entries(data.lidToPhone)) lidToPhone.set(k, v);
      }
      console.log(`[DATA] loaded ${monitoredNumbers.size} monitored, ${lidToPhone.size} LID mappings`);
    }
  } catch (err) {
    console.error('[DATA] load failed:', err.message);
  }
}

function savePersistentData() {
  try {
    const data = {
      monitoredNumbers: [...monitoredNumbers],
      lidToPhone: Object.fromEntries(lidToPhone),
    };
    fs.writeFileSync(VV_DATA_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('[DATA] save failed:', err.message);
  }
}

loadPersistentData();

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
    const folder = path.join(process.cwd(), 'auth_info', phoneNumber);
    await fsPromises.rm(folder, { recursive: true, force: true });
    connectedNumbers.delete(phoneNumber);
    console.log(`[AUTH] deleted folder for ${phoneNumber}`);
  } catch (err) {
    console.error(`[AUTH] delete folder failed for ${phoneNumber}:`, err.message);
  }
}

const RECONNECT_MAX_ATTEMPTS = 15;
const RECONNECT_BASE_DELAY = 10;
const RECONNECT_MAX_DELAY = 300;
const RECONNECT_COOLDOWN_AFTER = 60000;

const lastConnectedAt = new Map();

function scheduleReconnect(phoneNumber, socket, authType = false) {
  if (reconnectTimers.has(phoneNumber)) {
    clearTimeout(reconnectTimers.get(phoneNumber));
    reconnectTimers.delete(phoneNumber);
  }
  const attempt = (reconnectAttempts.get(phoneNumber) || 0) + 1;
  reconnectAttempts.set(phoneNumber, attempt);

  if (attempt > RECONNECT_MAX_ATTEMPTS) {
    console.log(`[RECON] ${phoneNumber} max attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up`);
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
        await startBot(phoneNumber, socket, authType);
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
      const target = args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : normalizeJid(sender) + '@s.whatsapp.net';
      console.log(`[CS] clearing session for ${target}`);
      try {
        const { deleteContactSession } = require('./redis');
        const deleted = await deleteContactSession(phoneNumber, target);
        if (deleted === 0) {
          const authFolder = path.join(process.cwd(), 'auth_info', phoneNumber);
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
      await conn.sendMessage(from, { text: '🏓 Pong! CYPHER MD is alive!' });
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
      if (!ctx && args[0]) target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      try {
        const ppUrl = await conn.profilePictureUrl(target, 'image');
        await conn.sendMessage(from, { image: { url: ppUrl }, caption: '🖼️ Profile picture' });
      } catch {
        await conn.sendMessage(from, { text: '❌ No profile picture found.' });
      }
    },
    aliases: [],
    args: ['@user (optional)'],
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
      await conn.sendMessage(from, { image: png, caption: '🖼️ Here is your image!' });
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
      const mem = process.memoryUsage();
      await conn.sendMessage(from, {
        text: `📊 Commands: ${totalCommandsAttempted}/${totalCommandsSucceeded} | Groups: ${currentGroups.size} | Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s | Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`
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
      await conn.sendMessage(from, { text: `👢 Kicked @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  warn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      if (target === botJid) throw new Error('❌ Cannot warn myself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ Not in group.');
      const key = `${from}:${target}`;
      const count = (warnings.get(key) || 0) + 1;
      warnings.set(key, count);
      await conn.sendMessage(from, { text: `⚔️ Warned @${target.split('@')[0]} (${count}/3)`, mentions: [target] });
      if (count >= 3) {
        await conn.groupParticipantsUpdate(from, [target], 'remove');
        await conn.sendMessage(from, { text: `🔨 Auto-kicked @${target.split('@')[0]} after 3 warnings.`, mentions: [target] });
        warnings.delete(key);
      }
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true,
  },
  unwarn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ Not admin.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply or mention.');
      const key = `${from}:${target}`;
      if (warnings.has(key)) {
        warnings.set(key, warnings.get(key) - 1);
        if (warnings.get(key) <= 0) warnings.delete(key);
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
      await conn.sendMessage(from, { text: `🔨 Banned @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
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
        throw new Error('Failed to reveal view-once message.');
      }
    },
    aliases: [],
    args: [],
    groupAdminRequired: false,
  },
  monitor: {
    handler: async (conn, from, args, msg, sender) => {
      if (from.endsWith('@g.us')) throw new Error('❌ Only in DMs.');
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const sub = args[0]?.toLowerCase();
      if (sub === 'list') {
        const list = [...monitoredNumbers].map(j => `• ${j}`).join('\n') || 'None';
        return conn.sendMessage(from, { text: `📋 Monitored:\n${list}` });
      }
      if (sub === 'clear') {
        monitoredNumbers.clear();
        savePersistentData();
        return conn.sendMessage(from, { text: '✅ Cleared.' });
      }
      if (sub === 'remove' && args[1]) {
        monitoredNumbers.delete(args[1]);
        savePersistentData();
        return conn.sendMessage(from, { text: `✅ Stopped monitoring ${args[1]}.` });
      }
      const num = args[0]?.replace(/[^0-9]/g, '');
      if (!num) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const repliedJid = ctx?.participant;
        if (repliedJid) {
          const normalized = normalizeJid(repliedJid);
          monitoredNumbers.add(normalized);
          savePersistentData();
          return conn.sendMessage(from, { text: `✅ Monitoring *${normalized}*.` });
        }
        throw new Error('❌ Usage: .monitor <number> or reply.');
      }
      if (num === botJid.split('@')[0]) throw new Error('❌ Cannot monitor yourself.');
      try {
        const ids = await conn.findUserId(num + '@s.whatsapp.net');
        if (ids?.phoneNumber) {
          const normalized = normalizeJid(ids.phoneNumber);
          monitoredNumbers.add(num);
          if (normalized !== num) monitoredNumbers.add(normalized);
          if (ids.lid) {
            const lidNum = normalizeJid(ids.lid);
            if (lidNum && lidNum !== num && lidNum !== normalized) {
              monitoredNumbers.add(lidNum);
              lidToPhone.set(lidNum, num);
            }
          }
        } else {
          throw new Error('Number not found.');
        }
      } catch (err) {
        monitoredNumbers.add(num);
      }
      savePersistentData();
      return conn.sendMessage(from, { text: `✅ Monitoring *${num}*.` });
    },
    aliases: ['mon'],
    args: ['<number> | list | remove <number> | clear'],
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
  tagall: {
    handler: async (conn, from, args, msg, sender, groupMeta) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ Only in groups.');
      const meta = groupMeta || await getGroupMeta(conn, from);
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const participants = meta.participants.filter(p => p.id !== botJid);
      const allJids = participants.map(p => p.id);
      const text = args.join(' ') || 'Hey everyone!';
      await conn.sendMessage(from, { text: `SORRY BUT MY USER ASKED  CYPHER MD TO  MENTIONED EVERYONE 👀🤷‍♂️\n\n${text}`, mentions: allJids });
    },
    aliases: ['tag', 'everyone'],
    args: ['message (optional)'],
    groupAdminRequired: false,
  },
  antilink: {
    handler: async (conn, from, args, msg, sender, groupMeta, isBotAdmin) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ Only in groups.');
      if (!isBotAdmin) throw new Error('❌ I must be admin.');
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        antilinkEnabled.set(from, true);
        await conn.sendMessage(from, { text: '🛡️ Anti-link ON.' });
        return;
      }
      if (sub === 'off') {
        antilinkEnabled.delete(from);
        antilinkWarnings.delete(from);
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
      const status = antilinkEnabled.has(from) ? 'ON' : 'OFF';
      await conn.sendMessage(from, { text: `🛡️ Anti-link is ${status}.` });
    },
    aliases: ['al'],
    args: ['on|off|whitelist'],
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
        `every message that person sends in any group we share — including text, images, and captions. ` +
        `If that person later deletes/recalls a message, I will forward the saved copy to you ` +
        `automatically. How to use:\n` +
        `  - *.monitor 2348012345678* — watch a number\n` +
        `  - *.monitor list* — show all monitored numbers\n` +
        `  - *.monitor remove 2348012345678* — stop watching\n` +
        `  - *.monitor clear* — remove all\n  ` +
        `⚠️ Only works in DMs with me. Cannot monitor my own number.\n\n` +
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
        `• *.tagall* / *.tag* — Mention all group members in a message. Use with a message ` +
        `to broadcast an announcement.\n\n` +
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
        `*— CYPHER MD, built with ❤️ by CYPHER.DEV*`;
      await conn.sendMessage(from, { text: helpText });
    },
    aliases: ['h'],
    args: [],
    groupAdminRequired: false,
  },
  menu: {
    handler: async (conn, from) => {
      const menuText = `*📋 CYPHER MD Commands*\n\n` +
        `🏓 .ping / .p\n🕐 .time\n🔄 .reverse / .r <text>\n💬 .quote\n📝 .bio\n🖼️ .getpp [@user]\n🎭 .sticker / .s\n🖼️ .toimage / .ti\n⏱️ .runtime / .uptime\n📊 .stats\n🛡️ .antilink / .al\n📢 .tagall / .tag\n👁️ .monitor / .mon <number>\n📸 .vv (reply to view-once)\n❓ ??? (reply to VV → DM)\n🆔 .id / .jid\n\n*Admin:*\n.kick .warn .unwarn .ban .delete .mute .unmute .antilink on|off\n\n_Send .help for a detailed guide_`;
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
  totalCommandsAttempted++;
  const cmd = commands[commandName];
  if (!cmd) { console.error(`[CMD] Command "${commandName}" not found in registry`); return false; }
  console.log(`[CMD] Executing "${commandName}" args=[${args.join(', ')}] admin=${isAdmin}`);
  try {
    if (cmd.args.length > 0 && !args.length && cmd.args[0] !== 'optional') {
      throw new Error(`❌ Missing argument: ${cmd.args[0]}`);
    }
    await cmd.handler(conn, from, args, msg, sender, groupMeta, isAdmin, botJid);
    totalCommandsSucceeded++;
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
async function startBot(phoneNumber, socket, useDb = false, preloadedState, preloadedSaveCreds) {
  if (isConnecting.get(phoneNumber)) {
    return;
  }
  isConnecting.set(phoneNumber, true);

  let state, saveCreds;
  if (preloadedState) {
    state = preloadedState;
    saveCreds = preloadedSaveCreds || (() => {});
  } else if (useDb === 'upstash') {
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
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
    const result = await useMultiFileAuthState(authFolder);
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
      const shouldDelete = reason === DisconnectReason.connectionReplaced ||
                           reason === 408 ||
                           reason === 503;
      if (shouldDelete) {
        console.log(`[CONN] ${phoneNumber} ${reason === DisconnectReason.connectionReplaced ? 'connectionReplaced' : reason} — purging session`);
        await deleteAuthFolder(phoneNumber);
        if (useDb === 'upstash') {
          const { deleteAuthSession } = require('./redis');
          await deleteAuthSession(phoneNumber).catch(() => {});
        } else if (useDb) {
          const { deleteAuthSession } = require('./db');
          await deleteAuthSession(phoneNumber).catch(() => {});
        }
        reconnectAttempts.delete(phoneNumber);
      }
      if (reason === 515) lastStream515At.set(phoneNumber, Date.now());
      if (reason === DisconnectReason.loggedOut) {
        const recent515 = Date.now() - (lastStream515At.get(phoneNumber) || 0) < 30000;
        if (recent515) {
          scheduleReconnect(phoneNumber, socket, useDb);
        } else {
          console.log(`[CONN] loggedOut, purging session`);
          if (socket) socket.emit('logged-out', 'Logged out');
          await deleteAuthFolder(phoneNumber);
          if (useDb === 'upstash') {
            const { deleteAuthSession } = require('./redis');
            await deleteAuthSession(phoneNumber).catch(() => {});
          } else if (useDb) {
            const { deleteAuthSession } = require('./db');
            await deleteAuthSession(phoneNumber).catch(() => {});
          }
          reconnectAttempts.delete(phoneNumber);
        }
      } else {
        scheduleReconnect(phoneNumber, socket, useDb);
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
                text: `WELCOME TO CYPHER MD 👑`
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
          const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
          let groupMeta = null;
          let isBotAdmin = false;
          if (isGroup && commands[cmdName]?.groupAdminRequired) {
            try {
              groupMeta = await getGroupMeta(conn, from);
              isBotAdmin = groupMeta.participants.some(p => p.id === botJid && p.admin);
            } catch (err) {
              console.error(`[CMD] Permission check failed:`, err.message);
              await conn.sendMessage(from, { text: '❌ Could not verify permissions.' });
              return;
            }
          }
          await executeCommand(conn, from, cmdName, args, msg, sender, groupMeta, isBotAdmin, botJid);
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
            if (buffer && inner?.imageMessage) await conn.sendMessage(ownerJid, { image: buffer, caption: '👁️ VV revealed' });
            else if (buffer && inner?.videoMessage) await conn.sendMessage(ownerJid, { video: buffer, caption: '👁️ VV revealed' });
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
      const stored = messageStore.get(revokedKey.id);
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
        messageStore.delete(revokedKey.id);
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
    const sender = isGroup ? (msg.key.participant || msg.key.participant || from) : from;
    // JIDS2 removed
    if (type !== 'notify') { return; }
    if (msg.key?.fromMe && !body.startsWith('.')) { return; }

    const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';

    // Monitor deleted messages
    if (monitoredNumbers.size) {
      let norm = normalizeJid(sender);
      let match = norm && monitoredNumbers.has(norm);
      if (!match && norm) {
        const viaCache = lidToPhone.has(norm) && monitoredNumbers.has(lidToPhone.get(norm));
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
              match = monitoredNumbers.has(resolved) || monitoredNumbers.has(norm);
              if (match && resolved !== norm) {
                monitoredNumbers.add(resolved);
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
        messageStore.set(msg.key.id, storeEntry);
        if (messageStore.size > 5000) messageStore.delete(messageStore.keys().next().value);
      }
    }

    // Anti-link
    if (!msg.key?.fromMe && isGroup && antilinkEnabled.has(from) && hasLink(body)) {
      try {
        await conn.sendMessage(from, { delete: { remoteJid: from, id: msg.key.id, participant: msg.key.participant } });
        const key = `${from}:${sender}`;
        const count = (antilinkWarnings.get(key) || 0) + 1;
        antilinkWarnings.set(key, count);
        if (count >= LINK_WARN_LIMIT) {
          await conn.groupParticipantsUpdate(from, [sender], 'remove');
          await conn.sendMessage(from, { text: `🔨 Kicked @${sender.split('@')[0]} for links.`, mentions: [sender] });
          antilinkWarnings.delete(key);
        } else {
          await conn.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} no links! (${count}/${LINK_WARN_LIMIT})`, mentions: [sender] });
        }
      } catch (_) {}
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
          const count = (antilinkWarnings.get(spamKey) || 0) + 1;
          antilinkWarnings.set(spamKey, count);
          if (count >= LINK_WARN_LIMIT) {
            await conn.groupParticipantsUpdate(from, [sender], 'remove');
            await conn.sendMessage(from, { text: `🔨 Kicked @${sender.split('@')[0]} for spamming.`, mentions: [sender] });
            antilinkWarnings.delete(spamKey);
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

// Cache cleanup
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, val] of spamTracker) {
    const recent = val.filter(t => t > cutoff);
    if (recent.length) spamTracker.set(key, recent); else spamTracker.delete(key);
  }
  for (const [key, val] of groupMetaCache) {
    if (Date.now() - val.ts > GROUP_CACHE_TTL) groupMetaCache.delete(key);
  }
  const expire = Date.now() - 86400000;
  for (const [key, val] of messageStore) {
    if (val.timestamp < expire) messageStore.delete(key);
  }
  if (processedMessages.size > 2000) {
    const toDelete = [...processedMessages].slice(0, 1000);
    for (const id of toDelete) processedMessages.delete(id);
  }
}, 300000);

module.exports = { startBot, connections, startTime, isConnecting };