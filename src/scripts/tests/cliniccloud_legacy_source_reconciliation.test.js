'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { normalizedRow } = require('../../lib/cliniccloud-import/appointments-apply');
const { prepareLegacyReconciliation, storedLegacyReconciliation, reconciliationChanged, patchForLegacyReconciliation } = require('../../lib/cliniccloud-import/legacy-source-reconciliation');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');
function fixture(cancel = false) {
  const old = { idCita: '900', idContacto: '901', idEmpresa: '5880', estado: '0',
    fechaIni: '2026-10-05', horaIni: '12:00:00', fechaFin: '2026-10-05', horaFin: '12:20:00', detalles: 'Synthetic note' };
  const before = normalizedRow({ id_cita: 9, paciente_id: 7, clinica_id: 66, doctor_id: 5, instalacion_id: 6, tratamiento_id: 8,
    source_system: 'cliniccloud', source_reference: 'appointment:900', estado: 'pendiente', tipo_cita: 'continuacion',
    nota: 'Imported original clinical note', inicio: '2026-10-05 10:00:00', fin: '2026-10-05 10:20:00',
    created_at: '2026-07-20 10:00:00', updated_at: '2026-07-20 10:00:00',
    import_metadata: { raw: old, source_appointment_id: '900', source_contact_id: '901', source_service_id: '8' } });
  const row = { ...old, estado: cancel ? -2 : 0, fechaIni: cancel ? old.fechaIni : '2026-09-22',
    fechaFin: cancel ? old.fechaFin : '2026-09-22', horaIni: cancel ? old.horaIni : '19:30:00',
    horaFin: cancel ? old.horaFin : '19:50:00', agenda: { nombre: 'Room A' }, conceptos: [{ idServicio: 8, asunto: 'Service' }] };
  const rows = cancel ? [row] : [row, { ...row, idCita: '902', agenda: { nombre: 'Room B' } }];
  const history = { source_account: 'cliniccloud-5880', captured_at: '2026-09-21T20:00:00Z', patients: [{ contact_id: '901', rows }] };
  const sources = rows.map((r, i) => ({ kind: 'appointment', source_contact_id: '901', status: cancel ? 'cancelada' : 'pendiente',
    start_local: `${r.fechaIni}T${r.horaIni}`, end_local: `${r.fechaFin}T${r.horaFin}`, agenda_key: i ? 'ROOM B' : 'ROOM A',
    service_key: 'SERVICE', details: 'Synthetic note', validation_errors: [],
    provenance: { file_sha256: 'a'.repeat(64), row_sha256: (i ? 'b' : 'c').repeat(64), source_row: i + 2, row_key: `synthetic:${i}` } }));
  return { before, history, sources, reviewedBy: 'Synthetic reviewer', reason: 'Exact source ID observed', now: Date.parse('2026-09-21T20:10:00Z') };
}
test('existing source ID moves in place; two parallel rows stay bound to one appointment with HOLD', () => {
  const f = fixture(), r = prepareLegacyReconciliation(f), after = patchForLegacyReconciliation(f.before, r, f.now);
  assert.equal(after.id_cita, f.before.id_cita); assert.equal(after.inicio, '2026-09-22T17:30:00.000Z');
  assert.equal(after.estado, 'pendiente'); assert.equal(r.entries.length, 2);
  assert.deepEqual(after.import_metadata.raw, f.before.import_metadata.raw);
  assert.deepEqual(after.import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
  for (const key of ['paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'nota', 'tipo_cita', 'source_reference']) assert.equal(after[key], f.before[key]);
  assert.deepEqual(storedLegacyReconciliation(after, after.import_metadata), r);
  assert.equal(reconciliationChanged(after, r), false);
});
test('explicit source cancellation retains date, source ID, notes and history', () => {
  const f = fixture(true), after = patchForLegacyReconciliation(f.before, prepareLegacyReconciliation(f), f.now);
  assert.equal(after.estado, 'cancelada'); assert.equal(after.inicio, f.before.inicio); assert.equal(after.nota, f.before.nota);
});

function durationFixture() {
  const f = fixture();
  f.sources = [f.sources[0]];
  const raw = f.before.import_metadata.raw;
  Object.assign(raw, { fechaIni: '2026-09-22', fechaFin: '2026-09-22', horaIni: '16:00:00', horaFin: '17:00:00' });
  f.before.inicio = localToUtc('2026-09-22T16:00:00');
  f.before.fin = localToUtc('2026-09-22T17:00:00');
  Object.assign(f.sources[0], { start_local: '2026-09-22T16:00:00', end_local: '2026-09-22T17:00:00' });
  f.history.patients[0].rows = [{ ...f.history.patients[0].rows[0], fechaIni: '2026-09-22', fechaFin: '2026-09-22', horaIni: '16:00:00', horaFin: '16:30:00' }];
  f.originalLive = { source_account: 'cliniccloud-5880', captured_at: '2026-09-21T10:00:00Z', rows: [{
    appointment_id: '900', contact_id: '901', state: 0, start: '2026-09-22 16:00:00', end: '2026-09-22 17:00:00',
    agenda: 'Room A', service: 'Service', details: 'Synthetic note',
  }] };
  f.reviewedMinutes = { previous: 60, current: 30, reason: 'Explicitly reviewed source-only duration change; do not infer another procedure.' };
  return f;
}
test('reviewed duration-only change binds the unchanged CSV to the same ID and preserves clinical data and HOLD', () => {
  const f = durationFixture(), receipt = prepareLegacyReconciliation(f), after = patchForLegacyReconciliation(f.before, receipt, f.now);
  assert.equal(after.inicio, f.before.inicio);
  assert.equal(after.fin, localToUtc('2026-09-22T16:30:00'));
  assert.equal(receipt.entries[0].source.end_local, '2026-09-22T17:00:00');
  assert.equal(receipt.current.end_local, '2026-09-22T16:30:00');
  for (const key of ['id_cita', 'paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'nota', 'tipo_cita', 'estado']) assert.equal(after[key], f.before[key]);
  assert.deepEqual(storedLegacyReconciliation(after, after.import_metadata), receipt);
  assert.equal(reconciliationChanged(after, receipt), false);
  assert.equal(after.import_metadata.notification_suppression.day_before, true);
});
for (const [name, alter] of [
  ['missing old observation', f => { delete f.originalLive; }],
  ['missing duration review', f => { delete f.reviewedMinutes; }],
  ['wrong previous minutes', f => { f.reviewedMinutes.previous = 45; }],
  ['wrong new minutes', f => { f.reviewedMinutes.current = 25; }],
  ['missing reason', f => { f.reviewedMinutes.reason = ''; }],
  ['old observation not prior', f => { f.originalLive.captured_at = f.history.captured_at; }],
  ['old observation another account', f => { f.originalLive.source_account = 'other'; }],
  ['old observation another source ID', f => { f.originalLive.rows[0].appointment_id = '999'; }],
  ['ambiguous old observation', f => { f.originalLive.rows.push(structuredClone(f.originalLive.rows[0])); }],
  ['old observation another note', f => { f.originalLive.rows[0].details = 'Another'; }],
  ['old observation another state', f => { f.originalLive.rows[0].state = -2; }],
  ['same start is required', f => { f.history.patients[0].rows[0].horaIni = '16:05:00'; }],
  ['source agenda change', f => { f.history.patients[0].rows[0].agenda.nombre = 'Room C'; }],
  ['source cancellation', f => { f.history.patients[0].rows[0].estado = -2; }],
  ['source procedure change', f => { f.history.patients[0].rows[0].conceptos[0].asunto = 'Another'; }],
  ['ambiguous parallel source', f => { f.sources.push(structuredClone(f.sources[0])); }],
  ['zero duration', f => { f.history.patients[0].rows[0].horaFin = '16:00:00'; f.reviewedMinutes.current = 0; }],
]) test(`duration revision rejects ${name}`, () => { const f = durationFixture(); alter(f); assert.throws(() => prepareLegacyReconciliation(f), /INVALID/); });
test('rehashed duration receipt cannot invent minutes, baseline, observation order or a changed clinical act', () => {
  const f = durationFixture(), after = patchForLegacyReconciliation(f.before, prepareLegacyReconciliation(f), f.now);
  for (const alter of [r => { r.duration_revision.current_minutes = 31; }, r => { r.duration_revision.reason = ''; },
    r => { r.duration_revision.original_row_sha256 = ''; }, r => { r.current.agenda_key = 'ROOM C'; },
    r => { r.duration_revision.original_observed_at = r.live_captured_at; }, r => { r.previous.end_utc = '2026-09-22T14:59:00.000Z'; }]) {
    const m = structuredClone(after.import_metadata), r = m.cliniccloud_legacy_source_reconciliation;
    alter(r); delete r.receipt_sha256; r.receipt_sha256 = hash(r);
    assert.throws(() => storedLegacyReconciliation(after, m), /INVALID/);
  }
});

function movedOutFixture(date = '2026-10-27') {
  const f = fixture();
  Object.assign(f.before.import_metadata.raw, { fechaIni: '2026-09-22', fechaFin: '2026-09-22' });
  f.before.inicio = localToUtc('2026-09-22T12:00:00');
  f.before.fin = localToUtc('2026-09-22T12:20:00');
  for (const row of f.history.patients[0].rows) Object.assign(row, { fechaIni: date, fechaFin: date });
  for (const source of f.sources) {
    source.start_local = `${date}T19:30:00`;
    source.end_local = `${date}T19:50:00`;
  }
  return f;
}
test('same existing source ID moved outside the priority week keeps one local appointment and both aliases', () => {
  const f = movedOutFixture(), receipt = prepareLegacyReconciliation(f);
  const after = patchForLegacyReconciliation(f.before, receipt, f.now);
  assert.equal(after.id_cita, f.before.id_cita);
  assert.equal(after.inicio, localToUtc('2026-10-27T19:30:00'));
  assert.equal(after.inicio, '2026-10-27T18:30:00.000Z'); // Madrid after DST switch.
  assert.equal(after.fin, localToUtc('2026-10-27T19:50:00'));
  assert.equal(receipt.entries.length, 2);
  assert.equal(receipt.previous.start_utc, f.before.inicio);
  for (const key of ['paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'nota', 'tipo_cita', 'source_reference']) assert.equal(after[key], f.before[key]);
  assert.equal(reconciliationChanged(after, receipt), false);
  assert.equal(after.import_metadata.notification_suppression.day_before, true);
});
test('moving out still requires unchanged act, note, duration and exact source identity', () => {
  for (const alter of [f => { f.history.patients[0].rows[0].idCita = 999; },
    f => { f.history.patients[0].rows[0].conceptos[0].idServicio = 99; },
    f => { f.history.patients[0].rows[0].detalles = 'New note'; },
    f => { f.history.patients[0].rows[0].horaFin = '20:00:00'; }]) {
    const f = movedOutFixture(); alter(f);
    assert.throws(() => prepareLegacyReconciliation(f), /INVALID/);
  }
});
test('an unrelated future-to-future move stays outside this weekly reconciliation scope', () => {
  const f = movedOutFixture();
  Object.assign(f.before.import_metadata.raw, { fechaIni: '2026-10-05', fechaFin: '2026-10-05' });
  f.before.inicio = localToUtc('2026-10-05T12:00:00');
  f.before.fin = localToUtc('2026-10-05T12:20:00');
  assert.throws(() => prepareLegacyReconciliation(f), /INVALID/);
});
test('a moved-out visit cannot exceed the supplied export coverage', () => {
  assert.throws(() => prepareLegacyReconciliation(movedOutFixture('2027-01-02')), /INVALID/);
});
test('future No Acude is not silently treated as an explicit cancellation', () => {
  const f = movedOutFixture();
  f.history.patients[0].rows[0].estado = -1;
  assert.throws(() => prepareLegacyReconciliation(f), /INVALID/);
});
for (const [name, change] of [
  ['native row', f => { f.before.source_system = null; }],
  ['changed local date', f => { f.before.inicio = '2026-10-05T10:05:00.000Z'; }],
  ['local human edit', f => { f.before.updated_by = 1; }],
  ['completed local record', f => { f.before.estado = 'completada'; }],
  ['voucher dependency', f => { f.before.voucher_id = 1; }],
  ['advanced booking', f => { f.before.import_metadata.booking = {}; }],
  ['stale source evidence', f => { f.now += 3600000; }],
  ['changed source patient', f => { f.history.patients[0].rows[0].idContacto = '902'; }],
  ['different source act', f => { f.history.patients[0].rows[0].conceptos[0].idServicio = 9; }],
  ['compound source procedure', f => { f.history.patients[0].rows[0].conceptos.push({ idServicio: 9, asunto: 'Other' }); }],
  ['changed duration', f => { f.history.patients[0].rows[0].horaFin = '20:00:00'; }],
  ['changed note', f => { f.history.patients[0].rows[0].detalles = 'Different'; }],
  ['absent source ID', f => { f.history.patients[0].rows[0].idCita = 903; }],
  ['ambiguous identical source rows', f => { f.history.patients[0].rows.push(structuredClone(f.history.patients[0].rows[0])); }],
  ['performed source state', f => { f.history.patients[0].rows[0].estado = 3; }],
  ['missing main source alias', f => { f.sources.shift(); }],
]) test(`rejects ${name}`, () => { const f = fixture(); change(f); assert.throws(() => prepareLegacyReconciliation(f), /INVALID/); });
test('receipt corruption and changed stored identity are rejected; later clinical edits are surfaced', () => {
  const f = fixture(), r = prepareLegacyReconciliation(f), after = patchForLegacyReconciliation(f.before, r, f.now);
  assert.throws(() => storedLegacyReconciliation({ ...after, paciente_id: 8 }, after.import_metadata), /INVALID/);
  const m = structuredClone(after.import_metadata); m.cliniccloud_legacy_source_reconciliation.current.status = 'cancelada';
  assert.throws(() => storedLegacyReconciliation(after, m), /INVALID/);
  assert.equal(reconciliationChanged({ ...after, nota: 'Later note' }, r), true);
  assert.throws(() => patchForLegacyReconciliation(f.before, r, f.now + 3600000), /INVALID/);
});
for (const [direction, factory] of [['into week', fixture], ['out of week', movedOutFixture], ['duration-only revision', durationFixture]])
test(`CSV replay ${direction} preserves a single local ID for both aliases and detects later local/source changes`, () => {
  const f = factory(), r = prepareLegacyReconciliation(f);
  const local = { id: 9, patient_id: 7, clinic_id: 66, source_system: 'cliniccloud', ...r.current,
    legacy_source_reconciliation: r, reconciliation_local_changed: false };
  const build = sources => buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-01', end: '2026-12-31' },
    contacts: [{ source_contact_id: '901', fields: {} }], appointments: sources,
    snapshot: { source_account: 'cliniccloud-5880', complete_for: { clinic_ids: [66,72] },
      patients: [{ id: 7, source_contact_ids: ['901'], fields: {} }], appointments: [local] } }).actions.filter(a => a.source?.kind === 'appointment');
  assert.deepEqual(build(f.sources).map(a => [a.action, a.local_id]), f.sources.map(() => ['preserve_reconciled_legacy_source', 9]));
  local.reconciliation_local_changed = true;
  assert(build(f.sources).every(a => a.action === 'review' && a.reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW')));
  local.reconciliation_local_changed = false;
  assert(build([{ ...f.sources[0], status: 'cancelada' }])[0].reasons.includes('RECONCILED_SOURCE_CHANGED_REQUIRES_REVIEW'));
});
