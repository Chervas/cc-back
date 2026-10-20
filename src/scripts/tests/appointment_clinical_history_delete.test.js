'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=require.resolve('../../controllers/citas.controller');
const source=fs.readFileSync(file,'utf8');
const method=source.slice(source.indexOf('exports.deleteCita ='),source.indexOf('exports.reagendarCita ='));
function fixture({primary=false,linked=false,revision=false,arrivesOnLock=false,failDetach=false}={}){
  let report=primary,join=linked;const calls=[];
  const row={id_cita:42,clinica_id:72,paciente_id:9,estado:'cancelada',lead_intake_id:null};
  const tx={LOCK:{UPDATE:'UPDATE'}};
  const db={
    AppointmentClinicalReport:{findOne:async query=>{calls.push(['report',!!query.transaction]);return report?{id:7}:null;}},
    ClinicalEpisodeAppointment:{findOne:async query=>{calls.push(['join',!!query.transaction]);return join?{appointment_id:42}:null;}},
    AppointmentClinicalReportRevision:{findOne:async query=>{calls.push(['revision',!!query.transaction]);assert.equal(query.attributes[0],'id');return revision?{id:9}:null;}},
    sequelize:{transaction:async fn=>{calls.push(['begin']);try{await fn(tx);calls.push(['commit']);}catch(error){calls.push(['rollback']);throw error;}}},
    ConsentSignaturePackage:{update:async()=>{calls.push(['detach-package']);}},
    PatientConsentDocument:{update:async()=>{calls.push(['detach-document']);if(failDetach)throw Error('OWNED_DETACH_FAILURE');}},
  };
  const nativeRequire=createRequire(file),exports={};let status=200,body;
  const context={exports,db,asyncHandler:fn=>fn,denyAppointmentManageAccessIfNeeded:async()=>false,
    CitaPaciente:{findByPk:async(id,query)=>{if(query?.transaction){assert.equal(query.lock,'UPDATE');calls.push(['lock']);if(arrivesOnLock)report=true;}return row;},
      destroy:async()=>calls.push(['destroy'])},
    appointmentAutomationV2Runtime:{cancelActiveExecutionsForCita:async()=>calls.push(['cancel-flows'])},
    appointmentNotificationCleanup:{markAutomationNotificationsReadForAppointment:async()=>calls.push(['read-notifications'])},
    syncLeadStatusFromAppointments:async()=>calls.push(['lead']),emitAppointmentSocketEvent:()=>calls.push(['emit']),
    require:name=>name==='../services/appointmentPatientLinks.service'?{membership:async()=>false}:
      name==='../lib/program-appointment-context'?{hasProgramAppointmentReference:()=>false}:nativeRequire(name),
  };
  vm.runInNewContext(method,context);
  const res={status:code=>{status=code;return res;},json:value=>{body=value;return res;}};
  return{calls,row,execute:()=>exports.deleteCita({params:{id:'42'}},res),status:()=>status,body:()=>body};
}
for(const source of ['primary','linked','revision'])test('a '+source+' episode prevents deletion before notification or automation effects',async()=>{
  const f=fixture({[source]:true});await f.execute();assert.equal(f.status(),409);assert.equal(f.body().code,'appointment_clinical_history_preserved');
  assert(!f.calls.some(([action])=>['begin','cancel-flows','read-notifications','destroy','emit'].includes(action)));assert.equal(f.row.estado,'cancelada');
});
test('a first clinical save committed while deletion waits for the reservation lock is preserved',async()=>{
  const f=fixture({arrivesOnLock:true});await f.execute();assert.equal(f.status(),409);assert.equal(f.body().code,'appointment_clinical_history_preserved');
  assert(f.calls.some(([action])=>action==='rollback'));assert(!f.calls.some(([action])=>['cancel-flows','read-notifications','detach-package','detach-document','destroy','emit'].includes(action)));
  const lock=f.calls.findIndex(([action])=>action==='lock'),check=f.calls.findIndex(([action,inTx])=>action==='report'&&inTx);assert(check>lock);
});
test('a cancelled reservation without history can still be deleted after the locked checks',async()=>{
  const f=fixture();await f.execute();assert.equal(f.status(),200);assert.equal(f.body().success,true);
  const at=action=>f.calls.findIndex(([name])=>name===action);assert(at('lock')<at('detach-package'));assert(at('detach-document')<at('destroy'));assert(at('commit')<at('emit'));
});
test('a detach failure rolls back deletion and emits no false deletion receipt',async()=>{
  const f=fixture({failDetach:true});await assert.rejects(f.execute(),/OWNED_DETACH_FAILURE/);
  assert(f.calls.some(([action])=>action==='rollback'));assert(!f.calls.some(([action])=>['cancel-flows','read-notifications','destroy','emit'].includes(action)));
});
