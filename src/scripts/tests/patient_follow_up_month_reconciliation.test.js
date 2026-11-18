'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const values = require('../../lib/patientFollowUps.contract');
const c = require('../../lib/cliniccloud-import/followup-reconciliation');
const override = require('../../lib/cliniccloud-import/followup-clinic-override');
const dateReconciliation = require('../../lib/cliniccloud-import/followup-date-reconciliation');
const { buildClinicDecision } = require('../../lib/cliniccloud-import/followup-clinic-decision');
const file = { role: 'fiction', path: '/private/fiction.csv', sha256: 'a'.repeat(64) };
const raw = (overrides = {}) => ({ local_patient_id: 1, source_contact_id: '100', history_number: '200', source_external_id: '300',
  source_contact_due_at: '2026-12-07T09:30:00', reasons: [],
  provenance: { file_sha256: file.sha256, row_sha256: 'b'.repeat(64), source_row: 2 },
  payload: { status: 'pending', contact_due_date: '2026-12-07', operational_reason: 'Seguimiento ficticio', clinical_notes: 'Revisión en ENERO' }, ...overrides });
function fixture(record = raw()) {
  const r = c.normalizedRecord(record);
  return { record, r, live: { database_identity: {host:'fixture.invalid',port:3306,database:'qa',server_uuid:'00000000-0000-0000-0000-000000000001',server_hostname:'owned-fixture'}, patients: [{ id_paciente: 1, clinica_id: 66 }], memberships: [{ paciente_id: 1, clinica_id: 66 }],
    identities: [{ paciente_id: 1, source_contact_id: '100', history_number: '200' }], followups: [] },
  decision: { source_key: r.source_key, action: 'apply', clinic_id: 66, rule: 'exclusive_capilar_membership_authorized_20261118' } };
}
function prepared(f) { return c.prepare({ records: [f.record], decisions: [f.decision], live: f.live, sourceFiles: [file], now: '2026-11-18T06:00:00Z' }); }
function persisted(f, patch = {}) { return { id: 4, public_id: '00000000-0000-4000-8000-000000000004', clinic_id: 66, patient_id: 1,
  source_kind: 'cliniccloud_alert', source_namespace: 'cliniccloud-5880', source_reference: f.r.source_reference, source_key: f.r.source_key,
  source_date: '2026-12-07', source_date_semantics: 'contact_due', contact_due_date: '2026-12-07', clinical_target_date: null,
  clinical_target_month: null, clinical_notes: f.record.payload.clinical_notes, operational_reason: 'Seguimiento ficticio', status: 'pending',
  notice_enabled: false, notice_cycle: 1, version_number: 1, created_at: '2026-09-07 05:00:00', updated_at: '2026-09-07 05:00:00', ...patch }; }

