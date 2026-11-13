'use strict';
const { createHash, createPublicKey } = require('node:crypto');
const { schema, ref } = require('./contracts');
const { canonical } = require('./canonical');
const reads = require('./google-business-profile-contract');
const writes = require('./google-business-profile-write-contract');
const oauth = require('./google-oauth-contract');
const { fail } = require('./errors');

const PREFIX = reads.PREFIX + 'enrollment.';
const OPERATIONS = Object.freeze(Object.fromEntries(['discover', 'prepare', 'activate', 'status', 'retire', 'abort']
  .map(name => [name, PREFIX + name + '.v1'])));
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const externalId = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const assetRef = { type: 'string', pattern: '^gbp:[1-9][0-9]{0,29}:[1-9][0-9]{0,29}$' };
const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const reassociationFields = {
  descriptorId: UUID,
  sourceTenantRef: { type: 'string', pattern: '^clinic:[1-9][0-9]{0,9}$' },
  sourceConnectionRef: ref,
  sourceScopeRef: { type: 'string', pattern: '^gbp-enroll:clinic:[1-9][0-9]{0,9}$' },
  sourceAssetRef: assetRef,
  retirementEnrollmentId: UUID,
  retirementDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
};
const reassociationSchema = object(reassociationFields);
const validateReassociation = schema(reassociationFields);
const scopeSchema = object({
  assetRef: { type: 'string', pattern: '^gbp-enroll:(clinic|group):[1-9][0-9]{0,9}$' },
  tenantRef: { type: 'string', pattern: '^clinic:[1-9][0-9]{0,9}$' },
  accountIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: externalId },
  locationIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: externalId },
  bootstrapPreviousAssetRef: { ...assetRef, type: ['string', 'null'] },
  readPrincipalId: ref, controlPrincipalId: ref,
  readOperations: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: reads.OPERATIONS } },
  maxAssets: { type: 'integer', minimum: 1, maximum: 1000 },
});
// Optional server policy only. Do not add it to legacy required fields or the
// ordinary scope digest: existing intents and grants keep their exact identity.
scopeSchema.properties.reassociationSources = { type: 'array', minItems: 1, maxItems: 20,
  items: reassociationSchema };
