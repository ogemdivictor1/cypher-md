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
- [Session Store (Advanced)](#session-store-advanced)
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
└──────────────────────────────────────────────┘
```

- **Single process** manages multiple Baileys socket instances — one per phone number
- All instances share the same memory space, connected via Express/Socket.IO to the web frontend
- Auth state stored in configurable backends: **Upstash Redis**, **PostgreSQL**, or **local files**

---

## Quick Start

```bash
# Install dependencies
npm install

# Configure auth backend (see below)
# Edit .env for Upstash Redis or set DATABASE_URL for PostgreSQL

# Start the server
npm start

# Open http://localhost:3000 in browser
# Enter phone number (234XXXXXXXXXX format) → click CONNECT
# Enter the pairing code in WhatsApp > Linked Devices
```

### Pairing Flow (detailed)

1. Frontend sends `request-code` via Socket.IO to server
2. Server validates: phone format (`^234\d{10}$`), not already connected, within 5-number limit
3. If the number was previously paired, **any stale session is wiped first** (`src/pair.js:17-26`)
4. Fresh auth state is created (Upstash/Postgres/File)
5. A **temporary** Baileys socket (from `@whiskeysockets/baileys`) connects to WhatsApp
6. After 3s, `conn.requestPairingCode()` generates a pairing code → sent to frontend
7. User enters this code in WhatsApp → temp socket detects `creds.registered`
8. Temp socket is destroyed, `startBot()` creates the **production** socket (from `@lordmega/baileys`)
9. Production socket connects and begins listening for commands

> **Why two Baileys packages?** `@whiskeysockets/baileys` is used ONLY for the ephemeral pairing socket in `src/pair.js`. The main bot sockets in `src/bot.js` use `@lordmega/baileys` (a forked version with critical patches for LID addressing and view-once media). See [Custom Patches](#custom-patches).

### Supported Phone Format

Only Nigerian numbers: `234XXXXXXXXXX` (13 digits starting with 234).

---

## Admin Panel

**URL**: `http://your-host:3000/admin`

**Credentials** (hardcoded in `src/server.js:35-36`):
- Username: `cypher2dwrld`
- Password: `4265803791`

### Features

- **Dashboard**: lists all connected numbers with live status (CONNECTED / DISCONNECTED)
- **Unpair**: removes a number from the allowed list, disconnects its socket, and deletes its auth state from the backend — freeing a slot for a new number
- **Allowed list**: shows which 5 numbers occupy the whitelist
- **Auto-refresh**: polls `/admin/api/numbers` every 10 seconds
- **Logout**: clears the session cookie

### Security

- Session token: random 32-byte hex string, stored in an **HTTP-only, SameSite=Strict** cookie
- Token expires after 24 hours
- All `/admin/api/*` endpoints are guarded by `requireAdmin` middleware
- Login page redirects already-authenticated users directly to the dashboard

### API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/admin/login` | POST | No | Accepts `{ username, password }`, returns auth cookie |
| `/admin/logout` | POST | No | Clears auth cookie |
| `/admin` | GET | Cookie | Serves admin dashboard |
| `/admin/login` | GET | No | Serves login page (redirects if authed) |
| `/admin/api/numbers` | GET | Cookie | Returns `{ numbers[], allowed[], maxAllowed }` |
| `/admin/api/unpair/:number` | POST | Cookie | Unpairs a number (removes from allowed list, disconnects, deletes auth) |

---

## Auth Backends

The bot supports three backends for storing WhatsApp authentication credentials, selected automatically by environment variables:

### Priority Order

1. **Upstash Redis** — if `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` are set
2. **PostgreSQL** — if `DATABASE_URL` is set (and Upstash not configured)
3. **Local files** — fallback (stores in `auth_info/{phoneNumber}/`)

### Redis Key Schema (`src/redis.js`)

```
auth:creds:{phoneNumber}            → credentials JSON
auth:key:{phoneNumber}:{type}:{id}  → session keys
bot:setting:{key}                   → general settings
```

### PostgreSQL Schema (`src/db.js`)

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
  ...
```

> **Note**: Bot state (monitored numbers, AI config, anti-link settings, message store, etc.) is always persisted via JSON files (`vv_data_{number}.json`), regardless of which auth backend is used. Only WhatsApp authentication uses the backend.

---

## Commands

All commands are prefixed with `.` (dot). Send them to the bot's DM or in a group where the bot is present.

| Command | Aliases | Admin Only | Description |
|---------|---------|:----------:|-------------|
| `.help` | `.h` | No | Full help text with all commands, tips, and examples (≈120 lines) |
| `.menu` | `.m` | No | Compact command list organized by section |
| `.ping` | `.p` | No | `ping` → "Pong!" / `ping diag` → resolve all JID variants / `ping blast` → diagnostic send to every JID / `ping raw <jid>` → step-by-step session/send test |
| `.clearsession` | `.cs`, `.clearsig` | No | Deletes Redis/file session keys for a given contact (or sender if no args), then re-establishes sessions via `conn.assertSessions()` |
| `.cleardb` | `.wipedb`, `.resetdb` | No | Wipes ALL persistent data: monitored numbers, AI targets, anti-link/status config, warnings, message store, conversations |
| `.testimg` | — | No | Sends a 1×1 transparent GIF to verify the media send pipeline works |
| `.time` | — | No | Returns current server time |
| `.reverse` | `.r` | No | Reverses the input text |
| `.quote` | — | No | Returns a random motivational quote (7-quote pool) |
| `.bio` | — | No | Fetches and displays the sender's WhatsApp status/about via `conn.fetchStatus` |
| `.getpp` | — | No | Gets profile picture of replied/mentioned user (resolves `@lid` participants) |
| `.sticker` | `.s` | No | Converts a quoted image to WebP sticker via `sharp` |
| `.toimage` | `.ti` | No | Converts a quoted sticker to PNG |
| `.runtime` | `.uptime` | No | Shows bot uptime (days/hours/minutes/seconds) |
| `.stats` | — | No | Shows command statistics, group count, uptime, memory usage |
| `.vv` | — | No | Reveals a quoted view-once message — tries `conn.rvo()` first, falls back to `downloadMediaMessage` + forward |
| `.ghost` | — | No | Creates a dark-themed SVG image with your text, sends as view-once (`viewOnceV2Extension`). Falls back to plain text if image generation fails |
| `.monitor` | `.mon` | No | Manage watched numbers: `monitor add <num>`, `monitor remove <num>`, `monitor list`, `monitor clear`. Also `monitor <num>` (shorthand add). Cannot monitor yourself |
| `.aichat` | `.ai` | No | Full AI management suite (see [AI Chat](#ai-chat)) |
| `.id` | `.jid` | No | Shows the JID of the current chat or replied-to user |
| `.tagall` | `.tag`, `.everyone` | No | Tags all group members (excluding bot) with optional message |
| `.kick` | — | **Yes** | Removes a group member. Checks target exists in group. Cannot kick self |
| `.ban` | — | **Yes** | Alias for `.kick` |
| `.warn` | — | **Yes** | Warns a user (1-3). At 3 warnings → auto-kick |
| `.unwarn` | — | **Yes** | Removes one warning from a user |
| `.promote` | `.admin` | **Yes** | Promotes to group admin. Supports reply, @mention, or raw number |
| `.demote` | — | **Yes** | Demotes from group admin |
| `.delete` | `.del` | **Yes** | Deletes the quoted message via `sendMessage(delete:)` |
| `.mute` | — | **Yes** | Sets group to announcement mode (only admins can send) |
| `.unmute` | — | **Yes** | Sets group to not-announcement mode |
| `.antilink` | `.al` | **Yes** | Toggle anti-link per group: `antilink on`, `antilink off`, `antilink whitelist add/remove <domain>`. Bot must be admin |
| `.antistatus` | `.as` | **Yes** | Toggle anti-status per group: `antistatus on`, `antistatus off`. Announces rules on activation |

> **Admin Only** = requires the bot to be a group admin AND the command sender must be a group admin. The bot owner can run any command regardless.

---

## Features

### Anti-Link

Enforced in groups where `.antilink on` has been activated. Bot must be a group admin.

**Detection** (`src/bot.js:1677-1696`):
- Checks message body for URLs using `hasLink()` (`src/bot.js:254-268`)
- Detects: `http://`, `https://`, `www.`, `chat.whatsapp.com`
- Parses hostname, checks against a **whitelist** (exempt domains)

**Whitelist** (hardcoded, `src/bot.js:115`):
```
youtube.com, youtu.be, google.com, github.com, wa.me
```
Can be extended at runtime via `.antilink whitelist add/remove <domain>`.

**Enforcement**:
1. Deletes the offending message
2. Increments warning count (keyed by `group:sender`)
3. At **5 warnings** → auto-kick the member
4. Below limit → sends a warning with remaining count

**Admin bypass**: the bot owner and group admins are exempt from anti-link enforcement.

### Anti-Status

Enforced in groups where `.antistatus on` has been activated. Detects when a group member tags the group in their WhatsApp status.

**Detection** (`src/bot.js:1698-1716`):
- Checks `msg.message?.groupStatusMentionMessage` on the **raw** (pre-normalization) message object
- `msg.key.participant` = the uploader's JID

**Enforcement**:
- Tracks `<group>:<sender>:<YYYY-MM-DD>` counts
- **3 strikes per day** → auto-kick
- Warning message includes remaining count
- Counter resets daily (date-based key)
- State is persisted via `saveSessionData`/`loadSessionData`

### Anti-Spam

**Detection** (`src/bot.js:270-277`):
- Per-user message timestamps within a **4-second window**
- More than **5 messages** in that window → flagged as spam

**Enforcement** (`src/bot.js:1718-1738`):
- **In DMs**: blocks the sender via `conn.blockUser(sender, 'block')`
- **In groups**: uses `_s.antilinkWarnings` keyed by `group:sender:spam`
  - Same `LINK_WARN_LIMIT` (5) as anti-link
  - At limit: kick; below limit: slow-down warning
- Reverts to the `_s.antilinkWarnings` Map (not a separate variable — there was a bug here that has been fixed, see `AGENTS.md`)

### View-Once (VV) Handling

The bot has **four layers** of view-once media handling:

#### 1. `.vv` Command (manual reveal)
Quoted VV message is revealed via:
- `conn.rvo()` (server-side re-upload, preferred)
- Falls back to `downloadMediaMessage()` + forward

#### 2. `???` — Secret Owner Reveal (`src/bot.js:1443-1484`)
When the **bot owner** sends `???` as a reply to a VV message:
- The content is downloaded and sent **directly to the owner's DM** — no trace in the original chat
- If the message is a stub (media not yet received): sends a `?` to trigger WhatsApp to re-send the full media
- Tracks pending re-sends via `pendingReveals` Set (keyed by stanza ID)
- On re-send: intercepts the incoming media (lines 1492-1517), reveals to owner DM

#### 3. Monitored Number VV Auto-Reveal
When a number on the `monitor` list sends a VV:
- Immediately revealed via `conn.rvo()`
- Falls back to `downloadMediaMessage()` + forward
- The owner receives the VV content automatically

#### 4. Patch-Level Detection (`AGENTS.md`)
- **Linked device Stanza 1 fix**: WhatsApp sends two stanzas for VVs on linked devices — Stanza 1 (enc, full metadata) and Stanza 2 (unavailable, placeholder). A patch to `decode-wa-message.js` ensures `key.isViewOnce` is set on the first stanza.
- **VV send fix**: A patch to `messages-send.js` unwraps `viewOnceMessage` wrappers in `getMediaType()` so the `mediatype` attribute is populated on the `enc` node for VV video/audio sends.

### AI Chat

Powered by [Groq](https://groq.com) using the `llama-3.3-70b-versatile` model.

#### Setup
```
.aichat key gsk_your_groq_api_key
```
The key is validated immediately with a test API call.

#### Targets
```
.aichat add 2348012345678     → enable AI replies for DMs from this number
.aichat remove 2348012345678  → disable
.aichat list                  → show all targets, AI groups, and system prompt
```

#### Group AI
Send `.aichat addgc` in the group you want to enable AI for. AI activates when the bot is @mentioned or replied to.

```
.aichat removegc JID          → disable AI in a group
```

#### System Prompt
```
.aichat system You are a helpful assistant...
.aichat system clear          → remove system prompt
```

#### Auto-Reply Logic
- In DMs: triggers if sender (normalized) is in `_s.aiTargets`
- In groups: triggers if group is in `_s.aiGroups` AND bot is @mentioned or replied to
- LID resolution: if sender has `@lid`, resolves via `findUserId` then checks targets
- Conversation history: maintained per `groupJid:sender` (or `sender` for DMs), max 20 messages
- Auto-replies with `{ quoted: msg }` so the reply is threaded

#### Reset
```
.aichat clear    (or .aichat reset / .aichat allclear)
```
Wipes all AI data: key, targets, groups, prompt, and conversation history.

### Message Monitoring

`.monitor add <number>` adds a phone number to the watchlist. All messages from monitored numbers are:

1. Stored in `_s.messageStore` (capped at 5000 entries, oldest deleted)
2. If view-once: immediately revealed and forwarded to the owner's DM
3. If deleted (detected via `protocolMessage.type === 0`):
   - If media: forwarded to the bot's DM via `sendImageViaFile`
   - If text: forwarded as text to the bot's DM

Messages are stored with: content, `fromJid`, `displayNumber`, `mediaBuffer`, `mediaType`, and `timestamp`.

### Delete Detection

When someone deletes a message (sends a `protocolMessage` with `type === 0`), the bot:
1. Checks `_s.messageStore` for the original content
2. If found and has media: forwards to bot's DM
3. If text-only: forwards text to bot's DM
4. Deletes from `messageStore`

This only works for messages that were previously stored by the monitoring system.

---

## 5-Number Limit

The bot enforces a hard limit of **5 unique phone numbers** (`MAX_ALLOWED_NUMBERS = 5` in `src/server.js:10`).

### How It Works

1. **Interactive pairing** (`src/server.js:258-266`):
   - When a new `request-code` comes in, the server checks `allowed_numbers.json`
   - If the number is NOT in the file AND the file already has 5 entries → **rejected**
   - If under 5 → added to the file and pairing proceeds
   - Numbers already in the file can re-pair freely (no slot consumed again)

2. **Startup auto-restore** (`src/server.js:78-113`):
   - Only restores up to 5 sessions from the auth backend
   - Previously, this was unlimited — all stored sessions were restored regardless of the limit. Now capped to `MAX_ALLOWED_NUMBERS`

3. **Admin un-pair** (`/admin/api/unpair/:number`):
   - Removes number from `allowed_numbers.json`
   - Disconnects the socket
   - Deletes auth from the backend (Redis/Postgres/files)
   - Frees one slot in the whitelist

### The `allowed_numbers.json` File

- Lives at project root (in `.gitignore`)
- Contains an array of phone number strings: `["2348012345678", "2348098765432", ...]`
- Auto-populated on first startup from existing stored sessions
- Acts as a **permanent whitelist** — the first 5 numbers that ever pair are the only numbers allowed
- You can manually edit this file to add/remove numbers (server restart required for removal to take effect on the next pairing attempt)

### Why a Number Might Fail to Re-Pair (and How It's Fixed)

**The bug**: When a number gets logged out (`reason 401`), the local auth folder is deleted but the old **registered** creds may remain in Redis. On re-pair, `pairWithWhiskey` loaded these stale creds. Since `creds.registered === true`, the pairing code was never generated — the socket connected with stale creds and immediately got logged out again.

**The fix** (`src/pair.js:17-26`): Before starting any pairing flow, the bot now **wipes any existing stale session** from the storage backend. This ensures the pairing always starts with fresh, unregistered credentials.

---

## ID & JID System

WhatsApp uses multiple identifier formats. The bot handles all of them.

### JID Formats

| Format | Example | Description |
|--------|---------|-------------|
| Phone JID | `2348012345678@s.whatsapp.net` | Standard phone-based identifier |
| LID | `1234567890@lid` | LinkedIn-like ID; newer accounts use this |
| Group JID | `1234567890-123456@g.us` | Group identifier |
| Newsletter | `1234567890@newsletter` | Newsletter identifier |

### Normalization (`normalizeJid()`, `src/bot.js:151`)

Strips `:`, `@`, `.` and any non-digit characters → returns just the numeric portion.
- `2348012345678@s.whatsapp.net` → `2348012345678`
- `1234567890@lid` → `1234567890`
- `2348012345678:1@s.whatsapp.net` → `2348012345678`

### LID Resolution (`resolveJid()`, `src/bot.js:153-171`)

When a user has an `@lid` JID, the bot resolves it to a phone JID:
1. Checks the in-memory `lidToPhone` cache (populated on bot connect)
2. Falls back to `conn.findUserId()` which queries WhatsApp's directory

### JID Variant Resolution (`resolveAllJids()`, `src/bot.js:6-44`)

For diagnostic purposes, the bot resolves ALL known variants of a JID:
- `normalized` (numeric only)
- `phone@s.whatsapp.net`
- `lid` (normalized + `@lid`)
- `findUserId_phone` / `findUserId_lid` (from WhatsApp directory)
- `onWhatsApp_jid` (from `conn.onWhatsApp()`)
- `lidToPhone` variants (from the LID→phone cache)

Used by `.ping diag` and `.ping blast` commands.

### Group Participant LID Handling

`@lid` group participants are explicitly resolved when:
- Fetching profile pictures (`.getpp` command, `src/bot.js:488-509`)
- Checking admin status in antilink enforcement (lines 967-971, 1614)
- Monitoring numbers: `conn.onWhatsApp()` is used to resolve LID→phone

---

## Admin Determination

The bot checks admin status in **three places**, all using the same method:

### Method (`areJidsSameUser` + dual JID comparison)

```js
areJidsSameUser(p.id, conn.user?.id)     // phone JID match
areJidsSameUser(p.id, conn.user?.lid)     // LID match (fallback)
```

Both the bot's phone JID (`conn.user.id`) and LID (`conn.user.lid`) are compared against group participants' JIDs. If either matches, the participant is considered to be the bot.

### Where Admin Is Checked

1. **Permission block** (`src/bot.js:1418-1434`) — before executing `groupAdminRequired` commands:
   ```js
   isBotAdmin = groupMeta.participants.some(p => {
     if (!p.admin) return false;
     return areJidsSameUser(p.id, botPn) || (botLid && areJidsSameUser(p.id, botLid));
   });
   ```

2. **Antilink toggle admin check** (`src/bot.js:992-997`) — when `.antilink on` is issued:
   - Same `areJidsSameUser` check against both `conn.user.id` and `conn.user.lid`

3. **Antilink enforcement bypass** (`src/bot.js:1679`) — before deleting a link message:
   - Owner bypass: `normalizeJid(sender) === ownerNumber`
   - Admin bypass: checks `groupMeta.participants` for admin with matching JID

### Owner Determination

The bot owner is the phone number that started the bot instance. Determined by:
- `msg.key.fromMe` (message sent by this socket)
- `normalizeJid(sender) === ownerNumber` (where `ownerNumber` = the phone number passed to `startBot()`)

The owner can run **any** command, including admin-only ones, regardless of group admin status.

---

## Reconnection Logic

When a Baileys socket disconnects, the bot determines the reason and responds accordingly:

| Reason Code | Meaning | Behavior |
|:-----------:|---------|----------|
| **428** | Bad session / stream error | Counts consecutive 428s. If **≥3** in a row → deletes auth folder and gives up. Otherwise resets the counter. Then **falls through to schedule reconnect** |
| **408** | Request timeout | Transient network issue. Reconnects without purging the session |
| **503** | Service unavailable | Same as 408 — transient, reconnect |
| **515** | Stream error | Records the timestamp. Schedules reconnect |
| **401** (`loggedOut`) | Session invalidated | **Two paths**: (1) If a 515 was seen within the last 30 seconds → tries to reconnect (the session might recover). (2) Otherwise → **purges the entire session**: deletes auth folder, calls `deleteAuthSession()` on the backend, and **gives up** |
| `connectionReplaced` | Another client logged in | Steps aside gracefully, does NOT delete the session data. Does NOT reconnect |
| Other | Unknown | Schedules reconnect with exponential backoff |

### Reconnect Parameters (`src/bot.js:290-293`)

| Parameter | Value | Description |
|-----------|-------|-------------|
| `RECONNECT_MAX_ATTEMPTS` | 15 | Gives up after this many attempts |
| `RECONNECT_BASE_DELAY` | 10s | Initial delay before first reconnect |
| `RECONNECT_MAX_DELAY` | 300s (5 min) | Maximum delay cap |
| `RECONNECT_COOLDOWN_AFTER` | 60s | If last connected was this long ago, use base delay (not exponential) |
| Jitter | ±30% | Random jitter applied to each delay |

### Reconnect Flow

```
close → determine reason → handle specific reason →
→ if not permanently closed:
    scheduleReconnect():
      clear old timer
      increment attempt counter
      if attempt > 15: give up
      calculate delay (exponential + jitter)
      set timeout → call startBot() again
```

---

## State Persistence

### Bot State (`src/bot.js:175-234`)

All bot configuration per phone number is saved to `vv_data_{phoneNumber}.json`:

| Data | Serialized As |
|------|---------------|
| `monitoredNumbers` | Array (Set → Array) |
| `aiTargets` | Array (Set → Array) |
| `aiGroups` | Array (Set → Array) |
| `groqApiKey` | String |
| `aiSystemPrompt` | String |
| `antilinkEnabled` | Object (Map → Object) |
| `antilinkWarnings` | Object (Map → Object) |
| `antistatusEnabled` | Object (Map → Object) |
| `antistatusCounts` | Object (Map → Object) |
| `warnings` | Object (Map → Object) |
| `lidToPhone` | Object (global cache) |

**Save triggers:**
- After any `.antilink` or `.antistatus` toggle
- After any `.warn` / `.unwarn`
- After any anti-link enforcement action
- After any anti-status enforcement action

**Load triggers:**
- On `startBot()` (every connect/reconnect)

### WhatsApp Auth State

Stored in the configured backend (Upstash Redis / PostgreSQL / files). Manages:
- Credentials (`creds.json`)
- Session keys (`session-*.json` in Baileys format)
- Pre-keys and identity keys

### Cache Cleanup (every 5 minutes, `src/bot.js:1767-1791`)

| Cache | Cleanup Rule |
|-------|-------------|
| `spamTracker` | Removes timestamps older than 60s |
| `groupMetaCache` | Removes entries older than 30s TTL |
| `messageStore` | Removes entries older than 24h |
| `antistatusCounts` | Removes entries with date older than today |
| `processedMessages` | If >2000 entries, removes oldest 1000 |

---

## Session Store (Advanced)

`src/session-store.js` provides a **generic session management layer** with support for:
- Upstash Redis, PostgreSQL, or File backends
- Session CRUD (create, load, delete, list)
- Baileys-compatible auth state factory
- Legacy migration from flat `auth_info/` format
- Stale session sweeping

### Session ID Schema

```
session:meta:{sessionId}           → { sessionId, phoneNumber, createdAt, updatedAt }
session:phone:{phoneNumber}        → sessionId (index)
auth:creds:{sessionId}             → credentials
auth:key:{sessionId}:{type}:{id}   → session keys
```

### Legacy Migration

The store automatically detects old-format keys (`auth:creds:{phoneNumber}` without session ID) and migrates them to the new session-ID format:
1. Creates a new session entry with UUID
2. Copies all keys to the new format
3. Leaves old data in place as fallback

### Stale Session Sweeper (`src/session-sweeper.js`)

A periodic cleaner that removes sessions not updated in the last **2 days**. Runs every **1 hour**.

> **Note**: The `SessionStore` class is fully implemented but **not currently wired into the main application**. `src/bot.js` and `src/server.js` use the direct backend functions (`useUpstashAuthState`, `usePostgresAuthState`, `useMultiFileAuthState`) instead. The SessionStore is available for migration to a more robust session management system.

---

## Custom Patches

The bot applies three patches to `node_modules/@lordmega/baileys`. These are documented in `AGENTS.md` and must be **re-applied after** `npm update @lordmega/baileys`.

### 1. LID Addressing for 1:1 Sends

**File**: `node_modules/@lordmega/baileys/lib/Socket/messages-send.js`

**Problem**: WhatsApp LID-addressed contacts silently drop 1:1 messages because the stanza was missing `addressing_mode: 'lid'` and `recipient_pn` attributes.

**Fix**: When `isLid` is true, resolves `recipient_pn` via `signalRepository.lidMapping.getPNForLID(jid)`, and adds:
```js
additionalAttributes = {
  ...additionalAttributes,
  addressing_mode: 'lid',
  ...(recipientPn && { recipient_pn: recipientPn })
};
```

**Upstream**: WhiskeySockets/Baileys PR [#2692](https://github.com/WhiskeySockets/Baileys/pull/2692) (frndchagas, Jul 2026)

### 2. View-Once Detection on Stanza 1 (Enc) for Linked Devices

**File**: `node_modules/@lordmega/baileys/lib/Utils/decode-wa-message.js`

**Problem**: When a view-once message arrives at a linked device, WhatsApp sends two stanzas — Stanza 1 (`enc`) with full media metadata, and Stanza 2 (`unavailable`) as a fanout placeholder. Stanza 1 was decoded but `key.isViewOnce` was never set, making the VV indistinguishable from regular media in `messages.upsert`.

**Fix**: After line 289, unwrap `viewOnceMessage`/`viewOnceMessageV2`/`viewOnceMessageV2Extension` wrappers and set `fullMessage.key.isViewOnce = true` if the inner message has `viewOnce: true`.

**Upstream**: WhiskeySockets/Baileys PR [#2435](https://github.com/WhiskeySockets/Baileys/pull/2435) (rsalcara, Mar 2026)

### 3. `mediatype` Attribute for VV Sends

**File**: `node_modules/@lordmega/baileys/lib/Socket/messages-send.js`

**Problem**: `getMediaType()` checks `message.imageMessage`, `message.videoMessage`, etc. directly. When sending VV media, `generateWAMessageContent` wraps the media inside `viewOnceMessage.message`, so the top-level `message.imageMessage` is `undefined`. The `mediatype` attribute was missing from the `enc` node, causing WhatsApp servers to silently drop view-once video and audio.

**Fix**: At the start of `getMediaType()`, unwrap VV wrappers so the function sees the inner media message.

**Upstream**: Same PR as above (#2435).

---

## File Structure

```
├── src/
│   ├── server.js              # Express + Socket.IO server, admin routes, pairing, session restore
│   ├── bot.js                 # Core bot: 22 commands, connection management, anti-link/status/spam,
│   │                          #   AI chat, monitoring, VV handling, message pipeline (1793 lines)
│   ├── pair.js                # WhatsApp pairing code flow (temporary socket, code gen, resolve)
│   ├── redis.js               # Upstash Redis auth state backend (Baileys-compatible)
│   ├── db.js                  # PostgreSQL auth state backend (Baileys-compatible)
│   ├── session-store.js       # Generic session manager with 3 backends and legacy migration
│   └── session-sweeper.js     # Periodic stale session cleaner (2-day TTL)
├── public/
│   ├── index.html             # Main pairing UI with Matrix rain animation + PWA support
│   ├── admin.html             # Admin dashboard (connected numbers, unpair, allowed list)
│   ├── admin-login.html       # Admin login page
│   ├── manifest.json          # PWA manifest
│   ├── sw.js                  # Service worker (cache-first static assets)
│   └── icon.svg               # PWA icon
├── allowed_numbers.json       # Whitelist of up to 5 paired numbers (auto-created, in .gitignore)
├── AGENTS.md                  # Custom patch documentation
├── .env                       # Environment variables (in .gitignore)
├── .gitignore
├── package.json
└── README.md
```

### Key Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/bot.js` | 1793 | Everything: commands, event handlers, utilities, message pipeline |
| `src/server.js` | 289 | HTTP server, Socket.IO, admin routes, startup, pairing orchestration |
| `src/pair.js` | 158 | WhatsApp pairing code generation and session creation |
| `src/redis.js` | 116 | Upstash Redis backend for auth state |
| `src/db.js` | 110 | PostgreSQL backend for auth state |
| `src/session-store.js` | 573 | Generic session manager (future use) |
| `public/index.html` | 288 | Main frontend with pairing UI and Matrix rain |

---

## Environment Variables

Create a `.env` file at the project root:

```env
# For Upstash Redis (takes priority)
UPSTASH_REDIS_URL=https://your-instance.upstash.io
UPSTASH_REDIS_TOKEN=your_token_here

# OR for PostgreSQL (only used if Upstash not configured)
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# OR neither — uses local file-based auth (auth_info/{number}/)
```

All three variables are optional. If neither is set, the bot falls back to file-based authentication.

---

## Dependency Notes

| Package | Where Used | Purpose |
|---------|-----------|---------|
| `@lordmega/baileys` | `bot.js` | **Primary** WhatsApp Web library (forked with patches) |
| `@whiskeysockets/baileys` | `pair.js`, `redis.js`, `db.js`, `session-store.js` | Upstream Baileys for `BufferJSON`, `initAuthCreds`, `Browsers` |
| `@upstash/redis` | `redis.js` | Upstash Redis HTTP client |
| `pg` | `db.js` | PostgreSQL client |
| `socket.io` | `server.js`, `index.html` | Real-time frontend communication |
| `sharp` | `bot.js` | Image processing (stickers, ghost images, thumbnails) |
| `express` | `server.js` | Web server framework |
| `pino` | `bot.js`, `pair.js` | Logging (used in silent mode) |
| `@hapi/boom` | `bot.js`, `pair.js` | Error code extraction from Baileys disconnect reasons |
| `dotenv` | `server.js` | .env file loading |
