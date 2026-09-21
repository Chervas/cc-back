'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compoundSourceEvidence}=require('../../lib/cliniccloud-import/compound-source-evidence');
function fixture(){
  const concepts=[{idServicio:1,asunto:'FACIAL '},{idServicio:2,asunto:'CAPILAR'},{idServicio:3,asunto:' CORPORAL '}];
  const raw=[900,901].map((id,i)=>({idCita:id,idContacto:77,idEmpresa:5880,estado:0,fechaIni:'2026-09-24',horaIni:'18:30:00',fechaFin:'2026-09-24',horaFin:'19:45:00',agenda:{nombre:i?'ROOM B':'ROOM A'},conceptos:structuredClone(concepts),detalles:'Facial, capilar y corporal'}));
  return {now:Date.parse('2026-09-21T20:10:00Z'),
    history:{source_account:'cliniccloud-5880',captured_at:'2026-09-21T20:00:00Z',patients:[{contact_id:'77',rows:raw}]},
    live:{source_account:'cliniccloud-5880',captured_at:'2026-09-21T20:01:00Z',rows:raw.map(r=>({appointment_id:r.idCita,contact_id:77,state:0,start:'2026-09-24 18:30:00',end:'2026-09-24 19:45:00',agenda:r.agenda.nombre,service:'CORPORAL ',details:r.detalles}))},
    actions:raw.map((r,i)=>({source:{kind:'appointment',source_contact_id:'77',start_local:'2026-09-24T18:30:00',end_local:'2026-09-24T19:45:00',agenda_key:r.agenda.nombre,service_key:'FACIAL -CAPILAR- CORPORAL',status:'pendiente',details:'Facial capilar y corporal',validation_errors:[],provenance:{row_key:'synthetic:'+i}}}))};
}
test('restores all concepts for parallel matching without changing raw evidence or inferring phases',()=>{
 const f=fixture(),before=structuredClone(f),r=compoundSourceEvidence(f);assert.deepEqual(f,before);
 assert.equal(r.live.rows.length,2);assert.equal(r.live.rows[0].service,'FACIAL -CAPILAR- CORPORAL');
 assert.equal(r.receipt.entries[0].source_concepts.length,3);assert.equal(r.receipt.phase_durations_inferred,false);
 assert.equal(r.receipt.entries[0].original_note,'Facial, capilar y corporal');
});
for(const [name,mutate] of [
 ['stale history',f=>f.now+=3600000], ['wrong company',f=>f.history.patients[0].rows[0].idEmpresa=2],
 ['different contact',f=>f.history.patients[0].rows[0].idContacto=78], ['changed source ID',f=>f.live.rows[0].appointment_id=902],
 ['different duration',f=>f.history.patients[0].rows[0].horaFin='20:00:00'], ['cancelled history',f=>f.history.patients[0].rows[0].estado=-2],
 ['cancelled calendar',f=>f.live.rows[0].state=-2], ['different clinical note',f=>f.history.patients[0].rows[0].detalles='Another act'],
 ['missing concept',f=>f.history.patients[0].rows[0].conceptos.pop()], ['different underlying service ID',f=>f.history.patients[0].rows[1].conceptos[1].idServicio=4],
 ['different displayed treatment',f=>f.live.rows[0].service='Another'], ['duplicate source record',f=>f.history.patients[0].rows.push(structuredClone(f.history.patients[0].rows[0]))],
 ['different CSV procedure',f=>f.actions[1].source.service_key='FACIAL'], ['different CSV notes',f=>f.actions[1].source.details='Changed'],
])test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>compoundSourceEvidence(f),/INVALID/)});
