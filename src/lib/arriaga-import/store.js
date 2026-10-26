'use strict';

// Reviewed operator import. Does not start application models or workers.
const crypto=require('node:crypto');
const SCOPE=Object.freeze({groupId:28,clinicIds:[1,70],defaultClinicId:70,source:'arriaga_excel',instance:'arriaga-excel-20261026',historyScope:'group:28'});
const TABLES=['Pacientes','PacienteClinicas','PatientHistoryCounters','ImportedClinicalCatalogs','PatientImportedIdentities','PatientImportedSourceRecords','PatientOperationalEvents','Tratamientos'];
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const demand=(value,code)=>{if(!value)throw Object.assign(Error(code),{safeCode:code});};
const instance=id=>`${SCOPE.instance}:clinic-${id}`;
const positive=v=>/^\d+$/.test(String(v||''))&&BigInt(v)>0n;
const publicId=key=>'pac_'+digest(`${SCOPE.instance}:${key}`).slice(0,28);
const cleanRecord=r=>({version:'arriaga_patient_source_record/1',provider:SCOPE.source,source_instance:instance(r.clinic_id),source_patient_id:`master-row-${r.master_source_row}`,
  clinic_id:r.clinic_id,source_database:r.source_file,source_table:r.source_sheet,source_row:r.source_row,source_key:r.source_activity_key,
  record_date:r.record_date,category:'historical',row_sha256:r.source.row_content_sha256,database_sha256:r.source_sha256,
  record:{service_label:r.service_label,service_family:r.family,source_classification:r.classification,site_assignment:r.clinic_assignment}});

function validateBundle(bundle){
 demand(bundle?.version==='arriaga_import_bundle/1','ARRIAGA_BUNDLE_VERSION');
 demand(bundle.group_id===28&&bundle.default_clinic_id===70,'ARRIAGA_SCOPE');
 demand(Array.isArray(bundle.patients)&&bundle.patients.length>0&&Array.isArray(bundle.activity)&&Array.isArray(bundle.catalog),'ARRIAGA_BUNDLE_CONTENT');
 const people=new Set(),rows=new Map(),keys=new Set();
 for(const p of bundle.patients){
  demand(/^master-row-[1-9]\d*$/.test(p.canonical_key)&&!people.has(p.canonical_key),'ARRIAGA_PERSON_KEY');people.add(p.canonical_key);
  demand(Array.isArray(p.source_rows)&&p.source_rows.length>0&&p.source_rows.every(x=>Number.isSafeInteger(x)&&x>1),'ARRIAGA_SOURCE_ROWS');
  demand(typeof p.profile?.nombre==='string'&&p.profile.nombre.trim()&&typeof p.profile.apellidos==='string','ARRIAGA_PERSON_PROFILE');
  demand(!p.profile.notas_paciente&&!p.profile.notas_medicas&&!p.profile.antecedentes&&!p.profile.medicacion,'ARRIAGA_NO_NOTES');
  for(const n of p.source_rows){demand(!rows.has(n),'ARRIAGA_SOURCE_ROW_DUPLICATE');rows.set(n,p.canonical_key);}
 }
 for(const r of bundle.activity){
  demand(rows.has(r.master_source_row)&&r.canonical_key===rows.get(r.master_source_row),'ARRIAGA_ACTIVITY_PATIENT');
  demand(SCOPE.clinicIds.includes(r.clinic_id)&&/^\d{4}-\d{2}-\d{2}$/.test(r.record_date),'ARRIAGA_ACTIVITY_SCOPE_DATE');
  demand(/^[a-f0-9]{64}$/.test(r.source_activity_key)&&!keys.has(r.source_activity_key),'ARRIAGA_ACTIVITY_KEY');keys.add(r.source_activity_key);
  demand(r.notes_imported===false&&r.financial_state_imported===false&&r.signed_episode===false&&r.care_state==null&&r.event_time==null,'ARRIAGA_NO_INVENTED_STATE');
  demand(typeof r.service_label==='string'&&r.service_label.trim()&&r.source_row>1,'ARRIAGA_ACTIVITY_LABEL');
  const label=r.service_label.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  demand(!/\b(?:NOTAS?|AVISOS?|NO VIENE|NO ACUDE|PAGOS?|RESERVAS?|CONSENTIMIENTO)\b/.test(label),'ARRIAGA_EXCLUDED_ACTIVITY');
 }
 const catalogs=new Set();for(const t of bundle.catalog){demand(t.catalog_key&&!catalogs.has(t.catalog_key),'ARRIAGA_CATALOG_KEY');catalogs.add(t.catalog_key);demand(t.precio_base==null&&t.duracion_min==null,'ARRIAGA_NO_INVENTED_TARIFF');}
 const clone={...bundle};delete clone.sha256;demand(bundle.sha256===digest(clone),'ARRIAGA_BUNDLE_DIGEST');
 return {rows,people};
}

