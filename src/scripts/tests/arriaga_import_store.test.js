'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const store=require('../../lib/arriaga-import/store');
const {SCOPE,digest,validateBundle,cleanRecord,planImport}=store;
const instance=clinicId=>`${SCOPE.instance}:clinic-${clinicId}`;
const clone=value=>JSON.parse(JSON.stringify(value));

function person(row,history='7'){
 return{canonical_key:`master-row-${row}`,source_rows:[row],source_history_numbers:[history],
  profile:{nombre:`TESTONLY Person ${row}`,apellidos:'Synthetic fixture',direccion:'TESTONLY fictional address'}};
}
function activity(row=2,clinicId=70,sourceRow=2){
 return{canonical_key:`master-row-${row}`,master_source_row:row,clinic_id:clinicId,clinic_assignment:clinicId===1?'explicit_aju':'default_arenal',
  record_date:'2025-03-04',source_activity_key:digest(`TESTONLY activity ${sourceRow}:${clinicId}`),
  notes_imported:false,financial_state_imported:false,signed_episode:false,care_state:null,event_time:null,
  service_label:'TESTONLY Quiropodía',family:'TESTONLY Clinical',classification:'QUIROPODIA',
  source_file:'TESTONLY activity.xlsx',source_sheet:'TESTONLY activity',source_row:sourceRow,
  source_sha256:'b'.repeat(64),source:{row_content_sha256:'c'.repeat(64)}};
}
function seal(bundle){delete bundle.sha256;bundle.sha256=digest(bundle);return bundle;}
function bundle(patients=[person(2)],acts=[activity()]){
 return seal({version:'arriaga_import_bundle/1',group_id:28,default_clinic_id:70,
  files:[{file:'TESTONLY activity.xlsx',sha256:'b'.repeat(64)}],policy:{messages_enabled:false,default_clinic_id:70},
  patients,activity:acts,catalog:[{catalog_key:'TESTONLY clinical service',nombre:'TESTONLY Quiropodía',family:'TESTONLY Clinical',
   disciplina:'Podología',precio_base:null,duracion_min:null,source_labels:['TESTONLY Quiropodía']}],
  source_history_by_row:Object.fromEntries(patients.flatMap(p=>p.source_rows.map((row,index)=>[String(row),p.source_history_numbers[index]??p.source_history_numbers[0]??''])))});
}
function snapshot(){return{clinics:[{id_clinica:1,nombre_clinica:'TESTONLY Ajuriaguerra',grupoClinicaId:28},{id_clinica:70,nombre_clinica:'TESTONLY Arenal',grupoClinicaId:28}],
 patients:[],memberships:[],histories:[],counter:[],catalogs:[],identities:[],sourceRecords:[],treatments:[]};}
function replaySnapshot(source,firstPlan){
 const s=snapshot(),idByKey=new Map();
 s.catalogs=[1,70].map((clinicId,index)=>({id:100+index,clinic_id:clinicId,source_system:SCOPE.source,source_instance:instance(clinicId),bundle_sha256:source.sha256}));
 for(const [index,op] of firstPlan.operations.entries()){
  const id=1000+index;idByKey.set(op.canonicalKey,id);
  s.patients.push({id_paciente:id,public_id:op.publicId,clinica_id:op.primaryClinicId,numero_historia:op.historyNumber,historia_scope:SCOPE.historyScope});
  s.histories.push({id_paciente:id,numero_historia:op.historyNumber,historia_scope:SCOPE.historyScope});
  for(const clinicId of op.clinicIds){
   s.memberships.push({id:s.memberships.length+1,paciente_id:id,clinica_id:clinicId,es_principal:clinicId===op.primaryClinicId});
   for(const row of op.sourceRows)s.identities.push({id:s.identities.length+1,catalog_id:s.catalogs.find(c=>c.clinic_id===clinicId).id,
    patient_id:id,clinic_id:clinicId,source_system:SCOPE.source,source_instance:instance(clinicId),source_patient_id:`master-row-${row}`,
    source_history_number:source.source_history_by_row[String(row)]||null,bundle_sha256:source.sha256,messages_hold:1});
  }
 }
 s.sourceRecords=source.activity.map((r,index)=>{const i=s.identities.find(i=>i.source_instance===instance(r.clinic_id)&&i.source_patient_id===`master-row-${r.master_source_row}`);
  return{id:index+1,identity_id:i.id,patient_id:i.patient_id,clinic_id:r.clinic_id,source_key:r.source_activity_key,
   source_database:r.source_file,source_table:r.source_sheet,category:'historical',record_date:r.record_date,
   row_sha256:r.source.row_content_sha256,database_sha256:r.source_sha256,bundle_sha256:source.sha256,
   record_json:JSON.stringify({...cleanRecord(r),bundle_sha256:source.sha256})};});
 s.treatments=firstPlan.catalogOps.map((t,index)=>({id_tratamiento:200+index,codigo:t.code,nombre:t.nombre,origen:'grupo',grupo_clinica_id:28,clinica_id:null,
  precio_base:null,duracion_min:null,activo:0,clinical_config:{catalog_status:'draft',source_system:SCOPE.source,source_instance:SCOPE.instance,import_batch:source.sha256}}));
 s.counter=[{scope_key:SCOPE.historyScope,next_number:firstPlan.nextHistoryNumber}];return s;
}

