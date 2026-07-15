const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const BACKENDS = { UPSTASH: 'upstash', POSTGRES: 'postgres', FILE: 'file' };

class SessionStore {
  constructor(config = {}) {
    this.backend = config.backend || BACKENDS.FILE;
    this.logger = config.logger || console;
    this.basePath = config.basePath || path.join(process.cwd(), 'auth_sessions');
    this.redis = config.redis || null;
    this.pgPool = config.pgPool || null;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async init() {
    if (this.backend === BACKENDS.POSTGRES && this.pgPool) {
      await this.pgPool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id   TEXT PRIMARY KEY,
          phone_number TEXT NOT NULL,
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          updated_at   TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS session_creds (
          session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
          creds      JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS session_keys (
          session_id TEXT   NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          key_type   TEXT   NOT NULL,
          key_id     TEXT   NOT NULL,
          value      JSONB  NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (session_id, key_type, key_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_phone ON sessions(phone_number);
        CREATE INDEX IF NOT EXISTS idx_session_updated ON sessions(updated_at);
      `);
    }
    if (this.backend === BACKENDS.FILE) {
      await fs.mkdir(path.join(this.basePath, 'sessions'), { recursive: true });
      await fs.mkdir(path.join(this.basePath, 'phone_index'), { recursive: true });
    }
    this.logger.info(`[SessionStore] initialized (backend=${this.backend})`);
  }

  // ── Session CRUD ───────────────────────────────────────────

  generateId() {
    return crypto.randomUUID();
  }

  async createSession(phoneNumber, creds = null) {
    const sessionId = this.generateId();
    const now = new Date().toISOString();

    await this._setMeta(sessionId, { phoneNumber, createdAt: now, updatedAt: now });
    await this._setCreds(sessionId, creds || initAuthCreds());
    await this._setPhoneIndex(phoneNumber, sessionId);

    this.logger.info(`[SessionStore] created session ${sessionId.slice(0, 8)}… for ${phoneNumber}`);
    return sessionId;
  }

  async loadSession(phoneNumber) {
    let sessionId = await this._getPhoneIndex(phoneNumber);

    // ── Legacy migration: no sessionId index yet → check old key format ──
    if (!sessionId) {
      sessionId = await this._migrateLegacy(phoneNumber);
      if (!sessionId) return null;
    }

    const meta = await this._getMeta(sessionId);
    if (!meta) return null;

    await this._touchMeta(sessionId);
    return sessionId;
  }

  async deleteSession(sessionId) {
    const meta = await this._getMeta(sessionId);
    if (!meta) return;

    await this._delPhoneIndex(meta.phoneNumber);

    if (this.backend === BACKENDS.UPSTASH) {
      await this.redis.del(`session:meta:${sessionId}`);
      await this.redis.del(`auth:creds:${sessionId}`);
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, {
          match: `auth:key:${sessionId}:*`,
          count: 100,
        });
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } else if (this.backend === BACKENDS.POSTGRES) {
      await this.pgPool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
    } else {
      await fs.rm(path.join(this.basePath, 'sessions', this._sanitize(sessionId)), {
        recursive: true,
        force: true,
      });
    }

    this.logger.info(`[SessionStore] deleted session ${sessionId.slice(0, 8)}… (phone=${meta.phoneNumber})`);
  }

  async listSessions() {
    const sessions = [];

    if (this.backend === BACKENDS.UPSTASH) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, {
          match: 'session:meta:*',
          count: 100,
        });
        cursor = next;
        for (const k of keys) {
          const raw = await this.redis.get(k);
          if (raw) sessions.push({ sessionId: k.replace('session:meta:', ''), ...raw });
        }
      } while (cursor !== '0');
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT session_id, phone_number, created_at, updated_at FROM sessions ORDER BY updated_at DESC'
      );
      sessions.push(...rows.map(r => ({
        sessionId: r.session_id,
        phoneNumber: r.phone_number,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })));
    } else {
      const dir = path.join(this.basePath, 'sessions');
      let entries;
      try { entries = await fs.readdir(dir); } catch { return []; }
      for (const entry of entries) {
        try {
          const raw = await fs.readFile(path.join(dir, entry, 'meta.json'), 'utf8');
          const meta = JSON.parse(raw);
          sessions.push({ sessionId: entry, ...meta });
        } catch { /* skip corrupt */ }
      }
    }

    return sessions;
  }

  // ── Baileys auth state factory ─────────────────────────────

  async getBaileysAuthState(sessionId) {
    const creds = await this._getCreds(sessionId);

    const store = this;

    const state = {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids || !ids.length) return {};
          return store._getKeys(sessionId, type, ids);
        },
        set: async (data) => {
          await store._setKeys(sessionId, data);
        },
      },
    };

    const saveCreds = async () => {
      await store._setCreds(sessionId, creds);
      await store._touchMeta(sessionId);
    };

    return { state, saveCreds };
  }

  // ── Stale session sweep ────────────────────────────────────

  async sweepStale(maxAgeMs = 2 * 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    let staleIds = [];

    if (this.backend === BACKENDS.UPSTASH) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, {
          match: 'session:meta:*',
          count: 100,
        });
        cursor = next;
        for (const k of keys) {
          const raw = await this.redis.get(k);
          if (raw && raw.updatedAt < cutoff) {
            staleIds.push(k.replace('session:meta:', ''));
          }
        }
      } while (cursor !== '0');
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        "SELECT session_id FROM sessions WHERE updated_at < $1",
        [cutoff]
      );
      staleIds = rows.map(r => r.session_id);
    } else {
      const dir = path.join(this.basePath, 'sessions');
      let entries;
      try { entries = await fs.readdir(dir); } catch { return 0; }
      for (const entry of entries) {
        try {
          const raw = await fs.readFile(path.join(dir, entry, 'meta.json'), 'utf8');
          const meta = JSON.parse(raw);
          if (meta.updatedAt < cutoff) staleIds.push(entry);
        } catch { /* skip */ }
      }
    }

    for (const sid of staleIds) {
      await this.deleteSession(sid);
    }

    if (staleIds.length > 0) {
      this.logger.info(`[SessionStore] sweep: deleted ${staleIds.length} stale session(s)`);
    }
    return staleIds.length;
  }

  // ── Internal: Meta ─────────────────────────────────────────

  async _setMeta(sessionId, meta) {
    if (this.backend === BACKENDS.UPSTASH) {
      await this.redis.set(`session:meta:${sessionId}`, meta);
    } else if (this.backend === BACKENDS.POSTGRES) {
      await this.pgPool.query(
        `INSERT INTO sessions (session_id, phone_number, created_at, updated_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_id)
         DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [sessionId, meta.phoneNumber, meta.createdAt, meta.updatedAt]
      );
    } else {
      const dir = path.join(this.basePath, 'sessions', this._sanitize(sessionId));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    }
  }

  async _getMeta(sessionId) {
    if (this.backend === BACKENDS.UPSTASH) {
      return this.redis.get(`session:meta:${sessionId}`);
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT session_id, phone_number, created_at, updated_at FROM sessions WHERE session_id = $1',
        [sessionId]
      );
      if (!rows.length) return null;
      const r = rows[0];
      return { phoneNumber: r.phone_number, createdAt: r.created_at, updatedAt: r.updated_at };
    } else {
      try {
        const raw = await fs.readFile(
          path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'meta.json'),
          'utf8'
        );
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }

  async _touchMeta(sessionId) {
    const now = new Date().toISOString();
    if (this.backend === BACKENDS.UPSTASH) {
      const meta = await this.redis.get(`session:meta:${sessionId}`);
      if (meta) {
        meta.updatedAt = now;
        await this.redis.set(`session:meta:${sessionId}`, meta);
      }
    } else if (this.backend === BACKENDS.POSTGRES) {
      await this.pgPool.query(
        'UPDATE sessions SET updated_at = $2 WHERE session_id = $1',
        [sessionId, now]
      );
    } else {
      const p = path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'meta.json');
      try {
        const raw = await fs.readFile(p, 'utf8');
        const meta = JSON.parse(raw);
        meta.updatedAt = now;
        await fs.writeFile(p, JSON.stringify(meta));
      } catch { /* best-effort */ }
    }
  }

  // ── Internal: Creds ────────────────────────────────────────

  async _setCreds(sessionId, creds) {
    const data = JSON.parse(JSON.stringify(creds), BufferJSON.reviver);
    if (this.backend === BACKENDS.UPSTASH) {
      await this.redis.set(`auth:creds:${sessionId}`, JSON.stringify(data, BufferJSON.replacer));
    } else if (this.backend === BACKENDS.POSTGRES) {
      await this.pgPool.query(
        `INSERT INTO session_creds (session_id, creds)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (session_id)
         DO UPDATE SET creds = $2::jsonb, updated_at = NOW()`,
        [sessionId, JSON.stringify(data, BufferJSON.replacer)]
      );
    } else {
      const p = path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'creds.json');
      await fs.writeFile(p, JSON.stringify(data, BufferJSON.replacer));
    }
  }

  async _getCreds(sessionId) {
    if (this.backend === BACKENDS.UPSTASH) {
      const raw = await this.redis.get(`auth:creds:${sessionId}`);
      return raw ? JSON.parse(JSON.stringify(raw), BufferJSON.reviver) : initAuthCreds();
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT creds FROM session_creds WHERE session_id = $1',
        [sessionId]
      );
      return rows.length
        ? JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver)
        : initAuthCreds();
    } else {
      try {
        const raw = await fs.readFile(
          path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'creds.json'),
          'utf8'
        );
        return JSON.parse(raw, BufferJSON.reviver);
      } catch {
        return initAuthCreds();
      }
    }
  }

  // ── Internal: Keys ─────────────────────────────────────────

  async _getKeys(sessionId, type, ids) {
    const result = {};

    if (this.backend === BACKENDS.UPSTASH) {
      const keys = ids.map(id => `auth:key:${sessionId}:${type}:${id}`);
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < ids.length; i++) {
        if (values[i] != null) {
          result[ids[i]] = JSON.parse(JSON.stringify(values[i]), BufferJSON.reviver);
        }
      }
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT key_id, value FROM session_keys WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)',
        [sessionId, type, ids]
      );
      for (const r of rows) {
        result[r.key_id] = JSON.parse(JSON.stringify(r.value), BufferJSON.reviver);
      }
    } else {
      const dir = path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'keys', type);
      for (const id of ids) {
        try {
          const raw = await fs.readFile(path.join(dir, `${this._sanitize(id)}.json`), 'utf8');
          result[id] = JSON.parse(raw, BufferJSON.reviver);
        } catch { /* key may not exist */ }
      }
    }

    return result;
  }

  async _setKeys(sessionId, data) {
    if (this.backend === BACKENDS.UPSTASH) {
      const pipeline = this.redis.pipeline();
      for (const type in data) {
        for (const id in data[type]) {
          const key = `auth:key:${sessionId}:${type}:${id}`;
          pipeline.set(key, JSON.stringify(data[type][id], BufferJSON.replacer));
        }
      }
      await pipeline.exec();
    } else if (this.backend === BACKENDS.POSTGRES) {
      for (const type in data) {
        for (const id in data[type]) {
          const value = JSON.parse(JSON.stringify(data[type][id]), BufferJSON.reviver);
          await this.pgPool.query(
            `INSERT INTO session_keys (session_id, key_type, key_id, value)
             VALUES ($1,$2,$3,$4::jsonb)
             ON CONFLICT (session_id, key_type, key_id)
             DO UPDATE SET value = $4::jsonb, updated_at = NOW()`,
            [sessionId, type, id, JSON.stringify(value, BufferJSON.replacer)]
          );
        }
      }
    } else {
      for (const type in data) {
        const dir = path.join(this.basePath, 'sessions', this._sanitize(sessionId), 'keys', type);
        await fs.mkdir(dir, { recursive: true });
        for (const id in data[type]) {
          const p = path.join(dir, `${this._sanitize(id)}.json`);
          await fs.writeFile(p, JSON.stringify(data[type][id], BufferJSON.replacer));
        }
      }
    }
  }

  // ── Internal: Phone ↔ sessionId index ──────────────────────

  async _setPhoneIndex(phoneNumber, sessionId) {
    const sanitized = phoneNumber.replace(/[^0-9]/g, '');
    if (this.backend === BACKENDS.UPSTASH) {
      await this.redis.set(`session:phone:${sanitized}`, sessionId);
    } else if (this.backend === BACKENDS.POSTGRES) {
      await this.pgPool.query(
        `INSERT INTO sessions (session_id, phone_number) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,  /* session already has phone_number, this is just a secondary index */
      );
      /* We use the sessions table itself — phone_number is a column there */
    } else {
      const p = path.join(this.basePath, 'phone_index', `${sanitized}.json`);
      await fs.writeFile(p, JSON.stringify({ sessionId }));
    }
  }

  async _getPhoneIndex(phoneNumber) {
    const sanitized = phoneNumber.replace(/[^0-9]/g, '');
    if (this.backend === BACKENDS.UPSTASH) {
      return this.redis.get(`session:phone:${sanitized}`);
    } else if (this.backend === BACKENDS.POSTGRES) {
      /* For PG, we query sessions table for the most recent session for this phone.
         Since createSession inserts a new row, the latest updated_at is the active one. */
      const { rows } = await this.pgPool.query(
        'SELECT session_id FROM sessions WHERE phone_number = $1 ORDER BY updated_at DESC LIMIT 1',
        [sanitized]
      );
      return rows.length ? rows[0].session_id : null;
    } else {
      try {
        const raw = await fs.readFile(
          path.join(this.basePath, 'phone_index', `${sanitized}.json`),
          'utf8'
        );
        return JSON.parse(raw).sessionId;
      } catch {
        return null;
      }
    }
  }

  async _delPhoneIndex(phoneNumber) {
    const sanitized = phoneNumber.replace(/[^0-9]/g, '');
    if (this.backend === BACKENDS.UPSTASH) {
      await this.redis.del(`session:phone:${sanitized}`);
    } else if (this.backend === BACKENDS.POSTGRES) {
      /* session row is already deleted by CASCADE; no separate index to clean */
    } else {
      const p = path.join(this.basePath, 'phone_index', `${sanitized}.json`);
      try { await fs.unlink(p); } catch { /* ok */ }
    }
  }

  // ── Legacy migration ───────────────────────────────────────

  async _migrateLegacy(phoneNumber) {
    const sanitized = phoneNumber.replace(/[^0-9]/g, '');
    let creds = null;

    if (this.backend === BACKENDS.UPSTASH) {
      const raw = await this.redis.get(`auth:creds:${sanitized}`);
      if (!raw) return null;
      creds = JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT creds FROM auth_creds WHERE phone_number = $1',
        [sanitized]
      );
      if (!rows.length) return null;
      creds = JSON.parse(JSON.stringify(rows[0].creds), BufferJSON.reviver);
    } else {
      const folder = path.join(process.cwd(), 'auth_info', sanitized);
      try {
        const credsRaw = await fs.readFile(path.join(folder, 'creds.json'), 'utf8');
        creds = JSON.parse(credsRaw, BufferJSON.reviver);
      } catch {
        return null;
      }
    }

    // Migrate: create session entry, copy keys, then delete old format
    const sessionId = await this.createSession(phoneNumber, creds);

    // Copy keys from legacy to new format
    if (this.backend === BACKENDS.UPSTASH) {
      let cursor = '0';
      const keysToCopy = {};
      do {
        const [next, keys] = await this.redis.scan(cursor, {
          match: `auth:key:${sanitized}:*`,
          count: 100,
        });
        cursor = next;
        for (const k of keys) {
          const val = await this.redis.get(k);
          if (val) {
            const withoutPrefix = k.replace(`auth:key:${sanitized}:`, '');
            const colonIdx = withoutPrefix.indexOf(':');
            const type = withoutPrefix.slice(0, colonIdx);
            const id = withoutPrefix.slice(colonIdx + 1);
            if (!keysToCopy[type]) keysToCopy[type] = {};
            keysToCopy[type][id] = JSON.parse(JSON.stringify(val), BufferJSON.reviver);
          }
        }
      } while (cursor !== '0');
      if (Object.keys(keysToCopy).length) {
        await this._setKeys(sessionId, keysToCopy);
      }
    } else if (this.backend === BACKENDS.POSTGRES) {
      const { rows } = await this.pgPool.query(
        'SELECT key_type, key_id, value FROM auth_keys WHERE phone_number = $1',
        [sanitized]
      );
      const keysToCopy = {};
      for (const r of rows) {
        if (!keysToCopy[r.key_type]) keysToCopy[r.key_type] = {};
        keysToCopy[r.key_type][r.key_id] = JSON.parse(JSON.stringify(r.value), BufferJSON.reviver);
      }
      if (Object.keys(keysToCopy).length) {
        await this._setKeys(sessionId, keysToCopy);
      }
    } else {
      const folder = path.join(process.cwd(), 'auth_info', sanitized);
      const keyDir = path.join(folder, 'keys');
      try {
        const types = await fs.readdir(keyDir);
        for (const type of types) {
          const typeDir = path.join(keyDir, type);
          const ids = await fs.readdir(typeDir);
          for (const idFile of ids) {
            const raw = await fs.readFile(path.join(typeDir, idFile), 'utf8');
            const id = idFile.replace(/\.json$/, '');
            const data = JSON.parse(raw, BufferJSON.reviver);
            await this._setKeys(sessionId, { [type]: { [id]: data } });
          }
        }
      } catch { /* no legacy keys */ }
    }

    // Don't delete legacy data — leave it as a fallback until old code is fully replaced.
    // Delete after confirming migration success in production.
    this.logger.info(`[SessionStore] migrated legacy session for ${phoneNumber} → ${sessionId.slice(0, 8)}…`);

    return sessionId;
  }

  // ── Internal: Helpers ──────────────────────────────────────

  _sanitize(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}

module.exports = { SessionStore, BACKENDS };