async function capture(connection,{lock=false}={}){
 const q=async(sql,values=[])=>{const[r]=await connection.query(sql,values);return r;};const suffix=lock?' FOR UPDATE':'';
 const clinics=await q('SELECT id_clinica,nombre_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (1,70) ORDER BY id_clinica'+suffix);
 demand(clinics.length===2&&clinics.every(c=>Number(c.grupoClinicaId)===28),'ARRIAGA_TARGET_CLINICS');
 const patients=await q('SELECT p.* FROM Pacientes p WHERE p.clinica_id IN (1,70) OR EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id IN (1,70)) ORDER BY p.id_paciente'+suffix);
 const ids=patients.map(p=>p.id_paciente);
 const memberships=ids.length?await q('SELECT * FROM PacienteClinicas WHERE paciente_id IN (?) ORDER BY id'+suffix,[ids]):[];
 const histories=await q('SELECT id_paciente,numero_historia,historia_scope FROM Pacientes WHERE historia_scope=? ORDER BY id_paciente'+suffix,[SCOPE.historyScope]);
 const counter=await q('SELECT * FROM PatientHistoryCounters WHERE scope_key=?'+suffix,[SCOPE.historyScope]);
 const catalogs=await q('SELECT * FROM ImportedClinicalCatalogs WHERE source_system=? AND source_instance IN (?,?) ORDER BY id'+suffix,[SCOPE.source,instance(1),instance(70)]);
 const identities=await q('SELECT * FROM PatientImportedIdentities WHERE source_system=? AND source_instance IN (?,?) ORDER BY id'+suffix,[SCOPE.source,instance(1),instance(70)]);
 const sourceRecords=identities.length?await q('SELECT * FROM PatientImportedSourceRecords WHERE identity_id IN (?) ORDER BY id'+suffix,[identities.map(i=>i.id)]):[];
 const treatments=await q("SELECT * FROM Tratamientos WHERE codigo LIKE 'ARR28-%' ORDER BY id_tratamiento"+suffix);
 return {clinics,patients,memberships,histories,counter,catalogs,identities,sourceRecords,treatments};
}

