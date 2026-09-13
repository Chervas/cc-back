'use strict';
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
function createWhatsappPhoneVerifier({ http }) {
  if (typeof http !== 'function') fail('invalid_request');
  return async ({ wabaId, phoneId, token, proof, signal }) => {
    if (!id(wabaId) || !id(phoneId) || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8'))
      || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) fail('invalid_request');
    let after; const cursors = new Set(); const ids = new Set();
    try {
      for (let page = 0; page < 20; page++) {
        if (signal?.aborted) fail('provider_timeout');
        const raw = await http({ action: 'phones', id: wabaId, token, proof, signal, ...(after ? { after } : {}) });
        if (signal?.aborted) fail('provider_timeout');
        if (!raw || raw.error || !Array.isArray(raw.data) || raw.data.length > 100) fail('oauth_credentials_incomplete');
        for (const row of raw.data) {
          if (!row || !id(row.id) || ids.has(row.id)) fail('oauth_credentials_incomplete');
          ids.add(row.id);
        }
        // Never follow paging.next, which can contain both a foreign URL and a
        // bearer token. Rebuild the fixed WABA endpoint with only its cursor.
        if (ids.has(phoneId)) return { wabaId, phoneId };
        if (!raw.paging?.next) fail('scope_denied');
        after = raw.paging?.cursors?.after;
        if (!raw.data.length || typeof after !== 'string' || !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(after) || cursors.has(after)) fail('oauth_credentials_incomplete');
        cursors.add(after);
      }
      fail('oauth_credentials_incomplete');
    } catch (error) { throw new BrokerError(error instanceof BrokerError ? new BrokerError(error.code).code : 'provider_failed'); }
  };
}
module.exports = { createWhatsappPhoneVerifier };
