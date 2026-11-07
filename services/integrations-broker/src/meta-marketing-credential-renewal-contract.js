'use strict';
const { schema } = require('./contracts'), { fail } = require('./errors');
const C = require('./meta-marketing-oauth-contract'), E = require('./meta-marketing-enrollment-contract');
const COHORT = 'meta-marketing-credential-renewal-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['begin', 'finish', 'status', 'activate', 'abort']
  .map(name => [name, `meta.marketing.credential.renewal.${name}.v1`])));
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const epoch = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const validators = {
  begin: schema({ renewalId: uuid, flowId: uuid, enrollmentId: uuid, expectedEpoch: epoch, expectedVersionId: uuid,
    expectedCandidateDigest: digest, assetSetDigest: digest, scopeDigest: digest, clinicSetDigest: digest,
    state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, expiresAt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }),
  finish: schema({ renewalId: uuid, flowId: uuid, state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    code: { type: 'string', pattern: '^[\\x21-\\x7e]{1,4096}$' } }),
  status: schema({ renewalId: uuid }), abort: schema({ renewalId: uuid }),
  activate: schema({ renewalId: uuid, enrollmentId: uuid, expectedEpoch: epoch, expectedVersionId: uuid,
    expectedCandidateDigest: digest, candidateVersionId: uuid, candidateDigest: digest }),
};
const STATES = Object.freeze(['awaiting', 'processing', 'staged', 'active', 'aborted', 'rejected', 'interrupted', 'not_found']);
const assetSetDigest = assets => C.hash(JSON.stringify(E.assets(assets).map(E.identity)));
const retentionStage = (enrollmentId, versionId) => {
  if (!C.uuid(enrollmentId) || !C.uuid(versionId)) fail('invalid_request');
  return 'CC_META_CREDENTIAL_' + C.hash(JSON.stringify([enrollmentId, versionId])).slice(0, 32);
};
function validate(operation, payload) {
  const name = Object.keys(OPERATIONS).find(key => OPERATIONS[key] === operation);
  if (!name) fail('operation_denied');
  validators[name](payload);
  if (['begin', 'finish'].includes(name) && payload.flowId !== payload.renewalId
    || name === 'activate' && payload.candidateVersionId !== payload.renewalId) fail('invalid_request');
  return name;
}
function authorize({ request, binding, principal }, environment) {
  const b = C.bindingFor(binding), roles = E.roles(environment);
  if (request.tenantRef !== 'clinic:' + b.clinicIds[0] || request.assetRef !== 'meta-enroll:' + b.scopeKey
    || ![roles.gateway, roles.control].includes(principal.id)
    || principal.id === roles.control && ![OPERATIONS.status, OPERATIONS.abort].includes(request.operation)) fail('scope_denied');
}
function effective(value, binding) {
  if (!C.exact(value, 'epoch,versionId,digest,metadata') || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || !C.uuid(value.versionId) || !/^[a-f0-9]{64}$/.test(value.digest)) fail('invalid_request');
  C.metadata(value.metadata, binding); return value;
}
function validateResponse(operation, value, payload, binding) {
  const name = validate(operation, payload);
  if (name === 'begin') {
    if (!C.exact(value, 'renewalId,flowId,enrollmentId,authUrl,expiresAt') || value.renewalId !== payload.renewalId
      || value.flowId !== payload.renewalId || value.enrollmentId !== payload.enrollmentId || value.expiresAt !== payload.expiresAt) fail('invalid_request');
    let url; try { url = new URL(value.authUrl); } catch { fail('invalid_request'); }
    if (url.origin !== 'https://www.facebook.com' || url.pathname !== '/v24.0/dialog/oauth'
      || url.searchParams.get('state') !== payload.state || url.searchParams.get('client_id') !== C.bindingFor(binding).appId) fail('invalid_request');
    return value;
  }
  if (!C.exact(value, 'renewalId,flowId,enrollmentId,status,grantDigest,assetSetDigest,effectiveCredential,candidate,activationApplied')
    || value.renewalId !== payload.renewalId || value.flowId !== payload.renewalId || !STATES.includes(value.status)
    || typeof value.activationApplied !== 'boolean') fail('invalid_request');
  if (value.status === 'not_found') {
    if (['enrollmentId', 'grantDigest', 'assetSetDigest', 'effectiveCredential', 'candidate'].some(key => value[key] !== null)
      || value.activationApplied) fail('invalid_request');
    return value;
  }
  if (!C.uuid(value.enrollmentId) || ![value.grantDigest, value.assetSetDigest].every(d => /^[a-f0-9]{64}$/.test(d))) fail('invalid_request');
  effective(value.effectiveCredential, binding);
  if (value.candidate !== null) {
    if (!['staged', 'active'].includes(value.status) || !C.exact(value.candidate, 'versionId,digest,metadata')
      || value.candidate.versionId !== value.renewalId || !/^[a-f0-9]{64}$/.test(value.candidate.digest)) fail('invalid_request');
    C.metadata(value.candidate.metadata, binding);
  } else if (['staged', 'active'].includes(value.status)) fail('invalid_request');
  if (value.activationApplied && (value.status !== 'active' || value.effectiveCredential.versionId !== value.renewalId
    || value.effectiveCredential.digest !== value.candidate.digest)) fail('invalid_request');
  return value;
}
module.exports = { COHORT, OPERATIONS, STATES, validators, validate, authorize, assetSetDigest, retentionStage, effective, validateResponse };
