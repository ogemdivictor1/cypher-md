const { Redis } = require('@upstash/redis');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

let redis;

function initRedis(url, token) {
  url = (url || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  token = (token || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  if (!url.startsWith('https://')) throw new Error(`Invalid Redis URL: "${url}"`);
  if (!token) throw new Error('Redis token is empty after sanitization');
  redis = new Redis({ url, token });
  return redis;
}

async function useUpstashAuthState(phoneNumber) {
  const credsKey = `auth:creds:${phoneNumber}`;

  const raw = await redis.get(credsKey);
  let creds = raw ? JSON.parse(JSON.stringify(raw), BufferJSON.reviver) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const keys = ids.map(id => `auth:key:${phoneNumber}:${type}:${id}`);
        const values = await redis.mget(...keys);
        const result = {};
        for (let i = 0; i < ids.length; i++) {
          if (values[i] != null) {
            result[ids[i]] = JSON.parse(JSON.stringify(values[i]), BufferJSON.reviver);
          }
        }
        return result;
      },
      set: async (data) => {
        const pipeline = redis.pipeline();
        for (const type in data) {
          for (const id in data[type]) {
            const value = JSON.parse(JSON.stringify(data[type][id]), BufferJSON.reviver);
            const key = `auth:key:${phoneNumber}:${type}:${id}`;
            pipeline.set(key, JSON.stringify(value, BufferJSON.replacer));
          }
        }
        await pipeline.exec();
      }
    }
  };

  const saveCreds = async () => {
    await redis.set(credsKey, JSON.stringify(creds, BufferJSON.replacer));
  };

  return { state, saveCreds };
}

async function loadSettings() {
  const keys = await redis.keys('bot:setting:*');
  if (!keys.length) return {};
  const values = await redis.mget(...keys);
  const settings = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].replace('bot:setting:', '');
    settings[key] = values[i];
  }
  return settings;
}

async function saveSetting(key, value) {
  await redis.set(`bot:setting:${key}`, value);
}

async function deleteAuthSession(phoneNumber) {
  const pattern = `auth:key:${phoneNumber}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
  await redis.del(`auth:creds:${phoneNumber}`);
}

async function deleteContactSession(phoneNumber, targetJid) {
  const pattern = `auth:key:${phoneNumber}:session:*${targetJid.replace(/[^0-9]/g, '')}*`;
  const keys = await redis.keys(pattern);
  const lidPattern = `auth:key:${phoneNumber}:lid-mapping:*${targetJid.replace(/[^0-9]/g, '')}*`;
  const lidKeys = await redis.keys(lidPattern);
  const allKeys = [...keys, ...lidKeys];
  if (allKeys.length) {
    await redis.del(...allKeys);
    console.log(`[REDIS] deleted ${allKeys.length} session keys for ${targetJid}`);
  } else {
    console.log(`[REDIS] no session keys for ${targetJid}`);
  }
  return allKeys.length;
}

async function getStoredPhoneNumbers() {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const keys = await redis.keys('auth:creds:*');
      return keys.map(k => k.replace('auth:creds:', ''));
    } catch (err) {
      lastErr = err;
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { initRedis, useUpstashAuthState, loadSettings, saveSetting, deleteAuthSession, deleteContactSession, getStoredPhoneNumbers, getRedis: () => redis };
