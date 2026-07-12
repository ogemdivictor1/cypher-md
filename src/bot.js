// ── Suppress noisy library logs (MUST be first before any requires) ──
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
  downloadMediaMessage
} = require('@lordmega/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const sharp = require('sharp');
const { usePostgresAuthState, loadSettings, saveSetting, deleteAuthSession, getPool } = require('./db');

// ------------------------------------------------------------------
// State (all in‑memory, no database)
// ------------------------------------------------------------------
const connections = new Map();           // phoneNumber -> socket instance
const warnings = new Map();              // "groupId:targetJid" -> count
const startTime = Date.now();
const connectedNumbers = new Set();       // numbers that already received welcome
const reconnectAttempts = new Map();      // phoneNumber -> current attempt count
const reconnectTimers = new Map();        // phoneNumber -> timeout object
const isConnecting = new Map();           // phoneNumber -> boolean
const consecutive428 = new Map();          // phoneNumber -> count of consecutive reason-428 closures
const lastStream515At = new Map();          // phoneNumber -> timestamp of last 515 (restartRequired)
const userGroups = new Set();             // all groups ever joined (historical)
const currentGroups = new Set();          // groups currently in (real-time)
const processedMessages = new Set();       // message IDs already handled (dedup)
let totalCommandsAttempted = 0;
let totalCommandsSucceeded = 0;

// Anti-link & anti-spam state
const antilinkEnabled = new Map();       // groupId -> boolean
const antilinkWarnings = new Map();      // "groupId:userId" -> count
const linkWhitelist = new Set(['youtube.com', 'youtu.be', 'google.com', 'github.com', 'wa.me']);
const spamTracker = new Map();           // userId -> [timestamp, ...]
const SPAM_WINDOW_MS = 4000;
const SPAM_MAX_MSGS = 5;
const LINK_WARN_LIMIT = 5;

const groupMetaCache = new Map();        // groupId -> { metadata, ts }
const GROUP_CACHE_TTL = 30000;
const lidToPhone = new Map();            // lidNumber (digits) -> phoneNumber (digits), resolved at runtime

const normalizeJid = (jid) => { if (!jid) return ''; return jid.replace(/[^0-9]/g, ''); };

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

// Anti-delete & view-once state
const messageStore = new Map();         // msgKeyId -> { content, fromJid, timestamp }
const monitoredNumbers = new Set();      // JIDs being monitored
const vvTargets = new Set();            // Numbers whose view-once to silently intercept
const MSG_RETENTION_MS = 86400000;      // 24 hours


// Load persisted settings from database (if available)
(async () => {
  try {
    if (getPool()) {
      const settings = await loadSettings();
      if (settings.antilinkEnabled) for (const [gid, val] of Object.entries(settings.antilinkEnabled)) antilinkEnabled.set(gid, val);
      if (settings.monitoredNumbers) for (const jid of settings.monitoredNumbers) monitoredNumbers.add(normalizeJid(jid));
      if (settings.vvTargets) for (const jid of settings.vvTargets) vvTargets.add(normalizeJid(jid));
      if (settings.linkWhitelist) { linkWhitelist.clear(); for (const d of settings.linkWhitelist) linkWhitelist.add(d); }
      console.log('Settings loaded from database');
    }
  } catch (err) { console.error('Failed to load settings from DB:', err); }
})();

// ------------------------------------------------------------------
// Auth folder deletion
// ------------------------------------------------------------------
async function deleteAuthFolder(phoneNumber) {
  try {
    if (getPool()) {
      await deleteAuthSession(phoneNumber);
      console.log(`Deleted auth session from database for ${phoneNumber}`);
    } else {
      const folder = path.join(process.cwd(), 'auth_info', phoneNumber);
      await fsPromises.rm(folder, { recursive: true, force: true });
      console.log(`Deleted auth folder for ${phoneNumber}`);
    }
    connectedNumbers.delete(phoneNumber);
  } catch (err) {
    console.error(`Failed to delete auth for ${phoneNumber}:`, err);
  }
}

// ------------------------------------------------------------------
// Exponential reconnect backoff with timer cleanup
// ------------------------------------------------------------------
function scheduleReconnect(phoneNumber, socket) {
  // Cancel existing timer for this number
  if (reconnectTimers.has(phoneNumber)) {
    clearTimeout(reconnectTimers.get(phoneNumber));
    reconnectTimers.delete(phoneNumber);
  }
  const attempt = (reconnectAttempts.get(phoneNumber) || 0) + 1;
  reconnectAttempts.set(phoneNumber, attempt);
  const delay = Math.min(5 * Math.pow(2, attempt - 1), 80); // 5,10,20,40,80
  console.log(`Reconnecting ${phoneNumber} in ${delay}s (attempt ${attempt})`);
  const timer = setTimeout(() => {
    if (!isConnecting.get(phoneNumber)) {
      startBot(phoneNumber, socket);
    }
    reconnectTimers.delete(phoneNumber);
  }, delay * 1000);
  reconnectTimers.set(phoneNumber, timer);
}

// ------------------------------------------------------------------
// Clean up a socket – remove listeners, close connection
// ------------------------------------------------------------------
async function cleanupSocket(conn) {
  if (!conn) return;
  try {
    conn.ev.removeAllListeners();
    if (conn.ws) await conn.ws.close();
    if (typeof conn.end === 'function') await conn.end();
  } catch (err) {
    console.error('Error during socket cleanup:', err);
  }
}

// ------------------------------------------------------------------
// Command Registry
// ------------------------------------------------------------------
const commands = {
  ping: {
    handler: async (conn, from) => {
      await conn.sendMessage(from, { text: '🏓 Pong! CYPHER MD is alive and active!' });
    },
    aliases: ['p'],
    args: [],
    groupAdminRequired: false,
    description: 'Check if bot is alive'
  },
  time: {
    handler: async (conn, from) => {
      await conn.sendMessage(from, { text: `🕐 CYPHER MD 👑 | *${new Date().toLocaleString()}*` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false
  },
  reverse: {
    handler: async (conn, from, args) => {
      const text = args.join(' ');
      if (!text) throw new Error('❌ Please provide text to reverse.');
      await conn.sendMessage(from, { text: `🔄 CYPHER MD 👑 | ${text.split('').reverse().join('')}` });
    },
    aliases: ['r'],
    args: ['text'],
    groupAdminRequired: false
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
      await conn.sendMessage(from, { text: `💬 *CYPHER MD 👑 Quote:*\n\n_${random}_` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false
  },
  bio: {
    handler: async (conn, from, args, msg, sender) => {
      const status = await conn.fetchStatus(sender);
      await conn.sendMessage(from, { text: `📝 *CYPHER MD 👑 | Bio:*\n\n_${status?.status || 'No bio set'}_` });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false
  },
  getpp: {
    handler: async (conn, from, args, msg, sender) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      let target = ctx?.participant || sender;
      if (!ctx && args[0]) target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      try {
        const ppUrl = await conn.profilePictureUrl(target, 'image');
        await conn.sendMessage(from, { image: { url: ppUrl }, caption: `🖼️ CYPHER MD 👑 | Profile picture` });
      } catch {
        await conn.sendMessage(from, { text: '❌ No profile picture found or privacy settings prevent fetching it.' });
      }
    },
    aliases: [],
    args: ['@user (optional)'],
    groupAdminRequired: false
  },
  sticker: {
    handler: async (conn, from, args, msg) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage;
      const imageMsg = quoted?.imageMessage || msg.message?.imageMessage;
      if (!imageMsg) throw new Error('❌ Please send or reply to an image with .sticker');

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
    groupAdminRequired: false
  },
  toimage: {
    handler: async (conn, from, args, msg) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage;
      const stickerMsg = quoted?.stickerMessage || msg.message?.stickerMessage;
      if (!stickerMsg) throw new Error('❌ Please reply to a sticker with .toimage');

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
      await conn.sendMessage(from, { image: png, caption: '🖼️ CYPHER MD 👑 | Here is your image!' });
    },
    aliases: ['ti'],
    args: [],
    groupAdminRequired: false
  },
  runtime: {
    handler: async (conn, from) => {
      const uptime = Date.now() - startTime;
      const seconds = Math.floor((uptime / 1000) % 60);
      const minutes = Math.floor((uptime / (1000 * 60)) % 60);
      const hours = Math.floor((uptime / (1000 * 60 * 60)) % 24);
      const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
      await conn.sendMessage(from, { text: `⏱️ *CYPHER MD 👑 Uptime:* ${days}d ${hours}h ${minutes}m ${seconds}s` });
    },
    aliases: ['uptime'],
    args: [],
    groupAdminRequired: false
  },
  stats: {
    handler: async (conn, from) => {
      const mem = process.memoryUsage();
      await conn.sendMessage(from, {
        text: `📊 *CYPHER MD 👑 Statistics*\n\n` +
          `Commands attempted: ${totalCommandsAttempted}\n` +
          `Commands succeeded: ${totalCommandsSucceeded}\n` +
          `Currently in groups: ${currentGroups.size}\n` +
          `All‑time groups joined: ${userGroups.size}\n` +
          `Uptime: ${Math.floor((Date.now() - startTime) / 1000)}s\n` +
          `Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`
      });
    },
    aliases: [],
    args: [],
    groupAdminRequired: false
  },
  kick: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ I am not an admin in this group.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply to a user or mention them to kick (e.g., .kick @user).');
      if (target === botJid) throw new Error('❌ You cannot kick yourself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ That user is not in this group.');
      await conn.groupParticipantsUpdate(from, [target], 'remove');
      await conn.sendMessage(from, { text: `👢 CYPHER MD 👑 kicked @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true
  },
  warn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ I am not an admin in this group.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply to a user or mention them to warn (e.g., .warn @user).');
      if (target === botJid) throw new Error('❌ You cannot warn yourself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ That user is not in this group.');
      const key = `${from}:${target}`;
      const count = (warnings.get(key) || 0) + 1;
      warnings.set(key, count);
      await conn.sendMessage(from, { text: `⚔️ CYPHER MD 👑 warned @${target.split('@')[0]}! (${count}/3)`, mentions: [target] });
      if (count >= 3) {
        await conn.groupParticipantsUpdate(from, [target], 'remove');
        await conn.sendMessage(from, { text: `🔨 CYPHER MD 👑 auto-kicked @${target.split('@')[0]} after 3 warnings.`, mentions: [target] });
        warnings.delete(key);
      }
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true
  },
  unwarn: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ I am not an admin in this group.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply to a user or mention them to unwarn (e.g., .unwarn @user).');
      const key = `${from}:${target}`;
      if (warnings.has(key)) {
        warnings.set(key, warnings.get(key) - 1);
        if (warnings.get(key) <= 0) warnings.delete(key);
        await conn.sendMessage(from, { text: `🛡️ CYPHER MD 👑 removed a warning from @${target.split('@')[0]}`, mentions: [target] });
      } else {
        await conn.sendMessage(from, { text: `ℹ️ CYPHER MD 👑 | @${target.split('@')[0]} has no warnings.`, mentions: [target] });
      }
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true
  },
  ban: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin, botJid) => {
      if (!isAdmin) throw new Error('❌ I am not an admin in this group.');
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      if (!target) throw new Error('❌ Reply to a user or mention them to ban (e.g., .ban @user).');
      if (target === botJid) throw new Error('❌ You cannot ban yourself.');
      if (!groupMeta.participants.some(p => p.id === target)) throw new Error('❌ That user is not in this group.');
      await conn.groupParticipantsUpdate(from, [target], 'remove');
      await conn.sendMessage(from, { text: `🔨 CYPHER MD 👑 banned @${target.split('@')[0]}`, mentions: [target] });
    },
    aliases: [],
    args: ['@user'],
    groupAdminRequired: true
  },
  delete: {
    handler: async (conn, from, args, msg, sender, groupMeta, isAdmin) => {
      if (!isAdmin) throw new Error('❌ I am not an admin in this group.');
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) throw new Error('❌ Reply to a message to delete it.');
      const id = msg.message.extendedTextMessage.contextInfo.stanzaId;
      const participant = msg.message.extendedTextMessage.contextInfo.participant;
      if (!id) throw new Error('❌ Could not find message ID.');
      await conn.sendMessage(from, { delete: { remoteJid: from, id, participant: participant || from } });
      await conn.sendMessage(from, { text: '🗑️ CYPHER MD 👑 deleted that message.' });
    },
    aliases: ['del'],
    args: [],
    groupAdminRequired: true
  },
  mute: {
    handler: async (conn, from) => {
      await conn.groupSettingUpdate(from, 'announcement');
      await conn.sendMessage(from, { text: '🔇 CYPHER MD 👑 muted the group.' });
    },
    aliases: [],
    args: [],
    groupAdminRequired: true
  },
  unmute: {
    handler: async (conn, from) => {
      await conn.groupSettingUpdate(from, 'not_announcement');
      await conn.sendMessage(from, { text: '🔊 CYPHER MD 👑 unmuted the group.' });
    },
    aliases: [],
    args: [],
    groupAdminRequired: true
  },
  vv: {
    handler: async (conn, from, args, msg, sender) => {
      const sub = args[0]?.toLowerCase();
      // ── .vv self — manage silent interception targets ──
      if (sub === 'self') {
        const action = args[1];
        if (action === 'list') {
          const list = [...vvTargets].map(j => `• ${j}`).join('\n') || 'None';
          console.log(`[VV] Active intercept targets: [${[...vvTargets].join(', ')}]`);
          return conn.sendMessage(from, { text: `👁️ *Intercepted numbers:*\n${list}` });
        }
        if (action === 'remove' && args[2]) {
          vvTargets.delete(args[2]);
          if (getPool()) await saveSetting('vvTargets', [...vvTargets]);
          console.log(`[VV] Removed ${args[2]} from intercept list`);
          return conn.sendMessage(from, { text: `✅ Stopped intercepting ${args[2]}.` });
        }
        const num = action?.replace(/[^0-9]/g, '');
        if (!num) throw new Error('❌ Usage: .vv self <number> | list | remove <number>');
        // Resolve both phone JID and LID (like .monitor does)
        try {
          const ids = await conn.findUserId(num + '@s.whatsapp.net');
          if (ids?.phoneNumber) {
            const normalized = normalizeJid(ids.phoneNumber);
            vvTargets.add(num);
            if (normalized !== num) vvTargets.add(normalized);
            if (ids.lid) {
              const lidNum = normalizeJid(ids.lid);
              if (lidNum && lidNum !== num && lidNum !== normalized) {
                vvTargets.add(lidNum);
                lidToPhone.set(lidNum, num);
              }
            }
            console.log(`[VV] Added to intercept list — input: ${num}, resolved: ${normalized}${ids.lid ? `, lid: ${normalizeJid(ids.lid)}` : ''}`);
          } else {
            vvTargets.add(num);
            console.log(`[VV] Added ${num} to intercept list (no findUserId result)`);
          }
        } catch (err) {
          vvTargets.add(num);
          console.log(`[VV] Added ${num} to intercept list — findUserId failed: ${err.message}`);
        }
        if (getPool()) await saveSetting('vvTargets', [...vvTargets]);
        return conn.sendMessage(from, { text: `✅ Now silently intercepting view-once from *${num}* 👁️` });
      }
      // ── .vv <jid?> — manual retrieval via rvo ──
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      if (!ctx?.stanzaId) throw new Error('❌ Reply to a view-once message with .vv to retrieve it.');
      const targetJid = args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender;
      const quotedMsg = {
        key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
        message: ctx.quotedMessage
      };
      await conn.rvo(quotedMsg, targetJid);
    },
    aliases: [],
    args: [],
    groupAdminRequired: false
  },
  monitor: {
    handler: async (conn, from, args, msg, sender) => {
      if (from.endsWith('@g.us')) throw new Error('❌ This command only works in DMs.');
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';

      const sub = args[0]?.toLowerCase();
      if (sub === 'list') {
        const list = [...monitoredNumbers].map(j => `• ${j}`).join('\n') || 'None';
        return conn.sendMessage(from, { text: `📋 *CYPHER MD 👑 | Monitored numbers:*\n${list}` });
      }
      if (sub === 'clear') {
        monitoredNumbers.clear();
        if (getPool()) await saveSetting('monitoredNumbers', []);
        return conn.sendMessage(from, { text: '✅ CYPHER MD 👑 cleared all monitored numbers.' });
      }
      if (sub === 'remove' && args[1]) {
        monitoredNumbers.delete(args[1]);
        if (getPool()) await saveSetting('monitoredNumbers', [...monitoredNumbers]);
        return conn.sendMessage(from, { text: `✅ CYPHER MD 👑 stopped monitoring ${args[1]}.` });
      }

      // If no numeric arg, try to get target from replied message
      const num = args[0]?.replace(/[^0-9]/g, '');
      if (!num) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const repliedJid = ctx?.participant;
        if (repliedJid) {
          const normalized = normalizeJid(repliedJid);
          monitoredNumbers.add(normalized);
          console.log(`[Monitor] Added ${normalized} to watchlist — triggered by reply-to message`);
          if (getPool()) await saveSetting('monitoredNumbers', [...monitoredNumbers]);
          return conn.sendMessage(from, { text: `✅ CYPHER MD 👑 now monitoring *${normalized}* (from replied message).` });
        }
        throw new Error('❌ Usage: .monitor <number> or reply to a message with .monitor');
      }
      if (num === botJid.split('@')[0]) throw new Error('❌ Cannot monitor yourself.');

      // Resolve the actual JID + LID using findUserId
      try {
        const ids = await conn.findUserId(num + '@s.whatsapp.net');
        if (ids?.phoneNumber) {
          const normalized = normalizeJid(ids.phoneNumber);
          // Store the raw input, resolved phone JID, and LID if present
          monitoredNumbers.add(num);
          if (normalized !== num) monitoredNumbers.add(normalized);
          if (ids.lid) {
            const lidNum = normalizeJid(ids.lid);
            if (lidNum && lidNum !== num && lidNum !== normalized) {
              monitoredNumbers.add(lidNum);
              lidToPhone.set(lidNum, num);
            }
          }
          console.log(`[Monitor] Added to watchlist — input: ${num}, resolved: ${normalized}${ids.lid ? `, lid: ${normalizeJid(ids.lid)}` : ''}`);
        } else {
          throw new Error('Number not found on WhatsApp');
        }
      } catch (err) {
        // Fallback: store raw number
        monitoredNumbers.add(num);
        console.log(`[Monitor] Added ${num} to watchlist as raw number — JID resolution failed: ${err.message}`);
      }
      if (getPool()) await saveSetting('monitoredNumbers', [...monitoredNumbers]);
      await conn.sendMessage(from, { text: `✅ CYPHER MD 👑 now monitoring *${num}* for deleted messages.` });
    },
    aliases: ['mon'],
    args: ['<number> | list | remove <number> | clear'],
    groupAdminRequired: false
  },
  id: {
    handler: async (conn, from, args, msg, sender) => {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const target = ctx?.participant || sender;
      await conn.sendMessage(from, { text: `🆔 CYPHER MD 👑 | ID: ${target}` });
    },
    aliases: ['jid'],
    args: [],
    groupAdminRequired: false
  },
  tagall: {
    handler: async (conn, from, args, msg, sender, groupMeta) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ This command can only be used in groups.');
      const meta = groupMeta || await getGroupMeta(conn, from);
      const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
      const participants = meta.participants.filter(p => p.id !== botJid);
      const allJids = participants.map(p => p.id);
      const text = args.join(' ') || 'Hey everyone!';

      const isAdmin = participants.some(p => p.id === sender && p.admin);
      const msgText = `👑 *CYPHER MD* | ${text}`;
      if (isAdmin) {
        await conn.sendMessage(from, { text: `📢 @all\n\n${msgText}`, mentions: allJids });
      } else {
        const mentions = allJids.map(j => `@${j.split('@')[0]}`).join(' ');
        await conn.sendMessage(from, { text: `${mentions}\n\n${msgText}` });
      }
    },
    aliases: ['tag', 'everyone'],
    args: ['message (optional)'],
    groupAdminRequired: false
  },
  antilink: {
    handler: async (conn, from, args, msg, sender, groupMeta, isBotAdmin) => {
      if (!from.endsWith('@g.us')) throw new Error('❌ This command can only be used in groups.');
      if (!isBotAdmin) throw new Error('❌ I must be a group admin to manage anti-link.');
      const sub = args[0]?.toLowerCase();

      if (sub === 'on') {
        antilinkEnabled.set(from, true);
        if (getPool()) await saveSetting('antilinkEnabled', Object.fromEntries(antilinkEnabled));
        await conn.sendMessage(from, { text: '🛡️ CYPHER MD 👑 — Anti-link filter is now *ON*.' });
        return;
      }

      if (sub === 'off') {
        antilinkEnabled.delete(from);
        antilinkWarnings.delete(from);
        if (getPool()) await saveSetting('antilinkEnabled', Object.fromEntries(antilinkEnabled));
        await conn.sendMessage(from, { text: '🛡️ CYPHER MD 👑 — Anti-link filter is now *OFF*.' });
        return;
      }

      if (sub === 'whitelist') {
        const action = args[1]?.toLowerCase();
        const domain = args[2]?.toLowerCase();
        if (action === 'add' && domain) {
          linkWhitelist.add(domain);
          if (getPool()) await saveSetting('linkWhitelist', [...linkWhitelist]);
          await conn.sendMessage(from, { text: `✅ CYPHER MD 👑 added *${domain}* to whitelist.` });
        } else if (action === 'remove' && domain) {
          linkWhitelist.delete(domain);
          if (getPool()) await saveSetting('linkWhitelist', [...linkWhitelist]);
          await conn.sendMessage(from, { text: `✅ CYPHER MD 👑 removed *${domain}* from whitelist.` });
        } else {
          const list = [...linkWhitelist].join('\n• ');
          await conn.sendMessage(from, { text: `📋 *CYPHER MD 👑 Whitelisted domains:*\n• ${list}` });
        }
        return;
      }

      const status = antilinkEnabled.has(from) ? 'ON' : 'OFF';
      await conn.sendMessage(from, { text: `🛡️ CYPHER MD 👑 — Anti-link is currently *${status}*.\n\n.antilink on | off | whitelist` });
    },
    aliases: ['al'],
    args: ['on|off|whitelist'],
    groupAdminRequired: true
  },
  help: {
    handler: async (conn, from) => {
      const helpText = `*📋 CYPHER MD Commands*\n\n` +
        `🏓 .ping / .p — Check bot\n` +
        `🕐 .time — Current time\n` +
        `🔄 .reverse / .r <text> — Reverse text\n` +
        `💬 .quote — Random quote\n` +
        `📝 .bio — Your WhatsApp bio\n` +
        `🖼️ .getpp [@user] — Profile picture\n` +
        `🎭 .sticker / .s — Image to sticker\n` +
        `🖼️ .toimage / .ti — Sticker to image\n` +

        `⏱️ .runtime / .uptime — Bot uptime\n` +
        `📊 .stats — Command stats\n` +
        `🛡️ .antilink / .al — Anti-link settings (group)\n` +
        `📢 .tagall / .tag — Tag all group members\n` +
        `👁️ .monitor / .mon <number> — Monitor DMs for deleted messages\n` +
        `📸 .vv [jid] — Retrieve a view-once message (reply to it)\n` +
        `👁️ .vv self <number> — Silently intercept view-once from that number no one knows you did it 👀👻\n` +
        `🆔 .id / .jid — Get a user's ID (reply to their message)\n\n` +
        `*Group Admin Commands:*\n` +
        `.kick @user\n.warn @user\n.unwarn @user\n.ban @user\n.delete (reply)\n.mute\n.unmute\n.antilink on|off`;
      await conn.sendMessage(from, { text: helpText });
    },
    aliases: ['h'],
    args: [],
    groupAdminRequired: false
  }
};

// Build alias map
const aliasMap = new Map();
for (const [cmdName, cmd] of Object.entries(commands)) {
  aliasMap.set(cmdName, cmdName);
  for (const alias of cmd.aliases) aliasMap.set(alias, cmdName);
}

// ------------------------------------------------------------------
// Central command executor with internal try/catch
// ------------------------------------------------------------------
async function executeCommand(conn, from, commandName, args, msg, sender, groupMeta, isAdmin, botJid) {
  totalCommandsAttempted++;
  const cmd = commands[commandName];
  if (!cmd) return false;

  try {
    // Argument validation now inside try/catch
    if (cmd.args.length > 0 && !args.length && cmd.args[0] !== 'optional') {
      throw new Error(`❌ Missing argument: ${cmd.args[0]}. Example: .${commandName} ${cmd.args.join(' ')}`);
    }
    await cmd.handler(conn, from, args, msg, sender, groupMeta, isAdmin, botJid);
    totalCommandsSucceeded++;
    return true;
  } catch (err) {
    console.error(`Command error (${commandName}):`, err);
    await conn.sendMessage(from, { text: err.message || '❌ An error occurred.' });
    return false;
  }
}

// ------------------------------------------------------------------
// Track groups (both historical and current)
// ------------------------------------------------------------------
function addGroupIfNew(groupJid) {
  if (!userGroups.has(groupJid)) userGroups.add(groupJid);
  currentGroups.add(groupJid);
}

function removeGroup(groupJid) {
  currentGroups.delete(groupJid);
  // We deliberately keep userGroups for historical stats
}

// ------------------------------------------------------------------
// Main bot start function
// ------------------------------------------------------------------
async function startBot(phoneNumber, socket) {
  if (isConnecting.get(phoneNumber)) {
    console.log(`Already connecting for ${phoneNumber}, skipping.`);
    return;
  }
  isConnecting.set(phoneNumber, true);

  let state, saveCreds;
  if (getPool()) {
    try {
      const result = await usePostgresAuthState(phoneNumber);
      state = result.state;
      saveCreds = result.saveCreds;
      console.log(`Auth state loaded from database for ${phoneNumber}`);
    } catch (dbErr) {
      console.warn('DB unreachable, falling back to file-based auth:', dbErr.message);
    }
  }
  if (!state) {
    const authFolder = path.join(process.cwd(), 'auth_info', phoneNumber);
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
    const result = await useMultiFileAuthState(authFolder);
    state = result.state;
    saveCreds = result.saveCreds;
  }
  const { version, isLatest } = await fetchLatestWaWebVersion();

  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Desktop', ''],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  connections.set(phoneNumber, conn);
  let welcomeTimeout = null;

  // Request pairing code if not registered (original logic)
  if (!conn.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        let code = await conn.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        if (socket) socket.emit('pairing-code', code);
        console.log('Pairing code:', code);
      } catch (err) {
        console.error('Failed to generate pairing code:', err);
      }
    }, 3000);
  }

  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`Connection closed, reason: ${reason}${reason === 428 ? ' (connectionClosed)' : ''}`);

      if (welcomeTimeout) clearTimeout(welcomeTimeout);
      await cleanupSocket(conn);
      connections.delete(phoneNumber);
      isConnecting.delete(phoneNumber);

      if (reconnectTimers.has(phoneNumber)) {
        clearTimeout(reconnectTimers.get(phoneNumber));
        reconnectTimers.delete(phoneNumber);
      }

      // After 3+ consecutive 428 (connectionClosed) errors, the stored
      // auth session is likely stale and causing Bad MAC loops. Clean it.
      if (reason === 428) {
        const count = (consecutive428.get(phoneNumber) || 0) + 1;
        consecutive428.set(phoneNumber, count);
        console.log(`Consecutive 428 closures for ${phoneNumber}: ${count}`);
        if (count >= 3) {
          console.log(`Too many consecutive 428 closures, deleting stale auth session for ${phoneNumber}`);
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
        await deleteAuthFolder(phoneNumber);
        reconnectAttempts.delete(phoneNumber);
      }

      // Track 515 (restartRequired) — a 401 that follows within 30s is
      // just WhatsApp cleaning up the old session slot, not a real logout.
      if (reason === 515) {
        lastStream515At.set(phoneNumber, Date.now());
      }

      if (reason === DisconnectReason.loggedOut) {
        const recent515 = Date.now() - (lastStream515At.get(phoneNumber) || 0) < 30000;
        if (recent515) {
          console.log(`401 after recent 515 — treating as reconnect, not logout`);
          scheduleReconnect(phoneNumber, socket);
        } else {
          if (socket) socket.emit('logged-out', 'WhatsApp session logged out');
          await deleteAuthFolder(phoneNumber);
          reconnectAttempts.delete(phoneNumber);
        }
      } else {
        scheduleReconnect(phoneNumber, socket);
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!');
      if (socket) socket.emit('connected', 'WhatsApp connected successfully');
      reconnectAttempts.delete(phoneNumber);
      isConnecting.delete(phoneNumber);
      consecutive428.delete(phoneNumber);

      if (reconnectTimers.has(phoneNumber)) {
        clearTimeout(reconnectTimers.get(phoneNumber));
        reconnectTimers.delete(phoneNumber);
      }

      // Only send welcome on new pairings (from web UI), not on DB reconnects
      if (socket && !connectedNumbers.has(phoneNumber)) {
        welcomeTimeout = setTimeout(async () => {
          if (connections.get(phoneNumber) === conn && !connectedNumbers.has(phoneNumber)) {
            try {
              await conn.sendMessage(phoneNumber + '@s.whatsapp.net', {
                text: `WELCOME INTO THE REALM OF TECHIES 🌐\n\nCYPHER MD WELCOMES YOU 👑\nDO WELL TO THANK CYPHER FOR THIS UPDATE 💥`
              });
              console.log(`Welcome message sent to ${phoneNumber}`);
              connectedNumbers.add(phoneNumber);
            } catch (err) {
              console.error(`Failed to send welcome message:`, err);
            }
          }
          welcomeTimeout = null;
        }, 10000);
      }
    }
  });

  conn.ev.on('creds.update', saveCreds);

  // ------------------------------------------------------------------
  // Anti-delete: backup handler via messages.update
  // (Primary detection is in messages.upsert — this catches any that
  //  arrive as updates instead of upserts)
  // ------------------------------------------------------------------
  conn.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      const proto = update?.message?.protocolMessage;
      if (proto?.type === 0) { // REVOKE
        const revokedKey = proto.key;
        console.log(`[Monitor] Delete/revoke detected via messages.update (backup path) — ID: ${revokedKey.id}`);
        const stored = messageStore.get(revokedKey.id);
        if (stored) {
          console.log(`[Monitor] (backup) Forwarding deleted message — ID: ${revokedKey.id}, sender: ${stored.displayNumber || stored.fromJid.split('@')[0]}`);
          const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
          const caption = ` *CYPHER MD 👀 caught a deleted message!*\n\nFrom: ${stored.displayNumber || stored.fromJid.split('@')[0]}\n${stored.mediaBuffer ? 'Caption' : 'Original'}: ${stored.content}`;
          try {
            if (stored.mediaBuffer && stored.mediaType === 'image') {
              await sendImageViaFile(conn, botJid, stored.mediaBuffer, caption);
            } else {
              await conn.sendMessage(botJid, { text: caption });
            }
          } catch (err) {
            console.error('[Monitor] (backup) Image forward failed, falling back to text:', err.message);
            try {
              await conn.sendMessage(botJid, { text: caption + '\n\n[Image could not be forwarded]' });
            } catch (_) {}
          }
          messageStore.delete(revokedKey.id);
        }
      }
    }
  });

  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------
  conn.ev.on('messages.upsert', async ({ messages, type }) => {
    const msg = messages[0];

    // ── Fast path: fromMe OR owner commands — skip all checks ──
    if (msg?.message) {
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (body.startsWith('.')) {
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? (msg.key.participant || msg.participant || from) : from;
        const isOwner = sender === phoneNumber + '@s.whatsapp.net';
        if (msg.key.fromMe || isOwner) {
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
                console.error('Group metadata error:', err);
                await conn.sendMessage(from, { text: '❌ Could not verify group permissions.' });
                return;
              }
            }
            await executeCommand(conn, from, cmdName, args, msg, sender, groupMeta, isBotAdmin, botJid);
            return;
          }
        }
      }
    }

    // ── Protocol message detection (must be BEFORE dedup — same msg ID as original) ──
    const proto = msg?.message?.protocolMessage;
    if (proto?.type === 0) {
      const revokedKey = proto.key;
      const stored = messageStore.get(revokedKey.id);
      if (stored) {
        console.log(`[Monitor] Delete/revoke detected — message ID: ${revokedKey.id}, sender: ${stored.displayNumber}, content: "${stored.content.slice(0, 100)}"`);
        const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const caption = ` *CYPHER MD 👀 caught a deleted message!*\n\nFrom: ${stored.displayNumber || stored.fromJid.split('@')[0]}\n${stored.mediaBuffer ? 'Caption' : 'Original'}: ${stored.content}`;
        try {
          if (stored.mediaBuffer && stored.mediaType === 'image') {
            await sendImageViaFile(conn, botJid, stored.mediaBuffer, caption);
          } else {
            await conn.sendMessage(botJid, { text: caption });
          }
        } catch (err) {
          console.error('[Monitor] Image forward failed, falling back to text:', err.message);
          try {
            await conn.sendMessage(botJid, { text: caption + '\n\n[Image could not be forwarded]' });
          } catch (_) {}
        }
        messageStore.delete(revokedKey.id);
      } else {
        console.log(`[Monitor] Delete/revoke from non-watched or expired — message ID: ${revokedKey.id}, remoteJid: ${revokedKey.remoteJid}`);
      }
      return;
    }

    // ── Silent view-once interception for tracked targets (before dedup & type filter) ──
    if (msg?.key && msg.message && vvTargets.size) {
      // Detect view-once: wrapped format (fromMe) OR raw media with viewOnce flag (incoming)
      let isViewOnce = !!(msg.message?.viewOnceMessage
        || msg.message?.viewOnceMessageV2
        || msg.message?.viewOnceMessageV2Extension);
      if (!isViewOnce) {
        for (const t of ['imageMessage', 'videoMessage', 'audioMessage']) {
          if (msg.message[t]?.viewOnce) { isViewOnce = true; break; }
        }
      }
      if (isViewOnce) {
        const remoteJid = msg.key.remoteJid;
        const sender = remoteJid.endsWith('@g.us') ? (msg.key.participant || msg.participant || remoteJid) : remoteJid;
        const norm = normalizeJid(sender);
        const matched = vvTargets.has(norm) || (lidToPhone.has(norm) && vvTargets.has(lidToPhone.get(norm)));
        console.log(`[VV] View-once detected from ${norm} (sender: ${sender}, tracked: ${matched})`);
        if (matched) {
          try {
            const ownerJid = phoneNumber + '@s.whatsapp.net';
            await conn.rvo(msg, ownerJid);
            console.log(`[VV] Intercepted & forwarded view-once from ${norm} to owner`);
          } catch (err) {
            console.error(`[VV] Intercept error for ${norm}:`, err);
          }
        }
        return;
      }
    }

    // ── Regular message processing below ──
    if (!msg.message) return;
    if (processedMessages.has(msg.key.id)) return;
    processedMessages.add(msg.key.id);

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    if (isGroup) addGroupIfNew(from);
    const sender = isGroup ? (msg.key.participant || msg.participant || from) : from;
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    // Only process 'notify' for regular messages (protocol + view-once handled above)
    if (type !== 'notify') return;

    // Skip own non-command messages (sent by bot, not a command)
    if (msg.key.fromMe && !body.startsWith('.')) return;

    // ── Non-command processing below (monitoring, anti-link, anti-spam) ──
    const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';

    // ── Store messages from monitored contacts (for deletion detection) ──
    if (monitoredNumbers.size) {
      let norm = normalizeJid(sender);
      let match = norm && monitoredNumbers.has(norm);

      if (!match && norm) {
        // Try cache first (covers @lid → phone and phone → @lid)
        const viaCache = lidToPhone.has(norm) && monitoredNumbers.has(lidToPhone.get(norm));
        if (viaCache) {
          match = true;
          console.log(`[Monitor] Sender ${norm} resolved from cache → ${lidToPhone.get(norm)}, matched watchlist`);
        }
        // Only attempt expensive onWhatsApp for @lid senders (need to resolve to phone JID)
        if (!match && sender.endsWith('@lid')) {
          try {
            console.log(`[Monitor] Sender ${norm} not in watchlist, resolving via onWhatsApp...`);
            const [result] = await conn.onWhatsApp(norm);
            if (result?.exists && result.jid) {
              const resolved = normalizeJid(result.jid);
              // Cache both directions
              if (resolved !== norm) {
                lidToPhone.set(norm, resolved);
                lidToPhone.set(resolved, norm);
              }
              match = monitoredNumbers.has(resolved) || monitoredNumbers.has(norm);
              if (match) console.log(`[Monitor] Sender ${norm} resolved → ${resolved}, matched watchlist`);
              if (match && resolved !== norm) {
                monitoredNumbers.add(resolved);
                console.log(`[Monitor] Auto-added ${resolved} to watchlist (alias for ${norm})`);
              }
            }
          } catch (err) {
            console.log(`[Monitor] Failed to resolve sender ${norm}: ${err.message}`);
          }
        }
      }

      console.log(`[Monitor] Incoming message check — sender: ${sender} (normalized: ${norm}), in watchlist: ${match}, watchlist: [${[...monitoredNumbers].join(', ')}]`);
      if (match) {
        // Resolve a user-friendly display number (the original input, not the LID)
        const displayNumber = lidToPhone.get(norm) || norm;
        const storeEntry = { content: body || '[media]', fromJid: from, displayNumber, timestamp: Date.now() };

        // Download media for future deletion forwarding
        if (msg.message?.imageMessage) {
          storeEntry.content = msg.message.imageMessage.caption || '[Image]';
          try {
            const stream = await downloadMediaMessage(msg, 'stream', { logger: conn.logger });
            const chunks = [];
            for await (const chunk of stream) {
              chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks);
            storeEntry.mediaBuffer = await sharp(raw).jpeg({ quality: 90 }).toBuffer();
            storeEntry.mediaType = 'image';
            console.log(`[Monitor] Downloaded image (${(storeEntry.mediaBuffer.length / 1024).toFixed(1)} KB) for message ${msg.key.id}`);
          } catch (err) {
            console.log(`[Monitor] Failed to download image: ${err.message}`);
          }
        }

        messageStore.set(msg.key.id, storeEntry);
        if (messageStore.size > 5000) messageStore.delete(messageStore.keys().next().value);
        console.log(`[Monitor] Message cached for delete detection — user: ${displayNumber}, content: "${(body || '[media]').slice(0, 200)}"`);
      }
    }

    // ── Anti-link check ──
    if (!msg.key.fromMe && isGroup && antilinkEnabled.has(from) && hasLink(body)) {
      try {
        await conn.sendMessage(from, {
          delete: { remoteJid: from, id: msg.key.id, participant: msg.key.participant }
        });
        const key = `${from}:${sender}`;
        const count = (antilinkWarnings.get(key) || 0) + 1;
        antilinkWarnings.set(key, count);
        if (count >= LINK_WARN_LIMIT) {
          await conn.groupParticipantsUpdate(from, [sender], 'remove');
          await conn.sendMessage(from, {
            text: `🔨 CYPHER MD 👑 kicked @${sender.split('@')[0]} for posting links.`,
            mentions: [sender]
          });
          antilinkWarnings.delete(key);
        } else {
          await conn.sendMessage(from, {
            text: `🚫 CYPHER MD 😒 | @${sender.split('@')[0]} links not allowed! Warning ${count}/${LINK_WARN_LIMIT}`,
            mentions: [sender]
          });
        }
      } catch (err) {
        console.error('Anti-link error:', err);
      }
      return;
    }

    // ── Anti-spam check ──
    if (!msg.key.fromMe && body && isSpamming(sender)) {
      try {
        if (!isGroup) {
          await conn.blockUser(sender, 'block');
          await conn.sendMessage(botJid, {
            text: `⚠️ *CYPHER MD 👑 Spam Alert (DM)*\n\nNumber: ${sender.split('@')[0]}\nMessage: ${body.slice(0, 100)}\n\n🚫 User has been blocked.`
          });
        } else {
          const spamKey = `${from}:${sender}:spam`;
          const count = (antilinkWarnings.get(spamKey) || 0) + 1;
          antilinkWarnings.set(spamKey, count);
          if (count >= LINK_WARN_LIMIT) {
            await conn.groupParticipantsUpdate(from, [sender], 'remove');
            await conn.sendMessage(from, {
              text: `🔨 CYPHER MD 👑 kicked @${sender.split('@')[0]} for spamming.`,
              mentions: [sender]
            });
            antilinkWarnings.delete(spamKey);
          } else {
            await conn.sendMessage(from, {
              text: `🐢 CYPHER MD 👑 | @${sender.split('@')[0]} slow down! You're sending too fast.`,
              mentions: [sender]
            });
          }
        }
      } catch (err) {
        console.error('Anti-spam error:', err);
      }
      return;
    }
  });

  // ------------------------------------------------------------------
  // Track group membership changes (add/remove bot itself)
  // ------------------------------------------------------------------
  conn.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    const botJid = conn.user?.id?.split(':')[0] + '@s.whatsapp.net';

    groupMetaCache.delete(id); // invalidate cached metadata
    addGroupIfNew(id); // on any update, add to historical and current

    // If the bot itself left or was removed, remove from currentGroups
    if (action === 'remove' && participants.includes(botJid)) {
      removeGroup(id);
    }

    // Welcome / goodbye messages for others
    if (action === 'add') {
      for (const p of participants) {
        if (p === botJid) continue;
        try {
          await conn.sendMessage(id, {
            text: `👋 Welcome @${p.split('@')[0]}! CYPHER MD is watching over this place. 😎\n\nType .help to see what I can do.`,
            mentions: [p]
          });
        } catch (_) {}
      }
    } else if (action === 'remove') {
      for (const p of participants) {
        if (p === botJid) continue;
        try {
          await conn.sendMessage(id, {
            text: `🚪 @${p.split('@')[0]} left the group. CYPHER MD 👑 says goodbye!`,
            mentions: [p]
          });
        } catch (_) {}
      }
    }
  });
}

// Periodic cache cleanup (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, val] of spamTracker) {
    const recent = val.filter(t => t > cutoff);
    if (recent.length) spamTracker.set(key, recent); else spamTracker.delete(key);
  }
  for (const [key, val] of groupMetaCache) {
    if (Date.now() - val.ts > GROUP_CACHE_TTL) groupMetaCache.delete(key);
  }
  const expire = Date.now() - MSG_RETENTION_MS;
  for (const [key, val] of messageStore) {
    if (val.timestamp < expire) messageStore.delete(key);
  }
  // Keep only last 1000 processed message IDs
  if (processedMessages.size > 2000) {
    const toDelete = [...processedMessages].slice(0, 1000);
    for (const id of toDelete) processedMessages.delete(id);
  }
}, 300000);

module.exports = { startBot };