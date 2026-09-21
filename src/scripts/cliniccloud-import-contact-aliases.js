#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash,normalizeContacts,normalizeAppointments}=require('../lib/cliniccloud-import/adapter');
const {readCsv,readBytes,parseArgs,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {validateContactAlias}=require('../lib/cliniccloud-import/contact-aliases');
const {prepareNativeCorroboration,prepareHistoryCorroboration,prepareConfirmedIdentity,preparePartialIdentityReview}=require('../lib/cliniccloud-import/contact-alias-evidence');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {createNewPatientsStore}=require('../lib/cliniccloud-import/new-patients-store');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
const VERSION='cliniccloud-contact-aliases/4';
async function run(args){
 const o=parseArgs(args,['--mode','--target','--contacts','--review','--private-output','--package','--approved-sha256','--backup-manifest','--private-journal','--appointments','--plan','--live-comparison','--live-histories','--identity-confirmation']);
 if(o['--target']!=='crm'||!['prepare','dry-run','apply'].includes(o['--mode']))throw Error('EXPLICIT_CRM_ALIAS_MODE_REQUIRED');
 if(process.cwd()!=='/home/ubuntu/wt/back-dev'||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
 const review=privateJson(o['--review']);
 if(!review.reviewed_by||!Array.isArray(review.links)||!review.links.length||review.links.length>50
   ||new Set(review.links.map(r=>r.source_contact_id)).size!==review.links.length
   ||new Set(review.links.map(r=>r.patient_id)).size!==review.links.length)throw Error('BOUNDED_EXPLICIT_ALIAS_REVIEW_REQUIRED');
 const input=readCsv(o['--contacts'],'contacts',['IDCONTACTO','NOMBRE','APELLIDOS']);
 const sourceRows=normalizeContacts(input.rows,input.file.sha256);
 const needsCurrent=review.links.some(link=>link.native_first_visit),needsHistory=review.links.some(link=>link.native_history_visit);
 const needsNative=needsCurrent||needsHistory;
 let nativeContext,histories,confirmation;
 if(review.links.some(link=>link.confirmed_identity)){
  if(!o['--identity-confirmation'])throw Error('CONTACT_ALIAS_USER_CONFIRMATION_REQUIRED');
  confirmation=privateJson(o['--identity-confirmation']);
 }
 if(needsCurrent){
  if(!o['--appointments']||!o['--plan']||!o['--live-comparison'])throw Error('CONTACT_ALIAS_NATIVE_SOURCE_FILES_REQUIRED');
  const appointmentFile=readCsv(o['--appointments'],'appointments',['IDCONTACTO','FECHA','HORA INICIO','HORA FIN']);
  nativeContext={contacts:sourceRows,appointments:normalizeAppointments(appointmentFile.rows,appointmentFile.file.sha256),
   plan:privateJson(o['--plan']),comparison:privateJson(o['--live-comparison'])};
 }
 if(needsHistory){if(!o['--live-histories'])throw Error('CONTACT_ALIAS_NATIVE_SOURCE_FILES_REQUIRED');histories=privateJson(o['--live-histories']);}
 const selected=review.links.map(link=>{
  const matches=sourceRows.filter(s=>s.source_contact_id===link.source_contact_id);
  if(matches.length!==1)throw Error('ALIAS_SOURCE_ID_NOT_UNIQUE');
  if([link.native_first_visit,link.native_history_visit,link.confirmed_identity,link.reviewed_partial_identity].filter(Boolean).length>1)throw Error('CONTACT_ALIAS_ONE_EVIDENCE_METHOD_REQUIRED');
  return {source:matches[0],patient_id:link.patient_id,...(link.reviewed_partial_identity
   ? {corroboration:preparePartialIdentityReview({link,source:matches[0],contacts:sourceRows,reviewedBy:review.reviewed_by})}
   :link.confirmed_identity
   ? {corroboration:prepareConfirmedIdentity({link,source:matches[0],confirmation})}
   :link.native_first_visit
   ? {corroboration:prepareNativeCorroboration({...nativeContext,link,source:matches[0]})}
   : link.native_history_visit?{corroboration:prepareHistoryCorroboration({link,source:matches[0],contacts:sourceRows,histories})}:{})};
 });
 let pkg,backup;
 if(o['--mode']!=='prepare'){
  pkg=privateJson(o['--package']);const {package_sha256,...body}=pkg;
  if(![VERSION,'cliniccloud-contact-aliases/3','cliniccloud-contact-aliases/2','cliniccloud-contact-aliases/1'].includes(pkg.version)||hash(body)!==package_sha256||o['--approved-sha256']!==package_sha256||pkg.target!=='crm'
    ||pkg.review_sha256!==hash(review)||pkg.contacts_sha256!==input.file.sha256||hash(pkg.selected)!==hash(selected)
    ||pkg.policy!=='add_external_alias_only_no_patient_or_history_mutation')throw Error('ALIAS_PACKAGE_REVIEW_MISMATCH');
  if(!Array.isArray(pkg.operations)||pkg.operations.length!==selected.length
    ||pkg.operations.some((op,i)=>hash({source:op.source,patient_id:op.patient_id,...(op.corroboration?{corroboration:op.corroboration}:{})})!==hash(selected[i])))throw Error('ALIAS_OPERATION_NOT_IN_REVIEWED_SOURCE');
  if(!Number.isFinite(Date.parse(pkg.created_at))||Date.parse(pkg.created_at)>Date.now()||Date.now()-Date.parse(pkg.created_at)>2*3600000)throw Error('ALIAS_PACKAGE_EXPIRED');
  const manifest=privateJson(o['--backup-manifest']);if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified)throw Error('ALIAS_VERIFIED_CRM_BACKUP_REQUIRED');
  backup=await validateBackup(o['--backup-manifest']);
 }
 const c=await connectOperatorDatabase('crm');let journal,commitAttempted=false;
 try{
  const store=await createNewPatientsStore(c,{groupId:29});
  const capture=async(lock=false)=>{
   const live=await store.captureGroup();
   if(needsNative){
    const nativeSelected=selected.filter(r=>r.corroboration?.native_appointment_id);
    const patients=nativeSelected.map(r=>r.patient_id);
    const starts=[...new Set(nativeSelected.map(r=>r.corroboration.start_utc.replace('T',' ').replace('.000Z','')))];
    [live.native_appointments]=await c.query(`SELECT id_cita,paciente_id,clinica_id,inicio,fin,estado,tipo_cita,source_system,source_reference,created_by,updated_at FROM CitasPacientes WHERE paciente_id IN (?) AND inicio IN (?) ORDER BY id_cita${lock?' FOR UPDATE':''}`,[patients,starts]);
   }
   return live;
  };
  if(o['--mode']==='prepare'){
   await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const live=await capture();
   const operations=selected.map(({source,patient_id,corroboration})=>{
    const match=validateContactAlias(source,patient_id,live,corroboration);if(match.already_linked)throw Error('ALIAS_ALREADY_LINKED_NOT_A_NEW_OPERATION');
    return {source,patient_id,...(corroboration?{corroboration}:{}),...(match.native_appointment_sha256?{native_appointment_sha256:match.native_appointment_sha256}:{}),patient_before:match.patient,patient_before_sha256:match.before_sha256,field_key:match.field_key,evidence:match.evidence};
   });await c.rollback();
   const body={version:VERSION,target:'crm',created_at:new Date().toISOString(),contacts_sha256:input.file.sha256,review_sha256:hash(review),selected,operations,policy:'add_external_alias_only_no_patient_or_history_mutation'};
   pkg={...body,package_sha256:hash(body)};writePrivateJson(o['--private-output'],pkg);
   return {status:'prepared',aliases:operations.length,patients_created:0,package_sha256:pkg.package_sha256};
  }
  const [lock]=await c.query('SELECT GET_LOCK(?,0) acquired',['cc-contact-aliases:cliniccloud-5880']);if(Number(lock[0].acquired)!==1)throw Error('ALIAS_OPERATOR_ALREADY_RUNNING');
  await acquireExecutorLocks(c,pkg.package_sha256,path.resolve(o['--private-journal']));journal=openJournal(o['--private-journal'],pkg.package_sha256);
  await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
  const ids=pkg.operations.map(op=>op.patient_id).sort((a,b)=>a-b);
  const [locked]=await c.query('SELECT id_paciente FROM Pacientes WHERE id_paciente IN (?) ORDER BY id_paciente FOR UPDATE',[ids]);
  if(locked.length!==ids.length)throw Error('ALIAS_PATIENT_DISAPPEARED');
  const [fieldsBefore]=await c.query('SELECT * FROM PatientCustomFields WHERE paciente_id IN (?) ORDER BY id FOR UPDATE',[ids]);
  const live=await capture(true);const decisions=[];
  for(const op of pkg.operations){
   const checked=validateContactAlias(op.source,op.patient_id,live,op.corroboration);
   if(op.corroboration&&checked.native_appointment_sha256!==op.native_appointment_sha256)throw Error('ALIAS_NATIVE_APPOINTMENT_STATE_DRIFT');
   if(hash(op.patient_before)!==op.patient_before_sha256||checked.before_sha256!==op.patient_before_sha256||checked.field_key!==op.field_key)throw Error('ALIAS_PATIENT_STATE_DRIFT');
   const ownField=fieldsBefore.find(f=>f.paciente_id===op.patient_id&&f.field_key===op.field_key);
   if(ownField&&(ownField.source!=='cliniccloud'||ownField.source_column!=='idContacto'||ownField.value!==op.source.source_contact_id))throw Error('ALIAS_FIELD_COLLISION');
   if(checked.already_linked&&!ownField)throw Error('ALIAS_NEWLY_LINKED_ELSEWHERE_REVIEW');
   decisions.push({...op,preserve:Boolean(ownField)});
  }
  await journal.append({stage:'prepared',operator:review.reviewed_by,backup,decisions,fields_before:fieldsBefore});
  const inserted=[];
  for(const op of decisions.filter(d=>!d.preserve)){
   const [r]=await c.query('INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,label,value,value_type,source,source_column,last_imported_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())',
    [op.patient_id,op.patient_before.clinica_id,op.field_key,'ID ClinicCloud adicional',op.source.source_contact_id,'text','cliniccloud','idContacto']);
   if(r.affectedRows!==1)throw Error('ALIAS_INSERT_COUNT_INVALID');inserted.push(Number(r.insertId));
  }
  const after=await capture();
  for(const op of decisions){const match=validateContactAlias(op.source,op.patient_id,after,op.corroboration);if(!match.already_linked||match.before_sha256!==op.patient_before_sha256
    ||(op.corroboration&&match.native_appointment_sha256!==op.native_appointment_sha256))throw Error('ALIAS_POST_WRITE_IDENTITY_DRIFT');}
  const [fieldsAfter]=await c.query('SELECT * FROM PatientCustomFields WHERE paciente_id IN (?) ORDER BY id',[ids]);
  if(hash(fieldsAfter.filter(r=>!inserted.includes(r.id)))!==hash(fieldsBefore))throw Error('ALIAS_EXISTING_FIELDS_CHANGED');
  await journal.append({stage:'written_before_commit',inserted_ids:inserted,fields_after:fieldsAfter,dry_run:o['--mode']==='dry-run'});
  if(o['--mode']==='dry-run'){
   await c.rollback();
   const [restored]=await c.query('SELECT * FROM PatientCustomFields WHERE paciente_id IN (?) ORDER BY id',[ids]);
   if(hash(restored)!==hash(fieldsBefore))throw Error('ALIAS_DRY_RUN_ROLLBACK_MISMATCH');
   const restoredLive=await capture();
   for(const op of decisions){const checked=validateContactAlias(op.source,op.patient_id,restoredLive,op.corroboration);if(checked.before_sha256!==op.patient_before_sha256||checked.already_linked!==op.preserve)throw Error('ALIAS_DRY_RUN_ROLLBACK_MISMATCH');}
   await journal.append({stage:'rolled_back_and_verified',aliases_would_create:inserted.length,patients_changed:0});
   return {status:'dry_run_rolled_back',aliases_would_create:inserted.length,aliases_created:0,patients_created:0,patient_fields_changed:0,appointments_changed:0,messages_sent:0};
  }
  commitAttempted=true;await c.commit();
  await journal.append({stage:'committed',inserted_ids:inserted,preserved:decisions.filter(d=>d.preserve).length,patient_ids:ids});
  return {status:'committed',aliases_created:inserted.length,aliases_preserved:decisions.filter(d=>d.preserve).length,patients_created:0,patient_fields_changed:0,appointments_changed:0,messages_sent:0};
 }catch(e){await c.rollback().catch(()=>{});if(commitAttempted)throw Error('ALIAS_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');throw e;}
 finally{journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'ALIAS_IMPORT_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={run};