test('Arriaga bundle validation and planning are pure, scope-bound and content-hash bound',()=>{
 const b=bundle(),s=snapshot(),beforeBundle=JSON.stringify(b),beforeSnapshot=JSON.stringify(s);
 const validated=validateBundle(b);assert.equal(validated.rows.get(2),'master-row-2');
 const plan=planImport(b,s);assert.equal(plan.bundleSha256,b.sha256);assert.equal(plan.snapshotSha256,digest(s));
 assert.equal(plan.operations.length,1);assert.equal(plan.operations[0].action,'create');assert.equal(plan.operations[0].primaryClinicId,70);
 assert.deepEqual(plan.operations[0].clinicIds,[70]);assert.equal(plan.operations[0].historyNumber,'7');
 assert.equal(JSON.stringify(b),beforeBundle);assert.equal(JSON.stringify(s),beforeSnapshot);
 const changed=clone(b);changed.patients[0].profile.nombre='TESTONLY changed without approval';
 assert.throws(()=>validateBundle(changed),/ARRIAGA_BUNDLE_DIGEST/);
 const changedTarget=clone(s);changedTarget.counter=[{scope_key:'group:28',next_number:100}];
 assert.notEqual(planImport(b,changedTarget).snapshotSha256,plan.snapshotSha256);
 for(const patch of [{group_id:29},{default_clinic_id:1}])assert.throws(()=>validateBundle(seal({...clone(b),...patch})),/ARRIAGA_SCOPE/);
});

test('source row, person and activity identity tampering cannot relink clinical evidence',()=>{
 const cases=[
  b=>b.patients.push(clone(b.patients[0])),
  b=>b.patients.push({...person(3),source_rows:[2]}),
  b=>b.activity[0].master_source_row=999,
  b=>b.activity[0].canonical_key='master-row-999',
  b=>b.activity[0].clinic_id=72,
  b=>b.activity.push(clone(b.activity[0])),
  b=>b.activity[0].source_activity_key='invalid',
  b=>b.activity[0].record_date='not a date',
 ];
 for(const mutate of cases){const b=bundle();mutate(b);assert.throws(()=>validateBundle(seal(b)),/ARRIAGA_/);}
});

test('notes, absences, payments, bookings and invented clinical or tariff state are rejected',()=>{
 for(const label of ['TESTONLY NOTAS','Avisos 5.NO VIENE','TESTONLY NO ACUDE','TESTONLY PAGO','TESTONLY RESERVA QUIROFANO','TESTONLY CONSENTIMIENTO']){
  const b=bundle();b.activity[0].service_label=label;assert.throws(()=>validateBundle(seal(b)),/ARRIAGA_EXCLUDED_ACTIVITY/);
 }
 for(const [key,value] of [['notes_imported',true],['financial_state_imported',true],['signed_episode',true],['care_state','completada'],['event_time','12:00:00']]){
  const b=bundle();b.activity[0][key]=value;assert.throws(()=>validateBundle(seal(b)),/ARRIAGA_NO_INVENTED_STATE/);
 }
 for(const [key,value] of [['notas_paciente','TESTONLY note'],['notas_medicas','TESTONLY medical note'],['antecedentes','TESTONLY prior state'],['medicacion','TESTONLY medication']]){
  const b=bundle();b.patients[0].profile[key]=value;assert.throws(()=>validateBundle(seal(b)),/ARRIAGA_NO_NOTES/);
 }
 for(const [key,value] of [['precio_base',0],['duracion_min',15]]){const b=bundle();b.catalog[0][key]=value;assert.throws(()=>validateBundle(seal(b)),/ARRIAGA_NO_INVENTED_TARIFF/);}
});

test('clean historical records contain only approved service data and preserve the real source date and row',()=>{
 const a=activity();a.record_note='TESTONLY must not be copied';a.patient_name='TESTONLY must not be copied';a.paid_amount='TESTONLY must not be copied';
 const original=JSON.stringify(a),r=cleanRecord(a);
 assert.equal(r.version,'arriaga_patient_source_record/1');assert.equal(r.provider,'arriaga_excel');
 assert.equal(r.source_instance,'arriaga-excel-20261026:clinic-70');assert.equal(r.source_patient_id,'master-row-2');assert.equal(r.clinic_id,70);
 assert.equal(r.record_date,'2025-03-04');assert.equal(r.source_row,2);assert.equal(r.source_key,a.source_activity_key);
 assert.deepEqual(Object.keys(r.record),['service_label','service_family','source_classification','site_assignment']);
 assert.doesNotMatch(JSON.stringify(r),/must not be copied|event_time|care_state|completed_at|paid_amount|patient_name/);assert.equal(JSON.stringify(a),original);
});

