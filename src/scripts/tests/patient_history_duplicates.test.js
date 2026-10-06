'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {patientFixture}=require('./fixtures/patient_read.fixture');
test('full-name matches stay scoped and list every candidate, prioritizing shared-contact matches',async()=>{
  const f=patientFixture();
  const rows=[{...f.patient().toJSON(),id_paciente:901,nombre:'Ana',apellidos:'Pérez',telefono_movil:'34611111111'},
    {...f.patient().toJSON(),id_paciente:902,nombre:'Ana',apellidos:'Pérez',telefono_movil:'34600000000'}];
  f.models.Paciente.findAll=async query=>{
    f.state.queries.push(query);
    return query.attributes?rows.map(row=>({id_paciente:row.id_paciente,clinica_id:71,clinicasVinculadas:[{clinica_id:71}]})):rows;
  };
  const result=await f.invoke('checkDuplicates',{query:{clinica_id:'71',telefono:'600000000',nombre:'Ana',apellidos:'Pérez'}});
  assert.equal(result.status,200);
  assert.equal(result.body.matches.length,2);
  assert.equal(result.body.paciente.id_paciente,902);
  assert.deepEqual(result.body.matches[0].reasons,['Mismo teléfono','Mismo nombre']);
  assert.deepEqual(result.body.matches[1].reasons,['Mismo nombre']);
  assert.equal(result.body.matches[1].contactMatch,false);
  assert.deepEqual(f.state.rows.at(-1).patientIds,['901','902']);
  assert.equal(f.state.rows.at(-1).resultCount,2);
  assert.equal(f.state.writes,0);
});
test('NHC and patient notes are hidden when sensitive access is denied',async()=>{
  const f=patientFixture({sensitive:false,patient:{numero_historia:'123',historia_scope:'group:9',notas_paciente:'FICTITIOUS_PRIVATE_NOTES'}});
  const result=await f.invoke('getAllPacientes');
  assert.equal(result.status,200);
  const body=result.body.items?.[0]||result.body[0];
  assert.equal(body.numero_historia,null);
  assert.equal(body.notas_paciente,null);
  assert.equal(body.historia_scope,null);
});
test('exact NHC search is prioritized before telephone substring matches',async()=>{
  const f=patientFixture();const result=await f.invoke('searchPacientes',{query:{clinica_id:'71',q:'00123'}});
  assert.equal(result.status,200);
  const query=f.state.queries.find(row=>row.order);
  assert.match(query.order[0][0].val,/numero_historia.*123/);
  assert.equal(query.order[0][1],'DESC');
});
