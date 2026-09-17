'use strict';
const C = require('./whatsapp-onboarding-contract');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const PREPARE = 'meta.whatsapp.onboarding.prepare.v1';
const PREFIX = '/clinicaclick/integrations/prod/whatsapp/automatic/';
const ACCOUNT = '137819318729'; const REGION = 'eu-west-3';
const ARN_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`;
const scopeKey = v => typeof v === 'string' && /^(clinic|group):[1-9][0-9]{0,9}$/.test(v)
  && Number(v.split(':')[1]) <= 2147483647;
function connectionRef(scope) {
  if (!scopeKey(scope)) fail('invalid_request');
  return 'whatsapp-auto-' + scope.replace(':', '-') + '-v1';
}
function publicBinding(template, scope, clinicIds) {
  const binding = { connectionRef: connectionRef(scope), scopeKey: scope, clinicIds: [...clinicIds],
    appId: template.appId, configId: template.configId, redirectUri: template.redirectUri,
    scopes: [...template.scopes], customer: { selectionOnly: true } };
  const { connectionRef: ref, ...metadata } = binding;
  C.bindingFor({ provider: C.PROVIDER, connectionRef: ref, secretArn: 'candidate', clientSecretArn: 'application',
    whatsappOnboarding: { ...metadata, appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32) } });
  return binding;
}
function validatePublicTemplate(value) {
  if (!C.exact(value, ['appId', 'configId', 'redirectUri', 'scopes'])) fail('invalid_request');
  const b = { scopeKey: 'clinic:1', clinicIds: [1], ...value, customer: { selectionOnly: true },
    appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32) };
  C.bindingFor({ provider: C.PROVIDER, secretArn: 'candidate', clientSecretArn: 'application', whatsappOnboarding: b });
  return structuredClone(value);
}
function validateSettings(v) {
  if (!C.exact(v, ['appId','configId','redirectUri','scopes','appVersionId','clientSecretArn','maxConnections'])
    || typeof v.appVersionId !== 'string' || !/^[A-Za-z0-9-]{32,64}$/.test(v.appVersionId)
    || typeof v.clientSecretArn !== 'string' || !v.clientSecretArn.startsWith(ARN_PREFIX + '/clinicaclick/integrations/prod/')
    || v.clientSecretArn.startsWith(ARN_PREFIX + PREFIX)
    || !/^[A-Za-z0-9/_+=.@-]+$/.test(v.clientSecretArn.slice(ARN_PREFIX.length))
    || !Number.isInteger(v.maxConnections) || v.maxConnections < 1 || v.maxConnections > 10000) fail('invalid_request');
  validatePublicTemplate(Object.fromEntries(['appId','configId','redirectUri','scopes'].map(k => [k,v[k]])));
  return structuredClone(v);
}
function validatePreparation(v, now) {
  if (!C.exact(v, ['scopeKey','clinicIds','scopeDigest','clinicSetDigest','expiresAt']) || !scopeKey(v.scopeKey)
    || !Array.isArray(v.clinicIds) || !v.clinicIds.length || v.clinicIds.length > 1000
    || v.clinicIds.some((id,i) => !Number.isInteger(id) || id < 1 || id > 2147483647 || i > 0 && id <= v.clinicIds[i-1])
    || v.scopeKey.startsWith('clinic:') && (v.clinicIds.length !== 1 || v.scopeKey !== 'clinic:' + v.clinicIds[0])
    || typeof v.scopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.scopeDigest)
    || v.clinicSetDigest !== C.hash(JSON.stringify(v.clinicIds))
    || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now || v.expiresAt > now + 30 * 60000) fail('invalid_request');
  return v;
}
function settingsDigest(settings) {
  const { maxConnections, ...identity } = validateSettings(settings);
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
  const { connectionRef: ref, ...metadata } = publicBinding(config,row.scope,ids);
  const binding = {connectionRef:ref,provider:C.PROVIDER,initialState:'active',expiresAt:null,
    secretArn:row.arn,clientSecretArn:config.clientSecretArn,
    whatsappOnboarding:{...metadata,appVersionId:config.appVersionId,slotVersionId:row.version_id}};
  C.bindingFor(binding); return binding;
}
module.exports = { PREPARE, PREFIX, ARN_PREFIX, connectionRef, publicBinding, validatePublicTemplate, validateSettings,
  validatePreparation, settingsDigest, bindingFromSlot };
