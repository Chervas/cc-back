'use strict';
const {randomBytes}=require('node:crypto');
const {digest,parse,rowKey,validateBundle,envelope,profileFor}=require('./bundle');
const {categoryFor}=require('../external-patient-history');
const {dateOnly}=require('../cliniccloud-patient-history');
const {allocatePatientHistoryNumber}=require('../../services/patientHistoryNumber.service');
const qFor=connection=>async(sql,args=[]) => (await connection.query(sql,args))[0];
const ownTables=['ImportedClinicalCatalogs','Pacientes','PacienteClinicas','PatientImportedIdentities','PatientImportedSourceRecords','PatientOperationalEvents','PatientHistoryCounters'];
const contact=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
function buildImportPlan(bundle,snapshot){
  validateBundle(bundle);
  if(!snapshot.clinic || Number(snapshot.clinic.id_clinica)<=0 || Number(snapshot.clinic.estado_clinica)!==1)throw Error('EURODENT_CLINIC_REQUIRED');
  const clinicId=Number(snapshot.clinic.id_clinica),operations=[];
  for(const catalog of snapshot.catalogs||[]){if(catalog.bundle_sha256===bundle.sha256&&(catalog.catalog_sha256!==digest(bundle.context)||digest(parse(catalog.context_json))!==digest(bundle.context)))throw Error('EURODENT_EXISTING_CATALOG_CHANGED');}
  for(const patient of bundle.patients){
    const profile=profileFor(patient);
    const matches=snapshot.identities.filter(i=>i.source_system==='eurodent'&&i.source_instance===bundle.source_instance&&i.source_patient_id===patient.source_patient_id);
    if(matches.length>1)throw Error('EURODENT_SOURCE_IDENTITY_AMBIGUOUS');
    const identity=matches[0];
    const base={sourcePatientId:patient.source_patient_id,recordCount:patient.records.length,profile};
    if(identity){
      if(!(snapshot.catalogs||[]).some(c=>Number(c.id)===Number(identity.catalog_id)&&c.bundle_sha256===bundle.sha256&&Number(c.clinic_id)===clinicId))throw Error('EURODENT_IDENTITY_CATALOG_MISMATCH');
      if(Number(identity.clinic_id)!==clinicId)throw Error('EURODENT_SOURCE_DESTINATION_MISMATCH');
      const existing=snapshot.patients.find(p=>Number(p.id_paciente)===Number(identity.patient_id));
      if(!existing)throw Error('EURODENT_LINKED_PATIENT_MISSING');
      const stored=snapshot.records.filter(r=>Number(r.identity_id)===Number(identity.id));
      const expected=patient.records.map(r=>({source_key:rowKey(bundle.source_instance,r),row_sha256:r.row_sha256,record_json:JSON.stringify(envelope(bundle,r,patient.source_patient_id))}));
      if(identity.bundle_sha256!==bundle.sha256||stored.length!==expected.length||expected.some(e=>!stored.some(s=>s.source_key===e.source_key&&s.row_sha256===e.row_sha256&&digest(parse(s.record_json))===digest(parse(e.record_json)))))throw Error('EURODENT_EXISTING_ARCHIVE_CHANGED');
      operations.push({...base,action:'preserve',patientId:Number(identity.patient_id),identityId:Number(identity.id)});continue;
    }
    // Contacts are evidence of a possible duplicate, never an identity key.
    const collisions=snapshot.patients.filter(p=>!p.fecha_baja&&(
      profile.dni&&contact(profile.dni)===contact(p.dni)
      ||profile.email&&contact(profile.email)===contact(p.email)
      ||[profile.telefono_movil,profile.telefono_secundario].filter(Boolean).some(phone=>[p.telefono_movil,p.telefono_secundario].some(existing=>contact(phone)&&contact(phone)===contact(existing)))
      ||contact(profile.nombre)===contact([p.nombre,p.apellidos].filter(Boolean).join(' '))));
    operations.push({...base,action:collisions.length?'review':'create',...(collisions.length?{reason:'possible_existing_identity',candidatePatientIds:collisions.map(p=>Number(p.id_paciente))}:{})});
  }
  const plan={version:'eurodent_import_plan/1',clinicId,clinicSha256:digest(snapshot.clinic),sourceInstance:bundle.source_instance,bundleSha256:bundle.sha256,
    sourceSnapshotSha256:digest({patients:snapshot.patients,memberships:snapshot.memberships,identities:snapshot.identities,records:snapshot.records,catalogs:snapshot.catalogs||[]}),operations};
  return {...plan,sha256:digest(plan),counts:operations.reduce((out,op)=>(out[op.action]=(out[op.action]||0)+1,out),{})};
}
async function captureImport(connection,{clinicId,bundle,lock=false}){
  validateBundle(bundle);const q=qFor(connection),suffix=lock?' FOR UPDATE':'';
  const clinic=(await q(`SELECT id_clinica,nombre_clinica,grupoClinicaId,estado_clinica FROM Clinicas WHERE id_clinica=?${suffix}`,[clinicId]))[0];
  if(!clinic)throw Error('EURODENT_CLINIC_NOT_FOUND');
  const identities=await q(`SELECT * FROM PatientImportedIdentities WHERE source_system='eurodent' AND source_instance=? ORDER BY id${suffix}`,[bundle.source_instance]);
  const clinicIds=Number(clinic.grupoClinicaId)>0?(await q('SELECT id_clinica FROM Clinicas WHERE grupoClinicaId=? ORDER BY id_clinica',[clinic.grupoClinicaId])).map(c=>Number(c.id_clinica)):[Number(clinicId)];
  const patients=await q(`SELECT p.* FROM Pacientes p WHERE p.clinica_id IN (?) OR EXISTS(SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id IN (?)) ORDER BY p.id_paciente${suffix}`,[clinicIds,clinicIds]);
  const memberships=await q(`SELECT * FROM PacienteClinicas WHERE clinica_id IN (?) ORDER BY paciente_id,clinica_id${suffix}`,[clinicIds]);
  const records=identities.length?await q(`SELECT * FROM PatientImportedSourceRecords WHERE identity_id IN (?) ORDER BY id${suffix}`,[identities.map(i=>i.id)]):[];
  const catalogs=await q(`SELECT * FROM ImportedClinicalCatalogs WHERE clinic_id=? AND source_system='eurodent' AND source_instance=? ORDER BY id${suffix}`,[clinicId,bundle.source_instance]);
  const snapshot={clinic,patients,memberships,identities,records,catalogs};return {...snapshot,plan:buildImportPlan(bundle,snapshot)};
}
async function applyImport(connection,{clinicId,bundle,expectedSha256,actorId,beforeCommit}){
  if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||!Number.isSafeInteger(actorId)||actorId<=0||typeof beforeCommit!=='function'||!require('../role-helpers').isGlobalAdmin(actorId))throw Error('EURODENT_REVIEWED_PLAN_AND_JOURNAL_REQUIRED');
  const q=qFor(connection),lockName=`cc-eurodent:${digest(bundle.source_instance).slice(0,40)}`;
  if(Number((await q('SELECT GET_LOCK(?,0) AS acquired',[lockName]))[0]?.acquired)!==1)throw Error('EURODENT_IMPORT_BUSY');let started=false;
  try{
    const triggers=await q('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?)',[ownTables]);
    if(triggers.length)throw Error('EURODENT_IMPORT_TRIGGERS_REQUIRE_REVIEW');
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');await connection.beginTransaction();started=true;
    if(!(await q('SELECT id_usuario FROM Usuarios WHERE id_usuario=? FOR SHARE',[actorId])).length)throw Error('EURODENT_ACTOR_NOT_PRESENT');
    const snapshot=await captureImport(connection,{clinicId,bundle,lock:true}),plan=snapshot.plan;
    if(plan.sha256!==expectedSha256)throw Error('EURODENT_PLAN_OR_TARGET_CHANGED');
    if(plan.operations.some(op=>op.action==='review'))throw Error('EURODENT_IDENTITY_REVIEW_REQUIRED');
    const historyBefore=await q('SELECT * FROM PatientHistoryCounters WHERE scope_key=? FOR UPDATE',[Number(snapshot.clinic.grupoClinicaId)>0?`group:${snapshot.clinic.grupoClinicaId}`:`clinic:${clinicId}`]);
    const created=[];let catalogId=Number(snapshot.catalogs.find(c=>c.bundle_sha256===bundle.sha256)?.id)||null;
    if(!catalogId&&plan.operations.some(op=>op.action==='create')){
      const result=await q(`INSERT INTO ImportedClinicalCatalogs (clinic_id,source_system,source_instance,bundle_sha256,source_zip_sha256,catalog_sha256,context_json,imported_at,actor_user_id) VALUES (?,'eurodent',?,?,?,?,?,UTC_TIMESTAMP(),?)`,[clinicId,bundle.source_instance,bundle.sha256,bundle.source_zip_sha256,digest(bundle.context),JSON.stringify(bundle.context),actorId]);catalogId=Number(result.insertId);
    }
    for(const operation of plan.operations.filter(op=>op.action==='create')){
      const publicId=`pac_${randomBytes(10).toString('hex')}`,p=operation.profile;
      const history=await allocatePatientHistoryNumber({query:(sql,options)=>connection.query({sql,namedPlaceholders:true},options.replacements)},clinicId,{});
      const result=await q(`INSERT INTO Pacientes (public_id,nombre,apellidos,dni,email,telefono_movil,telefono_secundario,fecha_nacimiento,direccion,codigo_postal,poblacion,provincia,profesion,clinica_id,numero_historia,historia_scope,fecha_alta,idioma_preferido,paciente_conocido,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),'es',FALSE,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[publicId,p.nombre,p.apellidos,p.dni,p.email,p.telefono_movil,p.telefono_secundario,p.fecha_nacimiento,p.direccion,p.codigo_postal,p.poblacion,p.provincia,p.profesion,clinicId,history.numero_historia,history.historia_scope]);
      const patientId=Number(result.insertId);
      await q('INSERT INTO PacienteClinicas (paciente_id,clinica_id,es_principal,createdAt,updatedAt) VALUES (?,?,TRUE,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[patientId,clinicId]);
      const identity=await q(`INSERT INTO PatientImportedIdentities (catalog_id,patient_id,clinic_id,source_system,source_instance,source_patient_id,source_history_number,bundle_sha256,messages_hold,imported_at,actor_user_id)
        VALUES (?,?,?,'eurodent',?,?,?,?,TRUE,UTC_TIMESTAMP(),?)`,[catalogId,patientId,clinicId,bundle.source_instance,operation.sourcePatientId,p.source_history_number,bundle.sha256,actorId]);
      const identityId=Number(identity.insertId),sourcePatient=bundle.patients.find(p=>p.source_patient_id===operation.sourcePatientId);
      for(const row of sourcePatient.records){
        const r=envelope(bundle,row,operation.sourcePatientId);
        await q(`INSERT INTO PatientImportedSourceRecords (identity_id,patient_id,clinic_id,source_key,source_database,source_table,category,record_date,row_sha256,database_sha256,bundle_sha256,record_json,imported_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[identityId,patientId,clinicId,rowKey(bundle.source_instance,row),row.source_database,row.source_table,categoryFor(r),row.source_table==='Paciente'?null:dateOnly(row.record.Fecha),row.row_sha256,row.database_sha256,bundle.sha256,JSON.stringify(r)]);
      }
      await q(`INSERT INTO PatientOperationalEvents (patient_id,clinic_id,actor_user_id,event_type,source,channel,metadata,occurred_at,created_at)
        VALUES (?,?,?,'patient.imported','eurodent',NULL,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[patientId,clinicId,actorId,JSON.stringify({source_instance:bundle.source_instance,bundle_sha256:bundle.sha256,source_patient_id:operation.sourcePatientId,messages_enabled:false,automation_activated:false})]);
      created.push({patientId,publicId,identityId,sourcePatientId:operation.sourcePatientId,recordCount:sourcePatient.records.length});
    }
    const after=await captureImport(connection,{clinicId,bundle});
    if(after.plan.operations.some(op=>op.action!=='preserve'))throw Error('EURODENT_POST_WRITE_VERIFICATION_FAILED');
    for(const patient of snapshot.patients){if(digest(patient)!==digest(after.patients.find(p=>Number(p.id_paciente)===Number(patient.id_paciente))))throw Error('EURODENT_EXISTING_PATIENT_CHANGED');}
    for(const membership of snapshot.memberships){if(!after.memberships.some(m=>digest(m)===digest(membership)))throw Error('EURODENT_EXISTING_MEMBERSHIP_CHANGED');}
    const result={clinicId,bundleSha256:bundle.sha256,planSha256:plan.sha256,created,preserved:plan.operations.filter(op=>op.action==='preserve').length,
      catalogId,recordCount:created.reduce((sum,p)=>sum+p.recordCount,0),historyBefore,messagesSent:0,appointmentsCreated:0,newDebt:0};
    await beforeCommit({snapshot,result,after});await connection.commit();started=false;return result;
  }finally{if(started)await connection.rollback();await q('SELECT RELEASE_LOCK(?)',[lockName]);}
}
module.exports={buildImportPlan,captureImport,applyImport};
