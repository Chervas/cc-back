'use strict';
const C = require('./whatsapp-onboarding-contract');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const PREPARE = 'meta.whatsapp.onboarding.prepare.v1';
const PREFIX = '/clinicaclick/integrations/prod/whatsapp/automatic/';
const ACCOUNT = '137819318729'; const REGION = 'eu-west-3';
const ARN_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`;
// Internal slot marker. NULL belongs to pre-mode slots and retains their
// original scope override; this marker pins a new strict Cloud enrollment.
const STRICT_GRANT_POLICY = 'strict-v1';
const validMode = mode => mode === undefined || ['cloud_api','coexistence'].includes(mode);
const templateOptions = value => ['grantPolicyOverrides','coexistenceGrantPolicy'].filter(key => Object.hasOwn(value || {}, key));
const scopeKey = v => typeof v === 'string' && /^(clinic|group):[1-9][0-9]{0,9}$/.test(v)
  && Number(v.split(':')[1]) <= 2147483647;
function connectionRef(scope) {
  if (!scopeKey(scope)) fail('invalid_request');
  return 'whatsapp-auto-' + scope.replace(':', '-') + '-v1';
}
function grantPolicyOverrides(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64
    || value.some((entry, i) => !C.exact(entry, ['scopeKey','policy']) || !scopeKey(entry.scopeKey)
      || entry.policy !== C.PROVIDER_GRANT_POLICY || i > 0 && entry.scopeKey <= value[i - 1].scopeKey)) fail('invalid_request');
  return structuredClone(value);
}
function publicTemplate(value) {
  return Object.fromEntries(['appId','configId','redirectUri','scopes', ...templateOptions(value)]
    .map(key => [key, structuredClone(value[key])]));
}
function publicBinding(template, scope, clinicIds, mode) {
  if (!validMode(mode)) fail('invalid_request');
  const binding = { connectionRef: connectionRef(scope), scopeKey: scope, clinicIds: [...clinicIds],
    appId: template.appId, configId: template.configId, redirectUri: template.redirectUri,
    scopes: [...template.scopes], customer: { selectionOnly: true } };
  // An explicit mode is authenticated intent, not provider evidence. The Owner
  // still proves Business App coexistence before saving any companion token.
  if (mode === 'coexistence' && template.coexistenceGrantPolicy !== undefined) {
    if (template.coexistenceGrantPolicy !== C.PROVIDER_GRANT_POLICY) fail('invalid_request');
    binding.customer.providerGrantPolicy = template.coexistenceGrantPolicy;
  } else if (mode !== 'cloud_api' && Object.hasOwn(template, 'grantPolicyOverrides')) {
    const override = grantPolicyOverrides(template.grantPolicyOverrides).find(entry => entry.scopeKey === scope);
    if (override) binding.customer.providerGrantPolicy = override.policy;
  }
  const { connectionRef: ref, ...metadata } = binding;
  C.bindingFor({ provider: C.PROVIDER, connectionRef: ref, secretArn: 'candidate', clientSecretArn: 'application',
    whatsappOnboarding: { ...metadata, appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32) } });
  return binding;
}
function validatePublicTemplate(value) {
  if (!C.exact(value, ['appId', 'configId', 'redirectUri', 'scopes', ...templateOptions(value)])
    || Object.hasOwn(value, 'coexistenceGrantPolicy') && value.coexistenceGrantPolicy !== C.PROVIDER_GRANT_POLICY) fail('invalid_request');
  if (Object.hasOwn(value, 'grantPolicyOverrides')) grantPolicyOverrides(value.grantPolicyOverrides);
  const b = { scopeKey: 'clinic:1', clinicIds: [1], ...Object.fromEntries(['appId','configId','redirectUri','scopes'].map(key => [key, value[key]])), customer: { selectionOnly: true },
    appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32) };
  C.bindingFor({ provider: C.PROVIDER, secretArn: 'candidate', clientSecretArn: 'application', whatsappOnboarding: b });
  if (value.grantPolicyOverrides || value.coexistenceGrantPolicy) C.bindingFor({ provider: C.PROVIDER, secretArn: 'candidate', clientSecretArn: 'application',
    whatsappOnboarding: { ...b, customer: { selectionOnly: true, providerGrantPolicy: C.PROVIDER_GRANT_POLICY } } });
  return structuredClone(value);
}
function validateSettings(v) {
  if (!C.exact(v, ['appId','configId','redirectUri','scopes','appVersionId','clientSecretArn','maxConnections',
    ...templateOptions(v)])
    || typeof v.appVersionId !== 'string' || !/^[A-Za-z0-9-]{32,64}$/.test(v.appVersionId)
    || typeof v.clientSecretArn !== 'string' || !v.clientSecretArn.startsWith(ARN_PREFIX + '/clinicaclick/integrations/prod/')
    || v.clientSecretArn.startsWith(ARN_PREFIX + PREFIX)
    || !/^[A-Za-z0-9/_+=.@-]+$/.test(v.clientSecretArn.slice(ARN_PREFIX.length))
    || !Number.isInteger(v.maxConnections) || v.maxConnections < 1 || v.maxConnections > 10000) fail('invalid_request');
  validatePublicTemplate(publicTemplate(v));
  return structuredClone(v);
}
function validatePreparation(v, now) {
  if (!C.exact(v, ['scopeKey','clinicIds','scopeDigest','clinicSetDigest','expiresAt',
    ...(Object.hasOwn(v || {}, 'mode') ? ['mode'] : [])]) || !validMode(v.mode)
    || Object.hasOwn(v, 'mode') && v.mode === undefined || !scopeKey(v.scopeKey)
    || !Array.isArray(v.clinicIds) || !v.clinicIds.length || v.clinicIds.length > 1000
    || v.clinicIds.some((id,i) => !Number.isInteger(id) || id < 1 || id > 2147483647 || i > 0 && id <= v.clinicIds[i-1])
    || v.scopeKey.startsWith('clinic:') && (v.clinicIds.length !== 1 || v.scopeKey !== 'clinic:' + v.clinicIds[0])
    || typeof v.scopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.scopeDigest)
    || v.clinicSetDigest !== C.hash(JSON.stringify(v.clinicIds))
    || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now || v.expiresAt > now + 30 * 60000) fail('invalid_request');
  return v;
}
function settingsDigest(settings) {
  // Scope overrides are pinned by each derived enrollment fingerprint, not by
  // the common empty-slot identity. Unrelated ready slots retain their digest.
  const { maxConnections, grantPolicyOverrides: overrides, coexistenceGrantPolicy: capability, ...identity } = validateSettings(settings);
  return C.hash(canonical(identity));
}
function bindingFromSlot(settings, row) {
  const config = validateSettings(settings);
  if (!row || row.state !== 'ready' || row.config_digest !== settingsDigest(config)
    || row.connection !== connectionRef(row.scope) || row.name !== PREFIX + row.scope.replace(':','-') + '/candidate'
    || !C.uuid(row.version_id) || typeof row.arn !== 'string' || !row.arn.startsWith(ARN_PREFIX + row.name + '-')
    || !/^[A-Za-z0-9]{6}$/.test(row.arn.slice((ARN_PREFIX + row.name + '-').length))) fail('scope_denied');
  let ids; try { ids = JSON.parse(row.clinic_ids); } catch { fail('scope_denied'); }
  if (!Array.isArray(ids)) fail('scope_denied');
  if (row.provider_grant_policy != null && ![STRICT_GRANT_POLICY,C.PROVIDER_GRANT_POLICY].includes(row.provider_grant_policy)) fail('scope_denied');
  // Persisted selection wins over future changes to admission capabilities.
  // Old NULL rows deliberately continue through the exact legacy code path.
  const { connectionRef: ref, ...metadata } = publicBinding(config,row.scope,ids,
    row.provider_grant_policy === STRICT_GRANT_POLICY ? 'cloud_api' : undefined);
  if (row.provider_grant_policy === C.PROVIDER_GRANT_POLICY) metadata.customer.providerGrantPolicy = C.PROVIDER_GRANT_POLICY;
  const binding = {connectionRef:ref,provider:C.PROVIDER,initialState:'active',expiresAt:null,
    secretArn:row.arn,clientSecretArn:config.clientSecretArn,
    whatsappOnboarding:{...metadata,appVersionId:config.appVersionId,slotVersionId:row.version_id}};
  C.bindingFor(binding); return binding;
}
module.exports = { PREPARE, PREFIX, ARN_PREFIX, connectionRef, publicBinding, validatePublicTemplate, validateSettings,
  validatePreparation, settingsDigest, bindingFromSlot, publicTemplate, STRICT_GRANT_POLICY };
