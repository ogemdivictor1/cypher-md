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
