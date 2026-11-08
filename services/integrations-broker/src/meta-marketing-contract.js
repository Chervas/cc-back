'use strict';
const Ajv = require('ajv');
const { schema, ref } = require('./contracts');
const { BrokerError, fail } = require('./errors');
const PROVIDER = 'meta_marketing';
const COHORT = 'meta-marketing-read-v1';
const GRAPH_VERSION = 'v24.0';
const STATUS = 'meta.marketing.connection.read.v1';
const ASSET = 'meta.marketing.asset.read.v1';
const REVOKE = 'meta.marketing.asset.revoke.v1';
const OPERATIONS = Object.freeze([STATUS, ASSET]);
const SCOPES = Object.freeze(['public_profile', 'ads_read', 'pages_show_list', 'pages_read_engagement', 'instagram_basic', 'leads_retrieval', 'pages_manage_ads', 'pages_manage_metadata']);
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
  if (!Number.isSafeInteger(value) || value < 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) credentialFailure('debug_expiry_shape');
  if (value === 0) return null;
  if (value * 1000 <= now) fail('credential_revoked');
  return value * 1000;
}
function credentialFailure(reason, dimensions) {
  // Fixed diagnostics only: never print provider values, permissions, tokens,
  // identifiers or a thrown provider message. This survives the outer safeError
  // projection without adding an RPC field or changing the audit envelope.
  const error = new BrokerError('oauth_credentials_incomplete');
  Object.defineProperty(error, 'credentialValidationReason', { value: reason });
  try { process.stderr.write(JSON.stringify({ event: 'meta_marketing_credential_validation_failed', reason, ...(dimensions ? { dimensions } : {}) }) + '\n'); } catch {}
  throw error;
}
const observedScope = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value);
function granularDimensions(value, scopes, expected) {
  // Fixed keys, categories and bounded counts only; never provider key names or
  // values. Inspect a bounded prefix even when the response itself is invalid.
  const rows = Array.isArray(value) ? value.slice(0, 64) : [];
  const result = { kind: value === undefined ? 'absent' : Array.isArray(value) ? 'array' : 'invalid',
    rowCount: Array.isArray(value) ? Math.min(value.length, 65) : 0, invalidRows: 0, unknownKeys: 0,
    badScopeSyntax: 0, duplicateScopes: 0, scopesAbsentFromTopLevel: 0, unrequestedScopes: 0,
    missingTargets: 0, withTargets: 0, nonArrayTargets: 0, excessiveTargetRows: 0,
    badTargetIds: 0, duplicateTargetIds: 0, targetsTotal: 0 };
  const seen = new Set();
  for (const row of rows) {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype) { result.invalidRows++; continue; }
    if (!['scope', 'scope,target_ids'].includes(Object.keys(row).sort().join(','))) result.unknownKeys++;
    if (!observedScope(row.scope)) result.badScopeSyntax++;
    else { if (!scopes.includes(row.scope)) result.scopesAbsentFromTopLevel++; if (!expected.includes(row.scope)) result.unrequestedScopes++; }
    if (seen.has(row.scope)) result.duplicateScopes++; seen.add(row.scope);
    if (!Object.hasOwn(row, 'target_ids')) { result.missingTargets++; continue; }
    result.withTargets++;
    if (!Array.isArray(row.target_ids)) { result.nonArrayTargets++; continue; }
    if (row.target_ids.length > 1000) result.excessiveTargetRows++;
    result.targetsTotal = Math.min(10001, result.targetsTotal + row.target_ids.length);
    const ids = new Set();
    for (const target of row.target_ids.slice(0, 1001)) { if (!graphId(target)) result.badTargetIds++; if (ids.has(target)) result.duplicateTargetIds++; ids.add(target); }
  }
  return result;
}
function verifyCredential(raw, binding, now) {
  return inspectCredential(raw, bindingFor(binding), now);
}
function inspectCredential(raw, expected, now, allowedScopes = SCOPES) {
  if (!graphId(expected?.appId) || !graphId(expected?.subjectId) || !Array.isArray(expected.scopes)
    || !expected.scopes.length || new Set(expected.scopes).size !== expected.scopes.length
    || expected.scopes.some(scope => !allowedScopes.includes(scope))) fail('invalid_request');
  const data = raw?.data;
  if (raw?.error || !data || typeof data !== 'object' || Array.isArray(data)) credentialFailure('debug_response_shape');
  if (data.is_valid !== true) fail('credential_revoked');
  if (data.app_id !== expected.appId || data.user_id !== expected.subjectId || !['USER', 'SYSTEM_USER'].includes(data.type)) fail('oauth_identity_mismatch');
  // Meta's opaque token may contain earlier app grants. They are observation,
  // never broker authority: validate the entire bounded set, require the binding
  // subset, then project exactly that subset into our credential metadata.
  if (!Array.isArray(data.scopes) || !data.scopes.length || data.scopes.length > 64
    || !data.scopes.every(observedScope) || new Set(data.scopes).size !== data.scopes.length) credentialFailure('debug_scope_shape');
  if (!expected.scopes.every(scope => data.scopes.includes(scope))) credentialFailure('debug_required_scope_missing');
  const granular = data.granular_scopes === undefined ? [] : data.granular_scopes;
  let targets = 0;
  if (!Array.isArray(granular) || granular.length > 64 || new Set(granular.map(row => row?.scope)).size !== granular.length
    || granular.some(row => !row || Object.getPrototypeOf(row) !== Object.prototype
      || !['scope', 'scope,target_ids'].includes(Object.keys(row).sort().join(',')) || !observedScope(row.scope)
      || Object.hasOwn(row, 'target_ids') && (!Array.isArray(row.target_ids) || row.target_ids.length > 1000 || !row.target_ids.every(graphId)
        || new Set(row.target_ids).size !== row.target_ids.length || (targets += row.target_ids.length) > 10000))) credentialFailure('debug_granular_shape', granularDimensions(data.granular_scopes, data.scopes, expected.scopes));
  // Internal normalization: a row without target evidence has the same local
  // meaning as an omitted row, which was already accepted. It does not attest
  // unrestricted provider access. Explicit [] remains evidence denying assets.
  const metadata = { appId: expected.appId, subjectId: expected.subjectId, tokenType: data.type,
    scopes: [...expected.scopes].sort(), expiresAt: expiry(data.expires_at, now),
    dataAccessExpiresAt: expiry(data.data_access_expires_at, now), granularScopes: granular.filter(row => expected.scopes.includes(row.scope) && Object.hasOwn(row, 'target_ids'))
      .map(row => ({ scope: row.scope, targetIds: [...row.target_ids] })), verifiedAt: now };
  const ignoredScopeCount = data.scopes.length - expected.scopes.length;
  if (ignoredScopeCount > 0) {
    try { process.stderr.write(JSON.stringify({ event: 'meta_marketing_scopes_projected', requestedScopeCount: expected.scopes.length, ignoredScopeCount }) + '\n'); } catch {}
  }
  return metadata;
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
  bindingSchema, bindingFor, resource, requiredScopes, graphId, validate, verifyCredential, inspectCredential,
  inspectBusinessCredential:(raw,expected,now)=>inspectCredential(raw,expected,now,['ads_read','business_management','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list']),
  assertAssetCredential, projectAsset };
