'use strict';
const { randomUUID } = require('node:crypto');
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
function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
}
function integrationOAuthEvent(v) {
  exact(v, KEYS); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 8 || typeof v.eventId !== 'string' || !UUID.test(v.eventId) || typeof v.correlationId !== 'string' || !UUID.test(v.correlationId) || !stamp(v.occurredAt)
    || !ACTIONS.includes(v.action) || !REASONS[v.action][v.stage]?.includes(v.reason)
    || !positive(v.subjectUserId) || !['clinic', 'group'].includes(v.scope.type) || !positive(v.scope.id)
    || v.provider !== 'google_business_profile' || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(v.assetRef)
    || v.capturePolicy !== 'google-oauth-pinned-v1' || v.authorizationPolicyVersion !== 'connection-scope-write-v1') fail();
  const user = v.actor.type === 'user' && v.actor.id === v.subjectUserId && typeof v.sessionRef === 'string' && UUID.test(v.sessionRef);
  const worker = v.actor.type === 'job' && v.actor.id === 'google_oauth_worker' && v.sessionRef === null;
  if (!user && !worker || v.stage === 'attempted' && v.action === ACTIONS[0] && !user
    || v.outcome !== (v.stage === 'attempted' ? 'unknown' : v.reason === 'authorization_cancelled' ? 'denied' : 'success')) fail();
  return Object.fromEntries(KEYS.map(k => [k, ['actor', 'scope'].includes(k) ? { type: v[k].type, id: v[k].id } : v[k]]));
}
function fromFlow(row, action, stage, reason, now, worker = false) {
  const [type, id] = row.scope_key.split(':');
  return integrationOAuthEvent({ version: 8, eventId: randomUUID(), correlationId: action === ACTIONS[0] ? row.flow_id : row.activation_id,
    occurredAt: now.toISOString(), action, stage, reason, outcome: stage === 'attempted' ? 'unknown' : reason === 'authorization_cancelled' ? 'denied' : 'success',
    actor: worker ? { type: 'job', id: 'google_oauth_worker' } : { type: 'user', id: String(row.actor_user_id) },
    subjectUserId: String(row.actor_user_id), sessionRef: worker ? null : row.session_ref, scope: { type, id },
    provider: 'google_business_profile', connectionRef: row.connection_ref, assetRef: row.asset_ref,
    capturePolicy: 'google-oauth-pinned-v1', authorizationPolicyVersion: 'connection-scope-write-v1' });
}
module.exports = { integrationOAuthEvent, fromFlow, ACTIONS };
