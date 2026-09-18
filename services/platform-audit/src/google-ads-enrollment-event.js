'use strict';
const { randomUUID } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const PHASES = Object.freeze({ enrollment_requested: ['prepare_pending', 1], enrollment_broker_confirmed: ['activation_confirmed', 2],
  enrollment_cancel_requested: ['revoke_pending', 3], enrollment_cancel_confirmed: ['revoked', 4] });
const CAUSES = new Set(['scope_disconnected', 'account_removed', 'account_replaced', 'google_discovery_session_required',
  'google_discovery_scope_forbidden', 'google_ads_enrollment_scope_conflict', 'google_ads_enrollment_scope_unconfigured',
  'google_ads_enrollment_disabled', 'google_ads_enrollment_account_in_use', 'asset_revoked']);
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const keys = ['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef',
  'scope','provider','connectionRef','assetRef','requestRef','mappingId','state','clinicCount','clinicSetDigest','cause','capturePolicy'];
function enrollmentEvent(v) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))
    || !v.actor || Object.keys(v.actor).sort().join(',') !== 'id,type' || !v.scope || Object.keys(v.scope).sort().join(',') !== 'id,type') fail();
  const phase = Object.hasOwn(PHASES, v.reason) ? PHASES[v.reason] : null; const human = v.actor.type === 'user';
  if (v.version !== 16 || !UUID.test(v.eventId) || !UUID.test(v.correlationId) || !UUID.test(v.requestRef)
    || v.correlationId !== v.requestRef || !stamp(v.occurredAt) || v.action !== 'integration.asset.enrollment'
    || v.stage !== 'completed' || v.outcome !== 'success' || !phase || v.state !== phase[0]
    || !id(v.subjectUserId) || !(human ? id(v.actor.id) && UUID.test(v.sessionRef)
      : v.actor.type === 'job' && v.actor.id === 'google_ads_enrollment_worker' && v.sessionRef === null)
    || v.reason === 'enrollment_requested' && (!human || v.actor.id !== v.subjectUserId)
    || ['enrollment_broker_confirmed', 'enrollment_cancel_confirmed'].includes(v.reason) && human
    || !['clinic','group'].includes(v.scope.type) || !id(v.scope.id) || v.provider !== 'google_ads'
    || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || !(v.mappingId === null || id(v.mappingId)) || v.reason === 'enrollment_broker_confirmed' && !id(v.mappingId)
    || !Number.isInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000
    || v.scope.type === 'clinic' && v.clinicCount !== 1 || !/^[a-f0-9]{64}$/.test(v.clinicSetDigest || '')
    || (v.reason === 'enrollment_cancel_requested' ? !CAUSES.has(v.cause) : v.cause !== null)
    || v.capturePolicy !== 'google-ads-enrollment-durable-v1') fail();
  return Object.fromEntries(keys.map(k => [k, ['actor','scope'].includes(k) ? { ...v[k] } : v[k]]));
}
function fromEnrollment(row, reason, { now, actorId, sessionRef, cause = null }) {
  const [type, scopeId] = row.scope_key.split(':');
  const human = reason === 'enrollment_requested' || actorId != null;
  return enrollmentEvent({ version: 16, eventId: randomUUID(), correlationId: row.enrollment_id, occurredAt: now.toISOString(),
    action: 'integration.asset.enrollment', stage: 'completed', outcome: 'success', reason,
    actor: human ? { type: 'user', id: String(actorId ?? row.actor_user_id) } : { type: 'job', id: 'google_ads_enrollment_worker' },
    subjectUserId: String(row.actor_user_id), sessionRef: reason === 'enrollment_requested' ? row.session_ref : human ? sessionRef : null,
    scope: { type, id: scopeId }, provider: 'google_ads', connectionRef: row.connection_ref, assetRef: 'ads:' + row.customer_id,
    requestRef: row.enrollment_id, mappingId: row.mapping_id === null ? null : String(row.mapping_id), state: PHASES[reason]?.[0],
    clinicCount: Number(row.clinic_count), clinicSetDigest: row.clinic_digest, cause, capturePolicy: 'google-ads-enrollment-durable-v1' });
}
module.exports = { enrollmentEvent, fromEnrollment, PHASES };