function planImport(bundle,snapshot){
 const {rows}=validateBundle(bundle),memberships=new Map(),identityBySource=new Map();
 const patientById=new Map(snapshot.patients.map(p=>[Number(p.id_paciente),p]));
 const membershipKeys=new Set(snapshot.memberships.map(m=>`${Number(m.paciente_id)}:${Number(m.clinica_id)}`));
 const catalogById=new Map(snapshot.catalogs.map(c=>[Number(c.id),c]));
 const identityById=new Map(snapshot.identities.map(i=>[Number(i.id),i]));
 const expectedActivities=new Map(bundle.activity.map(r=>[r.source_activity_key,r]));
 for(const i of snapshot.identities){
  const clinic=Number(i.clinic_id),owner=patientById.get(Number(i.patient_id)),catalog=catalogById.get(Number(i.catalog_id));
  demand(SCOPE.clinicIds.includes(clinic)&&i.source_instance===instance(clinic)&&i.source_system===SCOPE.source,'ARRIAGA_EXISTING_IDENTITY_SCOPE');
  demand(owner&&(Number(owner.clinica_id)===clinic||membershipKeys.has(`${Number(i.patient_id)}:${clinic}`)),'ARRIAGA_EXISTING_IDENTITY_PATIENT');
  demand(catalog&&Number(catalog.clinic_id)===clinic&&catalog.source_system===SCOPE.source&&catalog.source_instance===i.source_instance,'ARRIAGA_EXISTING_IDENTITY_CATALOG');
  identityBySource.set(`${i.source_instance}:${i.source_patient_id}`,i);
 }
 for(const record of snapshot.sourceRecords){
  const expected=expectedActivities.get(record.source_key),identity=identityById.get(Number(record.identity_id));
  demand(expected&&identity&&Number(record.patient_id)===Number(identity.patient_id)&&Number(record.clinic_id)===expected.clinic_id&&Number(identity.clinic_id)===expected.clinic_id,'ARRIAGA_EXISTING_RECORD_OWNER');
  demand(identity.source_patient_id===`master-row-${expected.master_source_row}`&&record.row_sha256===expected.source.row_content_sha256&&record.database_sha256===expected.source_sha256&&record.bundle_sha256===bundle.sha256,'ARRIAGA_EXISTING_RECORD_SOURCE');
  let json;try{json=JSON.parse(record.record_json);}catch{demand(false,'ARRIAGA_EXISTING_RECORD_JSON');}
  demand(digest(json)===digest({...cleanRecord(expected),bundle_sha256:bundle.sha256})&&String(record.record_date)===expected.record_date&&record.category==='historical'&&record.source_database===expected.source_file&&record.source_table===expected.source_sheet,'ARRIAGA_EXISTING_RECORD_CHANGED');
 }
 for(const p of bundle.patients)memberships.set(p.canonical_key,new Set());
 for(const r of bundle.activity)memberships.get(rows.get(r.master_source_row)).add(r.clinic_id);
 const sourceNumbers=bundle.patients.flatMap(p=>p.source_history_numbers||[]).filter(positive).map(Number);
 demand(sourceNumbers.every(Number.isSafeInteger),'ARRIAGA_HISTORY_RANGE');
 let next=Math.max(0,...sourceNumbers,...snapshot.histories.map(p=>Number(p.numero_historia)||0),Number(snapshot.counter[0]?.next_number||1)-1)+1;
 const used=new Set(snapshot.histories.map(p=>String(p.numero_historia))),operations=[];
 for(const p of bundle.patients){
  const clinics=memberships.get(p.canonical_key);if(!clinics.size)clinics.add(70);
  const primary=clinics.has(70)?70:1;const existing=new Set();let existingAliases=0;
  for(const sourceRow of p.source_rows)for(const clinic of clinics){const i=identityBySource.get(`${instance(clinic)}:master-row-${sourceRow}`);if(i){demand(i.bundle_sha256===bundle.sha256,'ARRIAGA_EXISTING_BUNDLE_CHANGED');demand(i.source_history_number===String(bundle.source_history_by_row[String(sourceRow)]||''),'ARRIAGA_EXISTING_HISTORY_ALIAS');existing.add(Number(i.patient_id));existingAliases++;}}
  demand(existing.size<=1,'ARRIAGA_IDENTITY_CONFLICT');
  if(existing.size)demand(existingAliases===p.source_rows.length*clinics.size,'ARRIAGA_PARTIAL_IDENTITY');
  if(existing.size){operations.push({canonicalKey:p.canonical_key,action:'preserve',patientId:[...existing][0],publicId:publicId(p.canonical_key),clinicIds:[...clinics].sort((a,b)=>a-b),primaryClinicId:primary,sourceRows:p.source_rows});continue;}
  demand(!snapshot.patients.some(x=>x.public_id===publicId(p.canonical_key)),'ARRIAGA_ORPHAN_PUBLIC_ID');
  let number=(p.source_history_numbers||[]).map(String).find(n=>positive(n)&&!used.has(String(Number(n))));
  const kept=number!=null;number=kept?String(Number(number)):String(next++);used.add(number);
  operations.push({canonicalKey:p.canonical_key,action:'create',publicId:publicId(p.canonical_key),historyNumber:number,historyRenumbered:!kept,clinicIds:[...clinics].sort((a,b)=>a-b),primaryClinicId:primary,sourceRows:p.source_rows,profile:p.profile,sourceHistoryNumbers:p.source_history_numbers});
 }
 const catalogOps=bundle.catalog.map(t=>{const code='ARR28-'+digest(t.catalog_key).slice(0,20);const old=snapshot.treatments.find(x=>x.codigo===code);if(old)demand(Number(old.grupo_clinica_id)===28&&old.origen==='grupo','ARRIAGA_EXISTING_CATALOG_SCOPE');return{...t,code,action:old?'preserve':'create',...(old?{id:old.id_tratamiento}:{})};});
 const plan={version:'arriaga_import_plan/1',bundleSha256:bundle.sha256,snapshotSha256:digest(snapshot),operations,catalogOps,nextHistoryNumber:next,expectedRecords:bundle.activity.length};plan.sha256=digest(plan);return plan;
}

