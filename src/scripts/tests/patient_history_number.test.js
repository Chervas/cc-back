'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeHistoryNumber,historyScope,allocatePatientHistoryNumber}=require('../../services/patientHistoryNumber.service');
const {createHistoryImportPlan}=require('../../lib/patient-history-import');
const patient=(id,name='Ana',surname='Pérez')=>({id_paciente:id,nombre:name,apellidos:surname,telefono_movil:'600111222'});
const contact=(id,number,extra={})=>({IDCONTACTO:String(id),NUM:String(number),NOMBRE:'Ana',APELLIDOS:'Pérez','TELF. MOVIL':'600111222',ALTA:'01-01-2026',...extra});
test('NHC normalization is deterministic and rejects invalid or zero identifiers',()=>{
  assert.equal(normalizeHistoryNumber(' 00123 '),'123');assert.equal(normalizeHistoryNumber(null),null);
  for(const value of ['0','ABC','-1','1.5','123'.repeat(12)])assert.throws(()=>normalizeHistoryNumber(value));
});
test('BS clinics share a group scope, unrelated clinics do not share an identifier namespace',()=>{
  assert.equal(historyScope({id_clinica:72,grupoClinicaId:29}),historyScope({id_clinica:66,grupoClinicaId:29}));
  assert.notEqual(historyScope({id_clinica:72}),historyScope({id_clinica:66}));
});
test('one local patient keeps the source NHC with more associated treatments, never multiple active aliases',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10),contact(2,20,{ALTA:'02-01-2026'})],patients:[patient(1)],
    links:[{contact_id:'1',paciente_id:1},{contact_id:'2',paciente_id:1}],clinicalCounts:{1:{count:3},2:{count:1}}});
  assert.equal(plan.operations.length,1);assert.equal(plan.operations[0].numero_historia,'10');
  assert.match(plan.operations[0].notes,/tenía varios números de historia clínica: 10, 20/);assert.match(plan.operations[0].notes,/más tratamientos asociados/);
});
test('absent associated treatments the more recently created source contact wins',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10),contact(2,20,{ALTA:'02-01-2026'})],patients:[patient(1)],
    links:[{contact_id:'1',paciente_id:1},{contact_id:'2',paciente_id:1}]});assert.equal(plan.operations[0].numero_historia,'20');
});
test('repeated NHC stays with one patient; no patient, source history or appointment is deleted',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10),contact(2,10)],patients:[patient(1),patient(2,'Luisa')],
    links:[{contact_id:'1',paciente_id:1},{contact_id:'2',paciente_id:2}],clinicalCounts:{1:{count:2},2:{count:1}}});
  assert.equal(plan.duplicates.length,1);assert.equal(plan.operations.find(op=>op.paciente_id===2).numero_historia,null);
  assert.equal(plan.operations.find(op=>op.paciente_id===1).numero_historia,'10');assert.equal(plan.operations.length,2);
});
test('shared family phone or name alone never merges different patient identities',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10)],patients:[patient(1,'Luisa')],links:[]});
  assert.equal(plan.matched.length,0);assert.equal(plan.unresolved.length,1);
});
test('a manual MOD profile can match by normalized full name plus phone',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10)],patients:[patient(1,'mod Ana')],links:[]});
  assert.equal(plan.matched.length,1);assert.equal(plan.operations[0].numero_historia,'10');
});
test('contradictory birth dates prevent a phone/name match',()=>{
  const plan=createHistoryImportPlan({contacts:[contact(1,10,{'F. NACIMIENTO':'01-01-2010'})],
    patients:[{...patient(1),fecha_nacimiento:'1980-01-01'}],links:[]});assert.equal(plan.matched.length,0);
});
test('sequential allocation locks the counter inside the caller transaction',async()=>{
  const calls=[];const tx={id:1};const db={query:async(sql,options)=>{calls.push({sql,options});
    return sql.startsWith('SELECT id_clinica')?[[{id_clinica:72,grupoClinicaId:29}]]:sql.startsWith('SELECT next_number')?[[{next_number:'14527'}]]:[[],{}];}};
  assert.deepEqual(await allocatePatientHistoryNumber(db,72,tx),{numero_historia:'14527',historia_scope:'group:29'});
  assert.ok(calls.some(c=>c.sql.includes('FOR UPDATE')));assert.ok(calls.every(c=>c.options.transaction===tx));
});
