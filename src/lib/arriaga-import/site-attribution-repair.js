'use strict';
// Operator-only correction of a derived import attribution. Never loads models,
// workers, messaging code or a provider. Source files/row hashes remain intact.
const crypto=require('node:crypto');
const original=require('./store');
const VERSION='arriaga-site-attribution-repair/1';
const BUNDLE='e8dad996b869e524dc42eb97c0685dc48693557f90277932a08a044d7c084b41';
const EVENT='patient.import_site_corrected',SOURCE='arriaga_site_repair';
const instance=id=>`arriaga-excel-20261026:clinic-${id}`;
const sorted=v=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(sorted(v))).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{safeCode:code});};
const need=(yes,code)=>{if(!yes)fail(code);};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const same=(a,b)=>hash(a)===hash(b);
const n=v=>Number(v);
// Future bundle preparation must run this before signing. Existing signed
// bundles are never rewritten; the repair cohort below reads their old policy.
function deriveSiteAttributions(activity){
 const marker=label=>{const text=String(label||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();const aju=/\b(?:aju|ajuriaguerra)\b/.test(text),arenal=/\barenal\b/.test(text);return aju&&arenal?'conflict':aju?1:arenal?70:null;};
 const explicit=new Map();for(const r of activity){need(typeof r.canonical_key==='string','ARRIAGA_REPAIR_PERSON_KEY');if(!explicit.has(r.canonical_key))explicit.set(r.canonical_key,new Set());const site=marker(r.service_label);if(site)explicit.get(r.canonical_key).add(site);}
 return activity.map(r=>{const site=marker(r.service_label),sites=explicit.get(r.canonical_key);
  if(site==='conflict')return{...r,site_attribution_review:true};
  if(site)return{...r,clinic_id:site,clinic_assignment:site===1?'explicit_aju':'explicit_arenal'};
  if(sites.size===1&&sites.has(1))return{...r,clinic_id:1,clinic_assignment:'inherited_explicit_aju'};
  return{...r,clinic_id:70,clinic_assignment:'default_arenal',...(sites.size>1?{site_attribution_review:true}:{})};
 });
}
const DEPENDENCIES=Object.freeze([
 ['CitasPacientes','paciente_id','clinica_id','native'],
 ['EconomicBudgets','patient_id','clinic_id','native'],['EconomicPayments','patient_id','clinic_id','native'],
 ['PatientVouchers','patient_id','clinic_id','native'],['PatientFiscalDocuments','patient_id','clinic_id','native'],
 ['PatientWalletEntries','patient_id','clinic_id','native'],['AppointmentClinicalReports','patient_id','clinic_id','native'],
 ['PatientConsentDocuments','paciente_id','clinica_id','native'],['PatientFollowUps','patient_id','clinic_id','native'],
 ['Conversations','patient_id','clinic_id','history'],['MarketingPatientListItems','paciente_id','clinica_id','history'],
 ['MarketingContactOptOuts','paciente_id','clinica_id','history'],
 ...['ClinicalPrivateAssets','ClinicalDrawings','ClinicalPhotoPairs','ClinicalAttachmentLibraryStates','ClinicalEpisodeAppointments',
  'ClinicalEpisodeStockConsumptions','DentalPlans','DentalSupportingTools','PatientDirectionAssignments','PatientNutritionMeasurements',
  'PatientNutritionReports','PatientIntakeRequests','AccountingSepaMandates','EconomicFundingParts','EconomicFiscalCoverages',
  'EconomicFiscalCommands','EconomicBudgetSignatureRequests','EconomicConceptAdjustments'].map(table=>[table,'patient_id','clinic_id','native']),
 ['PatientConsentExternalAttestations','paciente_id','clinica_id','native'],['ConsentSignaturePackages','paciente_id','clinica_id','native'],
]);
function cohort(bundle){
 original.validateBundle(bundle);need(bundle.sha256===BUNDLE,'ARRIAGA_REPAIR_APPROVED_BUNDLE_REQUIRED');
 const byPatient=new Map(bundle.patients.map(p=>[p.canonical_key,{patient:p,activity:[]} ]));
 for(const r of bundle.activity)byPatient.get(r.canonical_key).activity.push(r);
 const candidates=[],ambiguous=[];
 for(const [key,item]of byPatient){
  const explicit=new Set(item.activity.filter(r=>['explicit_aju','explicit_arenal'].includes(r.clinic_assignment)).map(r=>r.clinic_id));
  const defaults=item.activity.filter(r=>r.clinic_assignment==='default_arenal');
  if(explicit.has(1)&&explicit.has(70)&&defaults.length)ambiguous.push({canonicalKey:key,sourceRecordKeys:defaults.map(r=>r.source_activity_key)});
  if(explicit.size===1&&explicit.has(1)&&defaults.length)candidates.push({...item,canonicalKey:key,defaults,supportingKeys:item.activity.filter(r=>r.clinic_assignment==='explicit_aju').map(r=>r.source_activity_key).sort()});
 }
 return{candidates,ambiguous};
}
function correctedEnvelope(before,record,supportingKeys){
 const e=JSON.parse(JSON.stringify(parse(before)));
 e.clinic_id=1;e.source_instance=instance(1);e.record.site_assignment='inherited_explicit_aju';
 e.attribution_correction={version:VERSION,reason:'unique_explicit_aju_in_patient_source',original_clinic_id:70,
  original_identity_id:n(record.identity_id),original_source_instance:instance(70),original_site_assignment:'default_arenal',
  supporting_source_keys:supportingKeys,correction_key:hash(`${VERSION}:${BUNDLE}:${record.source_key}:70:1`)};
 return JSON.stringify(e);
}
async function capture(connection,bundle,{lock=false}={}){
 const scope=cohort(bundle),sourceRows=scope.candidates.flatMap(p=>p.patient.source_rows.map(r=>`master-row-${r}`));
 const q=async(sql,values=[])=>{const[r]=await connection.query(sql,values);return r;},s=lock?' FOR UPDATE':'';
 const clinics=await q('SELECT id_clinica,nombre_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN(1,70) ORDER BY id_clinica'+s);
 need(clinics.length===2&&clinics.every(c=>n(c.grupoClinicaId)===28),'ARRIAGA_REPAIR_CLINIC_SCOPE');
 const identities=await q('SELECT * FROM PatientImportedIdentities WHERE source_system=? AND source_instance IN (?,?) AND bundle_sha256=? AND source_patient_id IN (?) ORDER BY id'+s,['arriaga_excel',instance(1),instance(70),BUNDLE,sourceRows]);
 const catalogs=identities.length?await q('SELECT * FROM ImportedClinicalCatalogs WHERE id IN (?) ORDER BY id'+s,[[...new Set(identities.map(i=>n(i.catalog_id)))]]):[];
 const ids=[...new Set(identities.map(i=>n(i.patient_id)))].sort((a,b)=>a-b);need(ids.length>0,'ARRIAGA_REPAIR_IDENTITIES_MISSING');
 const patients=await q('SELECT id_paciente,public_id,clinica_id,numero_historia,historia_scope,updatedAt FROM Pacientes WHERE id_paciente IN (?) ORDER BY id_paciente'+s,[ids]);
 const memberships=await q('SELECT * FROM PacienteClinicas WHERE paciente_id IN (?) ORDER BY id'+s,[ids]);
 const records=await q('SELECT * FROM PatientImportedSourceRecords WHERE patient_id IN (?) ORDER BY id'+s,[ids]);
 const events=await q('SELECT * FROM PatientOperationalEvents WHERE patient_id IN (?) AND event_type=? AND source=? ORDER BY id'+s,[ids,EVENT,SOURCE]);
 const tables=[...DEPENDENCIES.map(d=>d[0]),'PatientOperationalEvents'];
 const columns=await q('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION',[tables]);
 const deps=[];
 for(const[table,patient,clinic,kind]of DEPENDENCIES){
  const cols=columns.filter(c=>c.TABLE_NAME===table).map(c=>c.COLUMN_NAME);if(!cols.length)continue;
  need(cols.includes(patient)&&cols.includes(clinic),'ARRIAGA_REPAIR_DEPENDENCY_SCHEMA');
  for(const row of await q(`SELECT ${patient} patient_id,COUNT(*) row_count FROM ${table} WHERE ${patient} IN (?) AND ${clinic}=70 GROUP BY ${patient} ORDER BY ${patient}`,[ids]))deps.push({table,kind,patient_id:n(row.patient_id),count:n(row.row_count)});
 }
 for(const row of await q('SELECT patient_id,COUNT(*) row_count FROM PatientOperationalEvents WHERE patient_id IN (?) AND clinic_id=70 AND event_type NOT IN (?,?) GROUP BY patient_id ORDER BY patient_id',[ids,'patient.imported',EVENT]))deps.push({table:'PatientOperationalEvents',kind:'history',patient_id:n(row.patient_id),count:n(row.row_count)});
 return{clinics,patients,memberships,identities,catalogs,records,events,dependencies:deps,dependencyTables:[...new Set(columns.map(c=>c.TABLE_NAME))].sort()};
}
function planRepair(bundle,snapshot,{actorId=1}={}){
 need(Number.isSafeInteger(actorId)&&actorId>0,'ARRIAGA_REPAIR_ACTOR_REQUIRED');
 const scoped=cohort(bundle),identity=new Map(snapshot.identities.map(i=>[`${i.patient_id}:${i.source_patient_id}:${i.clinic_id}`,i]));
 const byKey=new Map(snapshot.records.map(r=>[r.source_key,r])),records=[],patients=[],review=[];
 for(const candidate of scoped.candidates){
  const owners=new Set(snapshot.identities.filter(i=>candidate.patient.source_rows.some(r=>i.source_patient_id===`master-row-${r}`)).map(i=>n(i.patient_id)));
  need(owners.size===1,'ARRIAGA_REPAIR_PATIENT_IDENTITY_CONFLICT');const patientId=[...owners][0];
  const patient=snapshot.patients.find(p=>n(p.id_paciente)===patientId);need(patient,'ARRIAGA_REPAIR_PATIENT_MISSING');
  need(patient.public_id===original.publicId(candidate.canonicalKey)&&patient.historia_scope==='group:28','ARRIAGA_REPAIR_PATIENT_BINDING');
  const ownMembers=snapshot.memberships.filter(m=>n(m.paciente_id)===patientId),ajuMembers=ownMembers.filter(m=>n(m.clinica_id)===1),arenalMembers=ownMembers.filter(m=>n(m.clinica_id)===70);
  need(ajuMembers.length===1&&arenalMembers.length<=1,'ARRIAGA_REPAIR_MEMBERSHIP_CONFLICT');
  for(const support of candidate.activity.filter(r=>r.clinic_assignment==='explicit_aju')){
   const row=byKey.get(support.source_activity_key),supportIdentity=identity.get(`${patientId}:master-row-${support.master_source_row}:1`);
   need(row&&supportIdentity&&n(row.patient_id)===patientId&&n(row.clinic_id)===1&&n(row.identity_id)===n(supportIdentity.id)
    &&row.source_database===support.source_file&&row.source_table===support.source_sheet&&row.row_sha256===support.source.row_content_sha256
    &&row.database_sha256===support.source_sha256&&row.bundle_sha256===BUNDLE
    &&same(parse(row.record_json),{...original.cleanRecord(support),bundle_sha256:BUNDLE}),'ARRIAGA_REPAIR_SUPPORTING_AJU_CHANGED');
  }
  const desired=[];
  for(const source of candidate.defaults){
   const record=byKey.get(source.source_activity_key);need(record&&n(record.patient_id)===patientId,'ARRIAGA_REPAIR_RECORD_OWNER');
   const sourceId=`master-row-${source.master_source_row}`,oldIdentity=identity.get(`${patientId}:${sourceId}:70`),newIdentity=identity.get(`${patientId}:${sourceId}:1`);
   need(oldIdentity&&newIdentity,'ARRIAGA_REPAIR_TARGET_IDENTITY_REQUIRED');
   for(const item of [oldIdentity,newIdentity]){
    const catalog=snapshot.catalogs.find(c=>n(c.id)===n(item.catalog_id));
    need(catalog&&n(catalog.clinic_id)===n(item.clinic_id)&&catalog.source_system==='arriaga_excel'&&catalog.source_instance===instance(n(item.clinic_id))&&catalog.bundle_sha256===BUNDLE,'ARRIAGA_REPAIR_IDENTITY_CATALOG_BINDING');
   }
   const e=parse(record.record_json);
   need(record.row_sha256===source.source.row_content_sha256&&record.database_sha256===source.source_sha256&&record.bundle_sha256===BUNDLE
    &&record.source_database===source.source_file&&record.source_table===source.source_sheet&&(record.record_date instanceof Date?record.record_date.toISOString():String(record.record_date)).slice(0,10)===source.record_date,'ARRIAGA_REPAIR_SOURCE_PROOF_CHANGED');
   const correctionKey=hash(`${VERSION}:${BUNDLE}:${record.source_key}:70:1`);
   const originalEnvelope={...original.cleanRecord(source),bundle_sha256:BUNDLE};
   if(n(record.clinic_id)===1){
    need(n(record.identity_id)===n(newIdentity.id)&&e.clinic_id===1&&e.source_instance===instance(1)&&e.record?.site_assignment==='inherited_explicit_aju'
     &&e.attribution_correction?.version===VERSION&&e.attribution_correction.correction_key===correctionKey
     &&snapshot.events.some(event=>{const m=parse(event.metadata);return n(event.patient_id)===patientId&&m.version===VERSION&&m.record_corrections?.some(r=>r.correction_key===correctionKey&&n(r.source_record_id)===n(record.id));}),'ARRIAGA_REPAIR_UNAUDITED_CORRECTION');
    need(same(e,parse(correctedEnvelope(originalEnvelope,{...record,identity_id:n(oldIdentity.id)},candidate.supportingKeys))),'ARRIAGA_REPAIR_CORRECTED_ENVELOPE_DRIFT');
    desired.push(n(record.id));continue;
   }
   need(n(record.clinic_id)===70&&n(record.identity_id)===n(oldIdentity.id)&&e.clinic_id===70&&e.source_instance===instance(70)&&e.source_patient_id===sourceId&&e.record?.site_assignment==='default_arenal'
    &&e.source_key===record.source_key&&e.row_sha256===record.row_sha256&&!e.attribution_correction,'ARRIAGA_REPAIR_ATTRIBUTION_DRIFT');
   need(same(e,originalEnvelope),'ARRIAGA_REPAIR_ORIGINAL_ENVELOPE_DRIFT');
   const after={...record,clinic_id:1,identity_id:n(newIdentity.id),record_json:correctedEnvelope(record.record_json,record,candidate.supportingKeys)};
   records.push({patientId,sourceRecordId:n(record.id),correctionKey,before:record,after});desired.push(n(record.id));
  }
  const native=snapshot.dependencies.filter(d=>d.patient_id===patientId&&d.kind==='native');
  const otherArenal=snapshot.records.filter(r=>n(r.patient_id)===patientId&&n(r.clinic_id)===70&&!desired.includes(n(r.id)));
  const history=snapshot.dependencies.filter(d=>d.patient_id===patientId&&d.kind==='history');
  const retainReasons=[...native,...history].map(d=>`${d.table}:${d.count}`);if(otherArenal.length)retainReasons.push(`other_imported_records:${otherArenal.length}`);
  const outsidePrimary=ownMembers.some(m=>![1,70].includes(n(m.clinica_id))&&n(m.es_principal)===1)||![1,70].includes(n(patient.clinica_id));
  const primaryReview=native.length>0||otherArenal.length>0||outsidePrimary;
  if(primaryReview)review.push({patientId,reason:'independent_arenal_or_other_primary_requires_review',evidence:retainReasons});
  const targetPrimary=primaryReview?n(patient.clinica_id):1;
  const memberAfter=ownMembers.filter(m=>n(m.clinica_id)!==70||retainReasons.length>0||primaryReview).map(m=>({...m,...(!primaryReview&&[1,70].includes(n(m.clinica_id))?{es_principal:n(m.clinica_id)===1?1:0}:{})}));
  patients.push({patientId,canonicalKey:candidate.canonicalKey,sourceRecordIds:desired,fromPrimaryClinicId:n(patient.clinica_id),toPrimaryClinicId:targetPrimary,
   primaryReview,retainedArenalMembership:memberAfter.some(m=>n(m.clinica_id)===70),retainReasons,before:patient,after:{...patient,clinica_id:targetPrimary},membersBefore:ownMembers,membersAfter:memberAfter});
 }
 const body={version:VERSION,bundleSha256:BUNDLE,actorId,policy:{uniqueExplicitAjuInherits:true,bothExplicitPreserveAndReview:true,noExplicitDefaultsToArenal:true,preserveOriginalIdentitiesAndHolds:true,preserveAllSentSnapshots:true},beforeSha256:hash(snapshot),before:snapshot,recordCorrections:records,patientCorrections:patients,review,ambiguous:scoped.ambiguous,
  summary:{cohortPatients:patients.length,recordsToMove:records.length,primaryChanges:patients.filter(p=>p.fromPrimaryClinicId!==p.toPrimaryClinicId).length,memberships70Retained:patients.filter(p=>p.retainedArenalMembership).length,memberships70Removed:patients.filter(p=>p.membersBefore.some(m=>n(m.clinica_id)===70)&&!p.retainedArenalMembership).length,review:review.length,ambiguous:scoped.ambiguous.length}};
 return{...body,planSha256:hash(body)};
}
function validatePlan(plan){const{planSha256,...body}=plan;need(plan.version===VERSION&&plan.bundleSha256===BUNDLE&&hash(body)===planSha256&&hash(plan.before)===plan.beforeSha256,'ARRIAGA_REPAIR_PLAN_INVALID');return plan;}
function withoutTimestamps(row){const copy={...row};delete copy.updatedAt;delete copy.updated_at;return copy;}
function verifyState(plan,state){
 validatePlan(plan);const byId=new Map(state.records.map(r=>[n(r.id),r])),byPatient=new Map(state.patients.map(p=>[n(p.id_paciente),p]));
 for(const r of plan.recordCorrections)need(same(byId.get(r.sourceRecordId),r.after),'ARRIAGA_REPAIR_AFTER_RECORD_DRIFT');
 for(const p of plan.patientCorrections){
  need(same(withoutTimestamps(byPatient.get(p.patientId)),withoutTimestamps(p.after)),'ARRIAGA_REPAIR_AFTER_PATIENT_DRIFT');
  const members=state.memberships.filter(m=>n(m.paciente_id)===p.patientId).map(withoutTimestamps),expected=p.membersAfter.map(withoutTimestamps);
  need(same(members,expected),'ARRIAGA_REPAIR_AFTER_MEMBERSHIP_DRIFT');
 }
 need(same(state.identities,plan.before.identities),'ARRIAGA_REPAIR_IDENTITY_CHANGED');
 need(same(state.catalogs,plan.before.catalogs),'ARRIAGA_REPAIR_CATALOG_CHANGED');
 need(same(state.dependencies,plan.before.dependencies),'ARRIAGA_REPAIR_BUSINESS_DEPENDENCY_DRIFT');
 const changed=new Set(plan.recordCorrections.map(r=>r.sourceRecordId));need(same(state.records.filter(r=>!changed.has(n(r.id))),plan.before.records.filter(r=>!changed.has(n(r.id)))),'ARRIAGA_REPAIR_UNRELATED_RECORD_CHANGED');
 for(const patient of plan.patientCorrections){const changes=plan.recordCorrections.filter(r=>r.patientId===patient.patientId);if(!changes.length&&same(patient.before,patient.after)&&same(patient.membersBefore,patient.membersAfter))continue;
  need(state.events.some(e=>{const m=parse(e.metadata);return n(e.patient_id)===patient.patientId&&m.plan_sha256===plan.planSha256&&m.version===VERSION;}),'ARRIAGA_REPAIR_AUDIT_MISSING');}
 return{status:'verified',patients:plan.patientCorrections.length,records:plan.recordCorrections.length};
}
async function applyRepair(connection,{bundle,plan,beforeCommit=async()=>{}}){
 validatePlan(plan);need(bundle.sha256===plan.bundleSha256,'ARRIAGA_REPAIR_BUNDLE_CHANGED');let locked=false;
 try{
  const[[row]]=await connection.query('SELECT GET_LOCK(?,5) acquired',['cc-arriaga-site-repair:group-28']);need(n(row.acquired)===1,'ARRIAGA_REPAIR_BUSY');locked=true;
  await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await connection.beginTransaction();
  const current=await capture(connection,bundle,{lock:true});
  if(!same(current,plan.before)){
   const report=verifyState(plan,current);await connection.rollback();return{...report,status:'already_applied',planSha256:plan.planSha256,writes:0};
  }
  const at=new Date().toISOString().slice(0,19).replace('T',' ');
  for(const r of plan.recordCorrections){const[result]=await connection.query('UPDATE PatientImportedSourceRecords SET clinic_id=1,identity_id=?,record_json=? WHERE id=? AND clinic_id=70 AND identity_id=? AND BINARY record_json=BINARY ?',[r.after.identity_id,r.after.record_json,r.sourceRecordId,r.before.identity_id,r.before.record_json]);need(result.affectedRows===1,'ARRIAGA_REPAIR_RECORD_WRITE_CONFLICT');}
  for(const p of plan.patientCorrections){
   const changes=plan.recordCorrections.filter(r=>r.patientId===p.patientId),memberChange=!same(p.membersBefore,p.membersAfter),primaryChange=p.fromPrimaryClinicId!==p.toPrimaryClinicId;
   if(primaryChange){const[result]=await connection.query('UPDATE Pacientes SET clinica_id=?,updatedAt=? WHERE id_paciente=? AND clinica_id=?',[p.toPrimaryClinicId,at,p.patientId,p.fromPrimaryClinicId]);need(result.affectedRows===1,'ARRIAGA_REPAIR_PATIENT_WRITE_CONFLICT');}
   if(memberChange){const afterIds=new Set(p.membersAfter.map(m=>n(m.id)));for(const m of p.membersBefore){
    if(!afterIds.has(n(m.id))){const[result]=await connection.query('DELETE FROM PacienteClinicas WHERE id=? AND paciente_id=? AND clinica_id=70',[m.id,p.patientId]);need(result.affectedRows===1,'ARRIAGA_REPAIR_MEMBER_WRITE_CONFLICT');}
    else{const next=p.membersAfter.find(x=>n(x.id)===n(m.id));if(n(next.es_principal)!==n(m.es_principal)){const[result]=await connection.query('UPDATE PacienteClinicas SET es_principal=?,updatedAt=? WHERE id=? AND paciente_id=?',[next.es_principal,at,m.id,p.patientId]);need(result.affectedRows===1,'ARRIAGA_REPAIR_MEMBER_WRITE_CONFLICT');}}
   }}
   if(changes.length||memberChange||primaryChange){const metadata={version:VERSION,plan_sha256:plan.planSha256,bundle_sha256:BUNDLE,reason:'unique_explicit_aju_in_patient_source',original_files_unchanged:true,
    before_primary_clinic_id:p.fromPrimaryClinicId,after_primary_clinic_id:p.toPrimaryClinicId,retained_arenal_membership:p.retainedArenalMembership,retain_reasons:p.retainReasons,
    record_corrections:changes.map(r=>({source_record_id:r.sourceRecordId,correction_key:r.correctionKey,before_identity_id:r.before.identity_id,after_identity_id:r.after.identity_id,before_clinic_id:70,after_clinic_id:1,source_key:r.before.source_key,row_sha256:r.before.row_sha256,database_sha256:r.before.database_sha256,before_record_json_sha256:hash(r.before.record_json),after_record_json_sha256:hash(r.after.record_json)}))};
    await connection.query('INSERT INTO PatientOperationalEvents(patient_id,clinic_id,actor_user_id,event_type,source,metadata,occurred_at,created_at) VALUES(?,1,?,?,?,?,?,?)',[p.patientId,plan.actorId,EVENT,SOURCE,JSON.stringify(metadata),at,at]);
   }
  }
  const after=await capture(connection,bundle,{lock:true});const verified=verifyState(plan,after);
  await beforeCommit({after,verified});await connection.commit();
  return{...verified,status:'applied',planSha256:plan.planSha256,summary:plan.summary,writes:plan.recordCorrections.length};
 }catch(e){await connection.rollback().catch(()=>{});throw e;}finally{if(locked)await connection.query('SELECT RELEASE_LOCK(?) released',['cc-arriaga-site-repair:group-28']).catch(()=>{});}
}
module.exports={VERSION,BUNDLE,EVENT,SOURCE,DEPENDENCIES,hash,cohort,capture,planRepair,validatePlan,verifyState,applyRepair,correctedEnvelope,deriveSiteAttributions};