const identity = { enrollmentId: UUID, accountId: externalId, locationId: externalId,
  previousAssetRef: { ...assetRef, type: ['string', 'null'] },
  clinicCount: { type: 'integer', minimum: 1, maximum: 1000 },
  clinicSetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const validators = {
  discover: schema({ pageToken: { type: ['string', 'null'], maxLength: 4096 } }),
  status: schema({ enrollmentId: UUID }),
  ...Object.fromEntries(['prepare', 'activate', 'retire', 'abort'].map(name => {
    const legacy = schema(identity);
    return [name, value => {
      if (value && Object.hasOwn(value, 'reassociation')) {
        validateReassociation(value.reassociation);
        const ordinary = { ...value }; delete ordinary.reassociation; legacy(ordinary);
        return value;
      }
      return legacy(value);
    }];
  })),
};
const isOperation = value => Object.values(OPERATIONS).includes(value);
const resourceOperations = [...reads.OPERATIONS, ...Object.values(writes.OPERATIONS)];
function scopeFor(binding, asset, tenant) {
  const scope = binding?.googleBusinessProfileEnrollmentScopes?.find(s => s.assetRef === asset && s.tenantRef === tenant);
  if (!scope || binding.provider !== reads.PROVIDER || !binding.oauth
    || scope.assetRef.startsWith('gbp-enroll:clinic:') && scope.assetRef !== 'gbp-enroll:' + scope.tenantRef) fail('scope_denied');
  oauth.bindingFor(binding);
  return scope;
}
function digestFor(binding, scope) {
  // Candidate allowlists may grow without transferring existing ownership. Each
  // operation checks current membership separately, including after I/O. The
  // identity and the cryptographic roles/rights remain immutable for an intent.
  return createHash('sha256').update(canonical({ connection: binding.connectionRef, subject: binding.oauth.subject,
    secret: binding.secretArn, application: binding.clientSecretArn, scope: scope.assetRef, tenant: scope.tenantRef,
    reader: scope.readPrincipalId, control: scope.controlPrincipalId,
    operations: [...scope.readOperations].sort(), maxAssets: scope.maxAssets })).digest('hex');
}
function ownerFor(policy, binding, scope) {
  const owners = new Set(policy.grants.filter(g => g.connectionRef === binding.connectionRef
    && g.tenantRef === scope.tenantRef && g.assetRef === scope.assetRef
    && g.operations.some(op => [OPERATIONS.discover, OPERATIONS.prepare, OPERATIONS.activate, OPERATIONS.status].includes(op)))
    .map(g => g.principalId));
  if (owners.size !== 1) fail('invalid_request');
  return [...owners][0];
}
function validatePolicy(policy) {
  const reassociationDescriptors = new Set();
  const roles = { read: new Set(), write: new Set(), control: new Set(), oauth: new Set(), enrollment: new Set() };
  for (const grant of policy.grants) {
    if (grant.operations.some(op => reads.OPERATIONS.includes(op))) roles.read.add(grant.principalId);
    if (grant.operations.some(op => Object.values(writes.OPERATIONS).includes(op))) roles.write.add(grant.principalId);
    if (grant.operations.some(op => [reads.REVOKE_OPERATION, OPERATIONS.retire, OPERATIONS.abort].includes(op))) roles.control.add(grant.principalId);
    if (grant.operations.some(op => Object.values(oauth.OPERATIONS).includes(op))) roles.oauth.add(grant.principalId);
    if (grant.operations.some(op => [OPERATIONS.discover, OPERATIONS.prepare, OPERATIONS.activate, OPERATIONS.status].includes(op))) roles.enrollment.add(grant.principalId);
  }
  for (const binding of policy.connections) {
    const seen = new Set();
    for (const scope of binding.googleBusinessProfileEnrollmentScopes || []) {
      scopeFor(binding, scope.assetRef, scope.tenantRef);
      if (seen.has(scope.assetRef) || !scope.readOperations.includes(reads.PREFIX + 'discovery.read.v1')) fail('invalid_request');
      seen.add(scope.assetRef); roles.read.add(scope.readPrincipalId); roles.control.add(scope.controlPrincipalId);
      const owner = ownerFor(policy, binding, scope);
      for (const proof of scope.reassociationSources || []) {
        validateReassociation(proof);
        const physical = reads.asset(proof.sourceAssetRef);
        if (reassociationDescriptors.has(proof.descriptorId)
          || proof.sourceTenantRef === scope.tenantRef
          || proof.sourceConnectionRef !== binding.connectionRef
          || proof.sourceScopeRef !== 'gbp-enroll:' + proof.sourceTenantRef
          || !scope.assetRef.startsWith('gbp-enroll:clinic:')
          || !scope.accountIds.includes(physical.accountId) || !scope.locationIds.includes(physical.locationId)) fail('invalid_request');
        reassociationDescriptors.add(proof.descriptorId);
      }
      for (const grant of policy.grants.filter(g => g.connectionRef === binding.connectionRef && g.assetRef === scope.assetRef)) {
        if (grant.tenantRef !== scope.tenantRef || grant.operations.some(op => !isOperation(op))
          || grant.operations.some(op => [OPERATIONS.retire, OPERATIONS.abort].includes(op)) && grant.principalId !== scope.controlPrincipalId
          || grant.operations.some(op => ![OPERATIONS.retire, OPERATIONS.abort].includes(op)) && grant.principalId !== owner) fail('invalid_request');
      }
      if (scope.bootstrapPreviousAssetRef !== null) {
        reads.asset(scope.bootstrapPreviousAssetRef);
        if (!policy.grants.some(g => g.connectionRef === binding.connectionRef && g.assetRef === scope.bootstrapPreviousAssetRef
          && g.tenantRef === scope.tenantRef && g.principalId === scope.readPrincipalId
          && g.operations.includes(reads.PREFIX + 'discovery.read.v1'))) fail('invalid_request');
      }
    }
  }
  const key = id => {
    try { return createPublicKey(policy.principals.find(p => p.id === id).publicKey).export({ format: 'der', type: 'spki' }).toString('base64'); }
    catch { fail('invalid_request'); }
  };
  const keys = Object.values(roles).map(ids => new Set([...ids].map(key)));
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if ([...keys[i]].some(value => keys[j].has(value))) fail('invalid_request');
  }
}
function retirementDigest(row) {
  return createHash('sha256').update(canonical({ tenant: row.tenant, connection: row.connection,
    asset: row.asset, location: row.location, enrollment_id: row.enrollment_id, retired_at: row.retired_at })).digest('hex');
}
function reassociationDigest(proof, request) {
  validateReassociation(proof);
  const p = request.payload;
  return createHash('sha256').update(canonical({ descriptor: proof,
    target: { tenant: request.tenantRef, connection: request.connectionRef, scope: request.assetRef,
      enrollmentId: p.enrollmentId, accountId: p.accountId, locationId: p.locationId,
      previousAssetRef: p.previousAssetRef, clinicCount: p.clinicCount, clinicSetDigest: p.clinicSetDigest } })).digest('hex');
}
const SUMMARY_READ_MASK = 'name,title,storeCode,storefrontAddress,metadata';
const PUBLIC_GOOGLE_HOSTS = new Set(['google.com', 'www.google.com', 'maps.google.com', 'search.google.com',
  'google.es', 'www.google.es', 'maps.google.es', 'search.google.es']);
