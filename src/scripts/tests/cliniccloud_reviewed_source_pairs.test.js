'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { sourceReference } = require('../../lib/cliniccloud-import/week-appointments');
const { storedReviewedSourcePair } = require('../../lib/cliniccloud-import/reviewed-source-pairs');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');

function provenance(number, label) {
  const file_sha256 = 'a'.repeat(64), row_sha256 = hash(label);
  return { file_sha256, row_sha256, source_row: number, row_key: `appointment:${file_sha256}:${number}:${row_sha256}` };
}
function fixture() {
  const source = { source_contact_id: '123', start_local: '2026-09-22T10:00:00', end_local: '2026-09-22T10:30:00',
    agenda_key: 'SYNTHETIC CALENDAR', service_key: 'SYNTHETIC TREATMENT', status: 'pendiente' };
  const retained = provenance(3, 'retained'), cancelled = provenance(2, 'cancelled');
  const row = { id_cita: 10, paciente_id: 7, clinica_id: 72, source_system: 'cliniccloud', source_reference: sourceReference(source), nota: 'Synthetic note' };
  const metadata = { source_account: 'cliniccloud-5880', source_contact_id: '123', source_appointment_id: '200',
    cliniccloud_delta: { version: 1, source, provenance: retained, imported_at: '2026-09-21T12:05:00.000Z',
      source_reference_kind: 'import_fingerprint_not_source_appointment_id' },
    cliniccloud_reviewed_additional_visit: { version: 1, package_sha256: 'b'.repeat(64), live_evidence_sha256: 'c'.repeat(64),
      live_captured_at: '2026-09-21T12:00:00Z', preserved_appointment_id: 9, preserved_source_appointment_id: '199',
      superseded_cancelled_provenance: cancelled, reason: 'An authenticated source observation resolved this exact exported pair.' },
    cliniccloud_reconciliation: { applied: { synthetic: { package_sha256: 'b'.repeat(64), operation_sha256: 'd'.repeat(64),
      imported_at: '2026-09-21T12:05:00.000Z', automation_policy: 'hold', events_dispatched: false, reviewed_by: 'Synthetic reviewer' } } } };
  const appointments = [{ ...source, status: 'cancelada', provenance: cancelled }, { ...source, provenance: retained }]
    .map(s => ({ ...s, provenance: structuredClone(s.provenance), kind: 'appointment', details: row.nota, validation_errors: [] }));
  return { row, metadata, appointments };
}
function plan(f, change = {}) {
  const pair = storedReviewedSourcePair(f.row, f.metadata);
  const local = { id: 10, patient_id: 7, clinic_id: 72, source_system: 'cliniccloud',
    ...f.metadata.cliniccloud_delta.source, reviewed_source_pair: pair, ...change.local };
  return buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-21', end: '2026-09-27' },
    contacts: [{ source_contact_id: '123', fields: {} }], appointments: change.appointments || f.appointments,
    snapshot: { source_account: 'cliniccloud-5880', patients: [{ id: 7, source_contact_ids: ['123'], fields: {} }],
      appointments: [local, ...(change.otherLocals || [])], complete_for: { clinic_ids: [66, 72], start: '2026-09-21', end: '2026-09-27' } } });
}
const decisions = p => p.actions.filter(a => a.entity === 'appointment' && a.source);

