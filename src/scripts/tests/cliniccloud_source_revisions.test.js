'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { prepareSourceRevision, validateSourceRevision, revisedSource, validatedStoredRevision } = require('../../lib/cliniccloud-import/source-revisions');
const { prepareWeekAppointments, executeWeekAppointments } = require('../../lib/cliniccloud-import/week-appointments');
const { buildPlan } = require('../../lib/cliniccloud-import/planner');
function fixture() {
  const source = { kind: 'appointment', source_contact_id: '90001', start_local: '2026-09-24T10:00:00', end_local: '2026-09-24T10:15:00',
    agenda_key: 'CAPILAR', service_key: 'REVISION', status: 'pendiente', details: 'Synthetic visit unchanged', validation_errors: [],
    provenance: { file_sha256: 'a'.repeat(64), row_sha256: 'b'.repeat(64), row_key: 'synthetic:1', source_row: 2 } };
  source.start_utc = localToUtc(source.start_local); source.end_utc = localToUtc(source.end_local);
  const live = { source_account: 'cliniccloud-5880', captured_at: '2026-09-21T15:00:00Z', coverage: {start:'2026-09-21',end_exclusive:'2026-09-29'}, rows: [{ appointment_id: 555,
    contact_id: 90001, start: '2026-09-25 16:30:00', end: '2026-09-25 16:45:00', agenda: 'Capilar', service: 'Revision', state: 0, details: source.details }] };
  return { source, live, liveEvidenceSha256: 'c'.repeat(64), sourceAppointmentId: 555, reviewedBy: 'Synthetic reviewer',
    reason: 'Unique current appointment, with unchanged clinical content and duration', now: Date.parse('2026-09-21T15:10:00Z') };
}
function setup() {
  const f = fixture(), revision = prepareSourceRevision(f);
  const snapshot = { database_target: 'crm', database_group_id: 29, source_account: 'cliniccloud-5880',
    complete_for: { clinic_ids: [66,72], start: '2026-09-21', end: '2026-09-27' },
    patients: [{ id: 7, source_contact_ids: ['90001'], fields: {} }], appointments: [] };
  const plan = buildPlan({ sourceAccount: 'cliniccloud-5880', coverage: { start: '2026-09-21', end: '2026-09-27' },
    contacts: [{ source_contact_id: '90001', fields: {} }], appointments: [f.source], snapshot });
  const action = plan.actions.find(row => row.entity === 'appointment');
  const review = { plan_sha256: plan.plan_sha256, reviewed_by: 'Synthetic reviewer', reviewed_at: '2026-09-21T15:10:00Z',
    week: { start: '2026-09-21', end: '2026-09-27' }, decisions: [{ action_key: action.action_key, disposition: 'create', reason: 'Verified move',
      source_revision: revision, assignment: { clinic_id: 66, doctor_id: null, installation_id: null, treatment_id: null, appointment_type: 'revision' },
      pending_assignment: ['doctor_id','installation_id','treatment_id'], evidence: ['Synthetic source read'] }] };
  const pkg = prepareWeekAppointments({ plan, snapshot, review, target: 'crm' });
  const rows = [], store = { async transaction(cb) { const before=rows.length; try { await cb(store); } catch(e) {rows.length=before; throw e;} },
    async findSource(ref) { return rows.find(row => row.source_reference===ref); }, async validate() { return {reasons: []}; },
    async insert(payload) { rows.push({...payload,id_cita:10});return 10; }, async read() {return rows[0];} };
  const execution = { pkg, store, journal: { async append() {} }, now: () => f.now,
    approval: { package_sha256: pkg.package_sha256, automation_policy: 'hold', confirm_create_only: true, reviewed_by: 'Synthetic reviewer',
      backup_manifest_sha256: 'd'.repeat(64), expires_at: '2026-09-21T20:00:00Z' } };
  return {f,revision,snapshot,plan,review,pkg,rows,execution};
}
test('a reviewed source move retains both dates, exact ID and immutable CSV provenance', () => {
  const f=fixture(), before=structuredClone(f.source), revision=prepareSourceRevision(f), next=revisedSource(f.source,revision);
  assert.deepEqual(f.source,before); assert.equal(next.start_local,'2026-09-25T16:30:00');
  assert.equal(revision.original.start_local,'2026-09-24T10:00:00'); assert.equal(next.source_external_id,'555');
  assert.deepEqual(next.provenance,f.source.provenance);
});
test('different identity, service, duration, notes, state, account, ambiguous or stale evidence fails closed', () => {
  const changes = [f=>{f.live.rows[0].contact_id=8;}, f=>{f.live.rows[0].service='OTHER';}, f=>{f.live.rows[0].end='2026-09-25 17:00:00';},
    f=>{f.live.rows[0].details='Different clinical instruction';}, f=>{f.live.rows[0].state=3;}, f=>{f.live.rows[0].agenda='OTHER';},
    f=>{f.live.source_account='other';}, f=>{f.live.rows.push({...f.live.rows[0],appointment_id:556});},
    f=>{f.live.captured_at='2026-09-21T12:00:00Z';}, f=>{f.live.captured_at='2026-09-22T12:00:00Z';},
    f=>{f.source.source_external_id='556';}, f=>{f.source.validation_errors=['UNKNOWN'];}];
  for (const change of changes) {const f=fixture();change(f);assert.throws(()=>prepareSourceRevision(f),/SOURCE_REVISION_INVALID/);}
});
test('only punctuation comma/space normalization is allowed, not clinical rewriting', () => {
  const f=fixture();f.live.rows[0].details='Synthetic visit, unchanged';assert(prepareSourceRevision(f));
  f.live.rows[0].details='Synthetic visit not unchanged';assert.throws(()=>prepareSourceRevision(f),/INVALID/);
});
test('tampering and incorrect original CSV provenance are rejected', () => {
  const f=fixture(),revision=prepareSourceRevision(f);
  assert.throws(()=>validateSourceRevision({...revision,source_appointment_id:'556'}),/INVALID/);
  assert.throws(()=>revisedSource({...f.source,provenance:{...f.source.provenance,source_row:3}},revision),/INVALID/);
});
test('one HOLD appointment at new time is persisted with actual ID, before/after and safe replay', async () => {
  const s=setup();assert.equal((await executeWeekAppointments(s.execution)).created,1);
  const row=s.rows[0],m=row.import_metadata;assert.equal(row.inicio,'2026-09-25T14:30:00.000Z');
  assert.equal(m.source_appointment_id,'555');assert.deepEqual(validatedStoredRevision(row,m),s.revision);
  assert.deepEqual(m.notification_suppression,{appointment_details:true,day_before:true,same_day:true});
  s.execution.now=()=>Date.parse('2026-09-21T17:00:00Z');row.nota='Later local edit';
  assert.equal((await executeWeekAppointments(s.execution)).replayed,1);assert.equal(row.nota,'Later local edit');assert.equal(s.rows.length,1);
});
test('expired evidence cannot create even if approval is still valid', async () => {
  const s=setup();s.execution.now=()=>Date.parse('2026-09-21T17:00:00Z');
  await assert.rejects(executeWeekAppointments(s.execution),/EVIDENCE_EXPIRED/);assert.equal(s.rows.length,0);
});
test('an old CSV replay preserves the verified new date and does not propose creating the old slot', () => {
  const s=setup();s.snapshot.appointments=[{id:10,patient_id:7,clinic_id:66,source_system:'cliniccloud',source_revision:s.revision,
    ...s.revision.current,source_external_id:'555',last_imported:s.revision.current}];
  const make=(source=s.f.source)=>buildPlan({sourceAccount:'cliniccloud-5880',coverage:{start:'2026-09-21',end:'2026-09-27'},
    contacts:[{source_contact_id:'90001',fields:{}}],appointments:[source],snapshot:s.snapshot});
  assert.equal(make().actions.find(a=>a.entity==='appointment').action,'preserve_verified_source_revision');
  assert.equal(make().actions.filter(a=>a.entity==='appointment').length,1);
  s.snapshot.appointments[0].revision_local_note_changed=true;
  assert(make().actions.find(a=>a.source?.kind==='appointment').reasons.includes('LOCAL_EDIT_REQUIRES_REVIEW'));
  s.snapshot.appointments[0].revision_local_note_changed=false;
  assert(make({...s.f.source,status:'cancelada'}).actions.find(a=>a.source?.kind==='appointment').reasons.includes('REVISED_SOURCE_CHANGED_REQUIRES_REVIEW'));
});
test('revised time outside the reviewed week is rejected', () => {
  const s=setup(), f=s.f;f.live.rows[0].start='2026-09-28 16:30:00';f.live.rows[0].end='2026-09-28 16:45:00';
  s.review.decisions[0].source_revision=prepareSourceRevision(f);
  assert.throws(()=>prepareWeekAppointments({plan:s.plan,snapshot:s.snapshot,review:s.review,target:'crm'}),/OUTSIDE_WEEK/);
});
test('stored source revision cannot be rebound to another patient source or altered import baseline', async () => {
  const s=setup();await executeWeekAppointments(s.execution);
  const row=s.rows[0],metadata=row.import_metadata;
  for(const mutate of [m=>{m.source_contact_id='other';},m=>{m.source_appointment_id='556';},
    m=>{m.cliniccloud_delta.source.start_local='2026-09-25T17:00:00';},m=>{m.cliniccloud_delta.provenance.source_row=3;}]){
    const copy=structuredClone(metadata);mutate(copy);assert.throws(()=>validatedStoredRevision(row,copy),/SOURCE_REVISION_INVALID/);
  }
});
test('SQL checks old slot/source ID under patient locks before creating at the new time', async () => {
  const {createWeekAppointmentsStore}=require('../../lib/cliniccloud-import/week-appointments-store');
  const s=setup(),calls=[];
  const connection={async query(sql,values){calls.push({sql,values});
    if(sql.startsWith('SELECT id_clinica,grupoClinicaId'))return [[{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}]];
    if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return [[{COLUMN_NAME:'paciente_id',REFERENCED_TABLE_NAME:'Pacientes'}]];
    if(sql.startsWith('SELECT id_paciente,clinica_id'))return [[{id_paciente:7,clinica_id:66}]];
    if(sql.includes('SELECT DISTINCT pc.paciente_id'))return [[{paciente_id:7}]];
    if(sql.includes("WHERE (source_system='cliniccloud'"))return [[{id_cita:88}]];
    return [[]];},async beginTransaction(){},async commit(){},async rollback(){}};
  const store=await createWeekAppointmentsStore(connection,{groupId:29,readOnly:false});
  let result;await store.transaction(async tx=>{result=await tx.validate(s.pkg.operations[0],s.pkg);});
  assert.deepEqual(result.reasons,['REVISED_SOURCE_ALREADY_HAS_LOCAL_VISIT']);
  const locked=calls.findIndex(c=>c.sql==='SELECT id_cita FROM CitasPacientes WHERE paciente_id=? FOR UPDATE');
  const checked=calls.findIndex(c=>c.sql.includes("WHERE (source_system='cliniccloud'"));
  assert(locked>=0&&locked<checked);assert(calls[checked].values.includes('appointment:555'));
  assert(calls[checked].values.includes('2026-09-24 08:00:00.000'));
});
