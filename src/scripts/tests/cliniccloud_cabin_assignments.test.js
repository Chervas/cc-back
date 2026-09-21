'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {sourceReference}=require('../../lib/cliniccloud-import/week-appointments');
const {operationFor,preparePackage,verifyPackage,executeAssignments}=require('../../lib/cliniccloud-import/cabin-assignments');
const {createCabinStore}=require('../../lib/cliniccloud-import/cabin-assignments-store');
const now=Date.parse('2026-09-21T07:00:00Z');
function fixture(){
 const source={source_contact_id:'101',start_local:'2026-09-22T12:00:00',end_local:'2026-09-22T12:30:00',start_utc:'2026-09-22T10:00:00.000Z',end_utc:'2026-09-22T10:30:00.000Z',agenda_key:'DOCTOR',service_key:'VISIT',status:'pendiente',details:'note'};
 const baseline=Object.fromEntries(['source_contact_id','start_local','end_local','agenda_key','service_key','status'].map(k=>[k,source[k]]));
 const before={id_cita:1,paciente_id:10,clinica_id:72,doctor_id:53,instalacion_id:null,tratamiento_id:5,inicio:source.start_utc,fin:source.end_utc,estado:'pendiente',nota:'note',source_system:'cliniccloud',source_reference:sourceReference(source),created_at:'2026-09-21T06:00:00.000Z',updated_at:'2026-09-21T06:00:00.000Z',import_metadata:{source_contact_id:'101',cliniccloud_delta:{source:baseline},notification_suppression:{appointment_details:true,day_before:true,same_day:true},cliniccloud_reconciliation:{automation_policy:'hold'}}};
 const cabin={id:80,clinica_id:72,activo:0,capacidad:1,descripcion:'Mapa físico documental BS 2026. C7.'};
 const catalogRow={clinic_id:72,kind:'treatment',source_catalog_key:'a'.repeat(64),provenance:{sheet:'sample',source_row:3},installation_resolution:[{confirmed_id:80}]};
 const reason='Operator reviewed a single documentary location';
 return {before,source,cabin,catalogRow,reason};
}
function packageFor(f=fixture()) {return preparePackage({operations:[operationFor(f)],catalogPlanHash:'c'.repeat(64),sourcePlanHash:'d'.repeat(64),reviewedBy:'test operator',createdAt:new Date(now).toISOString()});}
function memoryStore(row){return {row:structuredClone(row),writes:0,blocked:[],async transaction(fn){const original=structuredClone(this.row);try{return await fn(this);}catch(e){this.row=original;throw e;}},async read(){return this.row;},async validate(){return this.blocked;},async update(id,patch){Object.assign(this.row,structuredClone(patch));this.writes++;}};}
test('physical assignment preserves patient, clinical act, staff, slot, state and HOLD',async()=>{
 const f=fixture(),pkg=packageFor(f),store=memoryStore(f.before),events=[];
 verifyPackage(pkg);const out=await executeAssignments({pkg,store,journal:{append:async e=>events.push(e)},now:()=>now});
 assert.equal(out.assigned,1);assert.equal(store.row.instalacion_id,80);
 for(const k of Object.keys(f.before).filter(k=>!['instalacion_id','import_metadata','updated_at'].includes(k)))assert.deepEqual(store.row[k],f.before[k]);
 assert.deepEqual(store.row.import_metadata.notification_suppression,f.before.import_metadata.notification_suppression);
 assert.equal(events[0].phase,'cabin_prepared');assert.equal(events[1].phase,'cabin_committed');assert.equal(out.rooms_activated,0);
});
test('replay never restores later edits or emits new writes',async()=>{
 const pkg=packageFor(),store=memoryStore(pkg.operations[0].before),journal={append:async()=>{}};
 await executeAssignments({pkg,store,journal,now:()=>now});store.row.nota='Edited by staff';store.row.instalacion_id=99;
 const out=await executeAssignments({pkg,store,journal,now:()=>now});assert.equal(out.replayed,1);assert.equal(store.writes,1);assert.equal(store.row.instalacion_id,99);
});
test('drift, expired package and absent journal reject before writing',async()=>{
 const pkg=packageFor(),store=memoryStore(pkg.operations[0].before),journal={append:async()=>{}};store.row.nota='changed';
 await assert.rejects(executeAssignments({pkg,store,journal,now:()=>now}),/APPOINTMENT_CHANGED/);
 await assert.rejects(executeAssignments({pkg,store,journal,now:()=>now+7200001}),/EXPIRED/);
 await assert.rejects(executeAssignments({pkg,store,now:()=>now}),/JOURNAL/);assert.equal(store.writes,0);
});
test('overlap is deferred without updating or pretending success',async()=>{
 const pkg=packageFor(),store=memoryStore(pkg.operations[0].before);store.blocked=['CABIN_CURRENT_APPOINTMENT_OVERLAP'];
 const out=await executeAssignments({pkg,store,journal:{append:async()=>{}},now:()=>now});assert.equal(out.deferred,1);assert.equal(out.assigned,0);assert.equal(store.writes,0);
});
test('rejects native, completed, advanced, program and provisional records',()=>{
 for(const change of [f=>f.before.source_system=null,f=>f.before.estado='completada',f=>f.before.import_metadata.booking={},f=>f.before.voucher_id=5,f=>f.before.es_provisional=1]){const f=fixture();change(f);assert.throws(()=>operationFor(f),/NOT_SIMPLE/);}
});
test('rejects source/notes/time/HOLD/clinic/multi-room/active/capacity changes',()=>{
 const changes=[f=>f.before.nota='new',f=>f.source.start_utc='2026-09-22T11:00:00.000Z',f=>f.before.import_metadata.notification_suppression.day_before=false,
  f=>f.cabin.clinica_id=66,f=>f.cabin.activo=1,f=>f.cabin.capacidad=2,f=>f.catalogRow.installation_resolution.push({confirmed_id:81}),f=>f.projectedConflicts=[2]];
 for(const change of changes){const f=fixture();change(f);assert.throws(()=>operationFor(f),/CABIN_/);}
});
test('even a rehashed package cannot add mutation columns or enable messages',()=>{
 for(const change of [p=>p.allowed_columns.push('inicio'),p=>p.sends_messages=true,p=>p.activates_rooms=true]){const p=packageFor();change(p);const {package_sha256,...body}=p;p.package_sha256=hash(body);assert.throws(()=>verifyPackage(p),/INVALID/);}
});
test('SQL store rejects wrong scope and triggers',async()=>{
 for(const rows of [[{id_clinica:66,grupoClinicaId:29}], [{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:1}]])await assert.rejects(createCabinStore({query:async()=>[rows]}),/GROUP_CHANGED/);
 await assert.rejects(createCabinStore({query:async sql=>[sql.includes('TRIGGER')?[{TRIGGER_NAME:'t'}]:[{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}]]}),/TRIGGERS/);
});
test('SQL writer admits only the physical field and metadata inside a transaction',async()=>{
 const queries=[];const c={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('FROM Clinicas'))return [[{id_clinica:66,grupoClinicaId:29},{id_clinica:72,grupoClinicaId:29}]];if(sql.startsWith('UPDATE'))return [{affectedRows:1}];return [[]];},beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{}};
 const store=await createCabinStore(c,{readOnly:false});await assert.rejects(store.update(1,{}),/COLUMNS/);
 await store.transaction(async tx=>{await assert.rejects(tx.update(1,{instalacion_id:80,inicio:'x'}),/COLUMNS/);await tx.update(1,{instalacion_id:80,import_metadata:{},updated_at:new Date(now).toISOString()});});
 const writes=queries.filter(q=>q.sql.startsWith('UPDATE'));assert.equal(writes.length,1);assert.match(writes[0].sql,/source_system='cliniccloud' AND estado='pendiente'/);assert.deepEqual(writes[0].args.slice(0,2),[80,'{}']);
});
