'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const snapshots = require('../../lib/review-care-snapshot');
const item = { paciente_id: 31, clinica_id: 56, custom_fields: { nombre: 'Ficticio' } };
function fixture() {
  const snapshot = snapshots.sealCareSnapshot({ care: { patientId: 31, clinicId: 56,
    latestCare: { date: '2026-09-10', kind: 'performed_service_import', provenance: [{ recordId: 11 }] },
    importedMessagesHold: true }, item, actorId: 9, capturedAt: '2026-11-12T10:00:00Z' });
  return snapshots.bindCareSnapshot({ ...item, custom_fields: { ...item.custom_fields, [snapshots.KEY]: snapshot } }, 98);
}
test('a minimal snapshot is bound to list, patient, clinic and authority', () => {
  const row = fixture();
  assert.equal(snapshots.careDateForTemplate(row, { id: 98 }), '10/09/2026');
  assert.equal(snapshots.validateCareSnapshot(row, { id: 98 }).importedMessagesHold, true);
  assert.deepEqual(snapshots.stripCareSnapshot(row.custom_fields), { nombre: 'Ficticio' });
});
test('changing a date, patient, clinic or list invalidates the snapshot', () => {
  const row = fixture();
  for (const change of [{ paciente_id: 32 }, { clinica_id: 57 }, { list_id: 99 },
    { custom_fields: { ...row.custom_fields, [snapshots.KEY]: { ...row.custom_fields[snapshots.KEY], date: '2026-10-10' } } }]) {
    assert.throws(() => snapshots.validateCareSnapshot({ ...row, ...change }), /referencia/);
  }
  assert.throws(() => snapshots.validateCareSnapshot(row, { id: 99 }), /referencia/);
});
test('sealing data for another patient or clinic is rejected', () => {
  assert.throws(() => snapshots.sealCareSnapshot({ care: { patientId: 32, clinicId: 56,
    latestCare: { date: '2026-09-10' } }, item, actorId: 9 }), /corresponde/);
});

function reorderJson(value) {
  if (Array.isArray(value)) return value.map(reorderJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort((a, b) => b.localeCompare(a)).map(key => [key, reorderJson(value[key])]));
}

test('JSON storage key reordering preserves the digest, including nested provenance objects', () => {
  const source = { ...item, custom_fields: { ...item.custom_fields, [snapshots.KEY]: snapshots.sealCareSnapshot({
    care: { patientId: 31, clinicId: 56, latestCare: { date: '2026-09-10', kind: 'performed_service_import',
      provenance: [{ sourceRecordId: '90071992547409931', identityId: '90071992547409932',
        qualificationVersion: 'arriaga-confirmed-performed-services/1', rowSha256: 'a'.repeat(64) }] } },
    item, actorId: 9, capturedAt: '2026-11-12T10:00:00Z' }) } };
  const bound = { ...snapshots.bindCareSnapshot(source, 98), list_id: 98 };
  const roundtrip = JSON.parse(JSON.stringify(reorderJson(bound)));
  assert.equal(snapshots.validateCareSnapshot(roundtrip, { id: 98 }).digest, snapshots.snapshotOf(bound).digest);
  assert.equal(snapshots.careDateForTemplate(roundtrip, { id: 98 }), '10/09/2026');
  roundtrip.custom_fields[snapshots.KEY].provenance[0].identityId = '90071992547409933';
  assert.throws(() => snapshots.validateCareSnapshot(roundtrip, { id: 98 }), { code: 'review_care_snapshot_invalid', status: 409 });
});

test('binding cannot heal a tampered unbound snapshot or transplant a bound snapshot to another list', () => {
  const snapshot = snapshots.sealCareSnapshot({ care: { patientId: 31, clinicId: 56,
    latestCare: { date: '2026-09-10', kind: 'performed_service_import' } }, item, actorId: 9 });
  const source = { ...item, custom_fields: { ...item.custom_fields, [snapshots.KEY]: snapshot } };
  source.custom_fields[snapshots.KEY].date = '2026-10-10';
  assert.throws(() => snapshots.bindCareSnapshot(source, 98), { code: 'review_care_snapshot_invalid', status: 409 });
  const bound = { ...fixture(), list_id: 98 };
  assert.throws(() => snapshots.bindCareSnapshot(bound, 99), { status: 409 });
  assert.equal(snapshots.snapshotOf(bound).listId, 98);
  assert.equal(snapshots.snapshotOf(snapshots.bindCareSnapshot(bound, 98)).digest, snapshots.snapshotOf(bound).digest);
});

test('an explicit list object cannot hide a different persisted item list_id', () => {
  const row = { ...fixture(), list_id: 99 };
  assert.throws(() => snapshots.validateCareSnapshot(row, { id: 98 }), { code: 'review_care_snapshot_invalid', status: 409 });
  assert.throws(() => snapshots.careDateForTemplate(row, { id: 98 }), { status: 409 });
});

test('the whitelist preserves clinical qualification and clinic timezone but omits notes and contacts', () => {
  const snapshot = snapshots.sealCareSnapshot({ care: { patientId: 31, clinicId: 56,
    latestCare: { date: '2026-09-10', kind: 'attended_appointment', provenance: [{ kind: 'attended_appointment',
      appointmentId: '71', timeZone: 'Europe/Madrid', qualificationVersion: 'arriaga-confirmed-performed-services/1',
      notes: 'FICTITIOUS_PRIVATE_NOTE', email: 'nobody@example.invalid', diagnosis: 'FICTITIOUS_PRIVATE_DIAGNOSIS' }] } },
    item, actorId: 9 });
  assert.deepEqual(snapshot.provenance, [{ kind: 'attended_appointment', appointmentId: '71', timeZone: 'Europe/Madrid',
    qualificationVersion: 'arriaga-confirmed-performed-services/1' }]);
  assert(!JSON.stringify(snapshot).includes('FICTITIOUS_PRIVATE'));
  assert.deepEqual(snapshots.stripCareSnapshot({ ...item.custom_fields, [snapshots.KEY]: snapshot }), item.custom_fields);
});

test('a minimal snapshot remains bound to its actor, date, kind and patient-site evidence after serialization', () => {
  for (const change of [{ actorId: 10 }, { date: '2026-09-11' }, { kind: 'attended_appointment' },
    { clinicId: 57 }, { patientId: 32 }, { importedMessagesHold: false }, { capturedAt: '2026-11-13T10:00:00Z' }]) {
    const row = JSON.parse(JSON.stringify(fixture()));
    Object.assign(row.custom_fields[snapshots.KEY], change);
    assert.throws(() => snapshots.validateCareSnapshot(row, { id: 98 }), { code: 'review_care_snapshot_invalid', status: 409 });
  }
});
