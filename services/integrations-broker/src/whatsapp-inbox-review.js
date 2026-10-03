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
function reviewSummary(raw) {
  try {
    const body = JSON.parse(raw);
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return { category: 'unknown', errorCodes: [] };
    const categories = new Set(); const errors = new Set();
    for (const entry of body.entry) for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field === 'messages') {
        if (value.messages?.length) categories.add('incoming_messages');
        if (value.statuses?.length) categories.add('delivery_updates');
        if (value.errors?.length && !value.messages?.length && !value.statuses?.length) categories.add('provider_errors');
        if (!value.messages?.length && !value.statuses?.length && !value.errors?.length) categories.add('unknown');
        for (const error of [...(value.errors || []), ...(value.statuses || []).flatMap(status => status.errors || [])]) {
          if (Number.isSafeInteger(error.code) && error.code > 0 && error.code <= 9999999) errors.add(error.code);
        }
      } else if (change.field === 'smb_message_echoes') categories.add('mobile_echoes');
      else if (change.field === 'smb_app_state_sync') categories.add('app_state_changes');
      else if (change.field === 'history') categories.add('history');
      else categories.add('unknown');
    }
    return { category: categories.size === 1 ? [...categories][0] : categories.size ? 'mixed' : 'unknown',
      errorCodes: [...errors].sort((a, b) => a - b).slice(0, 10) };
  } catch { return { category: 'unknown', errorCodes: [] }; }
}

module.exports = { reviewContacts, reviewSummary };