test('duplicate, colliding and missing source histories receive unique group-scoped numbers without merging people',()=>{
 const p2=person(2,'7'),p3=person(3,'7'),p4=person(4);p4.source_history_numbers=[];
 const b=bundle([p2,p3,p4],[]),plan=planImport(b,snapshot());
 assert.equal(plan.operations.length,3);assert.deepEqual(plan.operations.map(o=>o.historyNumber),['7','8','9']);
 assert.deepEqual(plan.operations.map(o=>o.historyRenumbered),[false,true,true]);assert.equal(plan.nextHistoryNumber,10);
 assert.equal(new Set(plan.operations.map(o=>o.publicId)).size,3);
 const s=snapshot();s.histories=[{id_paciente:99,numero_historia:'7',historia_scope:'group:28'}];
 const withConflict=planImport(b,s);assert.deepEqual(withConflict.operations.map(o=>o.historyNumber),['8','9','10']);
 assert.equal(s.histories[0].numero_historia,'7');
});

test('known aliases merge into one identity while clinical activity can link both Arriaga clinics',()=>{
 const p=person(2);p.source_rows=[2,3];p.source_history_numbers=['7','8'];
 const aju=activity(2,1,2),arenal=activity(3,70,3);arenal.canonical_key='master-row-2';
 const b=bundle([p],[aju,arenal]),plan=planImport(b,snapshot());
 assert.equal(plan.operations.length,1);assert.equal(plan.operations[0].primaryClinicId,70);assert.deepEqual(plan.operations[0].clinicIds,[1,70]);
 assert.deepEqual(plan.operations[0].sourceRows,[2,3]);assert.equal(plan.operations[0].historyNumber,'7');
 const replay=planImport(b,replaySnapshot(b,plan));assert.equal(replay.operations[0].action,'preserve');assert.equal(replay.operations[0].patientId,1000);
 assert.equal(replay.catalogOps[0].action,'preserve');assert.equal(replay.nextHistoryNumber,plan.nextHistoryNumber);
});

test('the import preserves unrelated native patients and never treats name-only equality as an imported identity',()=>{
 const b=bundle(),s=snapshot();
 s.patients.push({id_paciente:99,public_id:'pac_TESTONLY_existing',clinica_id:1,nombre:b.patients[0].profile.nombre,apellidos:b.patients[0].profile.apellidos,numero_historia:null});
 const before=JSON.stringify(s),plan=planImport(b,s);assert.equal(plan.operations[0].action,'create');assert.equal(JSON.stringify(s),before);
 const orphan=clone(s);orphan.patients[0].public_id=plan.operations[0].publicId;
 assert.throws(()=>planImport(b,orphan),/ARRIAGA_ORPHAN_PUBLIC_ID/);
});

test('existing imported identities and catalogues cannot be rebound to another provider, clinic, owner or catalogue',()=>{
 const b=bundle(),first=planImport(b,snapshot()),good=replaySnapshot(b,first);
 assert.equal(planImport(b,good).operations[0].action,'preserve');
 const cases=[
  s=>s.identities[0].clinic_id=72,
  s=>s.identities[0].source_system='cliniccloud',
  s=>s.identities[0].source_instance=instance(1),
  s=>s.identities[0].patient_id=777,
  s=>s.patients[0].clinica_id=72,
  s=>s.identities[0].catalog_id=999,
  s=>s.catalogs.find(c=>c.clinic_id===70).clinic_id=1,
  s=>s.catalogs.find(c=>c.clinic_id===70).source_system='eurodent',
  s=>s.identities[0].bundle_sha256='d'.repeat(64),
  s=>s.treatments[0].grupo_clinica_id=29,
  s=>s.treatments[0].origen='clinica',
 ];
 for(const mutate of cases){const s=clone(good);mutate(s);if(s.patients[0].clinica_id===72)s.memberships=[];
  assert.throws(()=>planImport(b,s),/ARRIAGA_/);}
});

test('replay refuses a missing alias and changed historical row contents instead of silently accepting source keys',()=>{
 const p=person(2);p.source_rows=[2,3];p.source_history_numbers=['7','8'];
 const b=bundle([p],[activity()]),first=planImport(b,snapshot()),good=replaySnapshot(b,first);
 assert.equal(planImport(b,good).operations[0].action,'preserve');
 const missing=clone(good);missing.identities=missing.identities.filter(i=>i.source_patient_id!=='master-row-3');
 assert.throws(()=>planImport(b,missing),/ARRIAGA_/);
 const cases=[
  s=>s.sourceRecords[0].patient_id=888,
  s=>s.sourceRecords[0].clinic_id=1,
  s=>s.sourceRecords[0].identity_id=999,
  s=>s.sourceRecords[0].row_sha256='d'.repeat(64),
  s=>s.sourceRecords[0].bundle_sha256='d'.repeat(64),
  s=>{const r=JSON.parse(s.sourceRecords[0].record_json);r.record.service_label='TESTONLY tampered retained service';s.sourceRecords[0].record_json=JSON.stringify(r);},
 ];
 for(const mutate of cases){const s=clone(good);mutate(s);assert.throws(()=>planImport(b,s),/ARRIAGA_/);}
});