function projectMetadata(raw) {
  const result = {};
  if (typeof raw?.hasVoiceOfMerchant === 'boolean') result.hasVoiceOfMerchant = raw.hasVoiceOfMerchant;
  if (raw?.placeId !== undefined) {
    // Google does not define a maximum Place ID length. The existing typed
    // transport imposes its own 8192-byte string bound; never truncate an ID.
    if (typeof raw.placeId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.placeId)
      || Buffer.byteLength(raw.placeId) > 8192) fail('provider_failed');
    result.placeId = raw.placeId;
  }
  for (const field of ['mapsUri', 'newReviewUri']) if (raw?.[field] !== undefined) {
    const value = raw[field]; let url;
    try { url = new URL(value); } catch { fail('provider_failed'); }
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || url.href !== value
      || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !PUBLIC_GOOGLE_HOSTS.has(url.hostname) || /^\/(?:url|redirect)(?:\/|$)/i.test(url.pathname)) fail('provider_failed');
    result[field] = value;
  }
  return result;
}
function projectLocation(raw) {
  const match = typeof raw?.name === 'string' && /^locations\/([1-9]\d{0,29})$/.exec(raw.name);
  if (!match) fail('provider_failed');
  const result = reads.project(reads.PREFIX + 'details.read.v1', raw, { location: raw.name });
  if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 1024
    || /[\x00-\x1f]/.test(result.title)) fail('provider_failed');
  const metadata = projectMetadata(result.metadata);
  return { locationId: match[1], name: result.name, title: result.title,
    ...(result.storeCode !== undefined ? { storeCode: result.storeCode } : {}),
    ...(result.storefrontAddress !== undefined ? { storefrontAddress: result.storefrontAddress } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}) };
}
module.exports = { PREFIX, OPERATIONS, scopeSchema, validators, scopeFor, digestFor, ownerFor,
  validatePolicy, isOperation, resourceOperations, SUMMARY_READ_MASK, projectMetadata, projectLocation,
  reassociationSchema, validateReassociation, retirementDigest, reassociationDigest };
