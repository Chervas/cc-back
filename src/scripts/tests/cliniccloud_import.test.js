'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../../lib/cliniccloud-import/csv');
const { normalizeContacts, normalizeAppointments, normalizeAlerts, localToUtc, utcToLocal, dateOnly, hash } = require('../../lib/cliniccloud-import/adapter');
const { buildPlan, choosePrimaryClinic } = require('../../lib/cliniccloud-import/planner');
const { parseArgs, writePrivateJson } = require('../../lib/cliniccloud-import/io');
const { prepareReview } = require('../../lib/cliniccloud-import/review');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const contactRecord = (extra = {}, source_row = 2) => ({ source_row, values: { IDCONTACTO: 'source-1', NUM: '42', NOMBRE: 'Paciente sintético', APELLIDOS: 'Prueba', EMAIL: '', 'TELF. MOVIL': '', DNI: '', WHATSAPP: 'NO', ...extra } });
const sourceContacts = () => normalizeContacts([contactRecord()], 'contact-file');
function sourceAppointment(extra = {}, source_row = 2) {
  return normalizeAppointments([{ source_row, values: { IDCONTACTO: 'source-1', FECHA: '07/09/2026', 'HORA INICIO': '10:00', 'HORA FIN': '10:30', ESTADO: 'Pendiente', 'TIPO SERVICIO': 'CLINICO', SERVICIOS: 'Servicio sintético', AGENDA: 'Consulta sintética', 'SALA/BOX': '', ...extra } }], 'appointment-file')[0];
}
function localAppointment(extra = {}) {
  return { id: 101, patient_id: 5, clinic_id: 72, source_system: 'cliniccloud', source_external_id: 'old-1', kind: 'appointment', start_local: '2026-09-07T10:00:00', end_local: '2026-09-07T10:30:00', status: 'pendiente', agenda_key: 'CONSULTA SINTETICA', service_key: 'SERVICIO SINTETICO', doctor_id: 8, installation_id: 12, treatment_id: 6, ...extra };
}
const snapshot = (appointments = [], extra = {}) => ({ source_account: 'test-group', captured_at: '2026-09-06T21:00:00Z', complete_for: { clinic_ids: [66, 72], start: '2026-08-01', end: '2026-12-31' }, patients: [{ id: 5, source_contact_ids: ['source-1'], fields: sourceContacts()[0].fields }], appointments, ...extra });
function plan(extra = {}) { return buildPlan({ sourceAccount: 'test-group', coverage: { start: '2026-08-01', end: '2026-12-31' }, contacts: sourceContacts(), appointments: [sourceAppointment()], ...extra }); }
const appointmentActions = (p) => p.actions.filter((r) => r.entity === 'appointment');

