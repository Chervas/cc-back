'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,SOURCES}=require('../../lib/cliniccloud-import/corporal-program-drafts');
const {fixture}=require('./fixtures/corporal_program_drafts.fixture');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {payloadHash,summarize,treatmentDto}=require('../../lib/treatmentPrograms.contract');
const {verifyRow}=require('../cliniccloud-import-corporal-program-drafts');
test('eleven remaining definitions contain 92 visits; preserve existing Tono, pelvic and capillary programs',()=>{
 const f=fixture();f.existingPrograms=[{name:'BS Tono'},{name:'BS Suelo Pélvico'},{name:'BS Esencial'}];const before=hash(f),p=prepare(f);
 assert.equal(hash(f),before);assert.equal(p.programs.length,11);
 assert.deepEqual(p.programs.map(p=>p.payload.appointments.length),[8,8,8,10,6,10,10,6,4,10,12]);
 assert.equal(p.programs.reduce((sum,p)=>sum+p.payload.appointments.length,0),92);
 const map=new Map(f.treatments.map(t=>[t.id_tratamiento,treatmentDto(t)]));
 for(const {payload:v}of p.programs){assert.equal(v.status,'draft');assert.equal(v.total_price,null);assert.equal(v.cadence,null);
  assert.equal(summarize(v,map).summary.ready_for_scheduling,false);assert.match(v.notes,/01\/10\/2026/);assert.match(v.notes,/no.*citas adicionales/);
 }
});
test('weekly proposals are seven-day offsets; frequency ranges never invent fixed dates',()=>{
 const p=prepare(fixture());for(const program of p.programs){const v=program.payload;
  if(['COR-05','COR-06','COR-13','COR-14','COR-15'].includes(program.code))assert.deepEqual(v.appointments.map(a=>a.offset_days),v.appointments.map((_,i)=>i*7));
  else assert(v.appointments.every(a=>a.offset_days===null));
 }
});
test('cellulite adds mesotherapy only after the combined treatment on visits 3 and 6, totaling 55 minutes',()=>{
 const f=fixture(),p=prepare(f),program=p.programs.find(p=>p.code==='COR-07');
 const map=new Map(f.treatments.map(t=>[t.id_tratamiento,treatmentDto(t)]));
 const resolved=summarize(program.payload,map);
 assert.deepEqual(resolved.appointments.map(a=>a.duration_minutes),[45,45,55,45,45,55,45,45]);
 for(const [i,a]of program.payload.appointments.entries())assert.deepEqual(a.treatment_ids,[p.bindings.cellulite.id,...([2,5].includes(i)?[p.bindings.mesotherapy.id]:[])]);
});
test('Contorno never substitutes a 75/90-minute combination or just an injectable for its missing 45-minute variant',()=>{
 const v=prepare(fixture()).programs.find(p=>p.code==='COR-05').payload;
 assert(v.appointments.every(a=>a.treatment_ids.length===0));assert.match(v.notes,/total 55 min/);
 assert.deepEqual(v.appointments.map((a,i)=>a.label.includes('mesoterapia')?i+1:0).filter(Boolean),[2,5,8]);
});
test('entry cycles keep uncertain combined time unresolved instead of borrowing another protocol',()=>{
 for(const p of prepare(fixture()).programs.filter(p=>['COR-13','COR-14','COR-15'].includes(p.code))){
  assert(p.payload.appointments.every(a=>a.treatment_ids.length===0));assert.match(p.payload.notes,/reparto|distribución/);
 }
});
test('conditional prices do not create duplicate recovery/Contorno 10 programs or automatic credits',()=>{
 const p=prepare(fixture());assert.equal(p.programs.filter(p=>p.code.startsWith('COR-09')).length,2);
 assert.equal(p.programs.filter(p=>p.code.startsWith('COR-14')).length,1);
 assert.match(p.programs.find(p=>p.code==='COR-09').payload.notes,/590.*no.*venta libre/);
 assert.match(p.programs.find(p=>p.code==='COR-14').payload.notes,/249.*crédito.*100/);
});
for(const [label,change]of [
 ['different PDF',f=>f.sourceHashes[Object.keys(SOURCES)[0]]='other'],
 ['missing tariff',f=>delete f.sourceHashes[Object.keys(SOURCES)[1]]],
 ['unknown extra source',f=>f.sourceHashes['unexpected.pdf']='hash'],
 ['different group',f=>f.clinics[0].grupoClinicaId=5],['missing clinic',f=>f.clinics=[]],
 ['tampered plan',f=>f.plan.rows[0].display_name='changed'],
 ['foreign treatment',f=>f.treatments[0].clinica_id=66],['active treatment',f=>f.treatments[0].activo=1],
 ['wrong duration',f=>f.treatments[0].duracion_min=90],['voucher as session',f=>f.treatments[0].sesiones_defecto=6],
 ['source change',f=>f.treatments[0].clinical_config.source_catalog={changed:true}],
 ['ambiguous reference',f=>f.treatments.push({...f.treatments[0],id_tratamiento:99})],
 ['human name collision',f=>f.existingPrograms.push({name:'BS CONTORNO',request_key:'human'})],
])test('rejects '+label,()=>{const f=fixture();change(f);assert.throws(()=>prepare(f));});
test('stable keys replay unchanged drafts; independent verifier rejects human edits and foreign clinics',()=>{
 const f=fixture(),p=prepare(f);f.existingPrograms=p.programs.map(p=>({name:p.payload.name,request_key:payloadHash([72,p.payload.idempotency_key])}));
 assert.deepEqual(prepare(f),p);const program=p.programs[0],{idempotency_key,...values}=program.payload;
 const row={...values,clinic_id:72,version_number:1,request_key:payloadHash([72,idempotency_key]),request_payload_hash:payloadHash(values)};
 verifyRow(row,program);assert.throws(()=>verifyRow({...row,version_number:2},program));assert.throws(()=>verifyRow({...row,clinic_id:66},program));
 assert.throws(()=>verifyRow({...row,notes:'Human edit'},program));
});
