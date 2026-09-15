'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'); const { fail } = require('./errors');
const PROVIDER = 'meta_whatsapp_onboarding'; const COHORT = 'whatsapp-onboarding-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['begin', 'finish', 'status', 'abort'].map(k => [k, `meta.whatsapp.onboarding.${k}.v1`])));
const REVOKE = 'meta.whatsapp.onboarding.scope.revoke.v1';
const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const uuidSchema = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const scopes = ['whatsapp_business_management', 'whatsapp_business_messaging', 'public_profile'];
const bindingSchema = { type: 'object', additionalProperties: false, properties: {
  appId: idSchema, configId: idSchema, redirectUri: { type: 'string', maxLength: 2048 },
  appVersionId: { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' }, slotVersionId: { type: 'string', pattern: '^[A-Za-z0-9-]{32,64}$' },
  scopeKey: { type: 'string', pattern: '^(clinic|group):[1-9][0-9]{0,9}$' },
  clinicIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 } },
  scopes: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { enum: scopes } },
}, required: ['appId', 'configId', 'redirectUri', 'appVersionId', 'slotVersionId', 'scopeKey', 'clinicIds', 'scopes'] };
const validateBinding = schema({ value: bindingSchema });
const validators = {
  begin: schema({ state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, expiresAt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    scopeDigest: hashSchema, clinicSetDigest: hashSchema }),
  finish: schema({ flowId: uuidSchema, state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    code: { type: 'string', pattern: '^[\\x21-\\x7e]{1,4096}$' }, wabaId: idSchema, phoneId: { anyOf: [idSchema, { type: 'null' }] } }),
  status: schema({ flowId: uuidSchema }), abort: schema({ flowId: uuidSchema }),
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
  return v;
}
const clinicDigest = v => hash(JSON.stringify(v.clinicIds));
function fingerprint(binding) {
  const v = bindingFor(binding);
  return hash(JSON.stringify([binding.connectionRef, binding.secretArn, binding.clientSecretArn, v.appId, v.configId, v.redirectUri,
    v.appVersionId, v.slotVersionId, v.scopeKey, v.clinicIds, [...v.scopes].sort()]));
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
  if (!exact(v, ['appId', 'subjectId', 'wabaId', 'phoneId', 'tokenType', 'scopes', 'expiresAt', 'dataAccessExpiresAt'])
    || v.appId !== b.appId || ![v.subjectId, v.wabaId, v.phoneId].every(id) || !['USER', 'SYSTEM_USER'].includes(v.tokenType)
    || !Array.isArray(v.scopes) || JSON.stringify([...v.scopes].sort()) !== JSON.stringify([...b.scopes].sort())
    || ![v.expiresAt, v.dataAccessExpiresAt].every(t => t === null || Number.isSafeInteger(t) && t > 0)) fail('oauth_credentials_incomplete');
  return { appId: v.appId, subjectId: v.subjectId, wabaId: v.wabaId, phoneId: v.phoneId, tokenType: v.tokenType,
    scopes: [...v.scopes].sort(), expiresAt: v.expiresAt, dataAccessExpiresAt: v.dataAccessExpiresAt };
}
module.exports = { PROVIDER, COHORT, OPERATIONS, REVOKE, bindingSchema, validators, bindingFor, clinicDigest, fingerprint, authorize, grantMetadata, hash, uuid, id, exact };
