'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {SOURCE_BATCH,DEMO_BATCH,SINCE,prepare,verifyPackage,verifyAfter,referencedTreatmentIds}=require('../../lib/cliniccloud-import/catalog-retirement');
const {assertCatalogEditable,catalogState}=require('../../lib/treatment-catalog-contract');
const {requireOperationalProfile}=require('../../services/treatmentBookingProfile.service');
const {run}=require('../cliniccloud-import-catalog-retirement');

function fixture(){
 const row=id=>({id_tratamiento:id,codigo:`CCLOUD-${9000+id}`,nombre:`Servicio ficticio ${id}`,clinica_id:72,origen:'clinica',activo:1,
  precio_base:'123.45',descripcion:'Descripción histórica conservada',duracion_min:30,updatedAt:'2026-07-26 00:00:00',
  clinical_config:{iva:21,source_system:'cliniccloud',source_batch:SOURCE_BATCH,source_reference:`service:${9000+id}`,
   raw:{idServicio:String(9000+id),nombre:`Servicio ficticio ${id}`,importe:'123.45'},unknown_future:{keep:true}}});
 return{createdAt:'2026-09-27T02:00:00Z',source:{since:SINCE,zip_sha256:'a'.repeat(64),services:['Otra técnica']},before:{
  clinics:[{id_clinica:66,grupo_clinica_id:29},{id_clinica:72,grupo_clinica_id:29}],treatments:[row(1),row(2)],
  appointment_usage:[{treatment_id:1,count:12,recent_count:0}],references:[],dependency_hashes:{appointments:'b'.repeat(64)}}};
}

