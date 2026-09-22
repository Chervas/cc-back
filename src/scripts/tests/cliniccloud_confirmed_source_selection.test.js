'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { sourceReference } = require('../../lib/cliniccloud-import/week-appointments');
const { prepareConfirmedSelection, storedConfirmedSelection, selectionLocalChanged } = require('../../lib/cliniccloud-import/confirmed-source-selection');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');
function fixture() {
  const action = (time, rowNumber, details) => {
    const file = 'a'.repeat(64), bytes = hash(time), provenance = { file_sha256: file, row_sha256: bytes, source_row: rowNumber,
      row_key: `appointment:${file}:${rowNumber}:${bytes}` };
    const source = { kind: 'appointment', source_contact_id: '123', start_local: `2026-09-25T18:${time}:00`,
      end_local: `2026-09-25T18:${Number(time)+10}:00`, agenda_key: 'SYNTHETIC ROOM', service_key: 'SYNTHETIC SERVICE',
      status: 'pendiente', details, provenance, validation_errors: [] };
    return { entity: 'appointment', action_key: hash('action'+time), patient_id: 7, provenance, source };
  };
  const retained = action('15', 3, ''), superseded = action('00', 2, 'Synthetic old time note');
  const confirmation = { version: 1, source: 'user_conversation', reference: 'synthetic-user-answer', answer: 'si',
    interpretation: 'Keep only the explicitly selected later time, without deleting any other visit.', source_account: 'cliniccloud-5880',
    patient_id: 7, recorded_at: '2026-09-21T10:00:00Z', ...Object.fromEntries(Object.entries({ retained, superseded }).map(([k,a]) =>
      [k, { action_key: a.action_key, source_reference: sourceReference(a.source), source_row: a.provenance.source_row }])) };
  const { kind, details, provenance, validation_errors, ...source } = retained.source;
  const before = { id_cita: 10, paciente_id: 7, clinica_id: 72, source_system: 'cliniccloud', source_reference: sourceReference(source),
    estado: 'pendiente', inicio: '2026-09-25 16:15:00', fin: '2026-09-25 16:25:00', nota: null,
    import_metadata: { source_account: 'cliniccloud-5880', source_contact_id: '123', cliniccloud_delta: { version: 1,
      source_reference_kind: 'import_fingerprint_not_source_appointment_id', source, provenance,
      evidence: ['synthetic-user-answer respuesta: si'] },
    notification_suppression: { appointment_details: true, day_before: true, same_day: true },
    cliniccloud_reconciliation: { automation_policy: 'hold', applied: { [retained.action_key]: { automation_policy: 'hold' } } } } };
  return { before, retained, superseded, confirmation, reviewedBy: 'Synthetic reviewer', now: Date.parse('2026-09-22T23:00:00Z') };
}
function plan(f, changes = {}) {
  const receipt = prepareConfirmedSelection(f), local = { id: 10, patient_id: 7, clinic_id: 72, source_system: 'cliniccloud',
    ...f.retained.source, kind: 'appointment', confirmed_source_selection: receipt, ...changes.local };
  const r = buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-21', end: '2026-09-27' },
    contacts: [{ source_contact_id: '123', fields: {} }], appointments: changes.sources || [f.superseded.source, f.retained.source],
    snapshot: { source_account: 'cliniccloud-5880', patients: [{ id: 7, source_contact_ids: ['123'], fields: {} }],
      appointments: [local, ...(changes.other || [])], complete_for: { clinic_ids: [66, 72], start: '2026-09-21', end: '2026-09-27' } } });
  return r.actions.filter(a => a.entity === 'appointment');
}
test('records the already applied selection without moving or rewriting a clinical record', () => {
  const f = fixture(), before = structuredClone(f), receipt = prepareConfirmedSelection(f);
  const m = { ...f.before.import_metadata, cliniccloud_confirmed_source_selection: receipt };
  assert.deepEqual(storedConfirmedSelection(f.before, m), receipt);
  assert.deepEqual(f, before); assert.equal(selectionLocalChanged(f.before, receipt), false);
  assert.equal(receipt.retained.source.details, ''); assert.equal(receipt.superseded.source.details, 'Synthetic old time note');
});
test('requires the exact confirmation, both original rows and the marker of the earlier applied choice', () => {
  const changes = [f => { f.confirmation.answer = 'no'; }, f => { f.confirmation.patient_id = 8; },
    f => { f.confirmation.retained.source_reference = f.confirmation.superseded.source_reference; },
    f => { f.confirmation.retained.action_key = hash('other'); }, f => { f.confirmation.superseded.source_row = 4; },
    f => { f.confirmation.source = 'inference'; }, f => { f.before.source_system = null; },
    f => { f.before.import_metadata.cliniccloud_delta.evidence = []; },
    f => { f.before.import_metadata.cliniccloud_reconciliation.applied = {}; },
    f => { f.superseded.source.service_key = 'OTHER'; }, f => { f.superseded.patient_id = 8; },
    f => { f.before.inicio = '2026-09-25 17:00:00'; }, f => { f.before.nota = 'Edited clinical note'; },
    f => { f.before.estado = 'completada'; }, f => { f.before.updated_by = 9; },
    f => { f.before.import_metadata.booking = {}; }, f => { f.before.voucher_id = 9; },
    f => { f.before.import_metadata.notification_suppression.day_before = false; },
    f => { f.before.import_metadata.cliniccloud_reconciliation.automation_policy = 'normal'; }];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => prepareConfirmedSelection(f), /CONFIRMED_SOURCE_SELECTION_INVALID/); }
});
test('stored receipts bind identity and the full original delta while preserving legitimate later resource changes', () => {
  const f = fixture(), r = prepareConfirmedSelection(f), m = { ...f.before.import_metadata, cliniccloud_confirmed_source_selection: r };
  assert(storedConfirmedSelection({ ...f.before, doctor_id: 123, instalacion_id: 456 }, m));
  for (const change of [row => { row.paciente_id = 8; }, row => { row.id_cita = 11; }, row => { row.clinica_id = 66; }]) {
    const row = structuredClone(f.before); change(row); assert.throws(() => storedConfirmedSelection(row, m));
  }
  const bad = structuredClone(m); bad.cliniccloud_confirmed_source_selection.superseded.source.status = 'cancelada';
  assert.throws(() => storedConfirmedSelection(f.before, bad));
  const changed = structuredClone(m); changed.cliniccloud_delta.source.service_key = 'OTHER';
  assert.throws(() => storedConfirmedSelection(f.before, changed));
  for (const patch of [{ nota: 'Edited' }, { fin: '2026-09-25 16:35:00' }, { estado: 'completada' }]) {
    assert(selectionLocalChanged({ ...f.before, ...patch }, r));
  }
});
test('same ZIP keeps one appointment and excludes only the expressly superseded source time', () => {
  const rows = plan(fixture());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.action), ['preserve_superseded_source_row', 'preserve_confirmed_source_selection']);
  assert(rows.every(r => r.local_id === 10 && !r.requires_review && !r.reasons.length && r.automation_policy === 'hold'));
});
test('another export, note, state or source ID requires a new review', () => {
  for (const patch of [{ status: 'cancelada' }, { details: 'Different note' }, { source_external_id: '999' },
    { provenance: { ...fixture().superseded.provenance, file_sha256: 'c'.repeat(64) } }]) {
    const f = fixture(), sources = [{ ...f.superseded.source, ...patch }, f.retained.source];
    assert(plan(f, { sources })[0].reasons.includes('CONFIRMED_SELECTION_SOURCE_CHANGED_REQUIRES_REVIEW'));
  }
});
test('local edits and native visits at either interval cannot be hidden by a source decision', () => {
  for (const local of [{ selection_local_changed: true }, { patient_id: 8 }, { status: 'confirmada' }, { local_modified: true }]) {
    assert(plan(fixture(), { local }).filter(r => r.source).every(r => r.action === 'review'));
  }
  for (const time of ['00', '15']) {
    const other = [{ id: 11, patient_id: 7, clinic_id: 72, kind: 'appointment', status: 'pendiente',
      start_local: `2026-09-25T18:${time}:00`, end_local: `2026-09-25T18:${Number(time)+10}:00` }];
    const rows = plan(fixture(), { other });
    assert(rows.filter(r => r.source).every(r => r.reasons.includes('CONFIRMED_SELECTION_LOCAL_OVERLAP')));
    assert(rows.some(r => !r.source && r.local_id === 11 && r.action === 'preserve_local'));
  }
});
test('partial input, reverse order and repetition never recreate the old visit', () => {
  const f = fixture();
  for (const sources of [[f.retained.source], [f.superseded.source], [f.retained.source, f.superseded.source]]) {
    const rows = plan(f, { sources }); assert.equal(rows.length, sources.length); assert(rows.every(r => !r.requires_review));
  }
});
test('third distinct source and source reschedules still require reconciliation', () => {
  const f = fixture(), third = { ...f.superseded.source, details: 'Third source entry', provenance: {
    ...f.superseded.provenance, row_sha256: hash('third'), row_key: 'third', source_row: 4 } };
  const rows = plan(f, { sources: [f.superseded.source, third, f.retained.source] });
  assert(rows.slice(0,2).every(r => r.reasons.includes('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT')));
  const moved = { ...f.retained.source, start_local: '2026-09-26T18:15:00', end_local: '2026-09-26T18:25:00' };
  assert(plan(f, { sources: [moved] }).some(r => r.source && r.action === 'review'));
});
test('an explicit prior selection can cross virtual cabins but cannot imply a different professional', () => {
  const f = fixture();
  f.retained.source.agenda_key = 'CABINA 4'; f.superseded.source.agenda_key = 'CABINA 3';
  f.before.import_metadata.cliniccloud_delta.source.agenda_key = 'CABINA 4';
  f.before.source_reference = sourceReference(f.retained.source);
  for (const key of ['retained','superseded']) f.confirmation[key].source_reference = sourceReference(f[key].source);
  assert.equal(plan(f)[0].action, 'preserve_superseded_source_row');
  f.superseded.source.agenda_key = 'DOCTOR B';
  f.confirmation.superseded.source_reference = sourceReference(f.superseded.source);
  assert.throws(() => prepareConfirmedSelection(f), /CONFIRMED_SOURCE_SELECTION_INVALID/);
});