test('month precision is validated without inventing an exact day or relative contact date', () => {
  const result = values.normalizeValues({ operational_reason: 'Prueba', clinical_target_month: '2027-02', contact_due_date: '2027-01-20' }, { creating: true, imported: true });
  assert.equal(result.clinical_target_date, null); assert.equal(result.clinical_target_month, '2027-02');
  assert.equal(result.contact_due_date, '2027-01-20'); assert.equal(result.notice_enabled, false);
  for (const month of ['2027-13','2027-00','2027-2','1899-01','2027-02-01']) assert.throws(() => values.monthOnly(month), { code: 'follow_up_invalid_month' });
  assert.throws(() => values.normalizeValues({ clinical_target_date: '2027-02-01', clinical_target_month: '2027-02' }), { code: 'follow_up_ambiguous_target' });
  assert.throws(() => values.normalizeValues({ clinical_target_month: '2027-02', reminder_advance_days: 7 }), { code: 'follow_up_month_advance' });
  assert.throws(() => values.normalizeValues({ clinical_target_month: '2027-02', contact_due_date: '2027-03-01' }), { code: 'follow_up_contact_after_month' });
});
test('month inference uses the source contact calendar, including same month, rollover and long explicit periods', () => {
  const infer = (text, contactDueDate) => c.inferTargetMonth({ text, contactDueDate });
  assert.equal(infer('Revisión ENERO','2026-12-07').month, '2027-01');
  assert.equal(infer('Revisión FEBRERO','2027-02-21').month, '2027-02');
  assert.equal(infer('Consulta MARZO de 2028','2026-11-04').month, '2028-03');
  assert.equal(infer('Consulta en septiembre','2026-10-04').month, '2027-09');
  assert.equal(infer('consulta SETIEMBRE','2026-08-04').month, '2026-09');
  assert.equal(infer('Revisión MARZO 2026','2026-11-04').reason, 'TARGET_MONTH_BEFORE_CONTACT');
  assert.equal(infer('Antes vino en 2025. Revisar ENERO','2026-12-04').reason, 'TARGET_YEAR_AMBIGUOUS');
  assert.equal(infer('ENERO o FEBRERO','2026-12-04').reason, 'MULTIPLE_TARGET_MONTHS');
  assert.equal(infer('Revisión anual','2026-12-04').reason, 'TARGET_MONTH_MISSING');
});
test('existing pending backfills only month; closed/cancelled history is preserved', () => {
  const f = fixture(); f.live.followups = [persisted(f)];
  const p = prepared(f); assert.equal(p.operations.length, 1); const op = p.operations[0];
  assert.equal(op.action, 'backfill_month'); assert.equal(op.inference.month, '2027-01');
  assert.equal(op.before.clinical_target_date, null); assert.equal(op.before.contact_due_date, '2026-12-07');
  assert.equal(c.verifyPrepared(p,p.prepared_sha256), undefined);
  for (const status of ['closed','cancelled','scheduled']) { f.live.followups = [persisted(f,{status})]; assert.equal(prepared(f).operations.length,0); }
});
test('manual target/contact edits, enabled notices and linked appointments require review', () => {
  for (const patch of [{clinical_target_date:'2027-01-12'},{contact_due_date:'2026-12-08'},{notice_enabled:true},{linked_appointment_id:10},{clinical_notes:'Otra nota'}]) {
    const f = fixture(); f.live.followups=[persisted(f,patch)]; const p=prepared(f); assert.equal(p.operations.length,0); assert.equal(p.reviews.length,1);
  }
});
test('source identity must be unique and source history must remain confirmed', () => {
  const f=fixture(); f.live.identities.push({paciente_id:2,source_contact_id:'100',history_number:'200'});
  assert.equal(prepared(f).reviews[0].reason,'FOLLOWUP_SOURCE_IDENTITY_CHANGED');
  f.live.identities=[{paciente_id:1,source_contact_id:'100',history_number:'201'}];
  assert.equal(prepared(f).reviews[0].reason,'FOLLOWUP_SOURCE_IDENTITY_CHANGED');
  f.live.identities=[{paciente_id:1,source_contact_id:'100',history_number:'200',source_column:'cliniccloud_contact_snapshot',source_snapshot_valid:null}];
  assert.equal(prepared(f).reviews[0].reason,'FOLLOWUP_SOURCE_IDENTITY_CHANGED');
});
test('exclusive Capilar rule cannot be applied to shared membership or Medical', () => {
  const f=fixture(); assert.equal(prepared(f).summary.create,1);
  f.live.memberships.push({paciente_id:1,clinica_id:72}); assert.throws(()=>prepared(f),{code:'FOLLOWUP_EXCLUSIVE_CLINIC_NOT_SUPPORTED'});
  f.decision={...f.decision,clinic_id:72}; assert.throws(()=>prepared(f),{code:'FOLLOWUP_EXCLUSIVE_CLINIC_NOT_SUPPORTED'});
});
test('documented clinic evidence must match source, clinic, source file and precede contact', () => {
  const f=fixture(); f.live.memberships.push({paciente_id:1,clinica_id:72});
  f.decision={...f.decision,rule:'documented_paid_treatment_scope',evidence:[{source_contact_id:'100',clinic_id:66,treatment_date:'2026-08-03',paid_evidence:true,provenance:{file_sha256:file.sha256,row_sha256:'c'.repeat(64),source_row:3}}]};
  assert.equal(prepared(f).summary.create,1);
  f.decision.evidence[0].treatment_date='2028-01-01';assert.throws(()=>prepared(f),{code:'FOLLOWUP_CLINIC_EVIDENCE_INVALID'});
});
test('date-change ambiguities and semantically repeated bodies cannot create another followup', () => {
  const f=fixture(raw({reasons:['POSSIBLE_CHANGED_ALERT_DATE']})); assert.equal(prepared(f).operations.length,0);
  assert.equal(prepared(f).reviews[0].reason,'POSSIBLE_CHANGED_ALERT_DATE');
  const g=fixture();g.live.followups=[persisted(g,{source_key:'d'.repeat(64),contact_due_date:'2026-11-07'})];
  assert.equal(prepared(g).operations.length,0);assert.equal(prepared(g).reviews[0].reason,'POSSIBLE_EXISTING_BODY_REQUIRES_REVIEW');
});
test('prepared and operation hashes reject tampering, even when an outer digest is recomputed', () => {
  const f=fixture();const p=prepared(f);p.operations[0].clinic_id=99;
  assert.throws(()=>c.verifyPrepared(p,p.prepared_sha256),{code:'FOLLOWUP_RECONCILIATION_PLAN_CHANGED'});
  const {prepared_sha256,...rest}=p;p.prepared_sha256=hash(rest);
  assert.throws(()=>c.verifyPrepared(p,p.prepared_sha256),{code:'FOLLOWUP_RECONCILIATION_OPERATION_INVALID'});
});
test('canonical snapshot matches SQL strings and Sequelize dates/booleans', () => {
  const f=fixture();const a=persisted(f),b={...a,id:String(a.id),clinic_id:'66',patient_id:'1',version_number:'1',notice_enabled:0,
    created_at:new Date(a.created_at.replace(' ','T')+'Z'),updated_at:new Date(a.updated_at.replace(' ','T')+'Z')};
  assert.deepEqual(c.rowSnapshot(a),c.rowSnapshot(b));
});
test('manifest and physical database identity are mandatory and do not silently widen clinical scope', () => {
  const f=fixture();f.record.provenance.file_sha256='e'.repeat(64);
  assert.throws(()=>prepared(f),{code:'FOLLOWUP_RECORD_FILE_NOT_IN_MANIFEST'});
  const g=fixture();delete g.live.database_identity;
  assert.throws(()=>prepared(g),{code:'FOLLOWUP_DATABASE_IDENTITY_REQUIRED'});
  const h=fixture(raw({payload:{status:'pending',contact_due_date:'2026-12-07',clinical_notes:'Control FACIAL en ENERO'}}));
  h.live.memberships.push({paciente_id:1,clinica_id:72});h.decision={...h.decision,clinic_id:72,rule:'explicit_followup_clinical_area'};
  assert.equal(prepared(h).operations.length,0);assert.equal(prepared(h).reviews[0].reason,'CLINIC_OUTSIDE_AUTHORIZED_BATCH');
});
test('six/twelve month clinical intervals require one matching documented month and never a generic last appointment', () => {
  const f=fixture(raw({payload:{status:'pending',contact_due_date:'2026-12-07',clinical_notes:'Revisión 6 MESES en ENERO 2027'}}));
  f.live.memberships.push({paciente_id:1,clinica_id:72});
  f.decision={...f.decision,rule:'interval_matched_documented_treatment',evidence:[{source_contact_id:'100',clinic_id:66,treatment_date:'2026-07-15',paid_evidence:false,provenance:{file_sha256:file.sha256,row_sha256:'c'.repeat(64),source_row:3}}]};
  assert.equal(prepared(f).operations[0].decision.rule,'interval_matched_documented_treatment');
  f.decision.evidence[0].treatment_date='2026-08-15';assert.throws(()=>prepared(f),{code:'FOLLOWUP_CLINIC_EVIDENCE_INVALID'});
});
function overrideFixture(f) {
  const document = { version: override.VERSION, source_account: 'cliniccloud-5880', target_clinic_id: 66,
    scope: 'unresolved_origin_only', authorization_kind: 'explicit_user_instruction', authorized_by: 'Operador ficticio',
    authorization_reference: 'qa-explicit-instruction', instruction: 'Asignar los orígenes indeterminados a Capilar',
    recorded_at: '2026-11-18T14:00:00Z', preserve_known_medical: true, preserve_contact_dates: true,
    keep_notifications_off: true, historical_origin_known: false, source_manifest_sha256: override.sourceManifestHash([file]),
    source_keys: [f.r.source_key] };
  const authFile = { role: override.ROLE, path: '/private/authorization.json', sha256: hash(document) };
  const sourceFiles = [file, authFile];
  return { document, authFile, sourceFiles, authorization: override.validateOverride({ document, file: authFile, sourceFiles }) };
}
test('an unresolved clinic requires explicit structured authorization bound to the source manifest and exact source rows', () => {
  const f = fixture(); f.live.memberships.push({ paciente_id: 1, clinica_id: 72 });
  assert.equal(buildClinicDecision({ input: f.record, live: f.live, evidence: [] }).action, 'review');
  const a = overrideFixture(f);
  const decision = buildClinicDecision({ input: f.record, live: f.live, evidence: [], administrativeOverride: a.authorization });
  assert.equal(decision.rule, override.RULE); assert.equal(decision.clinic_id, 66);
  assert.equal(decision.administrative_authorization.historical_origin_known, false);
  const plan = c.prepare({ records: [f.record], decisions: [decision], live: f.live, sourceFiles: a.sourceFiles });
  assert.equal(plan.summary.create, 1); c.verifyPrepared(plan, plan.prepared_sha256);
  const unrelated = { ...a.authorization, source_keys: ['f'.repeat(64)] };
  assert.equal(buildClinicDecision({ input: f.record, live: f.live, evidence: [], administrativeOverride: unrelated }).action, 'review');
  assert.throws(() => override.validateOverride({ document: { ...a.document, authorization_kind: 'inferred' }, file: a.authFile, sourceFiles: a.sourceFiles }), { code: 'FOLLOWUP_ADMINISTRATIVE_OVERRIDE_INVALID' });
  assert.throws(() => override.validateOverride({ document: { ...a.document, historical_origin_known: true }, file: a.authFile, sourceFiles: a.sourceFiles }), { code: 'FOLLOWUP_ADMINISTRATIVE_OVERRIDE_INVALID' });
  assert.throws(() => override.validateOverride({ document: a.document, file: a.authFile, sourceFiles: [...a.sourceFiles, { role: 'other', sha256: 'e'.repeat(64) }] }), { code: 'FOLLOWUP_OVERRIDE_MANIFEST_CHANGED' });
  assert.throws(() => c.prepare({ records: [f.record], decisions: [{ ...decision, administrative_authorization: null }], live: f.live, sourceFiles: a.sourceFiles }), { code: 'FOLLOWUP_OVERRIDE_AUTHORIZATION_REQUIRED' });
});
test('administrative unknown-origin scope never overrides known Medical evidence or missing identity/membership', () => {
  const f = fixture(); f.live.memberships.push({ paciente_id: 1, clinica_id: 72 }); const a = overrideFixture(f);
  const paid = [{ source_contact_id: '100', clinic_id: 72, treatment_date: '2026-08-03', paid_evidence: true,
    provenance: { file_sha256: file.sha256, row_sha256: 'c'.repeat(64), source_row: 3 } }];
  const decision = buildClinicDecision({ input: f.record, live: f.live, evidence: paid, administrativeOverride: a.authorization });
  assert.equal(decision.clinic_id, 72); assert.equal(decision.rule, 'documented_paid_treatment_scope');
  const plan = c.prepare({ records: [f.record], decisions: [decision], live: f.live, sourceFiles: a.sourceFiles });
  assert.equal(plan.operations.length, 0); assert.equal(plan.reviews[0].reason, 'CLINIC_OUTSIDE_AUTHORIZED_BATCH');
  f.live.identities[0].history_number = '999';
  assert.equal(buildClinicDecision({ input: f.record, live: f.live, evidence: [], administrativeOverride: a.authorization }).action, 'review');
  f.live.identities[0].history_number = '200'; f.live.patients[0].clinica_id = 72; f.live.memberships = [{ paciente_id: 1, clinica_id: 72 }];
  assert.equal(buildClinicDecision({ input: f.record, live: f.live, evidence: [], administrativeOverride: a.authorization }).action, 'review');
});
test('missing or contradictory clinical month never invents a date or discards an otherwise authorized source record', () => {
  const f = fixture(raw({ payload: { status: 'pending', contact_due_date: '2026-12-07', clinical_notes: 'Revisión anual' } }));
  f.live.followups = [persisted(f)]; const unchanged = prepared(f);
  assert.equal(unchanged.summary.preserved_without_target_month, 1); assert.equal(unchanged.reviews.length, 0);
  f.live.followups = []; assert.equal(prepared(f).operations[0].inference.month, null);
  const g = fixture(raw({ payload: { status: 'pending', contact_due_date: '2026-12-07', clinical_notes: 'Revisión DICIEMBRE 2025' } }));
  const op = prepared(g).operations[0]; assert.equal(op.inference.month, null); assert.equal(op.inference.reason, 'TARGET_MONTH_BEFORE_CONTACT');
  assert.equal(op.record.contact_due_date, '2026-12-07'); assert.equal(op.record.source_status, 'pending');
  assert.equal(op.clinical_target_review_reason, 'TARGET_MONTH_BEFORE_CONTACT');
});
test('Medical-exclusive unresolved origins require a separate batch-scope decision and never add patient memberships', () => {
  const f = fixture(); f.live.patients[0].clinica_id = 72; f.live.memberships = [{ paciente_id: 1, clinica_id: 72 }];
  const document = { version: override.SCOPE_VERSION, source_account: 'cliniccloud-5880', authorized_clinic_ids: [66,72],
    authorization_kind: 'clarification_of_existing_user_authorization', authorized_by: 'Operador ficticio', recorded_by: 'Coordinador QA',
    authorization_reference: 'qa-bs-scope', instruction: 'Completar en la clínica acreditada o exclusiva, sin cambiar vínculos',
    recorded_at: '2026-11-18T14:00:00Z', preserve_known_medical: true, preserve_primary_clinics_and_memberships: true,
    preserve_contact_dates_and_states: true, keep_notifications_off: true, unknown_shared_target_clinic_id: 66,
    unknown_exclusive_uses_current_clinic: true, historical_origin_known: false, source_manifest_sha256: override.sourceManifestHash([file]) };
  const scopeFile = { role: override.SCOPE_ROLE, path: '/private/scope.json', sha256: hash(document) }, sourceFiles = [file,scopeFile];
  const proof = override.validateBatchScope({ document, file: scopeFile, sourceFiles });
  const before = JSON.stringify(f.live);
  const decision = buildClinicDecision({ input: f.record, live: f.live, evidence: [], administrativeScope: proof });
  assert.equal(decision.clinic_id,72); assert.equal(decision.rule,override.MEDICAL_RULE);
  assert.equal(decision.administrative_authorization.historical_origin_known,false);
  assert.equal(JSON.stringify(f.live),before);
  assert.equal(c.prepare({ records:[f.record],decisions:[decision],live:f.live,sourceFiles,authorizedClinicIds:[66,72] }).summary.create,1);
  assert.throws(()=>c.prepare({ records:[f.record],decisions:[{...decision,administrative_authorization:null}],live:f.live,sourceFiles,authorizedClinicIds:[66,72] }),{code:'FOLLOWUP_BATCH_SCOPE_AUTHORIZATION_REQUIRED'});
  assert.throws(()=>override.validateBatchScope({document:{...document,preserve_primary_clinics_and_memberships:false},file:scopeFile,sourceFiles}),{code:'FOLLOWUP_BATCH_SCOPE_INVALID'});
});
test('a changed source date requires an explicit two-source resolution, preserves a closed state and guards both source identities', () => {
  const f=fixture(raw({source_external_id:null,reasons:['POSSIBLE_CHANGED_ALERT_DATE'],payload:{status:'closed',contact_due_date:'2026-12-07',clinical_notes:'Revisión ficticia cerrada'}}));
  const document={version:dateReconciliation.VERSION,rule:dateReconciliation.RULE,source_account:'cliniccloud-5880',
    authorization_kind:'explicit_operator_resolution_for_authorized_import',authorized_by:'Operador ficticio',recorded_by:'Coordinador QA',
    authorization_reference:'qa-date-resolution',recorded_at:'2026-11-18T14:00:00Z',patient_id:1,source_contact_id:'100',history_number:'200',
    body_sha256:hash(require('../../lib/cliniccloud-import/adapter').norm(f.r.clinical_notes)),
    selected:{provenance:f.r.provenance,contact_due_date:'2026-12-07',status:'closed'},
    historical:{provenance:{file_sha256:file.sha256,row_sha256:'c'.repeat(64),source_row:3},source_external_id:'300',contact_due_date:'2026-12-01',state_raw:'1'},
    alias_source_key:f.r.source_key,chosen_source:'newer_export',keep_notifications_off:true,preserve_primary_clinics_and_memberships:true,
    source_manifest_sha256:override.sourceManifestHash([file])};
  const resolutionFile={role:dateReconciliation.ROLE,path:'/private/date-resolution.json',sha256:hash(document)},sourceFiles=[file,resolutionFile];
  const proof=dateReconciliation.validateDocument({document,file:resolutionFile,sourceFiles,sourceManifestHash:override.sourceManifestHash});
  const record={...f.record,source_external_id:'300',contact_date_reconciliation:proof};const normalized=c.normalizedRecord(record);
  assert.equal(normalized.source_reference,'alert:300');assert.equal(normalized.validation_errors.length,0);
  const decision={...f.decision,source_key:normalized.source_key};
  const plan=c.prepare({records:[record],decisions:[decision],live:f.live,sourceFiles});
  assert.equal(plan.summary.create,1);assert.equal(plan.operations[0].record.source_status,'closed');
  assert.equal(plan.operations[0].record.contact_due_date,'2026-12-07');assert.equal(plan.operations[0].inference.month,null);
  assert.deepEqual(plan.operations[0].record.contact_date_reconciliation.alias_source_keys,[f.r.source_key]);
  c.verifyPrepared(plan,plan.prepared_sha256);
  f.live.followups=[persisted(f,{source_key:f.r.source_key})];
  assert.equal(c.prepare({records:[record],decisions:[decision],live:f.live,sourceFiles}).reviews[0].reason,'FOLLOWUP_ALIAS_SOURCE_ALREADY_EXISTS');
  assert.throws(()=>c.normalizedRecord({...record,source_external_id:'301'}),{code:'FOLLOWUP_DATE_RECONCILIATION_RECORD_CHANGED'});
  assert.throws(()=>dateReconciliation.validateDocument({document:{...document,selected:{...document.selected,status:'pending'}},file:resolutionFile,sourceFiles,sourceManifestHash:override.sourceManifestHash}),{code:'FOLLOWUP_DATE_RECONCILIATION_INVALID'});
});