test('recognizes the exact applied active/cancelled pair without rewriting either appointment', () => {
  const f = fixture(), before = structuredClone(f);
  const result = plan(f), rows = decisions(result);
  assert.deepEqual(rows.map(r => r.action), ['preserve_superseded_source_row', 'preserve_reviewed_source_pair']);
  assert(rows.every(r => r.local_id === 10 && !r.requires_review && !r.reasons.length && r.automation_policy === 'hold'));
  assert.equal(rows[0].source_external_id, null); assert.equal(rows[1].source_external_id, '200');
  assert.equal(result.actions.filter(a => a.entity === 'appointment').length, 2);
  assert.deepEqual(f, before);
});
test('reversed order and partial input do not recreate the cancelled copy or supersede the canonical visit', () => {
  for (const choose of [a => a.toReversed ? a.toReversed() : [...a].reverse(), a => [a[0]], a => [a[1]]]) {
    const f = fixture(), selected = choose(f.appointments), result = plan(f, { appointments: selected });
    assert.equal(result.actions.filter(a => a.entity === 'appointment').length, selected.length);
    assert(decisions(result).every(r => !r.requires_review));
  }
});
test('ordinary contradictory source rows still require review without the applied receipt', () => {
  const f = fixture(); delete f.metadata.cliniccloud_reviewed_additional_visit;
  assert.equal(storedReviewedSourcePair(f.row, f.metadata), null);
  assert(decisions(plan(f)).every(r => r.reasons.includes('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT')));
});
test('source state, notes, ID, row bytes and export changes cannot reuse a prior decision', () => {
  for (const change of [f => { f.appointments[0].status = 'pendiente'; },
    f => { f.appointments[0].details = 'Different clinical note'; },
    f => { f.appointments[1].source_external_id = '999'; },
    f => { f.appointments[0].source_external_id = '200'; },
    f => { f.appointments[0].provenance = provenance(2, 'new bytes'); },
    f => { f.appointments[1].provenance.file_sha256 = 'e'.repeat(64); },
    f => { f.appointments.push({ ...f.appointments[1], provenance: provenance(4, 'third row') }); }]) {
    const f = fixture(); change(f);
    assert(decisions(plan(f)).every(r => r.action === 'review' && r.reasons.includes('REVIEWED_PAIR_SOURCE_CHANGED_REQUIRES_REVIEW')));
  }
});
test('changed local notes, times, status and patient remain protected', () => {
  for (const local of [{ status: 'completada' }, { start_local: '2026-09-22T11:00:00' }, { local_modified: true }, { patient_id: 8 }]) {
    assert(decisions(plan(fixture(), { local })).every(r => r.action === 'review'));
  }
  const f = fixture(); f.row.nota = 'Locally corrected clinical note';
  assert(decisions(plan(f)).every(r => r.action === 'review'));
});
test('a competing overlapping native visit remains visible and blocks automatic discharge', () => {
  const other = { id: 11, patient_id: 7, clinic_id: 72, kind: 'appointment', status: 'pendiente',
    start_local: '2026-09-22T10:15:00', end_local: '2026-09-22T10:45:00' };
  const result = plan(fixture(), { otherLocals: [other] });
  assert(decisions(result).every(r => r.reasons.includes('REVIEWED_PAIR_LOCAL_OVERLAP')));
  assert.equal(result.actions.find(r => r.local_id === 11).action, 'preserve_local');
});
test('duplicate local receipt, patient conflicts and validation errors are never hidden', () => {
  const f = fixture(), base = { id: 11, patient_id: 7, clinic_id: 72, source_system: 'cliniccloud',
    ...f.metadata.cliniccloud_delta.source, reviewed_source_pair: storedReviewedSourcePair(f.row, f.metadata) };
  assert(decisions(plan(f, { otherLocals: [base] })).every(r => r.reasons.includes('REVIEWED_PAIR_MULTIPLE_LOCAL_MATCHES')));
  f.appointments[0].validation_errors.push('INVALID_SOURCE');
  assert(decisions(plan(f))[0].reasons.includes('INVALID_SOURCE'));
});
test('persisted receipt is bound to its source, applied package and original provenance', () => {
  const changes = [f => { f.row.source_system = null; }, f => { f.row.clinica_id = 99; },
    f => { f.row.source_reference = 'wrong'; }, f => { f.metadata.source_contact_id = '999'; },
    f => { f.metadata.source_appointment_id = '199'; }, f => { f.metadata.cliniccloud_reviewed_additional_visit.version = 2; },
    f => { f.metadata.cliniccloud_reviewed_additional_visit.package_sha256 = 'e'.repeat(64); },
    f => { f.metadata.cliniccloud_reviewed_additional_visit.live_captured_at = '2026-09-21T10:00:00Z'; },
    f => { f.metadata.cliniccloud_reviewed_additional_visit.live_evidence_sha256 = ''; },
    f => { f.metadata.cliniccloud_reviewed_additional_visit.superseded_cancelled_provenance = f.metadata.cliniccloud_delta.provenance; },
    f => { f.metadata.cliniccloud_reviewed_additional_visit.superseded_cancelled_provenance.row_key = 'wrong'; },
    f => { f.metadata.cliniccloud_reconciliation.applied.synthetic.events_dispatched = true; },
    f => { f.metadata.cliniccloud_delta.source.status = 'cancelada'; },
    f => { f.metadata.cliniccloud_parallel_sources = {}; }];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => storedReviewedSourcePair(f.row, f.metadata), /REVIEWED_SOURCE_PAIR_INVALID/); }
});
test('an additional visit without a cancelled copy does not invent a superseded source', () => {
  const f = fixture(); f.metadata.cliniccloud_reviewed_additional_visit.superseded_cancelled_provenance = null;
  assert.equal(storedReviewedSourcePair(f.row, f.metadata), null);
});
test('a source reschedule stays under review and does not cancel the previous local visit', () => {
  const f = fixture(), appointments = [{ ...f.appointments[1], start_local: '2026-09-23T10:00:00', end_local: '2026-09-23T10:30:00' }];
  const result = plan(f, { appointments });
  assert.equal(decisions(result)[0].action, 'review');
  assert(result.actions.some(a => a.local_id === 10 && !a.source && a.action === 'preserve_local'));
});
