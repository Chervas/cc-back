'use strict';
const { fail } = require('./errors');
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const allowedScopes = Object.freeze(['whatsapp_business_messaging', 'whatsapp_business_management', 'public_profile']);
function remoteExpiry(value, now) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) fail('oauth_credentials_incomplete');
  if (value === 0) return null;
  if (value * 1000 <= now) fail('credential_revoked');
  return value * 1000;
}
// This consumes a response fetched inside the broker, never browser-supplied
// debug output. Missing granular scope evidence is a denial, not a fallback to
// the claims saved alongside a credential.
function verifyWhatsappGrant(response, expected, now = Date.now()) {
  if (!expected || !graphId(expected.appId) || !graphId(expected.subjectId) || !graphId(expected.wabaId)
    || !Array.isArray(expected.scopes) || !expected.scopes.length || expected.scopes.length > 3
    || new Set(expected.scopes).size !== expected.scopes.length || expected.scopes.some(scope => !allowedScopes.includes(scope))
    || !expected.scopes.some(scope => scope !== 'public_profile')) fail('invalid_request');
  const data = response?.data;
  if (response?.error || !data || typeof data !== 'object' || Array.isArray(data)) fail('oauth_credentials_incomplete');
  if (data.is_valid !== true) fail('credential_revoked');
  if (data.app_id !== expected.appId || data.user_id !== expected.subjectId || !['USER', 'SYSTEM_USER'].includes(data.type)) fail('oauth_identity_mismatch');
  const scopes = data.scopes;
  if (!Array.isArray(scopes) || scopes.length !== expected.scopes.length || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !expected.scopes.includes(scope))) fail('oauth_credentials_incomplete');
  const granular = data.granular_scopes;
  if (!Array.isArray(granular) || granular.length > 3 || new Set(granular.map(row => row?.scope)).size !== granular.length) fail('oauth_credentials_incomplete');
  for (const entry of granular) {
    if (!entry || !scopes.includes(entry.scope) || entry.scope === 'public_profile'
      || !Array.isArray(entry.target_ids) || entry.target_ids.length !== 1 || entry.target_ids[0] !== expected.wabaId) fail('scope_denied');
  }
  for (const scope of scopes.filter(scope => scope !== 'public_profile')) {
    if (!granular.some(row => row.scope === scope)) fail('scope_denied');
  }
  const expiresAt = remoteExpiry(data.expires_at, now);
  const dataAccessExpiresAt = remoteExpiry(data.data_access_expires_at, now);
  return { appId: data.app_id, subjectId: data.user_id, wabaId: expected.wabaId, tokenType: data.type,
    scopes: [...scopes].sort(), expiresAt, dataAccessExpiresAt };
}
function createWhatsappCredentialInspector({ http, now = () => Date.now() }) {
  if (typeof http !== 'function') fail('invalid_request');
  return async ({ candidate, applicationToken, expected, signal }) => {
    const raw = await http({ action: 'inspect', id: expected.appId, token: applicationToken, candidate, signal });
    if (signal?.aborted) fail('provider_timeout');
    return verifyWhatsappGrant(raw, expected, now());
  };
}
module.exports = { verifyWhatsappGrant, createWhatsappCredentialInspector };
