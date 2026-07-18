// ── Unified storage abstraction ──
// Auto-detects backend from env vars:
//   UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN → Upstash Redis
//   DATABASE_URL                             → PostgreSQL (Supabase, Neon, etc.)
//   (neither)                                → File-based (auth_info/ + vv_data_*.json)

function detectDbType() {
  if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) return 'upstash';
  if (process.env.DATABASE_URL) return 'postgres';
  return 'file';
}

const dbType = detectDbType();

let impl;
if (dbType === 'upstash') {
  const redis = require('./redis');
  impl = redis;
} else if (dbType === 'postgres') {
  const pg = require('./db');
  impl = pg;
}

async function initBackend() {
  if (dbType === 'upstash') {
    impl.initRedis(process.env.UPSTASH_REDIS_URL, process.env.UPSTASH_REDIS_TOKEN);
    console.log('[STORAGE] Upstash Redis');
  } else if (dbType === 'postgres') {
    impl.initDb(process.env.DATABASE_URL);
    try {
      await impl.setupTables();
      console.log('[STORAGE] PostgreSQL (DATABASE_URL)');
    } catch (err) {
      console.error('[STORAGE] DB init failed:', err.message);
    }
  } else {
    console.log('[STORAGE] file-based');
  }
}

function getType() {
  return dbType;
}

async function useAuthState(phoneNumber) {
  if (dbType === 'upstash') return impl.useUpstashAuthState(phoneNumber);
  if (dbType === 'postgres') return impl.usePostgresAuthState(phoneNumber);
  const { useMultiFileAuthState } = require('@lordmega/baileys');
  const path = require('path');
  const fs = require('fs');
  const authFolder = path.join(process.cwd(), 'auth_info', phoneNumber);
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
  return useMultiFileAuthState(authFolder);
}

async function deleteAuthSession(phoneNumber) {
  if (dbType === 'upstash' || dbType === 'postgres') return impl.deleteAuthSession(phoneNumber);
  const path = require('path');
  const fs = require('fs');
  const folder = path.join(process.cwd(), 'auth_info', phoneNumber);
  fs.rmSync(folder, { recursive: true, force: true });
}

async function getStoredPhoneNumbers() {
  if (dbType === 'upstash' || dbType === 'postgres') return impl.getStoredPhoneNumbers();
  const path = require('path');
  const fs = require('fs');
  const authFolder = path.join(process.cwd(), 'auth_info');
  try {
    return fs.readdirSync(authFolder).filter(d => {
      try { return fs.existsSync(path.join(authFolder, d, 'creds.json')); }
      catch { return false; }
    });
  } catch { return []; }
}

async function loadBotState(phoneNumber) {
  if (dbType === 'upstash' || dbType === 'postgres') {
    const raw = await impl.loadBotState(phoneNumber);
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    return null;
  }
  const path = require('path');
  const fs = require('fs');
  const file = path.join(process.cwd(), `vv_data_${phoneNumber.replace(/\D/g, '')}.json`);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return null;
}

async function saveBotState(phoneNumber, data) {
  if (dbType === 'upstash' || dbType === 'postgres') return impl.saveBotState(phoneNumber, data);
  const path = require('path');
  const fs = require('fs');
  const file = path.join(process.cwd(), `vv_data_${phoneNumber.replace(/\D/g, '')}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
}

async function deleteContactSession(phoneNumber, targetJid) {
  if (dbType === 'upstash') return impl.deleteContactSession(phoneNumber, targetJid);
  console.log(`[STORAGE] deleteContactSession not supported for ${dbType} (${targetJid})`);
  return 0;
}

async function cleanupStaleSessions(activeNumbers) {
  const set = new Set(activeNumbers);
  if (dbType === 'upstash') {
    let cursor = 0;
    do {
      const [next, keys] = await impl.getRedis().scan(cursor, { match: 'auth:creds:*', count: 100 });
      cursor = parseInt(next);
      for (const k of keys) {
        const num = k.replace('auth:creds:', '');
        if (!set.has(num)) {
          await impl.deleteAuthSession(num);
          console.log(`[STORAGE] cleaned stale upstash session: ${num}`);
        }
      }
    } while (cursor !== 0);
  } else if (dbType === 'postgres') {
    const stored = await impl.getStoredPhoneNumbers();
    for (const num of stored) {
      if (!set.has(num)) {
        await impl.deleteAuthSession(num);
        console.log(`[STORAGE] cleaned stale postgres session: ${num}`);
      }
    }
  }
}

module.exports = {
  initBackend,
  getType,
  useAuthState,
  deleteAuthSession,
  getStoredPhoneNumbers,
  loadBotState,
  saveBotState,
  deleteContactSession,
  cleanupStaleSessions,
};
