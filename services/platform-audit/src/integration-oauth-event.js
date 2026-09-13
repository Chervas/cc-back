'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const { positive } = require('./integration-disconnect-event');
const ACTIONS = ['integration.oauth.authorize', 'integration.oauth.activate'];
const KEYS = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason',
  'actor', 'subjectUserId', 'sessionRef', 'scope', 'provider', 'connectionRef', 'assetRef', 'capturePolicy', 'authorizationPolicyVersion'];
const REASONS = {
  'integration.oauth.authorize': { attempted: ['authorization_requested'], completed: ['credentials_staged', 'authorization_cancelled'] },
  'integration.oauth.activate': { attempted: ['activation_requested'], completed: ['activation_confirmed'] },
};
const PROVIDERS = { business_profile: ['google_business_profile', /^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/],
  search_console: ['google_search_console', /^sc:[a-f0-9]{64}$/], analytics: ['google_analytics', /^ga4:[1-9]\d{0,19}$/],
  ads: ['google_ads', /^ads:(?!0000000000$)\d{10}$/] };
function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
}
function integrationOAuthEvent(v) {
  const expanded = v?.version === 10; const keys = expanded ? [...KEYS, 'clinicCount', 'clinicSetDigest'] : KEYS;
  exact(v, keys); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  const provider = Object.values(PROVIDERS).find(([name]) => name === v.provider);
  if (![8, 10].includes(v.version) || typeof v.eventId !== 'string' || !UUID.test(v.eventId) || typeof v.correlationId !== 'string' || !UUID.test(v.correlationId) || !stamp(v.occurredAt)
    || !ACTIONS.includes(v.action) || !REASONS[v.action][v.stage]?.includes(v.reason)
    || !positive(v.subjectUserId) || !['clinic', 'group'].includes(v.scope.type) || !positive(v.scope.id)
    || !provider || !expanded && v.provider !== 'google_business_profile' || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !provider[1].test(v.assetRef)
    || v.capturePolicy !== (expanded ? 'google-oauth-cohorts-v1' : 'google-oauth-pinned-v1')
    || v.authorizationPolicyVersion !== (expanded ? 'google-oauth-consumer-write-v1' : 'connection-scope-write-v1')) fail();
  if (expanded && (!Number.isSafeInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000
    || typeof v.clinicSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.clinicSetDigest))) fail();
  const user = v.actor.type === 'user' && v.actor.id === v.subjectUserId && typeof v.sessionRef === 'string' && UUID.test(v.sessionRef);
  const worker = v.actor.type === 'job' && v.actor.id === 'google_oauth_worker' && v.sessionRef === null;
  if (!user && !worker || v.stage === 'attempted' && v.action === ACTIONS[0] && !user
    || v.outcome !== (v.stage === 'attempted' ? 'unknown' : v.reason === 'authorization_cancelled' ? 'denied' : 'success')) fail();
  return Object.fromEntries(keys.map(k => [k, ['actor', 'scope'].includes(k) ? { type: v[k].type, id: v[k].id } : v[k]]));
}
function fromFlow(row, action, stage, reason, now, worker = false) {
  const expanded = row.policy_version === 'google-oauth-cohorts-v1';
  const [type, id] = (expanded ? row.request_scope_key : row.scope_key).split(':');
  let clinics;
  if (expanded) {
    if (!Array.isArray(row.clinic_ids)) fail(); clinics = row.clinic_ids.map(String);
    if (!clinics.length || clinics.length > 1000 || clinics.some(value => !positive(value))
      || clinics.some((value, index) => index > 0 && Number(value) <= Number(clinics[index - 1]))
      || type === 'clinic' && !clinics.includes(id)) fail();
  }
  return integrationOAuthEvent({ version: expanded ? 10 : 8, eventId: randomUUID(), correlationId: action === ACTIONS[0] ? row.flow_id : row.activation_id,
    occurredAt: now.toISOString(), action, stage, reason, outcome: stage === 'attempted' ? 'unknown' : reason === 'authorization_cancelled' ? 'denied' : 'success',
    actor: worker ? { type: 'job', id: 'google_oauth_worker' } : { type: 'user', id: String(row.actor_user_id) },
    subjectUserId: String(row.actor_user_id), sessionRef: worker ? null : row.session_ref, scope: { type, id },
    provider: expanded ? PROVIDERS[row.cohort]?.[0] : 'google_business_profile', connectionRef: row.connection_ref, assetRef: row.asset_ref,
    capturePolicy: expanded ? 'google-oauth-cohorts-v1' : 'google-oauth-pinned-v1',
    authorizationPolicyVersion: expanded ? 'google-oauth-consumer-write-v1' : 'connection-scope-write-v1',
    // The durable SQL request keeps the full set. A fixed-size commitment fits
    // the existing 4 KiB audit envelope even for a 1,000-clinic authorization.
    ...(expanded ? { clinicCount: clinics.length, clinicSetDigest: createHash('sha256').update(JSON.stringify(clinics)).digest('hex') } : {}) });
}
module.exports = { integrationOAuthEvent, fromFlow, ACTIONS };
