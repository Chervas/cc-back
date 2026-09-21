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
test('CSV replay preserves a single local ID for both aliases and detects later local/source changes', () => {
  const f = fixture(), r = prepareLegacyReconciliation(f);
  const local = { id: 9, patient_id: 7, clinic_id: 66, source_system: 'cliniccloud', ...r.current,
    legacy_source_reconciliation: r, reconciliation_local_changed: false };
  const build = sources => buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-01', end: '2026-12-31' },
    contacts: [{ source_contact_id: '901', fields: {} }], appointments: sources,
    snapshot: { source_account: 'cliniccloud-5880', complete_for: { clinic_ids: [66,72] },
      patients: [{ id: 7, source_contact_ids: ['901'], fields: {} }], appointments: [local] } }).actions.filter(a => a.source?.kind === 'appointment');
  assert.deepEqual(build(f.sources).map(a => [a.action, a.local_id]), [['preserve_reconciled_legacy_source', 9], ['preserve_reconciled_legacy_source', 9]]);
  local.reconciliation_local_changed = true;
  assert(build(f.sources).every(a => a.action === 'review' && a.reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW')));
  local.reconciliation_local_changed = false;
  assert(build([{ ...f.sources[0], status: 'cancelada' }])[0].reasons.includes('RECONCILED_SOURCE_CHANGED_REQUIRES_REVIEW'));
});
