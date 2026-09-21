'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { sourceReference } = require('../../lib/cliniccloud-import/week-appointments');
const { prepareParallelBinding, validatedParallelSources } = require('../../lib/cliniccloud-import/parallel-sources');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');
function fixture() {
  const source = { kind: 'appointment', source_contact_id: '123', start_local: '2026-09-21T18:00:00',
    end_local: '2026-09-21T18:30:00', agenda_key: 'CALENDAR A', service_key: 'SYNTHETIC',
    status: 'pendiente', details: 'Synthetic fixture', validation_errors: [] };
  const actions = ['CALENDAR A', 'CALENDAR B'].map((agenda, i) => {
    const provenance = { file_sha256: 'a'.repeat(64), row_sha256: hash(agenda), source_row: i + 2, row_key: 'row-' + i };
    return { entity: 'appointment', patient_id: 7, provenance, source: { ...source, agenda_key: agenda, provenance } };
  });
  const baseline = { ...source }; delete baseline.kind; delete baseline.details; delete baseline.validation_errors;
  const row = { id_cita: 10, paciente_id: 7, clinica_id: 66, source_system: 'cliniccloud',
    source_reference: sourceReference(source), inicio: '2026-09-21 16:00:00', fin: '2026-09-21 16:30:00',
    estado: 'pendiente', nota: 'Synthetic fixture', import_metadata: { source_account: 'cliniccloud-5880', source_contact_id: '123',
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_delta: { version: 1, source_reference_kind: 'import_fingerprint_not_source_appointment_id', source: baseline } } };
  const live = { captured_at: '2026-09-21T13:00:00Z', rows: actions.map((action, i) => ({ contact_id: 123,
    appointment_id: 200 + i, start: action.source.start_local.replace('T', ' '), end: action.source.end_local.replace('T', ' '),
    agenda: action.source.agenda_key, service: action.source.service_key, state: 0, details: 'Synthetic fixture ' })) };
  return { row, actions, live, liveEvidenceSha256: 'b'.repeat(64), reviewedBy: 'Synthetic reviewer', now: Date.parse('2026-09-21T13:10:00Z') };
}
function planWithBinding(f, change = {}) {
  const op = prepareParallelBinding(f);
  const local = { id: 10, patient_id: 7, clinic_id: 66, source_system: 'cliniccloud',
    start_local: f.actions[0].source.start_local, end_local: f.actions[0].source.end_local,
    status: 'pendiente', agenda_key: 'CALENDAR A', service_key: 'SYNTHETIC',
    parallel_sources: validatedParallelSources(f.row, op.after_metadata), ...change.local };
  return buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-21', end: '2026-09-27' },
    contacts: [{ source_contact_id: '123', fields: {} }], appointments: change.appointments || f.actions.map(a => a.source),
    snapshot: { source_account: 'cliniccloud-5880', patients: [{ id: 7, source_contact_ids: ['123'], fields: {} }],
      appointments: [local, ...(change.otherLocals || [])], complete_for: { clinic_ids: [66, 72], start: '2026-09-21', end: '2026-09-27' } } });
}
test('parallel agendas preserve one canonical appointment and both verified external IDs', () => {
  const f = fixture(), before = structuredClone(f.row), op = prepareParallelBinding(f);
  assert.deepEqual(f.row, before);
  const entries = validatedParallelSources(f.row, op.after_metadata);
  assert.equal(entries.length, 2); assert.deepEqual(entries.map(e => e.source_appointment_id).sort(), ['200', '201']);
  assert.equal(op.local_id, 10);
  assert.deepEqual(op.after_metadata.notification_suppression, f.row.import_metadata.notification_suppression);
  const { cliniccloud_parallel_sources, ...unchanged } = op.after_metadata;
  assert.deepEqual(unchanged, f.row.import_metadata);
});
test('another interval, patient, service, state, note or live source is not a proven copy', () => {
  const changes = [f => { f.actions[1].source.start_local = '2026-09-21T18:15:00'; },
    f => { f.actions[1].patient_id = 8; }, f => { f.actions[1].source.service_key = 'OTHER'; },
    f => { f.actions[1].source.status = 'cancelada'; }, f => { f.actions[1].source.details = 'Other procedure'; },
    f => { f.live.rows[1].state = 3; }, f => { f.live.rows[1].contact_id = 999; },
    f => { f.live.rows[1].appointment_id = 200; }, f => { f.live.rows.push({ ...f.live.rows[1] }); },
    f => { f.live.captured_at = '2026-09-21T11:00:00Z'; }, f => { f.row.source_system = null; }];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => prepareParallelBinding(f), /PARALLEL_SOURCE_BINDING_INVALID/); }
});
test('tampered or contradictory stored provenance fails closed', () => {
  const f = fixture(), metadata = prepareParallelBinding(f).after_metadata;
  const bad = structuredClone(metadata); bad.cliniccloud_parallel_sources.entries[0].source_appointment_id = '999';
  assert.throws(() => validatedParallelSources(f.row, bad), /BINDING_INVALID/);
  const other = { ...f.row, paciente_id: 8 };
  assert.throws(() => validatedParallelSources(other, metadata), /BINDING_INVALID/);
  assert.deepEqual(validatedParallelSources(f.row, f.row.import_metadata), []);
  assert.throws(() => prepareParallelBinding({ ...f, row: { ...f.row, import_metadata: metadata } }), /ALREADY_BOUND/);
});
test('next delta recognizes both aliases without a second target claim, creation or absence', () => {
  const plan = planWithBinding(fixture());
  const rows = plan.actions.filter(a => a.entity === 'appointment');
  assert.equal(rows.length, 2);
  assert(rows.every(a => a.action === 'preserve_parallel_source_link' && a.local_id === 10 && !a.requires_review));
  assert(rows.every(a => !a.reasons.length));
});
test('partial source coverage never cancels the canonical appointment', () => {
  const f = fixture(), plan = planWithBinding(f, { appointments: [f.actions[1].source] });
  assert.equal(plan.actions.filter(a => a.entity === 'appointment').length, 1);
  assert.equal(plan.actions.find(a => a.entity === 'appointment').action, 'preserve_parallel_source_link');
});
test('state and note edits in a new source are reviewed rather than applied independently', () => {
  for (const patch of [{ status: 'cancelada' }, { details: 'New source note' }, { source_external_id: '999' }]) {
    const f = fixture(), appointments = f.actions.map(a => ({ ...a.source }));
    Object.assign(appointments[1], patch);
    const row = planWithBinding(f, { appointments }).actions.find(a => a.provenance?.source_row === 3);
    assert.equal(row.action, 'review'); assert(row.reasons.includes('PARALLEL_SOURCE_CHANGED_REQUIRES_REVIEW'));
  }
});
test('local changes and competing native visits stay protected', () => {
  for (const patch of [{ start_local: '2026-09-21T19:00:00' }, { status: 'completada' }, { parallel_local_note_changed: true }]) {
    const rows = planWithBinding(fixture(), { local: patch }).actions.filter(a => a.source);
    assert(rows.every(a => a.reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW')));
  }
  const f = fixture(), native = { id: 11, patient_id: 7, clinic_id: 66, kind: 'appointment',
    start_local: f.actions[0].source.start_local, end_local: f.actions[0].source.end_local, status: 'pendiente' };
  const rows = planWithBinding(f, { otherLocals: [native] }).actions.filter(a => a.source);
  assert(rows.every(a => a.reasons.includes('PARALLEL_LOCAL_OVERLAP_REQUIRES_REVIEW')));
});
test('a source reschedule cannot become a blind create or supersede the linked visit', () => {
  const f = fixture(), appointments = [{ ...f.actions[1].source, start_local: '2026-09-22T18:00:00', end_local: '2026-09-22T18:30:00' }];
  const rows = planWithBinding(f, { appointments }).actions.filter(a => a.entity === 'appointment');
  assert.equal(rows.find(a => a.source).action, 'review');
  assert(rows.find(a => a.source).reasons.includes('POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE'));
  assert.equal(rows.find(a => !a.source).action, 'preserve_local');
});
test('contradictory input rows in the same calendar still require review even with a known alias', () => {
  const f = fixture(), a = f.actions[1].source;
  const cancelled = { ...a, status: 'cancelada', provenance: { ...a.provenance, row_sha256: hash('cancelled'), row_key: 'cancelled', source_row: 4 } };
  const rows = planWithBinding(f, { appointments: [a, cancelled] }).actions.filter(action => action.source);
  assert.equal(rows.length, 2);
  assert(rows.every(action => action.action === 'review' && action.reasons.includes('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT')));
});
