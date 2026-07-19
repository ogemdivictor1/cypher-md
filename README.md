# CYPHER MD

> **SEE IT. TOUCH IT. OBTAIN IT.**

A multi-device WhatsApp bot powered by [Baileys](https://github.com/WhiskeySockets/Baileys). Supports up to **5 unique phone numbers** simultaneously, with a web-based pairing UI, admin panel, and full command suite.

---

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Admin Panel](#admin-panel)
- [Auth Backends](#auth-backends)
- [Commands](#commands)
- [Features](#features)
  - [Anti-Link](#anti-link)
  - [Anti-Status](#anti-status)
  - [Anti-Spam](#anti-spam)
  - [View-Once (VV) Handling](#view-once-vv-handling)
  - [AI Chat](#ai-chat)
  - [Message Monitoring](#message-monitoring)
  - [Delete Detection](#delete-detection)
- [5-Number Limit](#5-number-limit)
- [ID & JID System](#id--jid-system)
- [Admin Determination](#admin-determination)
- [Reconnection Logic](#reconnection-logic)
- [State Persistence](#state-persistence)
- [Cache & Stale Session Cleanup](#cache--stale-session-cleanup)
- [Custom Patches](#custom-patches)
- [File Structure](#file-structure)
- [Environment Variables](#environment-variables)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              Node.js Process                  │
│                                                │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│  │ Bot #1   │   │ Bot #2   │   │ Bot #5   │  │
│  │ (Baileys)│   │ (Baileys)│   │ (Baileys)│  │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘  │
│       │              │              │         │
│  ┌────┴──────────────┴──────────────┴────┐    │
│  │         connections Map              │    │
│  │         sessions Map                 │    │
│  └──────────────────────────────────────┘    │
│       │                                      │
│  ┌────┴──────────────────────────────────┐   │
│  │        Express + Socket.IO            │   │
│  │  /admin  /status  WebSocket events    │   │
│  └───────────────────────────────────────┘   │
│       │                                      │
│  ┌────┴──────────────────────────────────┐   │
│  │     src/storage.js (unified layer)    │   │
│  │  Upstash Redis  │  PostgreSQL  │ File │   │
│  └───────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

- **Single process** manages multiple Baileys socket instances — one per phone number
- All instances share the same memory space, connected via Express/Socket.IO to the web frontend
- Auth state stored via `src/storage.js` — auto-detects backend from env vars: Upstash Redis, PostgreSQL (Supabase/Neon), or local files

---

## Quick Start

```bash
npm install

# Configure auth backend via .env (see below)

npm start
```

Open `http://localhost:3000`, enter a phone number (`234XXXXXXXXXX`), enter the pairing code in WhatsApp > Linked Devices.

### Pairing Flow

1. Frontend sends `request-code` via Socket.IO
2. Server validates phone format and 5-number limit
3. **If the number was previously paired**: old socket is disconnected, old session wiped from DB, fresh pairing starts
4. Temp pairing socket generates a code → user enters in WhatsApp
5. On success, production socket starts and listens for commands

---

## Admin Panel

**URL**: `http://your-host:3000/admin`

**Credentials** (hardcoded in `src/server.js:35-36`):
- Username: `cypher2dwrld` / Password: `4265803791`

- Dashboard with live connection status per number
- Unpair: removes number, disconnects socket, deletes auth from backend
- Auto-refresh every 10s

### API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/admin/login` | POST | No | Accepts `{ username, password }`, returns auth cookie |
| `/admin/logout` | POST | No | Clears auth cookie |
| `/admin` | GET | Cookie | Serves admin dashboard |
| `/admin/login` | GET | No | Serves login page (redirects if authed) |
| `/admin/api/numbers` | GET | Cookie | Returns `{ numbers[], allowed[], maxAllowed }` |
| `/admin/api/unpair/:number` | POST | Cookie | Unpairs a number |

---

## Auth Backends

Auto-detected from environment variables by `src/storage.js`:

1. **Upstash Redis** — `UPSTASH_REDIS_URL` + `UPSTASH_REDIS_TOKEN`
2. **PostgreSQL** — `DATABASE_URL` (works with Supabase, Neon, any Postgres)
3. **Local files** — fallback (`auth_info/{phoneNumber}/`)

No config changes needed to switch — just set the right env vars.

### Redis Key Schema

```
auth:creds:{phoneNumber}            → credentials JSON
auth:key:{phoneNumber}:{type}:{id}  → session keys
bot:state:{phoneNumber}             → bot state (future use)
```

### PostgreSQL Schema

```sql
auth_creds(phone_number PK, creds JSONB, updated_at)
auth_keys(phone_number PK, key_type PK, key_id PK, value JSONB, updated_at)
bot_data(key PK, value JSONB, updated_at)
```

### File-Based Schema

```
auth_info/{phoneNumber}/
  creds.json
  session-{id}.json
vv_data_{number}.json   → bot state (monitored numbers, AI config, etc.)
```

---

## Commands

All commands are prefixed with `.`. Send to the bot's DM or a group where the bot is present.

| Command | Aliases | Admin Only | Description |
|---------|---------|:----------:|-------------|
| `.help` | `.h` | No | Full help text |
| `.menu` | `.m` | No | Compact command list |
| `.ping` | `.p` | No | `ping` → "Pong!" / `ping diag` → resolve all JID variants / `ping blast` → diagnostic send to every JID / `ping raw <jid>` → step-by-step session/send test |
| `.clearsession` | `.cs`, `.clearsig` | No | Deletes session keys for a contact, then re-establishes |
| `.cleardb` | `.wipedb`, `.resetdb` | No | Wipes ALL persistent data per number |
| `.testimg` | — | No | Sends a 1×1 transparent GIF |
| `.time` | — | No | Server time |
| `.reverse` | `.r` | No | Reverses input text |
| `.quote` | — | No | Random motivational quote |
| `.bio` | — | No | Fetches sender's WhatsApp status |
| `.getpp` | — | No | Profile picture of replied/mentioned user |
| `.sticker` | `.s` | No | Converts quoted image to WebP sticker |
| `.toimage` | `.ti` | No | Converts sticker to PNG |
| `.runtime` | `.uptime` | No | Bot uptime |
| `.stats` | — | No | Command stats, group count, memory |
| `.vv` | — | No | Reveal quoted view-once message |
| `.ghost` | — | No | View-once image with custom text |
| `.monitor` | `.mon` | No | Manage watched numbers |
| `.aichat` | `.ai` | No | AI management suite |
| `.play` | `.song`, `.yt`, `.audio` | No | Search & download YouTube audio |
| `.id` | `.jid` | No | Shows JID of current chat or user |
| `.tagall` | `.tag`, `.everyone` | No | Tags all group members |
| `.kick` | — | **Yes** | Remove group member |
| `.ban` | — | **Yes** | Alias for kick |
| `.warn` | — | **Yes** | Warn user (3 strikes → kick) |
| `.unwarn` | — | **Yes** | Remove warning |
| `.promote` | `.admin` | **Yes** | Promote to group admin |
| `.demote` | — | **Yes** | Demote from group admin |
| `.delete` | `.del` | **Yes** | Delete quoted message |
| `.mute` | — | **Yes** | Group announcement mode |
| `.unmute` | — | **Yes** | Disable announcement mode |
| `.antilink` | `.al` | **Yes** | Toggle anti-link per group |
| `.antistatus` | `.as` | **Yes** | Toggle anti-status per group |

> **Admin Only** = bot must be a group admin AND sender must be a group admin. Bot owner bypasses all checks.

---

## Features

### Anti-Link

Enforced in groups where `.antilink on` is active. Bot must be a group admin.

**Detection**: Checks message body for URLs (`http://`, `https://`, `www.`, `chat.whatsapp.com`). Parses hostname against a whitelist.

**Whitelist** (extendable via `.antilink whitelist add/remove`):
```
youtube.com, youtu.be, google.com, github.com, wa.me
```

**Enforcement**:
1. Deletes offending message
2. Increments warning count (keyed by `group:sender`)
3. At **5 warnings** → auto-kick
4. Below limit → warning with remaining count

**Admin bypass**: bot owner and group admins exempt.

### Anti-Status

Enforced in groups where `.antistatus on` is active.

**Detection**: Checks `msg.message?.groupStatusMentionMessage` on the raw message. `msg.key.participant` = uploader's JID.

**Enforcement**:
- Tracks `<group>:<sender>:<date>` counts
- **3 strikes per day** → auto-kick
- Counter resets daily (date-based key)

### Anti-Spam

**Detection**: Per-user message timestamps within a **4-second window**. More than **5 messages** → flagged.

**Enforcement**:
- **In DMs**: blocks sender via `conn.blockUser()`
- **In groups**: warning count system, same 5-strike limit as anti-link

### View-Once (VV) Handling

Four layers:

1. **`.vv` command** — manual reveal via `conn.rvo()` or `downloadMediaMessage()`
2. **`???` secret owner reveal** — owner replies `???` to a VV, content sent to owner's DM only
3. **Monitored number auto-reveal** — monitored numbers' VVs auto-forwarded to owner
4. **Patch-level detection** — linked device stanza fix and VV send `mediatype` fix (see Custom Patches)

### AI Chat

Powered by [Groq](https://groq.com) using `llama-3.3-70b-versatile`.

```
.aichat key gsk_your_key       # Set API key
.aichat add 2348012345678       # Enable AI replies for this number
.aichat addgc                   # Enable AI in current group
.aichat system Your prompt      # Custom system prompt
.aichat clear                   # Reset all AI data
```

History maintained per conversation, pruned to last 20 messages every 5 minutes.

### Message Monitoring

`.monitor add <number>` adds a number to the watchlist. All messages are:
1. Stored in `messageStore` (capped at 5000)
2. View-once content auto-revealed and forwarded
3. Deletions detected and forwarded to owner

### Delete Detection

When someone deletes a message (`protocolMessage.type === 0`), the bot forwards the original content from `messageStore` to the owner's DM.

---

## 5-Number Limit

Hard limit of **5 unique phone numbers** (`MAX_ALLOWED_NUMBERS = 5` in `src/server.js:11`).

- New numbers rejected if 5 already in `allowed_numbers.json`
- Numbers already in the list can re-pair freely — old session is wiped from DB, fresh pairing starts
- Admin unpair removes from list, disconnects, and deletes auth from backend

---

## ID & JID System

| Format | Example | Description |
|--------|---------|-------------|
| Phone JID | `2348012345678@s.whatsapp.net` | Standard phone-based identifier |
| LID | `1234567890@lid` | LinkedIn-like ID; newer accounts |
| Group JID | `1234567890-123456@g.us` | Group identifier |

**Normalization** (`normalizeJid()`): strips non-digit characters → numeric portion only.

**LID Resolution** (`resolveJid()`): checks `lidToPhone` cache, falls back to `conn.findUserId()`.

**JID Variant Resolution** (`resolveAllJids()`): resolves ALL known variants of a JID for diagnostic purposes (used by `.ping diag` / `.ping blast`).

---

## Admin Determination

Uses `areJidsSameUser()` from Baileys, comparing against **both** `conn.user.id` (phone JID) and `conn.user.lid` (LID). Applied in all 3 admin check sites: permission block, antilink toggle, antilink enforcement bypass.

---

## Reconnection Logic

| Reason | Meaning | Behavior |
|:------:|---------|----------|
| **428** | Bad session | Counts consecutive. ≥3 → deletes session and gives up |
| **408/503** | Transient | Reconnects without purging |
| **515** | Stream error | Records timestamp, reconnects |
| **401** (`loggedOut`) | Session invalidated | Purges session from backend, gives up |
| `connectionReplaced` | Another client | Steps aside, keeps session |
| Other | Unknown | Reconnects with backoff |

### Reconnect Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `RECONNECT_MAX_ATTEMPTS` | 5 | Gives up and purges stale session after this many |
| `RECONNECT_BASE_DELAY` | 10s | Initial delay |
| `RECONNECT_MAX_DELAY` | 300s | Maximum delay cap |
| Jitter | ±30% | Random jitter applied to each delay |

After max attempts, the stale session is purged from the database.

---

## Audio Download (`.play` / `.song`)

Downloads YouTube audio and sends it as a WhatsApp audio message.

**Search**: Uses `yt-search` for video lookup by name or handles direct YouTube URLs.

**Download**: Uses the `yt-dlp` binary (bundled via `youtube-dl-exec`) spawned via `child_process.execFile`.

**MIME auto-detection**: The raw buffer is inspected for magic bytes to determine the format (`audio/webm` for Opus, `audio/mpeg` for MP3, `audio/mp4` for AAC/M4A), and the correct mimetype is sent.

> **Render / cloud deployments**: YouTube may flag datacenter IPs and return `"Sign in to confirm you're not a bot"`. Set `YOUTUBE_COOKIES` to a Netscape-format cookies file exported from a logged-in browser. See [yt-dlp cookie FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).

### ⚠️ The Saga (What Didn't Work First)

YouTube keeps changing their anti-scraping mechanisms. Every library we tried eventually broke:

**Attempt 1 — Cobalt API** (`api.cobalt.tools`)
- Search worked via `yt-search`. Cobalt returned `400 error.api.auth.jwt.missing`.
- The public API now requires a JWT auth token (Turnstile) — not usable without self-hosting.

**Attempt 2 — `@distube/ytdl-core`** (`highestaudio`)
- Audio extracted but immediately failed with `connectionReplaced` at the Baileys layer.
- Switching to `lowestaudio` still hit `403` — the library couldn't parse YouTube's new player cipher/n-transform functions.

**Attempt 3 — `youtube-dl-exec` / yt-dlp** (raw binary)
- yt-dlp needed Python at runtime on Render, plus YouTube started requiring a signed-in session.
- Ran into `"sign in to confirm you're not a bot"` blocks.

**Attempt 4 — `youtubei.js`** (recommended approach)
- Pure JS InnerTube client — no binary, no cookies. Search worked beautifully.
- **BUT**: YouTube changed their API response to send `"url": false` and `"cipher": false` for **all** formats. No download URL anywhere.
- Confirmed by scraping raw `ytInitialPlayerResponse` from the watch page — same result. YouTube now only hands out URLs through ABR segment streaming.
- `youtubei.js`'s `download()` throws `"No valid URL to decipher"`. Both `@distube/ytdl-core` and `play-dl` hit the same wall.

**Attempt 5 — `play-dl`** (yet another JS extractor)
- Same fundamental issue: YouTube changed the API response format. All formats returned `url: false`.

### ✅ What Finally Worked

Stick with the **bundled `yt-dlp` binary** (shipped by `youtube-dl-exec`) called via `child_process.execFile`:

```
yt-dlp.exe <URL> --extract-audio --no-check-certificates --no-warnings --quiet -o -
```

- yt-dlp handles YouTube's ABR streaming, cipher changes, and format negotiation internally.
- The `--extract-audio` flag picks the best audio-only stream (Opus in WebM container).
- Binary output piped to stdout, buffered, MIME-detected, and sent via WhatsApp.
- Works on Render (Linux binary auto-downloads via `youtube-dl-exec` postinstall).
- Falls back to `YT_DLP_PATH` env var if the binary is installed elsewhere.

### MIME Detection

```js
function audioMime(buf) {
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';      // MP3
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg';  // ID3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';  // WebM
  if (ftyp magic) return 'audio/mp4';  // MP4
  return 'audio/mpeg';  // fallback
}
```

---

## State Persistence

### WhatsApp Auth State

Stored in the auto-detected backend (Upstash Redis / PostgreSQL / files). Managed by `src/storage.js` which delegates to the appropriate backend.

### Bot State

Per-number configuration saved to `vv_data_{number}.json` (file-based for simplicity):

| Data | Serialized As |
|------|---------------|
| `monitoredNumbers` | Array |
| `aiTargets` / `aiGroups` | Array |
| `groqApiKey` / `aiSystemPrompt` | String |
| `antilinkEnabled` / `antistatusEnabled` | Array |
| `antilinkWarnings` / `antistatusCounts` / `warnings` | Object |
| `lidToPhone` | Object (global cache) |

Bot state DB functions (`loadBotState`/`saveBotState`) exist in both backends for future migration.

---

## Cache & Stale Session Cleanup

### Quick Pruning (every 5 min)

| Cache | Rule |
|-------|------|
| `spamTracker` | Removes timestamps older than 60s |
| `groupMetaCache` | Removes entries older than 30s |
| `messageStore` | Removes entries older than 24h |
| `antistatusCounts` | Removes previous days |
| `aiConversations` | Keeps last 20 messages per thread |
| `processedMessages` | Caps at 2000 entries |

### Deep Cleanup (every 6 hours)

1. **`auth_info/` folders** — deletes for unconnected numbers older than 3 days
2. **`vv_data_*.json` files** — deletes for unconnected numbers older than 3 days
3. **`lidToPhone` map** — purges entries not linked to any active connection
4. **DB/Redis sessions** — removes auth credentials for numbers no longer active

---

## Why Two Baileys?

The bot uses **two** Baileys packages simultaneously:

| Package | Where | Role |
|---------|-------|------|
| `@lordmega/baileys` | `bot.js`, `storage.js` | **Production runtime** — receives all custom patches (LID addressing, VV detection, VV mediatype). Main message processing and command execution runs through this fork. |
| `@whiskeysockets/baileys` | `pair.js`, `redis.js`, `db.js` | **Pairing & utilities only** — the upstream official package. Used for the pairing code flow, `BufferJSON`, `initAuthCreds`, `Browsers`. Kept clean to avoid re-applying patches in a second location and to prevent pairing from breaking if a patch introduces side effects. |

**The handoff** (`src/pair.js:95-105`): The pairing socket (upstream) generates credentials → saves them → the shared `state` object is passed to the production socket (fork) which picks it up and starts listening for commands. Both never run on the same connection at the same time.

---

## Custom Patches

Three patches applied to `node_modules/@lordmega/baileys`. Documented in `AGENTS.md`. Must be **re-applied after** `npm update @lordmega/baileys`.

### 1. LID Addressing for 1:1 Sends
Adds `addressing_mode: 'lid'` and `recipient_pn` when sending to LID contacts.  
**Upstream**: WhiskeySockets/Baileys PR [#2692](https://github.com/WhiskeySockets/Baileys/pull/2692)

### 2. View-Once Detection on Stanza 1 (Enc)
Sets `key.isViewOnce` on the first stanza for linked device VVs.  
**Upstream**: WhiskeySockets/Baileys PR [#2435](https://github.com/WhiskeySockets/Baileys/pull/2435)

### 3. `mediatype` Attribute for VV Sends
Unwraps `viewOnceMessage` in `getMediaType()` so `mediatype` is populated for VV sends.  
**Upstream**: Same PR as above.

---

## File Structure

```
├── src/
│   ├── server.js              # Express + Socket.IO server, admin, pairing (224 lines)
│   ├── bot.js                 # Core bot: commands, connection mgmt, anti-x, AI, VV (1904 lines)
│   ├── pair.js                # WhatsApp pairing code flow (119 lines)
│   ├── storage.js             # Unified storage abstraction — auto-detects backend (142 lines)
│   ├── redis.js               # Upstash Redis auth backend (124 lines)
│   ├── db.js                  # PostgreSQL auth backend (127 lines)
│   └── session-sweeper.js     # Periodic stale session cleaner (not wired)
├── public/
│   ├── index.html             # Pairing UI with Matrix rain + PWA
│   ├── admin.html             # Admin dashboard
│   ├── admin-login.html       # Admin login page
│   ├── manifest.json / sw.js  # PWA support
│   └── icon.svg               # PWA icon
├── allowed_numbers.json       # Whitelist of up to 5 numbers (auto-created)
├── AGENTS.md                  # Custom patch documentation
├── .env                       # Environment variables
└── package.json
```

---

## Environment Variables

```env
# Upstash Redis (takes priority)
UPSTASH_REDIS_URL=https://your-instance.upstash.io
UPSTASH_REDIS_TOKEN=your_token_here

# OR PostgreSQL / Supabase (used if Upstash not set)
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# OR neither → file-based auth

# YouTube cookies file (Netscape format) — required for .play on Render/bots
# Export from browser: https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
YOUTUBE_COOKIES=/path/to/cookies.txt

# Custom yt-dlp binary path (auto-detected if not set)
YT_DLP_PATH=/opt/render/project/src/node_modules/youtube-dl-exec/bin/yt-dlp
```

---

## Dependency Notes

| Package | Where Used | Purpose |
|---------|-----------|---------|
| `@lordmega/baileys` | `bot.js`, `storage.js` | Primary WhatsApp library (patched fork) |
| `@whiskeysockets/baileys` | `pair.js`, `redis.js`, `db.js` | Upstream for `BufferJSON`, `initAuthCreds`, `Browsers` |
| `@upstash/redis` | `redis.js` | Upstash Redis HTTP client |
| `pg` | `db.js` | PostgreSQL client |
| `socket.io` | `server.js`, `index.html` | Real-time frontend |
| `sharp` | `bot.js` | Image processing |
| `express` | `server.js` | Web server |
| `pino` | `bot.js`, `pair.js` | Logging (silent mode) |
| `@hapi/boom` | `bot.js`, `pair.js` | Error code extraction |
| `dotenv` | `server.js` | .env file loading |
| `yt-search` | `bot.js` | YouTube video search |
| `youtube-dl-exec` | `bot.js` | Bundles `yt-dlp` binary for audio download |
| `@distube/ytdl-core` | `bot.js` (removed) | Failed: couldn't parse YouTube player cipher |
| `youtubei.js` | `bot.js` (removed) | Failed: YouTube returns `url: false` for all formats |
| `play-dl` | `bot.js` (removed) | Failed: same API format issue as youtubei.js |
