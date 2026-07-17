# Custom Patches

## `addressing_mode: 'lid'` for 1:1 LID sends

**File**: `node_modules/@lordmega/baileys/lib/Socket/messages-send.js`

**Problem**: WhatsApp LID-addressed contacts silently drop 1:1 messages because the stanza was missing `addressing_mode: 'lid'` and `recipient_pn` attributes.

**Fix** (lines 585-595):
```js
} else if (isLid) {
    let recipientPn;
    try {
        recipientPn = await signalRepository.lidMapping.getPNForLID(jid);
    } catch (e) {
        logger.debug({ err: e?.message }, 'getPNForLID failed');
    }
    logger.debug({ jid, recipientPn }, 'LID 1:1 send - resolved recipient_pn');
    if (!recipientPn) {
        const { user } = jidDecode(jid);
        try {
            const pns = await signalRepository.lidMapping.getPNsForLIDs([jid]);
            recipientPn = pns?.[0]?.pn;
            logger.debug({ jid, pnsResult: pns }, 'getPNsForLIDs fallback');
        } catch (_) {}
    }
    additionalAttributes = {
        ...additionalAttributes,
        addressing_mode: 'lid',
        ...(recipientPn && { recipient_pn: recipientPn })
    };
}
```

**Upstream tracking**: WhiskeySockets/Baileys PR #2692 (frndchagas, Jul 2026) — "fix: route pn sends to mapped lid". Check if `@lordmega/baileys` has updated past this commit before deleting this patch.

**Re-apply after**: `npm update @lordmega/baileys`

---

# Bot Features

## Anti-Status (`.antistatus on|off`)

**Detection**: Checks `msg.message?.groupStatusMentionMessage` on the **raw** (pre-normalization) message object. When a group member tags the group in their WhatsApp status, the server sends a `groupStatusMentionMessage` with `msg.key.participant` = the uploader's JID.

**Enforcement**: Tracks `<group>:<sender>:<date>` counts. 3 strikes per day = auto-kick. Warning is a tag+mention with remaining count. Counter resets daily (date-based key). State is persisted via `saveSessionData`/`loadSessionData`.

**Files**: `src/bot.js` — state props `antistatusEnabled` (Map), `antistatusCounts` (Map); command handler at line 1028; detection at line 1693.

---

## Admin check uses `areJidsSameUser` + LID

**Problem**: Group metadata can identify participants by LID (`@lid`) or phone JID (`@s.whatsapp.net`) with different digit strings. Old `normalizeJid` comparison only checked phone JID.

**Fix**: Use Baileys' `areJidsSameUser()` and compare against **both** `conn.user?.id` (phone JID) and `conn.user?.lid` (LID). Applied in all 3 admin check sites: permission block (line 1358), antilink handler (line 968), and antilink enforcement bypass (line 1614).

---

## Anti-link / Anti-status state persistence

**Problem**: `antilinkEnabled`, `antilinkWarnings`, `antistatusEnabled`, `antistatusCounts` were in-memory only — lost on every reconnect/restart.

**Fix**: Added load/save in `loadSessionData` and `saveSessionData`.

---

## Anti-spam variable reference bug

**Problem**: Line 1641 used `antilinkWarnings` (without `_s.` prefix) instead of `_s.antilinkWarnings`, throwing a silent `ReferenceError`.

**Fix**: Changed to `_s.antilinkWarnings`.

**File**: `node_modules/@lordmega/baileys/lib/Utils/decode-wa-message.js`

**Problem**: When a view-once message arrives at a linked device, the server sends two stanzas — Stanza 1 (`enc`) with full media metadata, and Stanza 2 (`unavailable`) as a fanout placeholder. Stanza 1 was decoded but `key.isViewOnce` was never set, making the VV indistinguishable from regular media in `messages.upsert`.

**Fix** (after line 289):
```js
// PR #2435: Detect view-once media on Stanza 1 (enc) for linked devices
if (!fullMessage.key?.isViewOnce) {
    const vvInner = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message;
    if (vvInner && (vvInner.imageMessage?.viewOnce || vvInner.videoMessage?.viewOnce || vvInner.audioMessage?.viewOnce)) {
        fullMessage.key.isViewOnce = true;
    }
}
```

**Upstream tracking**: WhiskeySockets/Baileys PR #2435 (rsalcara, Mar 2026). Check if `@lordmega/baileys` has updated past this commit before deleting this patch.

**Re-apply after**: `npm update @lordmega/baileys`

---

## `mediatype` attribute missing on `enc` node for VV sends

**File**: `node_modules/@lordmega/baileys/lib/Socket/messages-send.js`

**Problem**: `getMediaType()` checks `message.imageMessage`, `message.videoMessage`, etc. directly. When sending VV media, `generateWAMessageContent` wraps the media inside `viewOnceMessage.message`, so `message.imageMessage` is `undefined` at the top level. The `mediatype` attribute was missing from the `enc` node, causing WA servers to silently drop view-once video and audio.

**Fix** (at start of `getMediaType`):
```js
// PR #2435: Unwrap view-once wrappers so mediatype is populated for VV sends
const vvInner = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message.viewOnceMessageV2Extension?.message;
if (vvInner) message = vvInner;
```

**Upstream tracking**: WhiskeySockets/Baileys PR #2435 (rsalcara, Mar 2026). Check if `@lordmega/baileys` has updated past this commit before deleting this patch.

**Re-apply after**: `npm update @lordmega/baileys`
