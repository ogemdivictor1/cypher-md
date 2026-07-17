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

## `key.isViewOnce` on linked-device Stanza 1 VV media

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