async function insertRows(connection,table,columns,values){
 demand(TABLES.includes(table),'ARRIAGA_TABLE_ALLOWLIST');
 for(let i=0;i<values.length;i+=250)await connection.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ?`,[values.slice(i,i+250)]);
}
async function applyImport(connection,{bundle,plan,actorId=1,beforeCommit=async()=>{},writeJournal=async()=>{}}){
 demand(actorId===1,'ARRIAGA_OPERATOR_ACTOR');validateBundle(bundle);const q=async(sql,values=[])=>{const[r]=await connection.query(sql,values);return r;};
 let started=false;const lock='cc-arriaga-import:group-28';
 demand(Number((await q('SELECT GET_LOCK(?,0) acquired',[lock]))[0]?.acquired)===1,'ARRIAGA_OPERATOR_LOCK');
 try{
  await connection.beginTransaction();started=true;
  // Lock native history allocation before observing group identities.
  const beforeCounter=await q('SELECT * FROM PatientHistoryCounters WHERE scope_key=? FOR UPDATE',[SCOPE.historyScope]);
  if(!beforeCounter.length)await q('INSERT INTO PatientHistoryCounters (scope_key,next_number) VALUES (?,1)',[SCOPE.historyScope]);
  const snapshot=await capture(connection,{lock:true});
  // The new counter row is an expected guard, not a target change.
  const observed={...snapshot,counter:beforeCounter};
  demand(digest(observed)===plan.snapshotSha256,'ARRIAGA_TARGET_CHANGED');
  const fresh=planImport(bundle,observed);demand(fresh.sha256===plan.sha256,'ARRIAGA_PLAN_CHANGED');
  const created=plan.operations.filter(p=>p.action==='create');const now=new Date();const dbDate=v=>v?new Date(v):now;
  const patientCols=['public_id','nombre','apellidos','dni','email','telefono_movil','telefono_secundario','fecha_nacimiento','direccion','codigo_postal','poblacion','provincia','pais','clinica_id','numero_historia','historia_scope','fecha_alta','idioma_preferido','paciente_conocido','createdAt','updatedAt'];
  await insertRows(connection,'Pacientes',patientCols,created.map(o=>{const p=o.profile;return[o.publicId,p.nombre,p.apellidos,p.dni||null,p.email||null,p.telefono_movil||null,p.telefono_secundario||null,p.fecha_nacimiento||null,p.direccion||null,p.codigo_postal||null,p.poblacion||null,p.provincia||null,p.pais||null,o.primaryClinicId,o.historyNumber,SCOPE.historyScope,dbDate(p.fecha_alta),'es',false,now,now];}));
  const ids=new Map(plan.operations.filter(o=>o.action==='preserve').map(o=>[o.canonicalKey,o.patientId]));
  for(let i=0;i<created.length;i+=250){const batch=created.slice(i,i+250),found=await q('SELECT id_paciente,public_id FROM Pacientes WHERE public_id IN (?)',[batch.map(o=>o.publicId)]);for(const o of batch){const p=found.find(x=>x.public_id===o.publicId);demand(p,'ARRIAGA_PATIENT_RECEIPT');ids.set(o.canonicalKey,Number(p.id_paciente));}}
  await writeJournal({phase:'patients',ids:[...ids]});
  await insertRows(connection,'PacienteClinicas',['paciente_id','clinica_id','es_principal','createdAt','updatedAt'],created.flatMap(o=>o.clinicIds.map(id=>[ids.get(o.canonicalKey),id,id===o.primaryClinicId,now,now])));
  const catalogIds=new Map(snapshot.catalogs.map(c=>[Number(c.clinic_id),Number(c.id)]));
  if(created.length){for(const clinicId of SCOPE.clinicIds){if(catalogIds.has(clinicId))continue;const context={version:'arriaga_import_context/1',group_id:28,clinic_id:clinicId,files:bundle.files,policy:bundle.policy};const r=await q('INSERT INTO ImportedClinicalCatalogs (clinic_id,source_system,source_instance,bundle_sha256,source_zip_sha256,catalog_sha256,context_json,imported_at,actor_user_id) VALUES (?,?,?,?,?,?,?,?,?)',[clinicId,SCOPE.source,instance(clinicId),bundle.sha256,digest(bundle.files),digest(context),JSON.stringify(context),now,actorId]);catalogIds.set(clinicId,Number(r.insertId));}}
  await insertRows(connection,'PatientImportedIdentities',['catalog_id','patient_id','clinic_id','source_system','source_instance','source_patient_id','source_history_number','bundle_sha256','messages_hold','imported_at','actor_user_id'],created.flatMap(o=>o.sourceRows.flatMap(rn=>o.clinicIds.map(cid=>[catalogIds.get(cid),ids.get(o.canonicalKey),cid,SCOPE.source,instance(cid),`master-row-${rn}`,String(bundle.source_history_by_row[String(rn)]||'')||null,bundle.sha256,true,now,actorId]))));
  const identityRows=await q('SELECT id,patient_id,clinic_id,source_instance,source_patient_id FROM PatientImportedIdentities WHERE source_system=? AND source_instance IN (?,?)',[SCOPE.source,instance(1),instance(70)]);
  const identityMap=new Map(identityRows.map(i=>[`${i.source_instance}:${i.source_patient_id}`,i]));const existingRecords=new Set(snapshot.sourceRecords.map(r=>r.source_key));
  await insertRows(connection,'PatientImportedSourceRecords',['identity_id','patient_id','clinic_id','source_key','source_database','source_table','category','record_date','row_sha256','database_sha256','bundle_sha256','record_json','imported_at'],bundle.activity.filter(r=>!existingRecords.has(r.source_activity_key)).map(r=>{const e=cleanRecord(r),identity=identityMap.get(`${instance(r.clinic_id)}:master-row-${r.master_source_row}`);demand(identity&&Number(identity.patient_id)===ids.get(r.canonical_key),'ARRIAGA_RECORD_OWNER');e.bundle_sha256=bundle.sha256;return[identity.id,identity.patient_id,r.clinic_id,r.source_activity_key,r.source_file,r.source_sheet,'historical',r.record_date,r.source.row_content_sha256,r.source_sha256,bundle.sha256,JSON.stringify(e),now];}));
  await insertRows(connection,'PatientOperationalEvents',['patient_id','clinic_id','actor_user_id','event_type','source','channel','metadata','occurred_at','created_at'],created.map(o=>[ids.get(o.canonicalKey),o.primaryClinicId,actorId,'patient.imported',SCOPE.source,null,JSON.stringify({source_instance:SCOPE.instance,bundle_sha256:bundle.sha256,messages_enabled:false,automation_activated:false,source_registration_date_known:!!o.profile.fecha_alta,registration_date_semantics:o.profile.fecha_alta?'source_registration_date':'clinicaclick_import_date'}),now,now]));
  const treatmentCols=['nombre','codigo','descripcion','disciplina','categoria','duracion_min','precio_base','origen','grupo_clinica_id','clinica_id','sesiones_defecto','requiere_pieza','requiere_zona','activo','clinical_config','createdAt','updatedAt'];
  await insertRows(connection,'Tratamientos',treatmentCols,plan.catalogOps.filter(t=>t.action==='create').map(t=>[t.nombre,t.code,'Catálogo inicial importado de Arriaga; pendiente de completar tarifa, duración y recursos.',t.disciplina||'Podología',t.family||t.source_categories?.[0]||null,null,null,'grupo',28,null,1,false,false,false,JSON.stringify({catalog_status:'draft',source_system:SCOPE.source,source_instance:SCOPE.instance,source_aliases:t.source_labels,import_batch:bundle.sha256}),now,now]));
  await q('UPDATE PatientHistoryCounters SET next_number=GREATEST(next_number,?) WHERE scope_key=?',[plan.nextHistoryNumber,SCOPE.historyScope]);
  const after=await capture(connection);demand(after.sourceRecords.length===bundle.activity.length,'ARRIAGA_RECORD_COUNT');demand(after.identities.every(i=>Number(i.messages_hold)===1),'ARRIAGA_COMMUNICATION_HOLD');
  const afterPatients=new Map(after.patients.map(p=>[p.id_paciente,p])),afterMemberships=new Set(after.memberships.map(digest));
  for(const p of snapshot.patients){demand(digest(p)===digest(afterPatients.get(p.id_paciente)),'ARRIAGA_EXISTING_PATIENT_CHANGED');}
  for(const m of snapshot.memberships)demand(afterMemberships.has(digest(m)),'ARRIAGA_EXISTING_MEMBERSHIP_CHANGED');
  const result={bundleSha256:bundle.sha256,planSha256:plan.sha256,patientsCreated:created.length,patientsPreserved:plan.operations.length-created.length,historyRenumbered:created.filter(o=>o.historyRenumbered).length,membershipsCreated:created.reduce((n,o)=>n+o.clinicIds.length,0),identities:after.identities.length,historicalActivities:after.sourceRecords.length,treatmentsCreated:plan.catalogOps.filter(o=>o.action==='create').length,treatmentsPreserved:plan.catalogOps.filter(o=>o.action==='preserve').length,byPrimaryClinic:Object.fromEntries(SCOPE.clinicIds.map(id=>[id,created.filter(p=>p.primaryClinicId===id).length])),messagesSent:0,appointmentsCreated:0,financialRecordsCreated:0};
  await beforeCommit({snapshot:observed,after,result,patientIds:[...ids]});await connection.commit();started=false;return result;
 }finally{if(started)await connection.rollback();await q('SELECT RELEASE_LOCK(?)',[lock]);}
}
module.exports={SCOPE,TABLES,digest,validateBundle,cleanRecord,publicId,capture,planImport,applyImport};
