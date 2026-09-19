'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'), { fail } = require('./errors');
const M = require('./meta-marketing-contract');
const PROVIDER = 'meta_marketing_onboarding', COHORT = 'meta-marketing-oauth-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['begin', 'finish', 'status', 'abort'].map(k => [k, `meta.marketing.oauth.${k}.v1`])));
const id = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const pin = { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' }, state = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const bindingSchema = object({ appId: id, appVersionId: pin, slotVersionId: pin,
  redirectUri: { type: 'string', maxLength: 512 }, scopeKey: { type: 'string', pattern: '^(clinic|group):[1-9][0-9]{0,9}$' },
  clinicIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 } },
  scopes: { type: 'array', minItems: 2, maxItems: M.SCOPES.length, uniqueItems: true, items: { enum: M.SCOPES } } });
const checkBinding = schema({ value: bindingSchema });
const validators = {
  begin: schema({ state, scopeDigest: digest, clinicSetDigest: digest, expiresAt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }),
  finish: schema({ flowId: uuid, state, code: { type: 'string', pattern: '^[\\x21-\\x7e]{1,4096}$' } }),
  status: schema({ flowId: uuid }), abort: schema({ flowId: uuid }),
};
const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (v, fields) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
function bindingFor(binding) {
  if (binding?.provider !== PROVIDER) fail('invalid_request');
  const b = binding.metaMarketingOAuth; checkBinding({ value: b });
  let uri; try { uri = new URL(b.redirectUri); } catch { fail('invalid_request'); }
  if (uri.href !== b.redirectUri || uri.protocol !== 'https:' || uri.username || uri.password || uri.port || uri.search || uri.hash
    || uri.pathname !== '/oauth/meta/marketing/callback' || Number(b.scopeKey.split(':')[1]) > 2147483647
    || b.clinicIds.some((v, i) => i > 0 && v <= b.clinicIds[i - 1])
    || b.scopeKey.startsWith('clinic:') && (b.clinicIds.length !== 1 || b.scopeKey !== 'clinic:' + b.clinicIds[0])
    || !b.scopes.includes('public_profile') || !b.scopes.some(s => s !== 'public_profile')
    || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0
    || typeof binding.secretArn !== 'string' || typeof binding.clientSecretArn !== 'string' || binding.secretArn === binding.clientSecretArn) fail('invalid_request');
  return b;
}
const clinicDigest = b => hash(JSON.stringify(b.clinicIds));
function fingerprint(binding) {
  const b = bindingFor(binding);
  return hash(JSON.stringify([binding.connectionRef, binding.secretArn, binding.clientSecretArn, binding.expiresAt,
    b.appId, b.appVersionId, b.slotVersionId, b.redirectUri, b.scopeKey, b.clinicIds, [...b.scopes].sort()]));
}
function authorize({ request, binding, principal }) {
  const b = bindingFor(binding);
  if (request.tenantRef !== 'clinic:' + b.clinicIds[0] || request.assetRef !== 'meta-enroll:' + b.scopeKey
    || !/^(gateway|control):(dev|staging):meta-marketing-oauth$/.test(principal.id)
    || principal.id.startsWith('control:') && ![OPERATIONS.abort, OPERATIONS.status].includes(request.operation)) fail('scope_denied');
}
function metadata(value, binding) {
  const b = bindingFor(binding);
  if (!exact(value, 'appId,subjectId,tokenType,scopes,expiresAt,dataAccessExpiresAt,granularScopes')
    || value.appId !== b.appId || !M.graphId(value.subjectId) || value.tokenType !== 'USER'
    || JSON.stringify(value.scopes) !== JSON.stringify([...b.scopes].sort())
    || ![value.expiresAt, value.dataAccessExpiresAt].every(v => v === null || Number.isSafeInteger(v) && v > 0)
    || !Array.isArray(value.granularScopes) || value.granularScopes.length > b.scopes.length
    || value.granularScopes.some((v, i, all) => !exact(v, 'scope,targetIds') || !b.scopes.includes(v.scope)
      || i > 0 && v.scope <= all[i - 1].scope || !Array.isArray(v.targetIds) || v.targetIds.length > 1000
      || v.targetIds.some((id, j, ids) => !M.graphId(id) || j > 0 && id <= ids[j - 1]))) fail('oauth_credentials_incomplete');
  return structuredClone(value);
}
function inspected(raw, binding, now) {
  const b = bindingFor(binding), subjectId = raw?.data?.user_id;
  const checked = M.inspectCredential(raw, { appId: b.appId, subjectId, scopes: b.scopes }, now);
  delete checked.verifiedAt;
  checked.granularScopes = checked.granularScopes.map(v => ({ scope: v.scope, targetIds: v.targetIds.sort() })).sort((a,b) => a.scope.localeCompare(b.scope));
  return metadata(checked, binding);
}
module.exports = { PROVIDER, COHORT, OPERATIONS, bindingSchema, validators, bindingFor, clinicDigest, fingerprint,
  authorize, metadata, inspected, hash, exact, uuid: value => typeof value === 'string' && new RegExp(uuid.pattern).test(value) };
