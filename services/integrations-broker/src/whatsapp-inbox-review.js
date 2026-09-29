'use strict';
const { createHash } = require('node:crypto');
const phone = value => typeof value === 'string' && /^[1-9][0-9]{6,14}$/.test(value);

// Attribution only: this never imports, acknowledges or relaxes an ownership
// check. Unknown/mixed account events retain the clinic-wide barrier.
function reviewContacts(raw, scopes) {
  try {
    const body = JSON.parse(raw);
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || !body.entry.length) return null;
    const contacts = new Map();
    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes) || !entry.changes.length) return null;
      for (const change of entry.changes) {
        const value = change.value;
        const scope = scopes?.find(s => s.wabaId === entry.id && s.phoneId === value?.metadata?.phone_number_id);
        if (!scope || value.messaging_product !== 'whatsapp' || value.statuses?.length || value.errors?.length) return null;
        const incoming = change.field === 'messages';
        if (!incoming && change.field !== 'smb_message_echoes') return null;
        const messages = incoming ? value.messages : value.message_echoes;
        if (!Array.isArray(messages) || !messages.length) return null;
        for (const message of messages) {
          const peer = incoming ? message.from : message.to;
          if (!phone(peer)) return null;
          for (const clinicId of scope.clinicIds) {
            const contactKey = createHash('sha256').update(JSON.stringify([clinicId, scope.phoneId, peer])).digest('hex');
            contacts.set(contactKey, { clinicId, contactKey });
            if (contacts.size > 128) return null;
          }
        }
      }
    }
    return contacts.size ? [...contacts.values()] : null;
  } catch { return null; }
}
module.exports = { reviewContacts };
