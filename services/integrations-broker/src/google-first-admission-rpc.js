'use strict';

const { createHash } = require('node:crypto');
const { canonical } = require('./canonical');
const { fail,BrokerError } = require('./errors');
const { validatePolicy } = require('./policy');
const { SERVICES } = require('./google-first-identity-provider');
const SC = require('./google-search-console-contract');
const GA = require('./google-analytics-contract');
const { projectSC,projectFirstGA,firstAnalyticsSubjectDigest } = require('./google-property-discovery-contract');

const ACTIONS = Object.freeze(['begin', 'status', 'finish', 'abort']);
const OPERATIONS = Object.freeze({ ...Object.fromEntries(ACTIONS.map(action => [action, 'google.oauth.admission.' + action + '.v1'])),
  publication:'google.oauth.admission.publication.verify.v1',
  catalogueReady:'google.oauth.admission.catalogue.ready.v1',
  catalogue:'google.oauth.admission.catalogue.v1',
  identityPreview:'google.oauth.admission.identity.preview.v1' });
const ACTION_FOR = new Map(Object.entries(OPERATIONS).map(([action, operation]) => [operation, action]));
const STATES = new Set(['prepared', 'exchanging', 'candidate_ready', 'stage_intent', 'candidate_staged', 'interrupted', 'aborted', 'expired']);
const PROVIDER = 'google_first_oauth';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE = /^(clinic|group):[1-9][0-9]{0,9}$/;
const PROOF = ['attemptId', 'bindingDigest', 'service', 'expiresAt'];
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const RECEIPT = ['attemptId','scopeKey','service','clinicId','assetRef','bindingDigest','clinicSetDigest',
  'receiptId','googleUserId','connectionRef','secretVersion','mode','observedAt','validUntil','status'];
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const typed = (value, shape) => typeof value === 'string' && shape.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

function clinicSetFingerprint(ids) { return hash(JSON.stringify(ids)); }

