'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { prepareDuplicateVisit, patchDuplicateVisit, duplicateVisitLinks } = require('../../lib/cliniccloud-import/duplicate-visits');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');
function fixture() {
  const start = '2026-10-01T16:00:00', end = '2026-10-01T17:00:00';
  const details = [1, 2].map(i => ({ idCita: String(100 + i), idContacto: '50', idEmpresa: '5880', estado: 0,
    idAgenda: String(i), agenda: { nombre: 'AGENDA ' + i }, fechaIni: '2026-10-01', fechaFin: '2026-10-01',
    horaIni: '16:00:00', horaFin: '17:00:00', detalles: 'Synthetic EXION', createdOn: '2026-06-01 16:00:0' + i,
    pagado: '0', idBono: '0', archivada: '0', cita_conceptos: [{ idServicio: '33', asunto: 'SYNTHETIC SERVICE' }] }));
  const rows = details.map((d, i) => ({ id_cita: 10 + i, paciente_id: 7, clinica_id: 72, doctor_id: 9, instalacion_id: 20 + i,
    tratamiento_id: 30, source_system: 'cliniccloud', source_reference: 'appointment:' + d.idCita,
    inicio: localToUtc(start), fin: localToUtc(end), estado: 'pendiente', tipo_cita: 'continuacion',
    nota: 'Original legacy note and service, kept literally', es_provisional: 0,
    import_metadata: { raw: { ...d }, raw_extra: { untouched: true }, source_appointment_id: d.idCita,
      source_contact_id: '50', source_service_id: '33', source_agenda_id: d.idAgenda } }));
  const actions = details.map((d, i) => {
    const p = { source_row: i + 2, file_sha256: hash('file'), row_sha256: hash(d) };
    p.row_key = `appointment:${p.file_sha256}:${p.source_row}:${p.row_sha256}`;
    return { entity: 'appointment', action: 'update_imported_candidate', local_id: 10 + i, patient_id: 7, requires_review: true, reasons: [],
      source: { kind: 'appointment', source_contact_id: '50', start_local: start, end_local: end, start_utc: localToUtc(start),
        end_utc: localToUtc(end), agenda_key: d.agenda.nombre, service_key: 'SYNTHETIC SERVICE', status: 'pendiente',
        details: d.detalles, validation_errors: [], provenance: p }, provenance: p };
  });
  return { rows, actions, detailEvidence: { origin: 'https://app.clinic-cloud.com/agenda_new.php',
    captured_at: '2026-09-27T12:00:00Z', data: { rows: details.map(d => ({ source_appointment_id: d.idCita, data: d })) } },
    canonicalAppointmentId: 11, sourcePlanSha256: hash('plan'), reviewedBy: 'Synthetic reviewer',
    reason: 'Exact same visit in two old agendas, preserve both source identities', now: Date.parse('2026-09-27T12:05:00Z') };
}
function saved(f = fixture()) { const receipt = prepareDuplicateVisit(f); return f.rows.map(r => patchDuplicateVisit(r, receipt, f.now)); }
function plan(f, rows, change = {}) {
  const links = duplicateVisitLinks(rows);
  const appointments = rows.map(r => ({ id: r.id_cita, patient_id: r.paciente_id, clinic_id: r.clinica_id,
    kind: 'appointment', source_system: 'cliniccloud', status: r.estado, source_external_id: r.import_metadata.source_appointment_id,
    start_local: f.actions[0].source.start_local, end_local: f.actions[0].source.end_local,
    ...(links.has(r.id_cita) ? { parallel_sources: links.get(r.id_cita).entries,
      parallel_duplicate_retired_id: links.get(r.id_cita).retired_id, parallel_local_note_changed: links.get(r.id_cita).local_changed } : {}) }));
  return buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-10-01', end: '2026-10-01' },
    contacts: [{ source_contact_id: '50', fields: {} }], appointments: change.sources || f.actions.map(a => a.source),
    snapshot: { source_account: 'cliniccloud-5880', patients: [{ id: 7, source_contact_ids: ['50'], fields: {} }],
      appointments: [...appointments, ...(change.extra || [])] } }).actions.filter(a => a.entity === 'appointment' && a.source);
}
test('keeps both legacy rows and source evidence; only the duplicate is locally cancelled, both remain HOLD', () => {
  const f = fixture(), rows = saved(f), links = duplicateVisitLinks(rows);
  assert.equal(rows[0].estado, 'cancelada'); assert.equal(rows[1].estado, 'pendiente'); assert.equal(links.size, 1);
  assert.equal(links.get(11).entries.length, 2);
  for (let i = 0; i < 2; i++) {
    for (const key of ['inicio', 'fin', 'nota', 'tratamiento_id', 'doctor_id', 'instalacion_id', 'source_reference']) assert.equal(rows[i][key], f.rows[i][key]);
    assert.deepEqual(rows[i].import_metadata.raw, f.rows[i].import_metadata.raw);
    assert.equal(rows[i].import_metadata.raw.estado, 0); // Not misrepresented as cancelled at source.
    assert.deepEqual(rows[i].import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
  }
});
test('planner replays both old calendars to one survivor, in either order, never reviving the duplicate', () => {
  const f = fixture(); const rows = saved(f);
  for (const sources of [f.actions.map(a => a.source), f.actions.map(a => a.source).reverse()]) {
    const actions = plan(f, rows, { sources });
    assert(actions.every(a => a.action === 'preserve_parallel_source_link' && a.local_id === 11 && !a.requires_review),
      JSON.stringify(actions.map(a => ({ action: a.action, id: a.local_id, reasons: a.reasons }))));
  }
});
test('unchanged reviewed pair does not authorize a changed export or local note', () => {
  const f = fixture(), rows = saved(f), sources = f.actions.map(a => ({ ...a.source, details: 'Changed' }));
  assert(plan(f, rows, { sources }).every(a => a.action === 'review'));
  rows[1].nota = 'Human edit'; assert(plan(f, rows).every(a => a.reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW')));
});
test('another local visit, including an unrelated cancelled row, is not silently exempted from collision review', () => {
  const f = fixture(), rows = saved(f);
  for (const status of ['pendiente', 'cancelada']) assert(plan(f, rows, { extra: [{ id: 99, patient_id: 7, kind: 'appointment',
    status, start_local: f.actions[0].source.start_local, end_local: f.actions[0].source.end_local }] })
    .every(a => a.reasons.includes('PARALLEL_LOCAL_OVERLAP_REQUIRES_REVIEW')));
});
const invalid = [
  ['different patient', f => { f.rows[1].paciente_id = 8; }],
  ['different clinic', f => { f.rows[1].clinica_id = 66; }],
  ['native visit', f => { f.rows[0].source_system = null; }],
  ['older survivor', f => { f.canonicalAppointmentId = 10; }],
  ['same source id', f => { f.detailEvidence.data.rows[1].source_appointment_id = '101'; }],
  ['different clinical note', f => { f.actions[1].source.details = 'Another act'; f.detailEvidence.data.rows[1].data.detalles = 'Another act'; }],
  ['different local note', f => { f.rows[1].nota += ' human'; }],
  ['source payment', f => { f.detailEvidence.data.rows[1].data.pagado = 10; }],
  ['historic payment', f => { f.rows[0].import_metadata.raw.pagado = 10; }],
  ['source voucher', f => { f.detailEvidence.data.rows[1].data.idBono = 3; }],
  ['human edit', f => { f.rows[0].updated_by = 3; }],
  ['local voucher', f => { f.rows[0].voucher_id = 3; }],
  ['local completion', f => { f.rows[0].estado = 'completada'; }],
  ['source cancellation', f => { f.detailEvidence.data.rows[1].data.estado = -2; }],
  ['existing advanced booking', f => { f.rows[0].import_metadata.booking = {}; }],
  ['existing receipt', f => { f.rows[0].import_metadata.cliniccloud_duplicate_visit = {}; }],
  ['wrong account', f => { f.detailEvidence.data.rows[1].data.idEmpresa = '99'; }],
  ['stale source observation', f => { f.now += 3600001; }],
  ['future observation', f => { f.detailEvidence.captured_at = new Date(f.now + 1).toISOString(); }],
  ['different source file', f => { f.actions[1].source.provenance.file_sha256 = hash('different'); }],
];
for (const [name, mutate] of invalid) test('rejects ' + name, () => { const f = fixture(); mutate(f); assert.throws(() => prepareDuplicateVisit(f)); });
test('full-row CAS and evidence expiry protect application', () => {
  const f = fixture(), r = prepareDuplicateVisit(f);
  assert.throws(() => patchDuplicateVisit({ ...f.rows[0], titulo: 'Changed' }, r, f.now));
  assert.throws(() => patchDuplicateVisit(f.rows[0], r, f.now + 3600001));
});
test('snapshot rejects missing, revived, tampered and mismatched partner receipts', () => {
  assert.throws(() => duplicateVisitLinks(saved().slice(1)));
  for (const change of [rows => { rows[0].estado = 'pendiente'; }, rows => { rows[0].paciente_id = 8; },
    rows => { rows[0].import_metadata.raw.estado = -2; }, rows => { delete rows[0].import_metadata.cliniccloud_duplicate_visit; },
    rows => { rows[1].import_metadata.cliniccloud_duplicate_visit.reason = 'Tampered'; }]) {
    const rows = saved(); change(rows); assert.throws(() => duplicateVisitLinks(rows));
  }
});
