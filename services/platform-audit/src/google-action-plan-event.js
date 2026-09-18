'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event');
function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail();
}
const { stamp } = require('./view-contract');
const id = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const KEYS = ['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','sessionRef',
  'initiatorSessionRef','scope','provider','connectionRef','assetRef','planRef','requestRef','relatedCommandRef','mappingId',
  'family','mode','receiptState','closed','eventCount','selectionDigest','clinicCount','clinicSetDigest','capturePolicy'];
function actionPlanEvent(v) {
  exact(v, KEYS); exact(v.actor, ['type','id']); exact(v.scope, ['type','id']);
  if (v.version !== 17 || !uuid(v.eventId) || !uuid(v.correlationId) || v.correlationId !== v.requestRef
    || !uuid(v.planRef) || !uuid(v.requestRef) || !uuid(v.sessionRef) || !uuid(v.initiatorSessionRef)
    || !stamp(v.occurredAt) || v.action !== 'integration.google_ads.action_plan' || v.actor.type !== 'user' || !id(v.actor.id)
    || !['clinic','group'].includes(v.scope.type) || !id(v.scope.id) || v.provider !== 'google_ads' || !id(v.mappingId)
    || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || !['prepare','validate','apply','status','cancel'].includes(v.family) || !['create','normalize'].includes(v.mode)
    || !['none','prepared','attempted','applied'].includes(v.receiptState) || typeof v.closed !== 'boolean'
    || !Number.isInteger(v.eventCount) || v.eventCount < 1 || v.eventCount > 5 || !/^[a-f0-9]{64}$/.test(v.selectionDigest || '')
    || !Number.isInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000 || !/^[a-f0-9]{64}$/.test(v.clinicSetDigest || '')
    || v.capturePolicy !== 'google-ads-actions-durable-v1'
    || v.closed && (v.family === 'apply' || ['attempted','applied'].includes(v.receiptState))) fail();
  if (v.reason === 'command_admitted') {
    if (v.stage !== 'attempted' || v.outcome !== 'unknown' || v.relatedCommandRef !== null || v.sessionRef !== v.initiatorSessionRef) fail();
  } else {
    if (v.stage !== 'completed') fail();
    if (v.reason === 'broker_acknowledged') {
      if (v.outcome !== 'success' || v.family === 'cancel' || v.relatedCommandRef !== null || v.receiptState === 'none'
        || v.family === 'apply' && v.receiptState !== 'applied' || v.sessionRef !== v.initiatorSessionRef) fail();
    } else if (v.reason === 'result_recovered') {
      if (v.outcome !== 'success' || !['prepare','apply'].includes(v.family) || !uuid(v.relatedCommandRef)
        || v.relatedCommandRef === v.requestRef || v.receiptState === 'none' || v.family === 'apply' && v.receiptState !== 'applied') fail();
    } else if (v.reason === 'command_cancelled') {
      if (v.outcome !== 'unknown' || v.family === 'apply' || v.family === 'cancel' || !v.closed
        || ['attempted','applied'].includes(v.receiptState) || !uuid(v.relatedCommandRef) || v.relatedCommandRef === v.requestRef) fail();
    } else if (v.reason === 'closure_observed') {
      if (v.outcome !== 'success' || v.family !== 'status' || !v.closed || v.relatedCommandRef !== null
        || ['attempted','applied'].includes(v.receiptState) || v.sessionRef !== v.initiatorSessionRef) fail();
    } else if (v.reason === 'preparation_cancelled') {
      if (v.outcome !== 'success' || v.family !== 'cancel' || !v.closed || v.relatedCommandRef !== null
        || ['attempted','applied'].includes(v.receiptState) || v.sessionRef !== v.initiatorSessionRef) fail();
    } else fail();
  }
  return Object.fromEntries(KEYS.map(key => [key, ['actor','scope'].includes(key) ? { ...v[key] } : v[key]]));
}
function fromActionPlan(plan, command, captured, actor, reason, { now, relatedCommandRef = null } = {}) {
  const [type, scopeId] = plan.scope_key.split(':');
  return actionPlanEvent({ version: 17, eventId: randomUUID(), correlationId: command.command_id, occurredAt: now.toISOString(),
    action: 'integration.google_ads.action_plan', stage: reason === 'command_admitted' ? 'attempted' : 'completed',
    outcome: ['command_admitted','command_cancelled'].includes(reason) ? 'unknown' : 'success', reason,
    actor: { type: 'user', id: String(actor.userId) }, sessionRef: actor.sessionRef, initiatorSessionRef: command.session_ref,
    scope: { type, id: scopeId }, provider: 'google_ads', connectionRef: captured.connectionRef, assetRef: captured.assetRef,
    planRef: plan.plan_id, requestRef: command.command_id, relatedCommandRef, mappingId: String(plan.mapping_id),
    family: command.family, mode: plan.input.mode, receiptState: plan.receipt?.state || 'none', closed: Boolean(plan.closed_at),
    eventCount: plan.input.targets.length, selectionDigest: hash(plan.input), clinicCount: captured.clinicIds.length,
    clinicSetDigest: hash([...captured.clinicIds].sort((a,b) => a-b)), capturePolicy: 'google-ads-actions-durable-v1' });
}
module.exports = { actionPlanEvent, fromActionPlan };