// A separate, control-only Owner policy, with no reader, resource credentials,
// regular connections or static grants. Each signed operation resolves to one
// already approved scope, roster and service. Other broker cohorts stay intact.
function createFirstGoogleAdmissionRpc({ policy, principalId, scopes, flow, publication, now = Date.now }) {
  const base = structuredClone(validatePolicy(policy));
  if (base.connections.length || base.grants.length || base.principals.length !== 1 || base.principals[0].id !== principalId
    || base.principals[0].enabled !== true || !Array.isArray(scopes) || scopes.length > 10000
    || ACTIONS.some(action => typeof flow?.[action] !== 'function') || typeof now !== 'function') fail('invalid_request');
  const approved = new Map();
  const resources = new Map();
  const catalogues = new Map();
  const hasCatalogue = typeof publication?.observe === 'function';
  const hasIdentityPreview = typeof publication?.identityPreview === 'function';

  for (const row of scopes) {
    if (!exact(row, ['scopeKey', 'clinicIds', 'services']) || !typed(row.scopeKey, SCOPE) || approved.has(row.scopeKey)
      || !Array.isArray(row.clinicIds) || row.clinicIds.length < 1 || row.clinicIds.length > 1000
      || row.clinicIds.some((id, index, ids) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647 || index > 0 && id <= ids[index - 1])
      || row.scopeKey.startsWith('clinic:') && (row.clinicIds.length !== 1 || row.scopeKey !== 'clinic:' + row.clinicIds[0])
      || !Array.isArray(row.services) || !row.services.length || new Set(row.services).size !== row.services.length
      || row.services.some(service => !SERVICES.includes(service))) fail('invalid_request');
    const clinicalRoster = Object.freeze([...row.clinicIds]);
    approved.set(row.scopeKey, Object.freeze({ tenantRef: 'clinic:' + clinicalRoster[0],
      clinicSetDigest: clinicSetFingerprint(clinicalRoster),clinicIds:clinicalRoster,
      services: Object.freeze([...row.services]) }));
  }
  function resourceKey(scopeKey,service,clinicId,assetRef) {
    return JSON.stringify([scopeKey,service,clinicId,assetRef]);
  }
  if (publication !== undefined) {
    if (!exact(publication,['resources','publish',...(hasCatalogue ? ['observe'] : []),...(hasIdentityPreview ? ['identityPreview'] : [])])
      || typeof publication.publish !== 'function'
      || !Array.isArray(publication.resources) || !publication.resources.length || publication.resources.length > 256) fail('invalid_request');
    for (const row of publication.resources) {
      if (!exact(row,['scopeKey','service','clinicId','resource'])) fail('invalid_request');
      const allowed = approved.get(row.scopeKey);
      if (!allowed?.clinicIds.includes(row.clinicId) || !allowed.services.includes(row.service)) fail('invalid_request');
      let asset, resource;
      if (row.service === 'search_console' && exact(row.resource,['siteUrl'])) {
        asset = SC.site(row.resource.siteUrl);
        resource = { siteUrl:asset.siteUrl };
      } else if (row.service === 'analytics' && exact(row.resource,['propertyName'])) {
        asset = GA.property(row.resource.propertyName);
        resource = { propertyName:asset.propertyName };
      } else fail('invalid_request');
      const key = resourceKey(row.scopeKey,row.service,row.clinicId,asset.assetRef);
      if (resources.has(key)) fail('invalid_request');
      resources.set(key,Object.freeze(resource));
      if (hasCatalogue) {
        const key = row.scopeKey + '/' + row.service;
        let catalog = catalogues.get(key);
        if (!catalog) catalogues.set(key,catalog = new Map());
        const known = catalog.get(asset.assetRef);
        if (known) known.clinicIds.push(row.clinicId);
        else catalog.set(asset.assetRef,{ assetRef:asset.assetRef,resource:Object.freeze(resource),clinicIds:[row.clinicId] });
      }
    }
  }
  const policyDigest = hash(canonical(base));

  function payload(value, action) {
    const analyticsPublication = action === 'publication' && value?.service === 'analytics';
    const extras = action === 'finish' ? ['state', 'code'] : action === 'publication'
      ? ['clinicId','selectedAssetRef',...(analyticsPublication ? ['expectedSubjectDigest'] : [])] : [];
    if (!exact(value, [...PROOF, 'clinicSetDigest', ...extras]) || !typed(value.attemptId, UUID) || !typed(value.bindingDigest, HASH)
      || !SERVICES.includes(value.service) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || !typed(value.clinicSetDigest, HASH)
      || action === 'finish' && (!typed(value.state, STATE) || !typed(value.code, TOKEN))
      || ['catalogue','catalogueReady'].includes(action) && !['search_console','analytics'].includes(value.service)
      || analyticsPublication && !typed(value.expectedSubjectDigest,HASH)
      || action === 'identityPreview' && value.service !== 'analytics'
      || action === 'publication' && (!Number.isSafeInteger(value.clinicId) || value.clinicId < 1 || value.clinicId > 2147483647
        || !typed(value.selectedAssetRef,value.service === 'search_console' ? /^sc:[a-f0-9]{64}$/ : /^ga4:[1-9]\d{0,19}$/)
        || !['analytics','search_console'].includes(value.service))) fail('invalid_request');
    return Object.freeze(Object.fromEntries(PROOF.map(key => [key, value[key]])));
  }

  function validateRequest(request, principal, livePolicy) {
    const action = ACTION_FOR.get(request.operation);
    if (!action || action === 'publication' && !publication || ['catalogue','catalogueReady'].includes(action) && !hasCatalogue
      || action === 'identityPreview' && !hasIdentityPreview || principal.id !== principalId || hash(canonical(livePolicy)) !== policyDigest) fail('scope_denied');
    const proof = payload(request.payload, action);
    if (request.connectionRef !== 'google-first:' + proof.attemptId || action === 'begin' && request.requestId !== proof.attemptId) fail('scope_denied');
    const prefix = 'google-oauth:' + proof.service + ':';
    const scopeKey = request.assetRef.startsWith(prefix) ? request.assetRef.slice(prefix.length) : '';
    const allowed = approved.get(scopeKey);
    if (!allowed || request.tenantRef !== allowed.tenantRef || request.payload.clinicSetDigest !== allowed.clinicSetDigest
      || !allowed.services.includes(proof.service)) fail('scope_denied');
    const owner = Object.freeze({ principalId: principal.id, tenantRef: request.tenantRef,
      connectionRef: request.connectionRef, assetRef: request.assetRef });
    if (['catalogue','catalogueReady'].includes(action)) {
      const catalogue = catalogues.get(scopeKey + '/' + proof.service);
      if (action === 'catalogue' && !catalogue || proof.expiresAt <= now()) fail('scope_denied');
      return { action,proof,owner,scopeKey,catalogue };
    }
    if (action === 'identityPreview') {
      if (!catalogues.has(scopeKey + '/analytics') || proof.expiresAt <= now()) fail('scope_denied');
      return { action,proof,owner,scopeKey };
    }
    if (action !== 'publication') return { action,proof,owner };
    const selection = Object.freeze({ scopeKey,clinicId:request.payload.clinicId,assetRef:request.payload.selectedAssetRef });
    const resource = resources.get(resourceKey(scopeKey,proof.service,selection.clinicId,selection.assetRef));
    if (!resource || proof.expiresAt <= now()) fail('scope_denied');
    return { action,proof,owner,selection,resource };
  }

  function resolve(request, principal, livePolicy) {
    validateRequest(request, principal, livePolicy);
    return { ...livePolicy,
      connections: [{ connectionRef: request.connectionRef, provider: PROVIDER, initialState: 'blocked' }],
      grants: [{ principalId, tenantRef: request.tenantRef, connectionRef: request.connectionRef,
        assetRef: request.assetRef, operations: [request.operation] }] };
  }

  function project(value, proof, action) {
    const url = action === 'begin' && Object.hasOwn(value || {}, 'authorizationUrl');
    const keys = [...PROOF, 'state', 'connected', 'authorizationConfirmed', ...(url ? ['authorizationUrl'] : [])];
    if (!exact(value, keys) || PROOF.some(key => value[key] !== proof[key]) || !STATES.has(value.state)
      || value.connected !== false || value.authorizationConfirmed !== false || action === 'begin' && value.state === 'prepared' && !url
      || url && (value.state !== 'prepared' || typeof value.authorizationUrl !== 'string'
        || !value.authorizationUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?') || value.authorizationUrl.length > 8192)) fail('internal_error');
    return Object.freeze({ ...value });
  }

  function projectPublication(value,proof,selection,resource,clinicSetDigest) {
    const sc = proof.service === 'search_console', at = now();
    if (!exact(value,sc ? [...RECEIPT,'resource'] : RECEIPT)
      || value.attemptId !== proof.attemptId || value.bindingDigest !== proof.bindingDigest || value.service !== proof.service
      || value.scopeKey !== selection.scopeKey || value.clinicId !== selection.clinicId || value.assetRef !== selection.assetRef
      || value.clinicSetDigest !== clinicSetDigest || value.mode !== 'provisioned' || value.status !== 'confirmed_resource_access'
      || value.connectionRef !== 'google-first:' + proof.service + ':' + selection.scopeKey
      || value.secretVersion !== proof.attemptId || !typed(value.receiptId,UUID)
      || !typed(value.googleUserId,/^(?!unknown$)[A-Za-z0-9._-]{1,128}$/)
      || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0 || value.observedAt > at
      || !Number.isSafeInteger(value.validUntil) || value.validUntil <= at || value.validUntil <= value.observedAt
      || value.validUntil > proof.expiresAt) fail('internal_error');
    if (!sc) return Object.freeze({ ...value });
    if (!exact(value.resource,['siteUrl','permissionLevel'])) fail('internal_error');
    const projected = projectSC(value.resource,resource.siteUrl);
    return Object.freeze({ ...value,resource:Object.freeze(projected) });
  }

  async function readCatalogue(proof,owner,scopeKey,catalogue,signal) {
    const timeout = AbortSignal.timeout(24000);
    const deadline = signal ? AbortSignal.any([timeout,signal]) : timeout;
    const assets = [];
    for (const entry of catalogue.values()) {
      if (deadline.aborted || proof.expiresAt <= now()) fail('provider_timeout');
      const clinicIds = [...entry.clinicIds].sort((a,b) => a-b);
      // A group's candidate is the same version for every destination. The
      // provider property is checked once, while each destination comes from
      // the exact Owner policy. Final confirmation checks that tuple again.
      const selection = { scopeKey,clinicId:clinicIds[0],assetRef:entry.assetRef };
      let observed;
      try {
        observed = await publication.observe(proof,owner,selection,entry.resource,{ signal:deadline });
      } catch (error) {
        if (error instanceof BrokerError && error.code === 'provider_unauthorized') continue;
        throw error;
      }
      if (deadline.aborted || proof.expiresAt <= now()) fail('provider_timeout');
      if (!exact(observed,['resource','selectionDigest','credentialDigest','observedAt','validUntil','authorizationConfirmed','connected'])
        || observed.authorizationConfirmed !== false || observed.connected !== false
        || !typed(observed.selectionDigest,HASH) || !typed(observed.credentialDigest,HASH)
        || !Number.isSafeInteger(observed.observedAt) || observed.observedAt > now()
        || !Number.isSafeInteger(observed.validUntil) || observed.validUntil <= now() || observed.validUntil > proof.expiresAt) fail('internal_error');
      let asset;
      if (proof.service === 'search_console') {
        if (!exact(observed.resource,['siteUrl','permissionLevel'])) fail('internal_error');
        const site = projectSC(observed.resource,entry.resource.siteUrl);
        asset = { siteUrl:site.siteUrl };
      } else {
        if (!exact(observed.resource,['name','displayName','propertyType','account','parent'])) fail('internal_error');
        const property = projectFirstGA(observed.resource,entry.resource.propertyName);
        asset = { propertyName:property.name,displayName:property.displayName };
      }
      assets.push(Object.freeze({ assetRef:entry.assetRef,...asset,clinicIds:Object.freeze(clinicIds) }));
    }
    // Do not serve a partial list after a temporary provider/read failure.
    if (deadline.aborted || proof.expiresAt <= now()) fail('provider_timeout');
    return Object.freeze({ attemptId:proof.attemptId,scopeKey,service:proof.service,assets:Object.freeze(assets) });
  }

  const actions = publication ? [...ACTIONS,'publication',...(hasCatalogue ? ['catalogueReady','catalogue'] : []),
    ...(hasIdentityPreview ? ['identityPreview'] : [])] : ACTIONS;
  const operations = Object.fromEntries(actions.map(action => [OPERATIONS[action], {
    provider: PROVIDER, control: 'google_oauth', validate: value => payload(value, action),
    async execute({ request, principal, policy: livePolicy, signal }) {
      const { proof,owner,selection,resource,scopeKey,catalogue } = validateRequest(request, principal, livePolicy);
      if (action === 'catalogueReady') {
        const status = project(await flow.status(proof,owner),proof,'status');
        const data = { attemptId:proof.attemptId,scopeKey,service:proof.service,
          canChooseAssets:catalogue?.size > 0 && status.state === 'candidate_staged' };
        return { requestId:request.requestId,data,replayed:false };
      }
      if (action === 'catalogue') {
        const data = await readCatalogue(proof,owner,scopeKey,catalogue,signal);
        return { requestId:request.requestId,data,replayed:false };
      }
      if (action === 'identityPreview') {
        const googleUserId = await publication.identityPreview(proof,owner);
        if (proof.expiresAt <= now()) fail('scope_denied');
        return { requestId:request.requestId,replayed:false,data:Object.freeze({ attemptId:proof.attemptId,scopeKey,
          service:proof.service,googleUserId,subjectDigest:firstAnalyticsSubjectDigest(googleUserId) }) };
      }
      if (action === 'publication') {
        const value = await publication.publish(proof,owner,selection,resource,{ signal,
          ...(proof.service === 'analytics' ? { expectedSubjectDigest:request.payload.expectedSubjectDigest } : {}) });
        return { requestId:request.requestId,data:projectPublication(value,proof,selection,resource,request.payload.clinicSetDigest),replayed:false };
      }
      const code = action === 'finish' ? Buffer.from(request.payload.code, 'ascii') : undefined;
      try {
        const value = await flow[action](proof, owner, code ? { state: request.payload.state, code } : undefined);
        return { requestId: request.requestId, data: project(value, proof, action), replayed: false };
      } finally { code?.fill(0); }
    },
  }]));
  return Object.freeze({ operations: Object.freeze(operations), policyResolver: Object.freeze({ resolve }) });
}

module.exports = { createFirstGoogleAdmissionRpc, OPERATIONS, clinicSetFingerprint };
