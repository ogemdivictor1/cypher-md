const { Pool } = require('pg');
const { initAuthCreds, BufferJSON } = require('@lordmega/baileys');

let pool;

function initDb(connectionString) {
  pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, ssl: { rejectUnauthorized: false } });
  return pool;
}

async function setupTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_creds (
      phone_number TEXT PRIMARY KEY,
      creds JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auth_keys (
      phone_number TEXT NOT NULL,
      key_type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (phone_number, key_type, key_id)
    );
    CREATE TABLE IF NOT EXISTS bot_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function usePostgresAuthState(phoneNumber) {
  const { rows: [credsRow] } = await pool.query(
    'SELECT creds FROM auth_creds WHERE phone_number = $1', [phoneNumber]
  );
  let creds = credsRow ? JSON.parse(JSON.stringify(credsRow.creds), BufferJSON.reviver) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const { rows } = await pool.query(
          'SELECT key_id, value FROM auth_keys WHERE phone_number = $1 AND key_type = $2 AND key_id = ANY($3)',
          [phoneNumber, type, ids]
        );
        const result = {};
        for (const row of rows) result[row.key_id] = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
        return result;
      },
      set: async (data) => {
        for (const type in data) {
          for (const id in data[type]) {
            const value = JSON.parse(JSON.stringify(data[type][id]), BufferJSON.reviver);
            await pool.query(
              `INSERT INTO auth_keys (phone_number, key_type, key_id, value)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (phone_number, key_type, key_id)
               DO UPDATE SET value = $4::jsonb, updated_at = NOW()`,
              [phoneNumber, type, id, JSON.stringify(value, BufferJSON.replacer)]
            );
          }
        }
      }
    }
  };

  const saveCreds = async () => {
    await pool.query(
      `INSERT INTO auth_creds (phone_number, creds)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (phone_number)
       DO UPDATE SET creds = $2::jsonb, updated_at = NOW()`,
      [phoneNumber, JSON.stringify(creds, BufferJSON.replacer)]
    );
  };

  return { state, saveCreds };
}

async function loadSettings() {
  const { rows } = await pool.query('SELECT key, value FROM bot_data');
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

async function saveSetting(key, value) {
  await pool.query(
    `INSERT INTO bot_data (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key)
     DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function deleteAuthSession(phoneNumber) {
  await pool.query('DELETE FROM auth_creds WHERE phone_number = $1', [phoneNumber]);
  await pool.query('DELETE FROM auth_keys WHERE phone_number = $1', [phoneNumber]);
}

async function getStoredPhoneNumbers() {
  const { rows } = await pool.query('SELECT phone_number FROM auth_creds');
  return rows.map(r => r.phone_number);
}

module.exports = { initDb, setupTables, usePostgresAuthState, loadSettings, saveSetting, deleteAuthSession, getStoredPhoneNumbers, getPool: () => pool };