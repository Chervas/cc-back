'use strict';
const crypto = require('crypto');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { parseImportedCareDate } = require('./marketing-import-care-date');
const KEY = 'review_care_v1';

function stripCareSnapshot(fields) {
  const clean = { ...(fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}) };
  delete clean[KEY];
  return clean;
}
function snapshotOf(item) {
  const plain = item?.get ? item.get({ plain: true }) : item;
  return plain?.custom_fields?.[KEY] || null;
}
function hasCareSnapshot(item) { return !!snapshotOf(item); }
function digestOf(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function sealCareSnapshot({ care, item, listId = null, actorId, capturedAt = new Date().toISOString() }) {
  if (!care?.latestCare?.date) return null;
  const clinicId = Number(item.clinica_id), patientId = Number(item.paciente_id);
  if (Number(care.clinicId) !== clinicId || Number(care.patientId) !== patientId || !Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) {
    throw Object.assign(Error('La fecha de atención no corresponde al paciente y clínica seleccionados'), { status: 409 });
  }
  const value = { version: 1, listId: listId ? Number(listId) : null, patientId, clinicId,
    date: care.latestCare.date, kind: care.latestCare.kind, precision: 'day', actorId: Number(actorId), capturedAt,
    provenance: (care.latestCare.provenance || []).map(p => Object.fromEntries(Object.entries(p).filter(([key]) => [
      'kind', 'appointmentId', 'occurredAt', 'status', 'precision', 'sourceRecordId', 'identityId', 'catalogId',
      'sourceSystem', 'sourceInstance', 'sourceKey', 'rowSha256', 'databaseSha256', 'bundleSha256', 'confirmationRef', 'qualificationVersion', 'timeZone',
    ].includes(key)))),
    importedMessagesHold: care.importedMessagesHold === true,
  };
  return { ...value, digest: digestOf(value) };
}
function bindCareSnapshot(item, listId) {
  const snapshot = snapshotOf(item);
  if (!snapshot) return item;
  validateCareSnapshot(item);
  if (snapshot.listId !== null && snapshot.listId !== Number(listId)) {
    throw Object.assign(Error('La referencia de última atención pertenece a otra lista'), { status: 409 });
  }
  const { digest: _digest, ...value } = snapshot;
  const next = { ...value, listId: Number(listId) };
  // The in-memory recipient must carry the same list identity as the sealed
  // evidence, including previews produced before bulkCreate returns SQL rows.
  return { ...item, list_id: Number(listId),
    custom_fields: { ...stripCareSnapshot(item.custom_fields), [KEY]: { ...next, digest: digestOf(next) } } };
}
function validateCareSnapshot(item, list = null) {
  const plain = item?.get ? item.get({ plain: true }) : item;
  const snapshot = snapshotOf(plain);
  if (!snapshot) return null;
  const { digest, ...value } = snapshot;
  const expectedListId = Number(list?.id || plain?.list_id || 0) || null;
  if (value.version !== 1 || value.patientId !== Number(plain.paciente_id) || value.clinicId !== Number(plain.clinica_id)
    || (list?.id && plain.list_id && Number(list.id) !== Number(plain.list_id))
    || value.listId !== expectedListId || value.precision !== 'day'
    || !['attended_appointment', 'performed_service_import', 'declared_care_date'].includes(value.kind)
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date)) || parseImportedCareDate(value.date).status !== 'valid'
    || !Number.isSafeInteger(value.actorId) || value.actorId <= 0 || digest !== digestOf(value)) {
    throw Object.assign(Error('La referencia de última atención ha cambiado. Vuelve a comprobar los destinatarios.'), { status: 409, code: 'review_care_snapshot_invalid' });
  }
  return snapshot;
}
// Only an authorized consumer may call this. Generic serializers always strip
// the reserved namespace; no clinical archive text is copied into Marketing.
function careDateForTemplate(item, list = null) {
  const snapshot = validateCareSnapshot(item, list);
  return snapshot ? `${snapshot.date.slice(8, 10)}/${snapshot.date.slice(5, 7)}/${snapshot.date.slice(0, 4)}` : '';
}
module.exports = { KEY, stripCareSnapshot, snapshotOf, hasCareSnapshot, sealCareSnapshot,
  bindCareSnapshot, validateCareSnapshot, careDateForTemplate };
