'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = v => typeof v === 'string' && UUID.test(v);
const STATES = ['prepared', 'attempted', 'unknown', 'accepted', 'succeeded', 'partial_success', 'failed'];
const KEYS = 'version,eventId,correlationId,occurredAt,action,stage,outcome,reason,actor,sessionRef,scope,provider,connectionRef,assetRef,mappingId,clinicCount,clinicSetDigest,family,submissionRef,criteriaDigest,resultCount,resultState,resultDigest,capturePolicy';
function receiptReviewEvent(v) {
  if (!exact(v, KEYS) || !exact(v.actor, 'type,id') || !exact(v.scope, 'type,id') || v.version !== 19
    || !uuid(v.eventId) || !uuid(v.correlationId) || !uuid(v.sessionRef) || !stamp(v.occurredAt)
    || !['list', 'check'].includes(v.family) || v.action !== 'integration.google_ads.receipt_' + v.family
    || v.actor.type !== 'user' || !id(v.actor.id) || !['clinic', 'group'].includes(v.scope.type) || !id(v.scope.id)
    || v.provider !== 'google_ads' || !id(v.mappingId) || typeof v.connectionRef !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || !Number.isInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000
    || !hex(v.clinicSetDigest) || !hex(v.criteriaDigest)
    || (v.family === 'list' ? v.submissionRef !== null : !uuid(v.submissionRef))
    || v.capturePolicy !== 'google-receipts-review-v1') fail();
  if (v.stage === 'attempted') {
    if (v.outcome !== 'unknown' || v.reason !== v.family + '_requested'
      || v.resultCount !== null || v.resultState !== null || v.resultDigest !== null) fail();
  } else if (v.stage === 'completed') {
    if (v.outcome !== 'success' || !hex(v.resultDigest)) fail();
    if (v.family === 'list') {
      if (v.reason !== 'list_prepared' || !Number.isInteger(v.resultCount) || v.resultCount < 0 || v.resultCount > 20 || v.resultState !== null) fail();
    } else if (v.resultCount !== 1 || !STATES.includes(v.resultState)
      || !['receipt_checked', 'receipt_already_terminal', 'receipt_not_dispatched'].includes(v.reason)
      || (v.reason === 'receipt_checked' && !['accepted', 'succeeded', 'partial_success', 'failed'].includes(v.resultState))
      || (v.reason === 'receipt_already_terminal' && !['succeeded', 'partial_success', 'failed'].includes(v.resultState))
      || (v.reason === 'receipt_not_dispatched' && v.resultState !== 'prepared')) fail();
  } else fail();
  return Object.fromEntries(KEYS.split(',').map(key => [key, ['actor', 'scope'].includes(key) ? { ...v[key] } : v[key]]));
}
function fromReceiptReview({ actor, captured, scopeKey, requestId, family, input, reason, result = null, now }) {
  const [type, scopeId] = scopeKey.split(':');
  return receiptReviewEvent({ version: 19, eventId: randomUUID(), correlationId: requestId, occurredAt: now.toISOString(),
    action: 'integration.google_ads.receipt_' + family, stage: result === null ? 'attempted' : 'completed',
    outcome: result === null ? 'unknown' : 'success', reason, actor: { type: 'user', id: String(actor.userId) },
    sessionRef: actor.sessionRef, scope: { type, id: scopeId }, provider: 'google_ads', connectionRef: captured.connectionRef,
    assetRef: captured.assetRef, mappingId: String(captured.id), clinicCount: captured.clinicIds.length,
    clinicSetDigest: hash([...captured.clinicIds].sort((a,b) => a-b)), family,
    submissionRef: family === 'list' ? null : input.submissionId, criteriaDigest: hash(input),
    resultCount: result === null ? null : family === 'list' ? result.items.length : 1,
    resultState: result === null || family === 'list' ? null : result.item.state,
    resultDigest: result === null ? null : hash(result), capturePolicy: 'google-receipts-review-v1' });
}
module.exports = { receiptReviewEvent, fromReceiptReview };
