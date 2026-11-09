'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'); const { fail } = require('./errors');
const PROVIDER = 'meta_whatsapp_onboarding'; const COHORT = 'whatsapp-onboarding-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['begin', 'finish', 'status', 'abort'].map(k => [k, `meta.whatsapp.onboarding.${k}.v1`])));
const REVOKE = 'meta.whatsapp.onboarding.scope.revoke.v1';
const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const uuidSchema = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const scopes = ['whatsapp_business_management', 'whatsapp_business_messaging', 'public_profile', 'whatsapp_business_manage_events'];
const OPTIONAL_SELECTION_SCOPE = 'whatsapp_business_manage_events';
const PROVIDER_GRANT_POLICY = 'meta-app-companion-v1';
const COMPANION_SCOPES = Object.freeze(['business_management', 'ads_management', 'ads_read', 'leads_retrieval',
  'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads']);
const PROVIDER_GRANT_LIMITS = Object.freeze({ maxScopes: 12, maxTargetsPerScope: 64, maxTargetsTotal: 256, maxBytes: 12288 });
const bindingSchema = { type: 'object', additionalProperties: false, properties: {
  appId: idSchema, configId: idSchema, redirectUri: { type: 'string', maxLength: 2048 },
  appVersionId: { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' }, slotVersionId: { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' },
  scopeKey: { type: 'string', pattern: '^(clinic|group):[1-9][0-9]{0,9}$' },
  clinicIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 } },
  scopes: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, items: { enum: scopes } },
  customer: { type: 'object', additionalProperties: false, properties: {
    businessId: idSchema, wabaIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: idSchema },
    selectionOnly: { const: true }, providerGrantPolicy: { const: PROVIDER_GRANT_POLICY },
  } },
}, required: ['appId', 'configId', 'redirectUri', 'appVersionId', 'slotVersionId', 'scopeKey', 'clinicIds', 'scopes'] };
const validateBinding = schema({ value: bindingSchema });
const validateStatus = schema({ flowId: uuidSchema });
const validateReadOnlyStatus = schema({ flowId: uuidSchema, readOnly: { const: true } });
const beginFields = { state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, expiresAt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  scopeDigest: hashSchema, clinicSetDigest: hashSchema };
const validateBeginV1 = schema(beginFields);
const validateBeginRole = schema({ ...beginFields, channelRole: { enum: ['primary','secondary'] } });
const validators = {
  begin: value => Object.hasOwn(value || {}, 'channelRole') ? validateBeginRole(value) : validateBeginV1(value),
  finish: schema({ flowId: uuidSchema, state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    code: { type: 'string', pattern: '^[\\x21-\\x7e]{1,4096}$' }, wabaId: idSchema, phoneId: { anyOf: [idSchema, { type: 'null' }] } }),
  status: value => Object.hasOwn(value || {}, 'readOnly') ? validateReadOnlyStatus(value) : validateStatus(value),
  abort: schema({ flowId: uuidSchema }),
};
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = v => typeof v === 'string' && new RegExp(uuidSchema.pattern).test(v);
const id = v => typeof v === 'string' && new RegExp(idSchema.pattern).test(v);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function bindingFor(binding) {
  if (binding?.provider !== PROVIDER) fail('invalid_request'); const v = binding.whatsappOnboarding;
  validateBinding({ value: v });
  let uri; try { uri = new URL(v.redirectUri); } catch { fail('invalid_request'); }
  if (uri.href !== v.redirectUri || uri.protocol !== 'https:' || uri.username || uri.password || uri.port || uri.search || uri.hash
    || Number(v.scopeKey.split(':')[1]) > 2147483647 || v.clinicIds.some((id, i) => i > 0 && id <= v.clinicIds[i - 1])
    || v.scopeKey.startsWith('clinic:') && (v.clinicIds.length !== 1 || v.scopeKey !== 'clinic:' + v.clinicIds[0])
    || !['whatsapp_business_management', 'whatsapp_business_messaging'].every(s => v.scopes.includes(s))
    || typeof binding.secretArn !== 'string' || typeof binding.clientSecretArn !== 'string' || binding.secretArn === binding.clientSecretArn) fail('invalid_request');
  if (v.scopes.includes('whatsapp_business_manage_events') && v.customer?.selectionOnly !== true) fail('invalid_request');
  if (v.customer?.providerGrantPolicy !== undefined
    && (v.customer.selectionOnly !== true || !v.scopes.includes('public_profile'))) fail('invalid_request');
  if (v.customer && (v.customer.wabaIds?.some((id, i, all) => i > 0 && id <= all[i - 1])
    || !v.customer.selectionOnly && (!v.customer.businessId || !v.customer.wabaIds || v.scopeKey.startsWith('clinic:') && v.customer.wabaIds.length !== 1))) fail('invalid_request');
  return v;
}
function grantedScopes(values, expected, selectionOnly, providerGrantPolicy) {
  if (providerGrantPolicy !== undefined && (providerGrantPolicy !== PROVIDER_GRANT_POLICY || selectionOnly !== true
    || !expected.includes('public_profile'))) fail('invalid_request');
  const allowed = providerGrantPolicy === PROVIDER_GRANT_POLICY ? [...expected, ...COMPANION_SCOPES] : expected;
  const optional = selectionOnly === true && expected.includes(OPTIONAL_SELECTION_SCOPE)
    ? OPTIONAL_SELECTION_SCOPE : null;
  if (!Array.isArray(values) || !values.length || values.length > allowed.length
    || new Set(values).size !== values.length || values.some(value => !allowed.includes(value))
    || expected.some(value => value !== optional && !values.includes(value))) fail('oauth_credentials_incomplete');
  return [...values].sort();
}
// Complete, bounded provider evidence. Marketing targets are observations only;
// consumers must never treat them as a WhatsApp or Marketing operation grant.
function validateProviderGrant(value, actualScopes) {
  grantedScopes(actualScopes, scopes, true, PROVIDER_GRANT_POLICY);
  if (!exact(value, ['version','granularScopes']) || value.version !== 1 || !Array.isArray(value.granularScopes)
    || !value.granularScopes.length || value.granularScopes.length > PROVIDER_GRANT_LIMITS.maxScopes) fail('oauth_credentials_incomplete');
  const seen = new Set(); let total = 0;
  const granularScopes = value.granularScopes.map(row => {
    if (!exact(row, ['scope','targetIds']) || !actualScopes.includes(row.scope) || seen.has(row.scope)
      || row.targetIds !== null && (!Array.isArray(row.targetIds) || row.targetIds.length > PROVIDER_GRANT_LIMITS.maxTargetsPerScope
        || row.targetIds.some(value => !id(value)) || new Set(row.targetIds).size !== row.targetIds.length)) fail('oauth_credentials_incomplete');
    seen.add(row.scope); total += row.targetIds?.length || 0;
    if (total > PROVIDER_GRANT_LIMITS.maxTargetsTotal) fail('oauth_credentials_incomplete');
    return { scope: row.scope, targetIds: row.targetIds === null ? null : [...row.targetIds].sort() };
  }).sort((a, b) => a.scope.localeCompare(b.scope));
  const normalized = { version: 1, granularScopes };
  if (Buffer.byteLength(JSON.stringify(normalized)) > PROVIDER_GRANT_LIMITS.maxBytes) fail('oauth_credentials_incomplete');
  return normalized;
}
const clinicDigest = v => hash(JSON.stringify(v.clinicIds));
function fingerprint(binding) {
  const v = bindingFor(binding);
  const parts = [binding.connectionRef, binding.secretArn, binding.clientSecretArn, v.appId, v.configId, v.redirectUri,
    v.appVersionId, v.slotVersionId, v.scopeKey, v.clinicIds, [...v.scopes].sort()];
  if (v.customer) parts.push(v.customer.businessId || null, v.customer.wabaIds || null);
  if (v.customer?.selectionOnly) parts.push('selected-phone-v1');
  if (v.customer?.providerGrantPolicy) parts.push('provider-grant-policy:' + v.customer.providerGrantPolicy);
  return hash(JSON.stringify(parts));
}
function authorize({ request, binding, principal }) {
  const v = bindingFor(binding);
  if (request.tenantRef !== 'clinic:' + v.clinicIds[0] || request.assetRef !== 'wa-enroll:' + v.scopeKey
    || !['gateway:whatsapp-onboarding', 'control:whatsapp-onboarding'].includes(principal.id)
    || principal.id === 'control:whatsapp-onboarding' && ![OPERATIONS.abort, OPERATIONS.status, REVOKE].includes(request.operation)
    || principal.id === 'gateway:whatsapp-onboarding' && request.operation === REVOKE) fail('scope_denied');
}
function grantMetadata(v, binding) {
  const b = bindingFor(binding);
  const companion = b.customer?.providerGrantPolicy === PROVIDER_GRANT_POLICY;
  const normalizedScopes = grantedScopes(v?.scopes, b.scopes, b.customer?.selectionOnly, b.customer?.providerGrantPolicy);
  if (!exact(v, ['appId', 'subjectId', 'wabaId', 'phoneId', 'tokenType', 'scopes', 'expiresAt', 'dataAccessExpiresAt',
    ...(b.customer ? ['businessId','grantedWabaIds'] : []), ...(companion ? ['providerGrant'] : [])])
    || v.appId !== b.appId || ![v.subjectId, v.wabaId, v.phoneId].every(id) || !['USER', 'SYSTEM_USER'].includes(v.tokenType)
    || ![v.expiresAt, v.dataAccessExpiresAt].every(t => t === null || Number.isSafeInteger(t) && t > 0)) fail('oauth_credentials_incomplete');
  if (b.customer && (!id(v.businessId) || b.customer.businessId && v.businessId !== b.customer.businessId || v.tokenType !== 'SYSTEM_USER'
    || !Array.isArray(v.grantedWabaIds) || !v.grantedWabaIds.length || v.grantedWabaIds.length > 64
    || !v.grantedWabaIds.includes(v.wabaId) || v.grantedWabaIds.some((value, i, all) => !id(value)
      || b.customer.wabaIds && !b.customer.wabaIds.includes(value) || i > 0 && value <= all[i - 1]))) fail('scope_denied');
  const providerGrant = companion ? validateProviderGrant(v.providerGrant, normalizedScopes) : null;
  if (companion) {
    const rows = providerGrant.granularScopes.filter(row => b.scopes.includes(row.scope) && row.scope !== 'public_profile');
    const wabas = new Set();
    for (const row of rows) {
      if (row.scope === OPTIONAL_SELECTION_SCOPE && (row.targetIds === null || !row.targetIds.length)) continue;
      if (!Array.isArray(row.targetIds) || !row.targetIds.length
        || b.customer.wabaIds && row.targetIds.some(value => !b.customer.wabaIds.includes(value))) fail('scope_denied');
      row.targetIds.forEach(value => wabas.add(value));
    }
    if (!['whatsapp_business_management','whatsapp_business_messaging'].every(scope => rows.find(row => row.scope === scope)?.targetIds?.includes(v.wabaId))
      || JSON.stringify([...wabas].sort()) !== JSON.stringify(v.grantedWabaIds)) fail('scope_denied');
  }
  return { appId: v.appId, subjectId: v.subjectId, wabaId: v.wabaId, phoneId: v.phoneId, tokenType: v.tokenType,
    scopes: normalizedScopes, expiresAt: v.expiresAt, dataAccessExpiresAt: v.dataAccessExpiresAt,
    ...(b.customer ? { businessId: v.businessId, grantedWabaIds: [...v.grantedWabaIds] } : {}),
    ...(companion ? { providerGrant } : {}) };
}
module.exports = { PROVIDER, COHORT, OPERATIONS, REVOKE, bindingSchema, validators, bindingFor, grantedScopes,
  clinicDigest, fingerprint, authorize, grantMetadata, hash, uuid, id, exact,
  PROVIDER_GRANT_POLICY, COMPANION_SCOPES, PROVIDER_GRANT_LIMITS, validateProviderGrant };
