'use strict';
// Private durable command metadata. No bearer, session JTI, OAuth code/state,
// provider credential, Secret ARN or provider operation is accepted here.
const { createHash } = require('node:crypto');
const C = require('./googleOAuthAdmissionAttempt.contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { firstAnalyticsSubjectDigest } = require('../../services/integrations-broker/src/google-property-discovery-contract');
const DOMAIN = 'clinicaclick/google-first-analytics-recovery/1';
const STATES = Object.freeze(['prepared','dispatch_pending','effect_unknown','remote_confirmed','sql_committed','published','quarantine_pending','quarantined','closed_unused']);
const TERMINAL = Object.freeze(['published','quarantined','closed_unused']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const SUBJECT = /^(?!unknown$)[A-Za-z0-9._-]{1,128}$/;
const LEASE_MS = 120000;
const FIELDS = Object.freeze(['attempt_id','crm_intent_id','dispatch_request_id','binding_digest','actor_user_id','session_ref_hash',
  'session_expires_at','scope_key','clinic_ids','clinic_digest','service','clinic_id','asset_ref','selection_digest',
  'attempt_requested_at','attempt_expires_at','google_user_id','subject_digest','claim_digest','scope_lock','subject_lock',
  'state','revision','generation','lease_token','lease_until','owner_observation','owner_observation_digest',
  'owner_receipt','owner_receipt_digest','native_resource','native_resource_digest','sql_publication_digest','last_error',
  'created_at','updated_at','completed_at']);
const DATES = Object.freeze(['session_expires_at','attempt_requested_at','attempt_expires_at','lease_until','created_at','updated_at','completed_at']);
const RECEIPT = Object.freeze(['attemptId','scopeKey','service','clinicId','assetRef','bindingDigest','clinicSetDigest','receiptId','googleUserId','connectionRef','secretVersion','mode','observedAt','validUntil','status']);
const REPLY = Object.freeze(['attemptId','scopeKey','service','crmIntentId','clinicId','assetRef','secretVersion','state','receiptId','receiptDigest','receipt']);
const SAFE_ERRORS = Object.freeze(['owner_unknown','authority_changed','sql_conflict','recovery_pending','owner_closed','configuration_unavailable']);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const typed = (value, pattern) => typeof value === 'string' && pattern.test(value);
const fail = () => { throw C.problem('google_oauth_admission_attempt_conflict',409); };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const scopeLock = scope => digest([DOMAIN,'scope','analytics',scope]);
const subjectLock = subject => digest([DOMAIN,'subject','analytics',subject]);
function json(text, limit = 16384) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) fail();
  let value; try { value = JSON.parse(text); } catch { fail(); }
  if (canonical(value) !== text) fail();
  return value;
}
function selection(context, input) {
  const c = C.input(context);
  if (!C.exact(input,['clinicId','assetRef']) || c.service !== 'analytics' || !positive(input.clinicId)
    || !c.clinicIds.includes(input.clinicId) || !typed(input.assetRef,/^ga4:[1-9]\d{0,19}$/)) fail();
  return Object.freeze({ ...input, digest:digest([DOMAIN,'selection',C.bindingDigest(c),c.scopeKey,c.clinicIds,input]) });
}
function receipt(value, row) {
  if (!C.exact(value,RECEIPT) || value.attemptId !== row.attempt_id || value.scopeKey !== row.scope_key
    || value.service !== 'analytics' || value.clinicId !== row.clinic_id || value.assetRef !== row.asset_ref
    || value.bindingDigest !== row.binding_digest || value.clinicSetDigest !== row.clinic_digest
    || value.googleUserId !== row.google_user_id || value.connectionRef !== 'google-first:analytics:'+row.scope_key
    || value.secretVersion !== row.attempt_id || value.mode !== 'provisioned' || value.status !== 'confirmed_resource_access'
    || !typed(value.receiptId,UUID) || !Number.isSafeInteger(value.observedAt) || value.observedAt < +row.attempt_requested_at
    || !Number.isSafeInteger(value.validUntil) || value.validUntil <= value.observedAt || value.validUntil > value.observedAt+60000 || value.validUntil > +row.attempt_expires_at) fail();
  // This is immutable effect history, not a fresh permission/expiry claim.
  return Object.freeze({ ...value });
}
function observation(value, row) {
  if (!C.exact(value,REPLY) || value.attemptId !== row.attempt_id || value.scopeKey !== row.scope_key
    || value.service !== 'analytics' || value.crmIntentId !== row.crm_intent_id || value.clinicId !== row.clinic_id
    || value.assetRef !== row.asset_ref || value.secretVersion !== row.attempt_id
    || !['unknown','confirmed_current','quarantined','published'].includes(value.state)) fail();
  const hasId = value.receiptId !== null || value.receiptDigest !== null;
  if (hasId && (!typed(value.receiptId,UUID) || !typed(value.receiptDigest,SHA)) || value.state === 'published' && !hasId) fail();
  if (value.receipt !== null) {
    const r = receipt(value.receipt,row);
    if (!['confirmed_current','published'].includes(value.state) || r.receiptId !== value.receiptId || digest(r) !== value.receiptDigest) fail();
  }
  if (value.state === 'unknown' && (hasId || value.receipt !== null) || value.state === 'quarantined' && value.receipt !== null) fail();
  if (row.owner_receipt_digest && hasId && row.owner_receipt_digest !== value.receiptDigest) fail();
  return Object.freeze({ ...value, ...(value.receipt ? { receipt:receipt(value.receipt,row) } : {}) });
}
function unusedAbort(value,row) {
  if (!C.exact(value,['attemptId','bindingDigest','service','expiresAt','state','authorizationConfirmed','connected'])
    || value.attemptId!==row.attempt_id || value.bindingDigest!==row.binding_digest || value.service!=='analytics'
    || value.expiresAt!==+row.attempt_expires_at || !['aborted','expired','interrupted'].includes(value.state)
    || value.authorizationConfirmed!==false || value.connected!==false) fail();
  return Object.freeze({...value});
}
function record(input) {
  if (!C.exact(input,FIELDS)) fail();
  const row = { ...input };
  if (!typed(row.attempt_id,UUID) || !typed(row.crm_intent_id,UUID) || !typed(row.dispatch_request_id,UUID)
    || !typed(row.binding_digest,SHA) || !positive(row.actor_user_id) || !typed(row.session_ref_hash,SHA)
    || !typed(row.clinic_digest,SHA) || row.service !== 'analytics' || !positive(row.clinic_id)
    || !typed(row.selection_digest,SHA) || !STATES.includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 0
    || !Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation > 2147483647
    || !typed(row.asset_ref,/^ga4:[1-9]\d{0,19}$/) || !/^(clinic|group):[1-9]\d{0,9}$/.test(row.scope_key)) fail();
  const ids = json(row.clinic_ids,16384);
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((id,i) => !positive(id) || i && id <= ids[i-1])
    || !ids.includes(row.clinic_id) || row.clinic_digest !== digest(ids)
    || row.scope_key.startsWith('clinic:') && (ids.length !== 1 || row.scope_key !== 'clinic:'+ids[0])) fail();
  for (const key of DATES) if (row[key] !== null && (!(row[key] instanceof Date) || !Number.isSafeInteger(+row[key]))) fail();
  if (['session_expires_at','attempt_requested_at','attempt_expires_at','created_at','updated_at'].some(key => row[key] === null)
    || +row.attempt_expires_at !== Math.min(+row.attempt_requested_at+C.TTL_MS,+row.session_expires_at)
    || +row.created_at < +row.attempt_requested_at || +row.updated_at < +row.created_at) fail();
  if (row.selection_digest !== digest([DOMAIN,'selection',row.binding_digest,row.scope_key,ids,{clinicId:row.clinic_id,assetRef:row.asset_ref}])) fail();
  const hasIdentity = row.subject_digest !== null || row.google_user_id !== null || row.claim_digest !== null;
  if (hasIdentity && (!typed(row.google_user_id,SUBJECT) || row.subject_digest !== firstAnalyticsSubjectDigest(row.google_user_id)
    || !typed(row.claim_digest,SHA))) fail();
  if (!['prepared','quarantine_pending','closed_unused'].includes(row.state) && !hasIdentity) fail();
  if (!hasIdentity && (row.owner_receipt!==null || row.native_resource!==null || row.sql_publication_digest!==null)) fail();
  if (row.state==='prepared' && (hasIdentity || row.owner_observation!==null || row.owner_receipt!==null || row.native_resource!==null || row.sql_publication_digest!==null)) fail();
  if (!['sql_committed','published'].includes(row.state) && row.sql_publication_digest!==null) fail();
  const terminal = TERMINAL.includes(row.state);
  if (terminal !== (row.completed_at !== null) || terminal && (row.lease_token !== null || row.lease_until !== null)
    || !terminal && (!typed(row.lease_token,UUID) || row.lease_until === null)) fail();
  const closedScope = ['published','closed_unused'].includes(row.state);
  if (closedScope ? row.scope_lock !== null : row.scope_lock !== scopeLock(row.scope_key)) fail();
  if (row.subject_lock !== (hasIdentity && !terminal ? subjectLock(row.subject_digest) : null)) fail();
  for (const [body,hash] of [['owner_receipt','owner_receipt_digest'],['owner_observation','owner_observation_digest'],['native_resource','native_resource_digest']]) {
    if ((row[body] === null) !== (row[hash] === null) || row[body] !== null && digest(json(row[body])) !== row[hash]) fail();
  }
  if (row.owner_receipt !== null) receipt(json(row.owner_receipt),row);
  if (row.owner_observation !== null) {if(hasIdentity)observation(json(row.owner_observation),row);else unusedAbort(json(row.owner_observation),row);}
  if (row.native_resource !== null) {
    const value = json(row.native_resource);
    if (!C.exact(value,['name','displayName','propertyType','parent','account']) || value.name !== 'properties/'+row.asset_ref.slice(4)) fail();
    require('../../services/integrations-broker/src/google-property-discovery-contract').projectFirstGA(value,value.name);
  }
  if (row.sql_publication_digest !== null && !typed(row.sql_publication_digest,SHA)
    || ['sql_committed','published'].includes(row.state) && (!row.owner_receipt || !row.native_resource || !row.sql_publication_digest)
    || row.last_error !== null && !SAFE_ERRORS.includes(row.last_error)) fail();
  return row;
}
function bound(row, context) {
  const r = record(row), c = C.input(context);
  if (r.attempt_id !== c.attemptId || r.binding_digest !== C.bindingDigest(c) || r.actor_user_id !== c.actorId
    || r.session_ref_hash !== C.sessionHash(c.sessionRef) || +r.session_expires_at !== c.sessionExpiresAt
    || r.scope_key !== c.scopeKey || r.clinic_ids !== canonical(c.clinicIds) || r.service !== c.service) fail();
  return r;
}
function fence(row) {
  const r = record(row);
  return Object.freeze({ attemptId:r.attempt_id,crmIntentId:r.crm_intent_id,generation:r.generation,revision:r.revision,leaseToken:r.lease_token });
}
function assertFence(row, expected, at, { liveLease = true } = {}) {
  const r = record(row);
  if (!C.exact(expected,['attemptId','crmIntentId','generation','revision','leaseToken']) || expected.attemptId !== r.attempt_id
    || expected.crmIntentId !== r.crm_intent_id || expected.generation !== r.generation || expected.revision !== r.revision
    || expected.leaseToken !== r.lease_token || r.lease_token === null || liveLease && +r.lease_until <= C.clock(at)) fail();
  return r;
}
function publicationDigest(value) {
  const p = value?.get ? value.get({ plain:true }) : value;
  if (!p || !typed(p.attempt_id,UUID) || !typed(p.receipt_id,UUID) || !typed(p.receipt_digest,SHA)
    || !positive(Number(p.google_connection_id)) || p.service !== 'analytics' || !positive(Number(p.clinic_id))
    || !typed(p.asset_ref,/^ga4:[1-9]\d{0,19}$/) || !(p.published_at instanceof Date)) fail();
  return digest(['clinicaclick/google-first-analytics-sql-publication/1',p.attempt_id,p.receipt_id,p.receipt_digest,
    Number(p.google_connection_id),p.scope_key,p.service,Number(p.clinic_id),p.asset_ref,p.published_at.toISOString()]);
}
const dto = value => { const row = record(value);return Object.freeze({ attemptId:row.attempt_id,crmIntentId:row.crm_intent_id,
  state:row.state,revision:row.revision,authorizationConfirmed:row.state === 'published',connected:row.state === 'published' }); };
module.exports = { DOMAIN,STATES,TERMINAL,UUID,SHA,FIELDS,DATES,LEASE_MS,SAFE_ERRORS,positive,digest,scopeLock,subjectLock,
  json,selection,receipt,observation,unusedAbort,record,bound,fence,assertFence,publicationDigest,dto,fail };
