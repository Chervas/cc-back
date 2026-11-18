'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const S = require('sequelize'), D = S.DataTypes;
  db.Sequelize = S; db.sequelize = sql;
  db.Clinica = sql.define('Clinica', { id_clinica: { type:D.INTEGER, primaryKey:true }, configuracion:D.JSON }, { tableName:'Clinicas', timestamps:false });
  db.Paciente = sql.define('Paciente', { id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,numero_historia:D.STRING,clinica_id:{type:D.INTEGER,references:{model:'Clinicas',key:'id_clinica'}},nombre:D.STRING,apellidos:D.STRING }, { tableName:'Pacientes',timestamps:false });
  db.PacienteClinica = sql.define('PacienteClinica', { paciente_id:{type:D.INTEGER,references:{model:'Pacientes',key:'id_paciente'}},clinica_id:{type:D.INTEGER,references:{model:'Clinicas',key:'id_clinica'}} }, { tableName:'PacienteClinicas',timestamps:false });
  db.PatientCustomField = sql.define('PatientCustomField', { paciente_id:{type:D.INTEGER,references:{model:'Pacientes',key:'id_paciente'}},clinica_id:D.INTEGER,source:D.STRING,source_column:D.STRING,field_key:D.STRING,value:D.TEXT }, { tableName:'PatientCustomFields',timestamps:false });
  db.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true}},{tableName:'Usuarios',timestamps:false});
  db.Tratamiento=sql.define('Tratamiento',{id_tratamiento:{type:D.INTEGER,primaryKey:true},nombre:D.STRING},{tableName:'Tratamientos',timestamps:false});
  db.CitaPaciente=sql.define('CitaPaciente',{id_cita:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,paciente_id:D.INTEGER},{tableName:'CitasPacientes',timestamps:false});
  for (const model of Object.values(db).filter(value=>typeof value?.sync==='function' && value!==sql)) await model.sync({force:true});
  await db.Clinica.bulkCreate([{id_clinica:66,configuracion:{timezone:'Europe/Madrid'}},{id_clinica:72,configuracion:{timezone:'Europe/Madrid'}}]);
  await db.Usuario.create({id_usuario:1});
  await require('../../../migrations/20260906230000-create-patient-follow-ups').up(sql.getQueryInterface(),D);
  await require('../../../migrations/20261112180000-patient-follow-up-notices').up(sql.getQueryInterface(),D);
  const migration=require('../../../migrations/20261118073000-patient-follow-up-target-month');
  assert.equal((await sql.getQueryInterface().describeTable('PatientFollowUps')).clinical_target_month,undefined);
  await migration.up(sql.getQueryInterface(),D);await migration.up(sql.getQueryInterface(),D);
  assert.equal((await sql.getQueryInterface().describeTable('PatientFollowUps')).clinical_target_month.type,'VARCHAR(7)');
  await migration.down(sql.getQueryInterface());await migration.up(sql.getQueryInterface(),D);
  report.checks.push('real additive migration up/replay/down/up on owned MySQL preserves empty legacy schema');
  for(const name of ['patientfollowup','patientfollowuprevision']){const model=require('../../../models/'+name)(sql,D);db[model.name]=model;}
  // The operator must never even resolve these transports.
  db.Message={create:()=>{throw Error('MESSAGE_FORBIDDEN')}};
  db.JobRequest={create:()=>{throw Error('JOB_FORBIDDEN')}};
  db.Notification={create:()=>{throw Error('NOTICE_FORBIDDEN')}};
  for(let id=1;id<=11;id++){
    await db.Paciente.create({id_paciente:id,public_id:'ficticio-'+id,numero_historia:String(200+id),clinica_id:66,nombre:'Ficticio',apellidos:String(id)});
    await db.PacienteClinica.create({paciente_id:id,clinica_id:66});
    await db.PatientCustomField.create({paciente_id:id,clinica_id:66,source:'cliniccloud',source_column:'cliniccloud_contact_snapshot',field_key:'snapshot',value:JSON.stringify({version:'cliniccloud_contact_snapshot/1',source_account:'cliniccloud-5880',contact:{idContacto:String(100+id),num:String(200+id)}})});
  }
  const { hash }=require('../../lib/cliniccloud-import/adapter');
  const { readCsv }=require('../../lib/cliniccloud-import/io');
  const c=require('../../lib/cliniccloud-import/followup-reconciliation');
  const rt=require('../../lib/cliniccloud-import/followup-reconciliation-runtime');
  const {createSourceProof}=require('../../lib/cliniccloud-import/followup-reconciliation-source');
  const {createPatientFollowUpService}=require('../../services/patientFollowUps.service');
  const dir=path.join(report.root,'sources');fs.mkdirSync(dir,{mode:0o700});
  function csv(role,headers,rows=[]){const text=[headers,...rows].map(r=>r.map(x=>'"'+String(x??'').replace(/"/g,'""')+'"').join(';')).join('\n')+'\n';const file=path.join(dir,role);fs.writeFileSync(file,text,{mode:0o600});return{role,path:file,sha256:hash(Buffer.from(text))};}
  const dateBody='Seguimiento ficticio finalizado con fecha conciliada';
  const sourceFiles=[csv('new_contacts',['IDCONTACTO','NUM'],Array.from({length:11},(_,i)=>[101+i,201+i])),
    csv('aviso_1.csv',['idAviso','idEntidad','detalles','fecha','estado'],[['999','111',dateBody,'2026-12-01 09:30:00','1']]),csv('servicio_1.csv',['idServicio','idTipoServicio','nombre']),
    csv('tiposervicio_1.csv',['idTipoServicio','nombre']),csv('cita_1.csv',['idCita','idContacto','fecha']),csv('cita_2.csv',['idCita','idContacto','fecha']),
    csv('citaconcepto_1.csv',['idCitaConcepto','idCita','idContacto','idServicio']),csv('citaconcepto_2.csv',['idCitaConcepto','idCita','idContacto','idServicio']),
    csv('new_appointments',['IDCONTACTO','FECHA','SERVICIOS','ESTADO','TIPO SERVICIO'])];
  const originalRows=[1,2,3,4,4,5,6,7,8,9,10,11].map((id,n)=>({patientId:id,body:n===11?dateBody:n===9?'Revisión DICIEMBRE 2025 · ficticio':`Revisión ENERO 2027 · ficticio ${id} · ${n}`,state:n===5||n===11?'Finalizada':'Programada'}));
  const later=csv('later_alerts',['RELACIONADO CON','FECHA','ESTADO','DETALLES'],originalRows.map(r=>[`${200+r.patientId}. Ficticio [600000100]`,'07/12/2026 09:30:00',r.state,r.body]));sourceFiles.push(later);
  const empty=path.join(dir,'empty-alerts.xlsx');fs.writeFileSync(empty,'unused legacy XLSX cohort',{mode:0o600});const emptyHash=hash(fs.readFileSync(empty));sourceFiles.push({role:'alerts',path:empty,sha256:emptyHash});
  // This cohort consists entirely of real CSV fixture rows. The unused legacy
  // workbook has no rows; production XLSX parsing is separately exercised by
  // the operator's actual 904-row read-only preflight.
  const proof=createSourceProof({sourceFiles,readAlerts:()=>({file:{sha256:emptyHash},rows:[]})});
  const parsed=readCsv(later.path,later.role);
  const records=parsed.rows.map((r,n)=>({local_patient_id:originalRows[n].patientId,source_contact_id:String(100+originalRows[n].patientId),history_number:String(200+originalRows[n].patientId),source_external_id:null,reasons:[],source_contact_due_at:'2026-12-07T09:30:00',provenance:{file_sha256:later.sha256,source_row:r.source_row,row_sha256:hash(r.values)},payload:{status:originalRows[n].state==='Finalizada'?'closed':'pending',contact_due_date:'2026-12-07',operational_reason:'Seguimiento ficticio',clinical_notes:originalRows[n].body}}));
  proof.verifyRecords(records);
  const identity=async(ids,tx=null)=>rt.readIdentity({patientIds:[...new Set(ids)],sourceIds:ids.map(id=>String(100+id)),lock:!!tx,query:(text,replacements)=>sql.query(text,{replacements,transaction:tx,type:S.QueryTypes.SELECT})});
  const snapshot=async recs=>({database_identity:await rt.databaseIdentityReader(db)(),...await identity(recs.map(r=>r.local_patient_id)),followups:await db.PatientFollowUp.findAll({raw:true})});
  const prepare=async recs=>{const live=await snapshot(recs);return c.prepare({records:recs,decisions:proof.decisionsFor(recs,live),sourceFiles,live,target:'dev'});};
  const noNotices={supported:false,decorate:async(_rows,items)=>items};
  const service=createPatientFollowUpService({db,noticeService:noNotices});
  const importLegacy=async record=>{const r=c.normalizedRecord(record);return service.create({clinicId:66,patientIdentifier:String(r.patient_id),actorId:1,includeClinical:true,payload:{operational_reason:r.operational_reason,clinical_notes:r.clinical_notes,status:r.source_status,clinical_target_date:null,contact_due_date:r.contact_due_date},importedSource:{kind:'cliniccloud_alert',namespace:'cliniccloud-5880',reference:r.source_reference,date:r.contact_due_date,date_semantics:'contact_due'}});};
  const execute=(prepared,options={})=>c.createExecutor({db,captureIdentity:rt.transactionalIdentityReader(db),getDatabaseIdentity:rt.databaseIdentityReader(db),verifyOperation:proof.verifyOperation,now:()=>new Date('2026-11-18T06:00:00.123Z'),...options}).apply({prepared,approvedHash:prepared.prepared_sha256,actorId:1});
  await importLegacy(records[0]);const before=(await db.PatientFollowUp.findOne({where:{patient_id:1}})).toJSON();
  const backfill=await prepare([records[0]]);await execute(backfill);
  let row=await db.PatientFollowUp.findOne({where:{patient_id:1}});assert.equal(row.clinical_target_month,'2027-01');assert.equal(row.clinical_target_date,null);assert.equal(row.contact_due_date,before.contact_due_date);assert.equal(row.status,before.status);assert.equal(row.notice_enabled,false);assert.equal(row.version_number,2);
  const audit=await db.PatientFollowUpRevision.findOne({where:{follow_up_id:row.id,version_number:2}});assert.equal(audit.change_type,'import_reconciled');assert.equal(audit.snapshot.import_reconciliation.prepared_sha256,backfill.prepared_sha256);
  assert.equal((await execute(backfill)).outcomes[0].action,'preserved_existing');assert.equal(await db.PatientFollowUpRevision.count({where:{follow_up_id:row.id}}),2);
  report.checks.push('real month backfill preserves contact/state/notice, appends canonical audit and replays at SQL timestamp precision');
  const fresh=await prepare([records[1]]);await execute(fresh);assert.equal((await execute(fresh)).outcomes[0].action,'preserved_existing');
  row=await db.PatientFollowUp.findOne({where:{patient_id:2}});assert.equal(row.clinical_target_month,'2027-01');assert.equal(row.notice_enabled,false);assert.equal(await db.PatientFollowUpRevision.count({where:{follow_up_id:row.id}}),1);
  const receipt=await db.PatientFollowUpRevision.findOne({where:{follow_up_id:row.id}});assert.deepEqual(c.rowSnapshot(row),c.rowSnapshot(receipt.snapshot));
  report.checks.push('real imported creation uses source domain, one immutable receipt and retry creates neither row nor notification');
  const concurrent=await prepare([records[7]]);await Promise.all([execute(concurrent),execute(concurrent)]);assert.equal(await db.PatientFollowUp.count({where:{patient_id:7}}),1);
  report.checks.push('two concurrent applications serialize on patient and leave one source row/revision');
  await importLegacy(records[2]);const drift=await prepare([records[2]]);let drifting=await db.PatientFollowUp.findOne({where:{patient_id:3}});await drifting.update({clinical_notes:'Cambio local explícito',version_number:2});
  await assert.rejects(execute(drift),{code:'FOLLOWUP_PREIMAGE_CHANGED'});assert.equal((await drifting.reload()).clinical_target_month,null);
  report.checks.push('manual drift after preparation rejects without overwriting local notes');
  await importLegacy(records[3]);const atomic=await prepare([records[3],records[4]]);const patientBefore=await db.PatientFollowUp.findAll({where:{patient_id:4},raw:true});
  const originalCreate=db.PatientFollowUpRevision.create;let writes=0;db.PatientFollowUpRevision.create=async function(...args){if(++writes===2)throw Error('TEST_AUDIT_FAILURE');return originalCreate.apply(this,args)};
  await assert.rejects(execute(atomic),/TEST_AUDIT_FAILURE/);db.PatientFollowUpRevision.create=originalCreate;
  assert.deepEqual((await db.PatientFollowUp.findAll({where:{patient_id:4},raw:true})).map(c.rowSnapshot),patientBefore.map(c.rowSnapshot));
  report.checks.push('audit failure after real writes rolls the entire patient group back');
  const closed=await prepare([records[5]]);await execute(closed);row=await db.PatientFollowUp.findOne({where:{patient_id:5}});assert.equal(row.status,'closed');assert.equal(row.clinical_target_month,null);assert.equal(row.notice_enabled,false);
  report.checks.push('closed source history is imported closed with original contact and no invented month');
  const stale=await prepare([records[6]]);await db.PacienteClinica.create({paciente_id:6,clinica_id:72});await assert.rejects(execute(stale),{code:'FOLLOWUP_PATIENT_GUARD_CHANGED'});assert.equal(await db.PatientFollowUp.count({where:{patient_id:6}}),0);
  report.checks.push('membership drift is revalidated under the same transaction before any row creation');
  const badSource={...records[6],provenance:{...records[6].provenance,row_sha256:'f'.repeat(64)}};assert.throws(()=>proof.verifyRecords([badSource]),{code:'FOLLOWUP_SOURCE_ROW_CONTENT_CHANGED'});
  const badBody={...records[6],payload:{...records[6].payload,clinical_notes:'Texto distinto con metadatos originales'}};assert.throws(()=>proof.verifyRecords([badBody]),{code:'FOLLOWUP_SOURCE_ROW_CONTENT_CHANGED'});
  const forgedDecision={...fresh.operations[0],decision:{clinic_id:66,rule:'single_prior_documented_clinic',evidence:[]}};
  assert.throws(()=>proof.verifyOperation(forgedDecision,{...stale.patient_guards, ...{patients:[{id_paciente:2,clinica_id:66}],memberships:[{paciente_id:2,clinica_id:66}],identities:[{paciente_id:2,source_contact_id:'102',history_number:'202'}]}}),{code:'FOLLOWUP_SOURCE_CLINIC_DECISION_CHANGED'});
  const badManifest={...records[6],provenance:{...records[6].provenance,file_sha256:'e'.repeat(64)}};assert.throws(()=>c.prepare({records:[badManifest],live:{database_identity:stale.database_identity},sourceFiles}),{code:'FOLLOWUP_RECORD_FILE_NOT_IN_MANIFEST'});
  report.checks.push('real CSV source proof rejects fabricated row hash and record outside source manifest');
  await assert.rejects(execute(fresh,{getDatabaseIdentity:async()=>({...fresh.database_identity,server_uuid:'00000000-0000-0000-0000-000000000001'})}),{code:'FOLLOWUP_DATABASE_IDENTITY_CHANGED'});
  report.checks.push('same target name with another physical server UUID is rejected before mutation');
  const source8=await db.PatientCustomField.findOne({where:{paciente_id:8}}),originalSource8=source8.value;
  await source8.update({value:JSON.stringify({contact:{idContacto:'108',num:'208'}})});
  const invalidIdentity=await identity([8]);assert.equal(invalidIdentity.identities[0].source_snapshot_valid,0);
  assert.throws(()=>c.validateIdentity({patient_id:8,source_contact_id:'108',history_number:'208'},invalidIdentity),{code:'FOLLOWUP_SOURCE_IDENTITY_CHANGED'});
  await source8.update({value:originalSource8});
  report.checks.push('canonical source JSON with missing account/version fails closed rather than accepting SQL NULL');
  await service.create({clinicId:66,patientIdentifier:'8',actorId:1,payload:{operational_reason:'Mes nativo ficticio',clinical_target_month:'2027-02',contact_due_date:'2027-01-15',reminder_advance_days:null}});
  const native=(await service.list({clinicId:66,patientIdentifier:'8'})).items[0];assert.equal(native.clinical_target_precision,'month');assert.equal(native.clinical_target_date,null);assert.equal(native.clinical_target_month,'2027-02');
  await assert.rejects(migration.down(sql.getQueryInterface()),/historia/);assert.equal((await sql.getQueryInterface().describeTable('PatientFollowUps')).clinical_target_month.type,'VARCHAR(7)');
  report.checks.push('native service DTO reports month precision and down refuses deleting populated monthly history');
  const override=require('../../lib/cliniccloud-import/followup-clinic-override');
  await db.PacienteClinica.create({paciente_id:8,clinica_id:72});
  const unknownLive=await snapshot([records[8]]);
  assert.equal(proof.decisionsFor([records[8]],unknownLive)[0].action,'review');
  const document={version:override.VERSION,source_account:'cliniccloud-5880',target_clinic_id:66,scope:'unresolved_origin_only',
    authorization_kind:'explicit_user_instruction',authorized_by:'Operador ficticio',authorization_reference:'qa-instruction',
    instruction:'Asignar los orígenes indeterminados a Capilar',recorded_at:'2026-11-18T14:00:00Z',preserve_known_medical:true,
    preserve_contact_dates:true,keep_notifications_off:true,historical_origin_known:false,
    source_manifest_sha256:override.sourceManifestHash(sourceFiles),source_keys:[c.normalizedRecord(records[8]).source_key]};
  const authorizationPath=path.join(dir,'administrative-authorization.json'),authorizationBytes=Buffer.from(JSON.stringify(document));
  fs.writeFileSync(authorizationPath,authorizationBytes,{mode:0o600});
  const overrideFiles=[...sourceFiles,{role:override.ROLE,path:authorizationPath,sha256:hash(authorizationBytes)}];
  const overrideProof=createSourceProof({sourceFiles:overrideFiles,readAlerts:()=>({file:{sha256:emptyHash},rows:[]})});
  overrideProof.verifyRecords(records);
  assert.throws(()=>overrideProof.verifyRecords([records[9]]),{code:'FOLLOWUP_OVERRIDE_SOURCE_NOT_IN_BATCH'});
  const overridePlan=c.prepare({records:[records[8]],decisions:overrideProof.decisionsFor([records[8]],unknownLive),sourceFiles:overrideFiles,live:unknownLive,target:'dev'});
  assert.equal(overridePlan.operations[0].decision.rule,override.RULE);
  const executeOverride=()=>execute(overridePlan,{verifyOperation:overrideProof.verifyOperation});
  await executeOverride();const overridden=await db.PatientFollowUp.findOne({where:{source_key:c.normalizedRecord(records[8]).source_key}});
  const overrideAudit=await db.PatientFollowUpRevision.findOne({where:{follow_up_id:overridden.id,version_number:1}});
  assert.equal(overrideAudit.snapshot.import_reconciliation.decision.administrative_authorization.historical_origin_known,false);
  assert.equal(overrideAudit.snapshot.import_reconciliation.decision.administrative_authorization.file_sha256,hash(authorizationBytes));
  assert.equal(overridden.clinic_id,66);assert.equal(overridden.status,'pending');assert.equal(overridden.notice_enabled,false);
  assert.equal((await executeOverride()).outcomes[0].action,'preserved_existing');
  assert.equal(await db.PatientFollowUpRevision.count({where:{follow_up_id:overridden.id}}),1);
  const changedAuthorization=Buffer.from(JSON.stringify({...document,authorization_kind:'inferred'}));fs.writeFileSync(authorizationPath,changedAuthorization);
  assert.throws(()=>createSourceProof({sourceFiles:overrideFiles,readAlerts:()=>({file:{sha256:emptyHash},rows:[]})}),{code:'FOLLOWUP_OVERRIDE_FILE_CHANGED'});
  report.checks.push('explicit administrative source-bound authorization imports unknown origins with immutable audit and idempotent replay, rejecting changed proof');
  const contradiction=await prepare([records[9]]);assert.equal(contradiction.operations[0].inference.reason,'TARGET_MONTH_BEFORE_CONTACT');
  await execute(contradiction);const undated=await db.PatientFollowUp.findOne({where:{patient_id:9}});
  assert.equal(undated.status,'pending');assert.equal(undated.clinical_target_month,null);assert.equal(undated.clinical_target_date,null);
  assert.equal(undated.contact_due_date,'2026-12-07');assert.equal(undated.notice_enabled,false);
  const undatedAudit=await db.PatientFollowUpRevision.findOne({where:{follow_up_id:undated.id}});
  assert.equal(undatedAudit.snapshot.import_reconciliation.inference.reason,'TARGET_MONTH_BEFORE_CONTACT');
  const undatedDto=(await service.get({id:undated.public_id,clinicId:66,includeClinical:false})).item;
  assert.equal(undatedDto.clinical_target_review_reason,'TARGET_MONTH_BEFORE_CONTACT');assert.equal(undatedDto.clinical_notes,null);
  assert.throws(()=>proof.verifyOperation({...contradiction.operations[0],inference:{month:'2026-12',reason:'EXPLICIT_TARGET_MONTH_YEAR'}},{}),{code:'FOLLOWUP_SOURCE_TARGET_CHANGED'});
  const corrected=(await service.update({id:undated.public_id,clinicId:66,actorId:1,payload:{expected_version:1,clinical_target_month:'2027-12'}})).item;
  assert.equal(corrected.clinical_target_review_reason,null);
  report.checks.push('contradictory source year stays unaltered and pending without fabricated month or active notice');
  await db.Paciente.update({clinica_id:72},{where:{id_paciente:10}});await db.PacienteClinica.destroy({where:{paciente_id:10}});
  await db.PacienteClinica.create({paciente_id:10,clinica_id:72});
  const scopeDocument={version:override.SCOPE_VERSION,source_account:'cliniccloud-5880',authorized_clinic_ids:[66,72],
    authorization_kind:'clarification_of_existing_user_authorization',authorized_by:'Operador ficticio',recorded_by:'Coordinador QA',
    authorization_reference:'qa-bs-scope',instruction:'Completar en la clínica acreditada o exclusiva, sin cambiar vínculos',recorded_at:'2026-11-18T14:00:00Z',
    preserve_known_medical:true,preserve_primary_clinics_and_memberships:true,preserve_contact_dates_and_states:true,keep_notifications_off:true,
    unknown_shared_target_clinic_id:66,unknown_exclusive_uses_current_clinic:true,historical_origin_known:false,source_manifest_sha256:override.sourceManifestHash(sourceFiles)};
  const scopePath=path.join(dir,'batch-scope.json'),scopeBytes=Buffer.from(JSON.stringify(scopeDocument));fs.writeFileSync(scopePath,scopeBytes,{mode:0o600});
  const medicalFiles=[...sourceFiles,{role:override.SCOPE_ROLE,path:scopePath,sha256:hash(scopeBytes)}];
  const medicalProof=createSourceProof({sourceFiles:medicalFiles,readAlerts:()=>({file:{sha256:emptyHash},rows:[]})});
  const medicalLive=await snapshot([records[10]]),medicalDecision=medicalProof.decisionsFor([records[10]],medicalLive);
  const medicalPlan=c.prepare({records:[records[10]],decisions:medicalDecision,live:medicalLive,sourceFiles:medicalFiles,target:'dev',authorizedClinicIds:[66,72]});
  assert.equal(medicalPlan.operations[0].decision.rule,override.MEDICAL_RULE);
  const membershipBefore=await db.PacienteClinica.findAll({where:{paciente_id:10},raw:true});
  await execute(medicalPlan,{verifyOperation:medicalProof.verifyOperation});
  assert.equal((await db.PatientFollowUp.findOne({where:{patient_id:10}})).clinic_id,72);
  assert.equal((await db.Paciente.findByPk(10)).clinica_id,72);
  assert.deepEqual(await db.PacienteClinica.findAll({where:{paciente_id:10},raw:true}),membershipBefore);
  assert.equal((await execute(medicalPlan,{verifyOperation:medicalProof.verifyOperation})).outcomes[0].action,'preserved_existing');
  report.checks.push('Medical-exclusive administrative assignment preserves primary clinic and all memberships, requires source-bound scope and replays safely');
  const dates=require('../../lib/cliniccloud-import/followup-date-reconciliation');
  const oldFile=sourceFiles.find(f=>f.role==='aviso_1.csv'),oldRow=readCsv(oldFile.path,oldFile.role).rows[0],dateRaw=records[11];
  const dateDocument={version:dates.VERSION,rule:dates.RULE,source_account:'cliniccloud-5880',
    authorization_kind:'explicit_operator_resolution_for_authorized_import',authorized_by:'Operador ficticio',recorded_by:'Coordinador QA',
    authorization_reference:'qa-date-resolution',recorded_at:'2026-11-18T14:00:00Z',patient_id:11,source_contact_id:'111',history_number:'211',
    body_sha256:hash(require('../../lib/cliniccloud-import/adapter').norm(dateBody)),selected:{provenance:dateRaw.provenance,contact_due_date:'2026-12-07',status:'closed'},
    historical:{provenance:{file_sha256:oldFile.sha256,source_row:oldRow.source_row,row_sha256:hash(oldRow.values)},source_external_id:'999',contact_due_date:'2026-12-01',state_raw:'1'},
    alias_source_key:c.normalizedRecord(dateRaw).source_key,chosen_source:'newer_export',keep_notifications_off:true,preserve_primary_clinics_and_memberships:true,
    source_manifest_sha256:override.sourceManifestHash(sourceFiles)};
  const datePath=path.join(dir,'date-resolution.json'),dateBytes=Buffer.from(JSON.stringify(dateDocument));fs.writeFileSync(datePath,dateBytes,{mode:0o600});
  const dateFile={role:dates.ROLE,path:datePath,sha256:hash(dateBytes)},dateFiles=[...sourceFiles,dateFile];
  const dateAuthority=dates.validateDocument({document:dateDocument,file:dateFile,sourceFiles:dateFiles,sourceManifestHash:override.sourceManifestHash});
  const dateRecord={...dateRaw,source_external_id:'999',contact_date_reconciliation:dateAuthority};
  const dateProof=createSourceProof({sourceFiles:dateFiles,readAlerts:()=>({file:{sha256:emptyHash},rows:[]})});
  dateProof.verifyRecords([dateRecord]);const dateLive=await snapshot([dateRecord]);
  const datePlan=c.prepare({records:[dateRecord],decisions:dateProof.decisionsFor([dateRecord],dateLive),sourceFiles:dateFiles,live:dateLive,target:'dev'});
  const aliasCreated=await importLegacy(dateRaw),aliasRow=await db.PatientFollowUp.findOne({where:{public_id:aliasCreated.item.id}});
  await assert.rejects(execute(datePlan,{verifyOperation:dateProof.verifyOperation}),{code:'FOLLOWUP_ALIAS_SOURCE_ALREADY_EXISTS'});
  assert.equal(await db.PatientFollowUp.count({where:{source_reference:'alert:999'}}),0);
  await db.PatientFollowUpRevision.destroy({where:{follow_up_id:aliasRow.id}});await aliasRow.destroy();
  await execute(datePlan,{verifyOperation:dateProof.verifyOperation});
  const reconciled=await db.PatientFollowUp.findOne({where:{patient_id:11}}),reconciledAudit=await db.PatientFollowUpRevision.findOne({where:{follow_up_id:reconciled.id}});
  assert.equal(reconciled.source_reference,'alert:999');assert.equal(reconciled.source_date,'2026-12-07');assert.equal(reconciled.contact_due_date,'2026-12-07');
  assert.equal(reconciled.status,'closed');assert.equal(reconciled.notice_enabled,false);assert.equal(reconciled.clinical_target_month,null);
  assert.equal(reconciledAudit.snapshot.import_reconciliation.source_entry.historical.contact_due_date,'2026-12-01');
  assert.equal(reconciledAudit.snapshot.import_reconciliation.source_entry.historical.source_external_id,'999');
  assert.deepEqual(reconciledAudit.snapshot.import_reconciliation.source_entry.alias_source_keys,[c.normalizedRecord(dateRaw).source_key]);
  assert.equal((await execute(datePlan,{verifyOperation:dateProof.verifyOperation})).outcomes[0].action,'preserved_existing');
  assert.equal(await db.PatientFollowUpRevision.count({where:{follow_up_id:reconciled.id}}),1);
  const badDate={...dateRecord,contact_date_reconciliation:{...dateAuthority,historical:{...dateAuthority.historical,contact_due_date:'2026-12-02'}}};
  assert.throws(()=>dateProof.verifyRecords([badDate]),{code:'FOLLOWUP_DATE_RECONCILIATION_RECORD_CHANGED'});
  const duplicateHistory={...csv('duplicated-history.csv',['idAviso','idEntidad','detalles','fecha','estado'],
    [['999','111',dateBody,'2026-12-01 09:30:00','1'],['999','111',dateBody,'2026-12-01 09:30:00','1']]),role:'aviso_1.csv'};
  const duplicateBase=sourceFiles.map(f=>f.role==='aviso_1.csv'?duplicateHistory:f);
  const duplicateDocument={...dateDocument,historical:{...dateDocument.historical,provenance:{...dateDocument.historical.provenance,file_sha256:duplicateHistory.sha256}},
    source_manifest_sha256:override.sourceManifestHash(duplicateBase)};
  const duplicatePath=path.join(dir,'duplicated-date-resolution.json'),duplicateBytes=Buffer.from(JSON.stringify(duplicateDocument));fs.writeFileSync(duplicatePath,duplicateBytes,{mode:0o600});
  assert.throws(()=>createSourceProof({sourceFiles:[...duplicateBase,{role:dates.ROLE,path:duplicatePath,sha256:hash(duplicateBytes)}],
    readAlerts:()=>({file:{sha256:emptyHash},rows:[]})}),{code:'FOLLOWUP_DATE_RECONCILIATION_SOURCE_NOT_UNIQUE'});
  report.checks.push('changed export date resolves one closed historical alert with both source rows, alias collision protection, canonical ID and idempotent replay');
},{performanceSchema:false}).catch(error=>{console.error(error.code||error.message);process.exitCode=1});
