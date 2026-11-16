'use strict';

// A sealed snapshot remains a receipt of the original selection. Before a new
// communication, its imported source must still belong to that patient/site.
const snapshots = require('./review-care-snapshot');
const changed = () => Object.assign(Error('Ha cambiado la sede o la referencia de la atención. Revisa el destinatario antes de enviar.'),
  { status: 409, code: 'review_care_source_attribution_changed' });
const unavailable = () => Object.assign(Error('No se pudo comprobar la sede actual de la atención importada. Inténtalo de nuevo.'),
  { status: 503, code: 'review_care_source_attribution_unavailable' });
const equal = (a, b) => String(a) === String(b);

async function assertCurrentImportedCare({ items, query }) {
  const references = [];
  for (const item of items) {
    const snapshot = snapshots.snapshotOf(item);
    for (const provenance of snapshot?.provenance || []) {
      if (provenance.sourceRecordId == null) continue;
      if (!/^[1-9]\d*$/.test(String(provenance.sourceRecordId))) throw changed();
      references.push({ snapshot, provenance });
    }
  }
  if (!references.length) return;
  const ids = [...new Set(references.map(value => String(value.provenance.sourceRecordId)))];
  const rows = new Map();
  for (let offset = 0; offset < ids.length; offset += 200) {
    let result;
    try {
      result = await query(`SELECT r.id,r.patient_id,r.clinic_id,r.identity_id,r.source_key,
        r.row_sha256,r.database_sha256,r.bundle_sha256,i.catalog_id,i.source_instance,i.source_system,
        i.patient_id identity_patient_id,i.clinic_id identity_clinic_id
        FROM PatientImportedSourceRecords r LEFT JOIN PatientImportedIdentities i ON i.id=r.identity_id
        WHERE r.id IN (:sourceRecordIds)`, { sourceRecordIds: ids.slice(offset, offset + 200) });
    } catch (_) { throw unavailable(); }
    for (const row of result) rows.set(String(row.id), row);
  }
  for (const { snapshot, provenance: p } of references) {
    const row = rows.get(String(p.sourceRecordId));
    if (!row || !equal(row.patient_id, snapshot.patientId) || !equal(row.clinic_id, snapshot.clinicId)
      || !equal(row.identity_patient_id, snapshot.patientId) || !equal(row.identity_clinic_id, snapshot.clinicId)) throw changed();
    for (const [expected, field] of [['identityId','identity_id'], ['catalogId','catalog_id'], ['sourceInstance','source_instance'],
      ['sourceSystem','source_system'], ['sourceKey','source_key'], ['rowSha256','row_sha256'],
      ['databaseSha256','database_sha256'], ['bundleSha256','bundle_sha256']]) {
      if (p[expected] != null && !equal(p[expected], row[field])) throw changed();
    }
  }
}

module.exports = { assertCurrentImportedCare };
