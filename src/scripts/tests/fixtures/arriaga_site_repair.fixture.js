'use strict';
const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const store=require('../../../lib/arriaga-import/store');
function fixture(){
 const patients=[2,3,4,5,6].map(row=>({canonical_key:`master-row-${row}`,source_rows:[row],source_history_numbers:[String(row)],profile:{nombre:`TESTONLY Person ${row}`,apellidos:'Synthetic'}}));
 const activity=[];let row=20;
 function add(master,clinic,assignment,label){const id=row++;activity.push({canonical_key:`master-row-${master}`,master_source_row:master,clinic_id:clinic,clinic_assignment:assignment,record_date:assignment==='explicit_aju'?'2026-09-24':'2026-09-30',source_activity_key:store.digest('TESTONLY record '+id),source_file:'procedencia servicios 2026.xlsx',source_sheet:'2026 servicios',source_row:id,source_sha256:store.digest('TESTONLY workbook'),source:{row_content_sha256:store.digest('TESTONLY row '+id)},service_label:label,family:'TESTONLY clinical service',classification:'TESTONLY',notes_imported:false,financial_state_imported:false,signed_episode:false,care_state:null,event_time:null});}
 for(const id of [2,3,4]){add(id,1,'explicit_aju','TESTONLY Consulta AJU');add(id,70,'default_arenal','TESTONLY Entrega');}
 add(5,1,'explicit_aju','TESTONLY Consulta AJU');add(5,70,'explicit_arenal','TESTONLY Consulta ARENAL');add(5,70,'default_arenal','TESTONLY Entrega');add(6,70,'default_arenal','TESTONLY Consulta');
 const bundle={version:'arriaga_import_bundle/1',group_id:28,default_clinic_id:70,files:[],policy:{fixture:'TESTONLY'},patients,activity,catalog:[],source_history_by_row:Object.fromEntries(patients.map(p=>[p.source_rows[0],p.source_history_numbers[0]]))};bundle.sha256=store.digest(bundle);
 const filename=require.resolve('../../../lib/arriaga-import/site-attribution-repair');
 const source=fs.readFileSync(filename,'utf8').replace("const BUNDLE='e8dad996b869e524dc42eb97c0685dc48693557f90277932a08a044d7c084b41';",`const BUNDLE='${bundle.sha256}';`);
 const box={exports:{}};vm.runInNewContext(source,{module:box,exports:box.exports,require:createRequire(filename),Date,Map,Set,Buffer,Object,JSON,Number,console},{filename});const repair=box.exports;
 return{bundle,repair};
}
function snapshot(bundle){
 const people=[2,3,4].map(row=>({id_paciente:90000+row,public_id:store.publicId(`master-row-${row}`),clinica_id:70,numero_historia:String(row),historia_scope:'group:28',updatedAt:'2026-10-26 10:00:00'}));
 const identities=[],memberships=[],records=[];let id=1;
 for(const p of people)for(const clinic of [1,70]){identities.push({id:id++,catalog_id:clinic,patient_id:p.id_paciente,clinic_id:clinic,source_system:'arriaga_excel',source_instance:`arriaga-excel-20261026:clinic-${clinic}`,source_patient_id:`master-row-${p.id_paciente-90000}`,bundle_sha256:bundle.sha256,messages_hold:1});memberships.push({id:memberships.length+1,paciente_id:p.id_paciente,clinica_id:clinic,es_principal:clinic===70?1:0,createdAt:'2026-10-26 10:00:00',updatedAt:'2026-10-26 10:00:00'});}
 for(const a of bundle.activity.filter(a=>a.master_source_row<5)){const i=identities.find(i=>i.source_patient_id===`master-row-${a.master_source_row}`&&i.clinic_id===a.clinic_id);records.push({id:records.length+1,identity_id:i.id,patient_id:i.patient_id,clinic_id:a.clinic_id,source_key:a.source_activity_key,source_database:a.source_file,source_table:a.source_sheet,category:'historical',record_date:a.record_date,row_sha256:a.source.row_content_sha256,database_sha256:a.source_sha256,bundle_sha256:bundle.sha256,record_json:JSON.stringify({...store.cleanRecord(a),bundle_sha256:bundle.sha256}),imported_at:'2026-10-26 10:00:00'});}
 return{clinics:[{id_clinica:1,nombre_clinica:'TESTONLY AJU',grupoClinicaId:28},{id_clinica:70,nombre_clinica:'TESTONLY ARENAL',grupoClinicaId:28}],patients:people,memberships,identities,catalogs:[1,70].map(clinic=>({id:clinic,clinic_id:clinic,source_system:'arriaga_excel',source_instance:`arriaga-excel-20261026:clinic-${clinic}`,bundle_sha256:bundle.sha256})),records,events:[],dependencies:[{table:'CitasPacientes',kind:'native',patient_id:90004,count:1},{table:'Conversations',kind:'history',patient_id:90003,count:1}],dependencyTables:['CitasPacientes','Conversations','PatientOperationalEvents']};
}
module.exports={fixture,snapshot};