test('CSV supports BOM, quoted semicolons/quotes, multiline fields and CRLF provenance', () => {
  const rows = parseCsv('\uFEFFid;details\r\n1;"primera; \"\"cita\"\"\r\nsegunda línea"\r\n2;fin\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].values.details, 'primera; "cita"\r\nsegunda línea');
  assert.equal(rows[1].source_row, 4);
});
test('CSV rejects malformed rows rather than shifting fields silently', () => {
  for (const text of ['id;id\n1;2', 'id;data\n1', 'id;data\n1;"unfinished', 'id;data\n1;"bad"suffix']) assert.throws(() => parseCsv(text));
  assert.throws(() => parseCsv('id\n1', { required: ['missing'] }), /MISSING_REQUIRED/);
});
test('WhatsApp export value never enters fields, consent decisions or patient patches', () => {
  const a = normalizeContacts([contactRecord({ WHATSAPP: 'SI' })], 'file');
  const b = normalizeContacts([contactRecord({ WHATSAPP: 'NO' })], 'file');
  assert.deepEqual(a[0].fields, b[0].fields);
  const local = snapshot(); local.patients[0].opt_out_whatsapp = true;
  const p = plan({ contacts: b, snapshot: local });
  assert.deepEqual(p.actions.find((r) => r.entity === 'patient').fields_patch, {});
  assert.equal(local.patients[0].opt_out_whatsapp, true);
  assert.equal(p.manifest.whatsapp_column_policy, 'ignored_no_consent_mutation');
});
test('calendar normalization is strict and rejects nonexistent/ambiguous Madrid instants', () => {
  assert.equal(dateOnly('31/02/2026'), null);
  assert.equal(localToUtc('2026-09-07T10:00:00'), '2026-09-07T08:00:00.000Z');
  assert.equal(utcToLocal('2026-09-07T08:00:00Z'), '2026-09-07T10:00:00');
  assert.equal(localToUtc('2026-03-29T02:30:00'), null);
  assert.equal(localToUtc('2026-10-25T02:30:00'), null);
});
test('classification uses BLOQUEO, not TIPO=CITA; payment state does not create money', () => {
  const block = sourceAppointment({ TIPO: 'CITA', 'TIPO SERVICIO': 'BLOQUEO', ESTADO: 'Anulada (Clínica)' });
  assert.equal(block.kind, 'block'); assert.equal(block.status, 'cancelada');
  const paid = sourceAppointment({ ESTADO: 'Pagada' });
  assert.equal(paid.status, 'completada'); assert.equal(paid.source_paid_state, true);
  assert.equal(paid.amount_paid, undefined);
  const unknown = sourceAppointment({ ESTADO: '' });
  assert.equal(unknown.status, null); assert.ok(unknown.validation_errors.includes('UNKNOWN_SOURCE_STATE'));
});
test('identical duplicate source rows alias once; distinct rows at same slot require review', () => {
  const same = [sourceAppointment({}, 2), sourceAppointment({}, 3)];
  assert.equal(appointmentActions(plan({ appointments: same }))[1].action, 'alias_identical_source_row');
  const different = [sourceAppointment(), sourceAppointment({ ESTADO: 'Anulada (Contacto)' }, 3)];
  assert.ok(appointmentActions(plan({ appointments: different })).every((r) => r.reasons.includes('MULTIPLE_DISTINCT_SOURCE_ROWS_SAME_SLOT')));
});
test('unique historical identity preserves cabin/professional and links original source ID', () => {
  const old = { ...sourceAppointment(), source_external_id: 'old-1' };
  const p = plan({ historicalAppointments: [old], snapshot: snapshot([localAppointment()]) });
  const row = appointmentActions(p)[0];
  assert.equal(row.action, 'update_imported_candidate'); assert.equal(row.source_external_id, 'old-1');
  assert.equal(row.preserve.installation_id, 12); assert.equal(row.preserve.doctor_id, 8);
  assert.equal(row.automation_policy, 'hold');
});
test('ambiguous historical match is never first-row-wins', () => {
  const old = { ...sourceAppointment(), source_external_id: 'old-1' };
  const p = plan({ historicalAppointments: [old, { ...old, source_external_id: 'old-2' }] });
  assert.ok(appointmentActions(p)[0].reasons.includes('AMBIGUOUS_HISTORIC_IDENTITY'));
  assert.equal(appointmentActions(p)[0].source_external_id, null);
});
test('reschedule without IDCITA becomes a candidate, never blind create', () => {
  const row = sourceAppointment({ 'HORA INICIO': '11:00', 'HORA FIN': '11:30' });
  const p = plan({ appointments: [row], snapshot: snapshot([localAppointment()]) });
  assert.equal(appointmentActions(p)[0].action, 'review');
  assert.ok(appointmentActions(p)[0].reasons.includes('POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE'));
  assert.deepEqual(appointmentActions(p)[0].candidate_local_ids, [101]);
});
test('source-ID reschedule can be proposed but local edits are protected', () => {
  const row = sourceAppointment({ IDCITA: 'old-1', 'HORA INICIO': '11:00', 'HORA FIN': '11:30' });
  const baseline = localAppointment();
  let p = plan({ appointments: [row], snapshot: snapshot([{ ...baseline, last_imported: baseline }]) });
  assert.equal(appointmentActions(p)[0].action, 'update_imported_candidate');
  p = plan({ appointments: [row], snapshot: snapshot([{ ...baseline, start_local: '2026-09-07T12:00:00', end_local: '2026-09-07T12:30:00', last_imported: baseline }]) });
  assert.ok(appointmentActions(p)[0].reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW'));
});
test('an exact native appointment is one canonical appointment, not a second create', () => {
  const p = plan({ snapshot: snapshot([localAppointment({ source_system: null, source_external_id: null })]) });
  const actions = appointmentActions(p);
  assert.equal(actions.length, 1); assert.equal(actions[0].action, 'link_native_preserve'); assert.equal(actions[0].local_id, 101);
});
test('imported match plus native duplicate is explicitly reviewed with both candidates', () => {
  const p = plan({ appointments: [sourceAppointment({ IDCITA: 'old-1' })], snapshot: snapshot([localAppointment(), localAppointment({ id: 102, source_system: null, source_external_id: null })]) });
  const row = appointmentActions(p)[0];
  assert.ok(row.reasons.includes('NATIVE_OVERLAP_WITH_MATCHED_SOURCE'));
  assert.deepEqual(row.candidate_local_ids, [101, 102]);
});
test('authoritative absence proposes supersession only inside interval; native and outside survive', () => {
  const local = [localAppointment(), localAppointment({ id: 102, source_system: null }), localAppointment({ id: 103, start_local: '2030-01-01T10:00:00' })];
  const p = plan({ appointments: [], snapshot: snapshot(local) });
  assert.deepEqual(appointmentActions(p).map((r) => [r.local_id, r.action]), [[101, 'supersede_candidate'], [102, 'preserve_local'], [103, 'preserve_local']]);
  assert.ok(appointmentActions(p).every((r) => r.physical_delete === false && r.preserve_clinical_evidence));
});
test('incomplete snapshot never authorizes absence, unknown coverage/account fail closed', () => {
  const p = plan({ appointments: [], snapshot: snapshot([localAppointment()], { complete_for: { clinic_ids: [72], start: '2026-09-01', end: '2026-12-31' } }) });
  assert.equal(appointmentActions(p)[0].action, 'preserve_local');
  assert.throws(() => plan({ snapshot: snapshot([], { source_account: 'different-group' }) }), /ACCOUNT_MISMATCH/);
  assert.throws(() => plan({ coverage: { start: '2026-12-31', end: '2026-08-01' } }), /INVALID_COVERAGE/);
  assert.throws(() => plan({ snapshot: snapshot([localAppointment({ clinic_id: 999 })]) }), /OUTSIDE_SNAPSHOT/);
});
test('patient three-way merge proposes source fields but preserves independent local edits and blanks', () => {
  const baseline = sourceContacts()[0];
  const local = snapshot(); local.patients[0].fields = { ...baseline.fields, email: 'edited@example.invalid' };
  const contacts = normalizeContacts([contactRecord({ NOMBRE: 'Cambio de origen', EMAIL: 'source@example.invalid', APELLIDOS: '' })], 'new-file');
  const p = plan({ contacts, snapshot: local, historicalContacts: [baseline] });
  const action = p.actions.find((r) => r.entity === 'patient');
  assert.equal(action.fields_patch.name, 'Cambio de origen'); assert.equal(action.fields_patch.surname, undefined);
  assert.equal(action.fields_patch.email, undefined); assert.ok(action.reasons.includes('LOCAL_FIELD_CONFLICT:email'));
});
test('alerts match NUM, never IDCONTACTO or phone, and retain administrative due date', () => {
  const contacts = sourceContacts();
  const alerts = normalizeAlerts([{ source_row: 3, values: { Fecha: '07/09/2026 09:30', Estado: 'Programada', Tipo: 'Alerta Contacto', Detalles: '42. Paciente sintético [000000000] Revisión octubre' } }], 'alerts-file', contacts);
  assert.equal(alerts[0].source_contact_id, 'source-1'); assert.equal(alerts[0].contact_due_at, '2026-09-07T09:30:00'); assert.equal(alerts[0].target_date, null);
  const action = plan({ alerts }).actions.find((r) => r.entity === 'followup');
  assert.equal(action.occupies_agenda, false); assert.equal(action.automation_policy, 'hold');
});
test('closed/cancelled alerts stay history, duplicate history numbers require review', () => {
  const records = ['Finalizada', 'Anulada'].map((Estado, i) => ({ source_row: i + 3, values: { Fecha: '07/09/2026 09:30', Estado, Tipo: 'Alerta Contacto', Detalles: '42. Paciente sintético [000] Revisión' } }));
  const alerts = normalizeAlerts(records, 'alerts-file', sourceContacts());
  assert.deepEqual(alerts.map((r) => r.status), ['closed', 'cancelled']);
  const duplicate = normalizeAlerts(records, 'alerts-file', [...sourceContacts(), { ...sourceContacts()[0], source_contact_id: 'different' }]);
  assert.ok(duplicate[0].validation_errors.includes('AMBIGUOUS_OR_MISSING_HISTORY_NUMBER'));
});
test('primary clinic uses oldest treatment with paid evidence, not newest payment or import date', () => {
  const evidence = [{ clinic_id: 72, treatment_id: 1, treatment_date: '2020-01-01', paid_evidence: false }, { clinic_id: 66, treatment_id: 2, treatment_date: '2021-01-01', paid_evidence: true }, { clinic_id: 72, treatment_id: 3, treatment_date: '2022-01-01', paid_evidence: true }];
  assert.equal(choosePrimaryClinic(evidence).clinic_id, 66);
  assert.equal(choosePrimaryClinic(evidence.map((r) => ({ ...r, paid_evidence: false }))).clinic_id, 72);
  assert.equal(choosePrimaryClinic([...evidence, { clinic_id: 72, treatment_id: 4, treatment_date: '2021-01-01', paid_evidence: true }]).requires_review, true);
});
test('dry-run is reproducible, aggregate output is PHI-free, no execution flag exists', () => {
  const a = plan(), b = plan(); assert.equal(a.plan_sha256, b.plan_sha256); assert.equal(hash(a), hash(b));
  const publicResult = JSON.stringify({ manifest: a.manifest, summary: a.summary });
  assert.ok(!publicResult.includes('Paciente sintético')); assert.ok(!publicResult.includes('source-1'));
  assert.equal(a.summary.application_implemented, false); assert.equal(a.summary.automation_activation_allowed, false);
  assert.throws(() => parseArgs(['--execute', 'true'], ['--contacts']), /INVALID_CLI/);
  assert.throws(() => writePrivateJson('/tmp/forbidden-cliniccloud-plan.json', {}), /OUTSIDE_PRIVATE_IMPORT_ROOT/);
});

function reviewed(planResult, snap, decisions) {
  return prepareReview({ plan: planResult, snapshot: snap, review: { plan_sha256: planResult.plan_sha256, reviewed_by: 'synthetic-reviewer', reviewed_at: '2026-09-07T00:00:00Z', decisions } });
}
test('review binds plan + snapshot hashes and leaves deferred items unresolved', () => {
  const snap = snapshot([localAppointment()]); const p = plan({ snapshot: snap });
  const result = reviewed(p, snap, []);
  assert.equal(result.executable, false); assert.equal(result.commands.length, 0); assert.ok(result.unresolved_review_actions > 0);
  assert.throws(() => reviewed({ ...p, actions: [] }, snap, []), /PLAN_INTEGRITY/);
  assert.throws(() => reviewed(p, { ...snap, captured_at: 'different' }, []), /SNAPSHOT_INTEGRITY/);
});
test('review can link a Graci native appointment and retire only the imported duplicate', () => {
  const snap = snapshot([localAppointment(), localAppointment({ id: 102, source_system: null, source_external_id: null })]);
  const p = plan({ snapshot: snap, appointments: [sourceAppointment({ IDCITA: 'old-1' })] });
  const action = appointmentActions(p)[0];
  const result = reviewed(p, snap, [{ action_key: action.action_key, disposition: 'link_appointment', local_appointment_id: 102, superseded_local_ids: [101], reason: 'Exact duplicated booking confirmed from both original records' }]);
  assert.deepEqual(result.commands.map((r) => r.command), ['link_appointment_source', 'supersede_imported_duplicate']);
  assert.equal(result.commands[0].mutate_schedule, false); assert.equal(result.commands[1].physical_delete, false);
  assert.equal(result.commands[1].canonical_local_id, 102);
});
test('review never overwrites a native booking or retires one outside coverage', () => {
  const snap = snapshot([localAppointment({ source_system: null, source_external_id: null }), localAppointment({ id: 103, start_local: '2030-01-01T10:00:00' })]);
  const p = plan({ snapshot: snap }); const action = appointmentActions(p)[0];
  assert.throws(() => reviewed(p, snap, [{ action_key: action.action_key, disposition: 'upsert_appointment', local_appointment_id: 101, reason: 'test' }]), /CANNOT_OVERWRITE_NATIVE/);
  assert.throws(() => reviewed(p, snap, [{ action_key: action.action_key, disposition: 'link_appointment', local_appointment_id: 101, superseded_local_ids: [103], reason: 'test' }]), /OUTSIDE_COVERAGE/);
});
test('review creation needs explicit complete resources, real patient and appointment type', () => {
  const snap = snapshot(); const p = plan({ snapshot: snap }); const action = appointmentActions(p)[0];
  const decision = { action_key: action.action_key, disposition: 'upsert_appointment', reason: 'Resource map reviewed', local_patient_id: 5 };
  assert.throws(() => reviewed(p, snap, [decision]), /COMPLETE_RESOURCE/);
  const result = reviewed(p, snap, [{ ...decision, assignment: { clinic_id: 72, doctor_id: 8, installation_id: 12, treatment_id: 6, appointment_type: 'continuacion' } }]);
  assert.equal(result.commands[0].command, 'create_imported_appointment'); assert.equal(result.commands[0].automation_policy, 'hold');
  assert.ok(result.requires_live_validation.includes('atomic_calendar_availability'));
});
test('review rejects repeated action decisions and repeated canonical appointment claims', () => {
  const snap = snapshot([localAppointment()]); const p = plan({ snapshot: snap }); const action = appointmentActions(p)[0];
  const decision = { action_key: action.action_key, disposition: 'preserve', reason: 'test' };
  assert.throws(() => reviewed(p, snap, [decision, decision]), /DUPLICATE_REVIEW_ACTION/);
});
test('primary clinic date comparison handles original day/month dates chronologically', () => {
  const choice = choosePrimaryClinic([{ clinic_id: 72, treatment_id: 1, treatment_date: '01/02/2020' }, { clinic_id: 66, treatment_id: 2, treatment_date: '31/01/2020' }]);
  assert.equal(choice.clinic_id, 66);
});
test('XLSX reader retains sparse columns and numeric dates without spreadsheet dependencies', () => {
  const script = `import importlib.util,json,sys,tempfile,zipfile,os
spec=importlib.util.spec_from_file_location('alerts_reader',sys.argv[1]); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
base='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
headers=['Nivel','Estado','Fecha','Tipo','Privada','Detalles']
cells=''.join('<c r="%s2" t="inlineStr"><is><t>%s</t></is></c>'%(chr(65+i),h) for i,h in enumerate(headers))
sheet='<worksheet xmlns="'+base+'"><sheetData><row r="2">'+cells+'</row><row r="4"><c r="B4" t="inlineStr"><is><t>Programada</t></is></c><c r="C4"><v>46272.3958333333</v></c><c r="D4" t="inlineStr"><is><t>Alerta Contacto</t></is></c><c r="F4" t="inlineStr"><is><t>42. Sintético [000] Revisión</t></is></c></row></sheetData></worksheet>'
with tempfile.TemporaryDirectory() as directory:
 filename=os.path.join(directory,'synthetic.xlsx')
 with zipfile.ZipFile(filename,'w') as archive:
  archive.writestr('xl/workbook.xml','<workbook xmlns="'+base+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Alertas" sheetId="1" r:id="rId1"/></sheets></workbook>')
  archive.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
  archive.writestr('xl/worksheets/sheet1.xml',sheet)
 print(json.dumps(module.read_alerts(filename)))`;
  const rows = JSON.parse(execFileSync('python3', ['-B', '-c', script, path.resolve(__dirname, '../../lib/cliniccloud-import/xlsx_alerts.py')], { encoding: 'utf8' }));
  assert.equal(rows[0].source_row, 4); assert.equal(rows[0].values.Privada, '');
  assert.equal(rows[0].values.Detalles, '42. Sintético [000] Revisión');
  assert.match(rows[0].values.Fecha, /^\d{2}\/\d{2}\/\d{4} /);
});
