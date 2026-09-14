'use strict';
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
function createWhatsappPhoneVerifier({ http }) {
  if (typeof http !== 'function') fail('invalid_request');
  return async ({ wabaId, phoneId, token, proof, signal }) => {
    if (!id(wabaId) || phoneId !== null && !id(phoneId) || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8'))
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
        if (phoneId !== null && ids.has(phoneId)) return { wabaId, phoneId };
        if (!raw.paging?.next) {
          if (phoneId === null && ids.size === 1) return { wabaId, phoneId: [...ids][0] };
          fail('scope_denied');
        }
        after = raw.paging?.cursors?.after;
        if (!raw.data.length || typeof after !== 'string' || !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(after) || cursors.has(after)) fail('oauth_credentials_incomplete');
        cursors.add(after);
      }
      fail('oauth_credentials_incomplete');
    } catch (error) { throw new BrokerError(error instanceof BrokerError ? new BrokerError(error.code).code : 'provider_failed'); }
  };
}
// This is an observation, never a registration, QR decision or sending grant.
// Missing fields remain unknown; a CLOUD_API observation does not prove that
// the WABA is unrestricted, subscribed, billable or authorized for messaging.
async function inspectWhatsappPhoneState({ http, phoneId, token, proof, signal }) {
  if (typeof http !== 'function' || !id(phoneId)) fail('invalid_request');
  try {
    if (signal?.aborted) fail('provider_timeout');
    const raw = await http({ action: 'phone_state', id: phoneId, token, proof, signal });
    if (signal?.aborted) fail('provider_timeout');
    if (!raw || raw.error || raw.id !== phoneId) fail('oauth_credentials_incomplete');
    const isOnBizApp = typeof raw.is_on_biz_app === 'boolean' ? raw.is_on_biz_app : null;
    const platformType = ['CLOUD_API', 'ON_PREMISE', 'NOT_APPLICABLE'].includes(raw.platform_type) ? raw.platform_type : null;
    return { phoneId, isOnBizApp, platformType,
      coexistenceAvailable: isOnBizApp === true && platformType === 'CLOUD_API',
      registrationAttempted: false };
  } catch (error) { throw new BrokerError(error instanceof BrokerError ? error.code : 'provider_failed'); }
}
module.exports = { createWhatsappPhoneVerifier, inspectWhatsappPhoneState };
