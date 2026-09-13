'use strict';
const { UUID, fail } = require('./event'); const { stamp } = require('./view-contract');
const { PATIENT_READ_ACTIONS, MAX_CLINICS, IDS_PER_EVENT, MAX_PATIENTS, positive } = require('./patient-read-contract');
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'sessionRef', 'scope', 'clinicIds', 'patientIds', 'patientCount', 'resultCount', 'includesSensitive',
  'batchIndex', 'batchCount', 'resultSetDigest', 'authorizationPolicyVersion', 'capturePolicy'];
function exact(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length
    || names.some(key => !Object.hasOwn(value, key))) fail();
}
function patientReadEvent(value) {
  exact(value, keys); exact(value.actor, ['type', 'id']); exact(value.scope, ['type', 'id']);
  const uuid = v => typeof v === 'string' && UUID.test(v);
  const ids = (v, max) => Array.isArray(v) && v.length <= max && v.every((id, index) => positive(id) && (index === 0 || Number(v[index - 1]) < Number(id)));
  if (value.version !== 6 || !uuid(value.eventId) || !uuid(value.correlationId) || !stamp(value.occurredAt)
    || !PATIENT_READ_ACTIONS.includes(value.action) || value.actor.type !== 'user' || !positive(value.actor.id)
    || !(value.sessionRef === null || uuid(value.sessionRef)) || value.capturePolicy !== 'patient-reads-durable-v1'
    || value.authorizationPolicyVersion !== 'patient-read-scope-v1'
    || !ids(value.clinicIds, MAX_CLINICS) || !ids(value.patientIds, IDS_PER_EVENT)
    || !Number.isInteger(value.batchIndex) || value.batchIndex < 0 || !Number.isInteger(value.batchCount)
    || value.batchCount < 1 || value.batchCount > Math.ceil(MAX_PATIENTS / IDS_PER_EVENT) || value.batchIndex >= value.batchCount) fail();
  const success = value.stage === 'completed' && value.outcome === 'success';
  if (success) {
    if (value.reason !== 'response_prepared' || !Number.isInteger(value.patientCount) || value.patientCount < 0 || value.patientCount > MAX_PATIENTS
      || !Number.isSafeInteger(value.resultCount) || value.resultCount < 0 || value.resultCount > 1000000000
      || typeof value.includesSensitive !== 'boolean' || typeof value.resultSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultSetDigest)
      || value.batchCount !== Math.max(1, Math.ceil(value.patientCount / IDS_PER_EVENT))
      || value.patientIds.length !== Math.min(IDS_PER_EVENT, Math.max(0, value.patientCount - value.batchIndex * IDS_PER_EVENT))
      || (value.patientCount || value.includesSensitive) && !value.clinicIds.length) fail();
    const type = value.clinicIds.length === 1 ? 'clinic' : value.clinicIds.length ? 'clinic_set' : 'platform';
    if (value.scope.type !== type || value.scope.id !== (type === 'clinic' ? value.clinicIds[0] : null)) fail();
  } else {
    if (value.clinicIds.length || value.patientIds.length || value.patientCount !== null || value.resultCount !== null
      || value.includesSensitive !== null || value.resultSetDigest !== null || value.batchIndex !== 0 || value.batchCount !== 1
      || value.scope.type !== 'platform' || value.scope.id !== null) fail();
    if (value.stage === 'attempted') {
      if (value.outcome !== 'unknown' || value.reason !== 'request_received') fail();
    } else if (value.stage === 'completed') {
      if (!(value.outcome === 'denied' && ['request_invalid', 'access_denied', 'resource_missing'].includes(value.reason)
        || value.outcome === 'error' && value.reason === 'operation_unconfirmed')) fail();
    } else if (value.stage === 'discarded') {
      if (!(value.outcome === 'denied' && value.reason === 'access_changed' || value.outcome === 'error' && value.reason === 'response_unconfirmed')) fail();
    } else fail();
  }
  return Object.fromEntries(keys.map(key => [key, key === 'actor' || key === 'scope' ? { type: value[key].type, id: value[key].id }
    : key === 'clinicIds' || key === 'patientIds' ? [...value[key]] : value[key]]));
}
module.exports = { patientReadEvent };
