'use strict';
// Provider evidence for customer-scoped enrollment. Not a sending
// grant: the caller separately authorizes the selected clinic/phone. Whole-group
// enrollment additionally reserves every WABA; selectionOnly does not.
// Expected scopes/optional owner pins come from server policy. The selected
// account comes from signup and is proven against authenticated Meta evidence.
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const required = ['whatsapp_business_management', 'whatsapp_business_messaging'];
const permitted = [...required, 'public_profile'];
const uniqueStrings = (v, max, validate) => Array.isArray(v) && v.length > 0 && v.length <= max
  && v.every(validate) && new Set(v).size === v.length;
function expiry(v, now) {
  if (!Number.isSafeInteger(v) || v < 0 || v > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) fail('oauth_credentials_incomplete');
  if (v === 0) return null;
  if (v * 1000 <= now) fail('credential_revoked');
  return v * 1000;
}
function inspectCustomerGrant(response, expected, now) {
  const selectedOnly = expected?.selectionOnly === true;
  const allowedScopes = selectedOnly ? [...permitted, 'whatsapp_business_manage_events'] : permitted;
  if (!Number.isSafeInteger(now) || now <= 0 || !expected || !id(expected.appId)
    || (!selectedOnly || expected.businessId !== undefined) && !id(expected.businessId)
    || !id(expected.selectedWabaId) || expected.wabaIds === undefined && !selectedOnly
    || expected.wabaIds !== undefined && (!uniqueStrings(expected.wabaIds, 64, id) || !expected.wabaIds.includes(expected.selectedWabaId))
    || !uniqueStrings(expected.scopes, allowedScopes.length, s => allowedScopes.includes(s))
    || !required.every(s => expected.scopes.includes(s))) fail('invalid_request');
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || response.error) fail('oauth_credentials_incomplete');
  if (data.is_valid !== true) fail('credential_revoked');
  if (data.app_id !== expected.appId || !id(data.user_id) || data.type !== 'SYSTEM_USER') fail('oauth_identity_mismatch');
  if (!uniqueStrings(data.scopes, allowedScopes.length, s => expected.scopes.includes(s)) || data.scopes.length !== expected.scopes.length) fail('oauth_credentials_incomplete');
  const granular = data.granular_scopes;
  if (!Array.isArray(granular) || !granular.length || granular.length > (selectedOnly ? 3 : 2)
    || granular.some(g => !g || typeof g !== 'object' || Array.isArray(g))
    || new Set(granular.map(g => g.scope)).size !== granular.length) fail('oauth_credentials_incomplete');
  const wabas = new Set();
  for (const g of granular) {
    if (!expected.scopes.includes(g.scope) || g.scope === 'public_profile') fail('scope_denied');
    // The optional events permission does not authorize any broker operation.
    // Meta may return it without asset targets. That is not evidence against
    // the mandatory messaging/management targets checked below, and must not
    // invent a WABA grant or require a new authorization from the customer.
    if (selectedOnly && g.scope === 'whatsapp_business_manage_events'
      && (g.target_ids == null || Array.isArray(g.target_ids) && g.target_ids.length === 0)) continue;
    if (!uniqueStrings(g.target_ids, 64, id) || expected.wabaIds && g.target_ids.some(v => !expected.wabaIds.includes(v))) fail('scope_denied');
    g.target_ids.forEach(v => wabas.add(v));
  }
  if (wabas.size > 64) fail('scope_denied');
  for (const s of required) {
    const g = granular.find(g => g.scope === s);
    if (!g || !g.target_ids.includes(expected.selectedWabaId)) fail('scope_denied');
  }
  return { appId: data.app_id, subjectId: data.user_id, tokenType: data.type, scopes: [...data.scopes].sort(),
    expiresAt: expiry(data.expires_at, now), dataAccessExpiresAt: expiry(data.data_access_expires_at, now),
    businessId: expected.businessId || null, wabaIds: [...wabas].sort() };
}
function createWhatsappCustomerVerifier({ http, now = () => Date.now() }) {
  if (typeof http !== 'function' || typeof now !== 'function') fail('invalid_request');
  return async ({ response, expected, token, proof, signal }) => {
    if (!Buffer.isBuffer(token) || !tokenText(token.toString('utf8')) || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) fail('invalid_request');
    // Snapshot provider/policy evidence before the first async read.
    const at = now(); const grant = inspectCustomerGrant(response, expected, at);
    const check = () => {
      if (signal?.aborted) fail('provider_timeout');
      if ([grant.expiresAt, grant.dataAccessExpiresAt].some(v => v !== null && v <= now())) fail('credential_revoked');
    };
    try {
      // Bounded read-only requests, including unselected WABAs. Never enumerate
      // a portfolio. IDs must come from authenticated granular grants and, when
      // configured, the server allowlist. Owners must match the pinned business or
      // the owner proven by Meta for the selected account.
      const ordered = [expected.selectedWabaId, ...grant.wabaIds.filter(v => v !== expected.selectedWabaId)];
      for (const wabaId of ordered) {
        check(); const v = await http({ action: 'waba_owner', id: wabaId, token, proof, signal }); check();
        if (!v || v.error || v.id !== wabaId || !id(v.owner_business_info?.id)) fail('scope_denied');
        if (grant.businessId === null) grant.businessId = v.owner_business_info.id;
        if (v.owner_business_info.id !== grant.businessId) fail('scope_denied');
      }
      check(); return { ...grant, observedAt: at };
    } catch (e) { throw new BrokerError(e instanceof BrokerError ? e.code : 'provider_failed'); }
  };
}
module.exports = { inspectCustomerGrant, createWhatsappCustomerVerifier };
