'use strict';
const Ajv = require('ajv');
const { schema, ref } = require('./contracts');
const { fail } = require('./errors');
const PROVIDER = 'meta_marketing';
const COHORT = 'meta-marketing-read-v1';
const GRAPH_VERSION = 'v24.0';
const STATUS = 'meta.marketing.connection.read.v1';
const ASSET = 'meta.marketing.asset.read.v1';
const REVOKE = 'meta.marketing.asset.revoke.v1';
const OPERATIONS = Object.freeze([STATUS, ASSET]);
const SCOPES = Object.freeze(['public_profile', 'ads_read', 'pages_show_list', 'pages_read_engagement', 'instagram_basic']);
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const id = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const pin = { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const bindingSchema = object({ appId: id, subjectId: id, tokenVersionId: pin, appVersionId: pin,
  scopes: { type: 'array', minItems: 1, maxItems: SCOPES.length, uniqueItems: true, items: { enum: SCOPES } },
  assets: { type: 'array', minItems: 1, maxItems: 100, items: object({ assetRef: ref,
    kind: { enum: ['ad_account', 'facebook_page', 'instagram_business'] }, id, parentPageId: { type: ['string', 'null'], pattern: id.pattern } }) },
});
const checkBinding = new Ajv({ strict: true }).compile(bindingSchema);
const empty = schema({});
function requiredScopes(kind) {
  return kind === 'ad_account' ? ['ads_read'] : kind === 'facebook_page' ? ['pages_read_engagement'] : ['pages_read_engagement', 'instagram_basic'];
}
function bindingFor(binding) {
  const value = binding?.metaMarketing;
  if (binding?.provider !== PROVIDER || !checkBinding(value)) fail('invalid_request');
  const seen = new Set();
  for (const asset of value.assets) {
    if (asset.assetRef !== `meta-${asset.kind}:${asset.id}` || seen.has(asset.assetRef)
      || (asset.kind === 'instagram_business' ? !graphId(asset.parentPageId) : asset.parentPageId !== null)
      || !requiredScopes(asset.kind).every(scope => value.scopes.includes(scope))) fail('invalid_request');
    seen.add(asset.assetRef);
  }
  return value;
}
function resource(binding, assetRef) {
  const asset = bindingFor(binding).assets.find(row => row.assetRef === assetRef);
  if (!asset) fail('scope_denied');
  return asset;
}
function validate(operation, payload) {
  if (![...OPERATIONS, REVOKE].includes(operation)) fail('operation_denied');
  return empty(payload);
}
function expiry(value, now) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) fail('oauth_credentials_incomplete');
  if (value === 0) return null;
  if (value * 1000 <= now) fail('credential_revoked');
  return value * 1000;
}
function verifyCredential(raw, binding, now) {
  return inspectCredential(raw, bindingFor(binding), now);
}
function inspectCredential(raw, expected, now) {
  if (!graphId(expected?.appId) || !graphId(expected?.subjectId) || !Array.isArray(expected.scopes)
    || !expected.scopes.length || new Set(expected.scopes).size !== expected.scopes.length
    || expected.scopes.some(scope => !SCOPES.includes(scope))) fail('invalid_request');
  const data = raw?.data;
  if (raw?.error || !data || typeof data !== 'object' || Array.isArray(data)) fail('oauth_credentials_incomplete');
  if (data.is_valid !== true) fail('credential_revoked');
  if (data.app_id !== expected.appId || data.user_id !== expected.subjectId || !['USER', 'SYSTEM_USER'].includes(data.type)) fail('oauth_identity_mismatch');
  if (!Array.isArray(data.scopes) || data.scopes.length !== expected.scopes.length || new Set(data.scopes).size !== data.scopes.length
    || data.scopes.some(scope => !expected.scopes.includes(scope))) fail('oauth_credentials_incomplete');
  const granular = data.granular_scopes === undefined ? [] : data.granular_scopes;
  if (!Array.isArray(granular) || granular.length > SCOPES.length || new Set(granular.map(row => row?.scope)).size !== granular.length
    || granular.some(row => !row || !expected.scopes.includes(row.scope) || !Array.isArray(row.target_ids)
      || row.target_ids.length > 1000 || !row.target_ids.every(graphId) || new Set(row.target_ids).size !== row.target_ids.length)) fail('oauth_credentials_incomplete');
  return { appId: expected.appId, subjectId: expected.subjectId, tokenType: data.type,
    scopes: [...data.scopes].sort(), expiresAt: expiry(data.expires_at, now),
    dataAccessExpiresAt: expiry(data.data_access_expires_at, now), granularScopes: granular.map(row => ({ scope: row.scope, targetIds: [...row.target_ids] })), verifiedAt: now };
}
function assertAssetCredential(metadata, asset) {
  for (const scope of requiredScopes(asset.kind)) {
    if (!metadata.scopes.includes(scope)) fail('scope_denied');
    const granular = metadata.granularScopes.find(row => row.scope === scope);
    // Instagram permissions use the linked Facebook page as their target.
    if (granular && !granular.targetIds.includes(asset.parentPageId || asset.id)) fail('scope_denied');
  }
}
function safeText(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) fail('provider_failed');
  return value;
}
function projectAsset(raw, asset) {
  if (!raw || raw.error || raw.id !== (asset.kind === 'ad_account' ? 'act_' + asset.id : asset.id)) fail('provider_failed');
  const name = asset.kind === 'instagram_business' && (raw.name == null || raw.name === '') ? raw.username : raw.name;
  const result = { assetRef: asset.assetRef, kind: asset.kind, id: raw.id, name: safeText(name, 256) };
  if (asset.kind === 'ad_account') {
    if (raw.account_id !== asset.id || !Number.isSafeInteger(raw.account_status) || raw.account_status < 0 || raw.account_status > 1000
      || typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)
      || typeof raw.timezone_name !== 'string' || !/^[A-Za-z0-9_+./-]{1,100}$/.test(raw.timezone_name)) fail('provider_failed');
    Object.assign(result, { accountStatus: raw.account_status, currency: raw.currency, timezone: raw.timezone_name });
  } else if (asset.kind === 'instagram_business') result.username = safeText(raw.username, 100);
  return result;
}
module.exports = { PROVIDER, COHORT, GRAPH_VERSION, STATUS, ASSET, REVOKE, OPERATIONS, SCOPES,
  bindingSchema, bindingFor, resource, requiredScopes, graphId, validate, verifyCredential, inspectCredential, assertAssetCredential, projectAsset };