test('retirement keeps IDs, historical description, price, source and unknown configuration; never maps or deletes',()=>{
 const f=fixture(),pkg=prepare(f);assert.equal(pkg.operations.length,2);verifyPackage(pkg);
 for(const op of pkg.operations){const old=f.before.treatments.find(t=>t.id_tratamiento===op.id),value=op.after;
  assert.equal(value.activo,0);assert.equal(value.clinical_config.catalog_status,'obsolete');
  assert.deepEqual({...value,activo:old.activo,clinical_config:old.clinical_config},old);
  assert.deepEqual(value.clinical_config.raw,old.clinical_config.raw);assert.deepEqual(value.clinical_config.unknown_future,{keep:true});
  assert.equal(value.clinical_config.source_catalog_retirement.replacement_treatment_id,null);
  assert.throws(()=>assertCatalogEditable(value),{code:'treatment_obsolete'});
  assert.throws(()=>requireOperationalProfile({...value,activo:false}),{code:'treatment_not_bookable'});
  assert.equal(catalogState({...value,activo:false}).editable,false);
 }
 assert(Object.values(pkg.policy).every(v=>v===false));
});
test('recent appointments are retained regardless of state, not mistaken for a removable duplicate',()=>{
 const f=fixture();f.before.appointment_usage[0].recent_count=1;const pkg=prepare(f);
 assert.deepEqual(pkg.operations.map(o=>o.id),[2]);assert.deepEqual(pkg.retained[0].reasons,['appointment_in_launch_week_or_later']);
});
test('latest source protects unimported future and combined services, case and whitespace insensitive',()=>{
 const f=fixture();f.source.services=['SERVICIO  FICTICIO 1 - SEGUNDA TÉCNICA'];
 assert.deepEqual(prepare(f).operations.map(o=>o.id),[2]);
});
for(const kind of ['PatientVouchers','EconomicBudgetVersions.lines','TreatmentPrograms.appointments','Instalaciones.tratamientos_exclusivos','AutomationFlows','appointment_snapshot'])test('preserves dependency '+kind,()=>{
 const f=fixture();f.before.references=[{kind,treatment_id:1}];const p=prepare(f);assert.deepEqual(p.operations.map(o=>o.id),[2]);assert.deepEqual(p.retained[0].reasons,[kind]);
});
test('changed clinic, source identity, display name, status or inactive state is retained',()=>{
 for(const mutate of [t=>t.clinica_id=9,t=>t.origen='sistema',t=>t.nombre='Edición humana',t=>t.codigo='BS26-other',
  t=>t.clinical_config.source_batch='another-import',t=>t.clinical_config.source_reference='service:other',
  t=>t.clinical_config.catalog_status='draft',t=>t.activo=0]){const f=fixture();mutate(f.before.treatments[0]);assert.deepEqual(prepare(f).operations.map(o=>o.id),[2]);}
});
test('invalid source, changed group and overbroad capture fail closed',()=>{
 for(const change of [f=>f.source.services=[],f=>f.source.since='2026-09-28',f=>f.source.zip_sha256='bad',f=>f.before.clinics[0].grupo_clinica_id=99,f=>f.before.treatments=[]]){const f=fixture();change(f);assert.throws(()=>prepare(f),/SCOPE_INVALID/);}
});
test('verification rejects tampering, deleted history, changed balances, retained records or names',()=>{
 const f=fixture(),pkg=prepare(f),after={...f.before,treatments:pkg.operations.map(o=>({...o.after,updatedAt:'2026-09-27 02:01:00'}))};assert(verifyAfter(after,pkg));
 for(const mutate of [p=>p.operations[0].after.precio_base='0',p=>p.operations.pop(),p=>p.retained.push({id:99})]){const p=structuredClone(pkg);mutate(p);const{package_sha256,...body}=p;p.package_sha256=hash(body);assert.throws(()=>verifyPackage(p),/PACKAGE_CHANGED/);}
 for(const mutate of [a=>a.treatments.pop(),a=>a.treatments[0].nombre='renamed',a=>a.dependency_hashes.appointments='changed',a=>a.references.push({kind:'PatientVouchers',treatment_id:1})]){const a=structuredClone(after);mutate(a);assert.throws(()=>verifyAfter(a,pkg));}
 const g=fixture();g.before.references=[{kind:'PatientVouchers',treatment_id:1}];const p=prepare(g),a=structuredClone(g.before);a.treatments[1]=p.operations[0].after;a.treatments[0].activo=0;assert.throws(()=>verifyAfter(a,p),/AFTER_CHANGED/);
});
test('nested budget/program references detect scalar/array IDs without confusing price, person or equipment',()=>{
 assert.deepEqual(referencedTreatmentIds({patient_id:1,price:2,equipment_ids:[1],lines:[{treatment_id:'3'},{program:{appointments:[{treatment_ids:[4,'5']}]}}]},new Set([1,2,3,4,5])),[3,4,5]);
 assert.deepEqual(referencedTreatmentIds({treatment_ids:[['4'],5]},new Set([4,5])),[4,5]);
 assert.deepEqual(referencedTreatmentIds(null,new Set([1])),[]);
});
test('operator requires an explicit CRM target and mode before using credentials',async()=>{
 await assert.rejects(run(['--mode','prepare','--target','dev']),/EXPLICIT_RETIREMENT/);
 await assert.rejects(run(['--target','crm']),/EXPLICIT_RETIREMENT/);
});
function demoFixture(){
 const f=fixture();f.source.catalogue_kind='demo';f.source.services=['Servicio ficticio 1'];
 f.before.canonical_treatments=structuredClone(f.before.treatments);
 f.before.treatments=f.before.treatments.map(t=>({...t,id_tratamiento:t.id_tratamiento+100,codigo:t.codigo.replace('CCLOUD-','CCIMP-'),createdAt:t.updatedAt,
  clinical_config:{demo:true,import_batch:DEMO_BATCH,source_system:'cliniccloud',source_service_id:t.clinical_config.raw.idServicio,unknown:{preserve:true}}}));
 f.before.appointment_usage=[{treatment_id:101,count:5,recent_count:0}];return f;
}
test('explicit demo scope hides unused duplicates even if the exact real source service has future demand; no reference remapping',()=>{
 const f=demoFixture(),p=prepare(f);verifyPackage(p);assert.deepEqual(p.operations.map(o=>o.id),[101,102]);
 assert(p.operations.every(o=>o.after.clinical_config.demo&&o.after.clinical_config.source_catalog_retirement.replacement_treatment_id===null));
 assert.deepEqual(p.before.canonical_treatments,f.before.canonical_treatments);
 const after={...f.before,treatments:p.operations.map(o=>o.after)};assert(verifyAfter(after,p));
 after.canonical_treatments=structuredClone(after.canonical_treatments);after.canonical_treatments[0].precio_base='0';assert.throws(()=>verifyAfter(after,p),/DEPENDENCIES_CHANGED/);
});
test('demo scope requires exact marker, import batch, source ID, unchanged timestamp/name and unique canonical counterpart',()=>{
 for(const mutate of [f=>f.before.treatments[0].clinical_config.demo=false,f=>f.before.treatments[0].clinical_config.import_batch='other',
  f=>f.before.treatments[0].codigo='CCIMP-other',f=>f.before.treatments[0].nombre='Edited demo',f=>f.before.treatments[0].updatedAt='2026-09-27 03:00:00',
  f=>f.before.canonical_treatments.shift(),f=>f.before.canonical_treatments.push({...f.before.canonical_treatments[0],id_tratamiento:3}),
  f=>f.before.canonical_treatments[0].clinical_config.source_batch='other',f=>f.before.canonical_treatments[0].clinica_id=99]){
  const f=demoFixture();mutate(f);assert.deepEqual(prepare(f).operations.map(o=>o.id),[102]);
 }
});
test('demo scope retains current appointments, vouchers, signatures and JSON dependencies without assuming they are fake',()=>{
 for(const kind of ['PatientVouchers','EconomicBudgetSignatureRequests.snapshot_json','appointment_snapshot','appointment_source_service']){
  const f=demoFixture();f.before.references=[{kind,treatment_id:101}];assert.deepEqual(prepare(f).operations.map(o=>o.id),[102]);
 }
 const f=demoFixture();f.before.appointment_usage[0].recent_count=1;assert.deepEqual(prepare(f).operations.map(o=>o.id),[102]);
});
test('demo scope does not remove a source-demanded service if its canonical counterpart is unavailable',()=>{
 for(const change of [t=>t.activo=0,t=>t.clinical_config.catalog_status='draft',t=>t.clinical_config.catalog_status='obsolete']){
  const f=demoFixture();change(f.before.canonical_treatments[0]);assert.deepEqual(prepare(f).operations.map(o=>o.id),[102]);
 }
 const f=demoFixture();f.before.canonical_treatments[1].activo=0;assert.equal(prepare(f).operations.length,2); // No source demand for second service.
});
test('demo mode fails closed for missing counterparts, unknown scopes and overbroad sets; default legacy mode never includes demo records',()=>{
 for(const mutate of [f=>f.before.canonical_treatments=[],f=>f.source.catalogue_kind='any',f=>f.before.treatments=Array(101).fill(f.before.treatments[0])]){
  const f=demoFixture();mutate(f);assert.throws(()=>prepare(f),/SCOPE_INVALID/);
 }
 const f=demoFixture();delete f.source.catalogue_kind;assert.equal(prepare(f).operations.length,0);
});
module.exports={fixture};
