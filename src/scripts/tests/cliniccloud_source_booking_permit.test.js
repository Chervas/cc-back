'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSourceBookingPermit,inspectSourceBookingPermit,sourcePreservedContext,sourceSolutionExceptions,preservesConfiguredConsultationSharing}=require('../../lib/cliniccloud-import/source-booking-permit');
function fixture(){const now=Date.now(),start='2030-01-07T10:00:00.000Z',end='2030-01-07T10:30:00.000Z';
 return {now,appointment:{clinica_id:66,paciente_id:1,doctor_id:50,instalacion_id:75,tratamiento_id:null,
  inicio:start,fin:end,nota:'Synthetic source',estado:'pendiente',source_system:'cliniccloud',source_reference:'delta:synthetic',
  import_metadata:{source_account:'cliniccloud-5880',source_contact_id:'999999',source_appointment_id:'888888',
   notification_suppression:{appointment_details:true,day_before:true,same_day:true},cliniccloud_reconciliation:{automation_policy:'hold'}}},
 source:{kind:'appointment',status:'pendiente',source_contact_id:'999999',start_utc:start,end_utc:end,
  start_local:'2030-01-07T11:00:00',end_local:'2030-01-07T11:30:00',details:'Synthetic source',validation_errors:[]},
 sourceAppointmentId:'888888',liveCapturedAt:new Date(now).toISOString(),sourceEvidenceSha256:'a'.repeat(64),
 reviewedBy:'Synthetic operator',reason:'Explicitly preserve this verified source interval; report imported conflicts',equipmentIds:[]};}
test('source permit is in-process only, source-bound, fresh and preserves the local open state',()=>{
 const f=fixture(),token=createSourceBookingPermit(f);assert(inspectSourceBookingPermit(token,f.appointment,f.now));
 assert.throws(()=>inspectSourceBookingPermit({},f.appointment,f.now),/PERMIT_INVALID/);
 assert.throws(()=>inspectSourceBookingPermit(structuredClone(token),f.appointment,f.now),/PERMIT_INVALID/);
 assert.throws(()=>inspectSourceBookingPermit(token,{...f.appointment,fin:'2030-01-07T10:45:00Z'},f.now),/PERMIT_INVALID/);
 assert.throws(()=>inspectSourceBookingPermit(token,f.appointment,f.now+3600001),/PERMIT_INVALID/);
 f.appointment.estado='recordatorio_confirmado';assert(createSourceBookingPermit(f));
});
test('cannot permit wrong identity, account, time, note, completed care, purchase or live source ID',()=>{
 for(const change of [f=>f.appointment.clinica_id=1,f=>f.source.source_contact_id='777777',
  f=>f.source.end_utc='2030-01-07T10:45:00.000Z',f=>f.source.details='Another source',
  f=>f.appointment.estado='completada',f=>f.appointment.voucher_id=1,f=>f.sourceAppointmentId='777777',
  f=>f.source.source_external_id='777777',
  f=>{delete f.appointment.import_metadata.source_account;f.appointment.import_metadata.raw={idEmpresa:5880};},
  f=>f.appointment.import_metadata.notification_suppression.day_before=false,f=>f.liveCapturedAt=new Date(f.now+1).toISOString()]){
  const f=fixture();change(f);assert.throws(()=>createSourceBookingPermit(f),/PERMIT_INVALID/);
 }
});
test('compound source profile cannot change duration, first resources or authorized equipment',()=>{
 const f=fixture();f.profile={version:2,phases:[{key:'one',duration_minutes:15,installation_ids:[75],
  professionals:{mode:'any',ids:[50],preferred_id:50}},{key:'two',duration_minutes:15,installation_ids:[73],
  professionals:{mode:'any',ids:[50],preferred_id:50}}]};assert(createSourceBookingPermit(f));
 for(const change of [f=>f.profile.phases[0].duration_minutes=20,f=>f.profile.phases[0].installation_ids=[73],
  f=>f.profile.phases[0].professionals.ids=[53],f=>f.profile.phases[1].equipment_requirements=[{equipment_ids:[15]}]]){
  const x=structuredClone(f);change(x);assert.throws(()=>createSourceBookingPermit(x),/PERMIT_INVALID/);
 }
});
test('source exceptions never mutate the availability context or equipment status',()=>{
 const start=new Date('2030-01-07T10:00Z'),end=new Date('2030-01-07T10:30Z');
 const original={doctors:new Map([[50,{windows:[],busy:[{start,end,appointment_id:1}]}]]),
  installations:new Map([[75,{windows:[],busy:[{start,end,appointment_id:2}]}]]),
  equipment:new Map([[15,{status:'unavailable',busy:[{start,end,appointment_id:3}]}]]),patientBusy:[{start,end}],clinicWindows:[]};
 const result=sourcePreservedContext(original,start,end);assert.equal(result.conflicts.length,4);
 assert.equal(result.context.equipment.get(15).status,'unavailable');assert.equal(original.doctors.get(50).busy.length,1);
 assert.equal(result.context.doctors.get(50).busy.length,0);assert.equal(original.patientBusy.length,1);
});
test('report compares exact phase intervals, not the entire visit against every room',()=>{
 const win={start:'2030-01-07T10:00Z',end:'2030-01-07T11:00Z'},busy={start:'2030-01-07T10:00Z',end:'2030-01-07T10:15Z',appointment_id:9};
 const context={doctors:new Map([[50,{windows:[win],busy:[]}]]),installations:new Map([[75,{windows:[win],busy:[busy]}]]),
  patientBusy:[],clinicWindows:[win]};
 const solution={start_at:'2030-01-07T10:00Z',end_at:'2030-01-07T10:30Z',phases:[{key:'second',
  start_at:'2030-01-07T10:15Z',end_at:'2030-01-07T10:30Z',installation_id:75,doctor_ids:[50]}]};
 assert.deepEqual(sourceSolutionExceptions(context,solution),{conflicts:[],outside_schedule:[]});
 solution.phases[0].start_at='2030-01-07T10:14Z';assert.equal(sourceSolutionExceptions(context,solution).conflicts.length,1);
});
test('explicit physical units cannot become one alternative machine',()=>{
 const f=fixture();f.equipmentIds=[14,15];f.profile={version:2,phases:[{key:'one',duration_minutes:30,
  installation_ids:[75],professionals:{mode:'any',ids:[50],preferred_id:50},
  equipment_requirements:[{equipment_ids:[14,15]}]}]};
 assert.throws(()=>createSourceBookingPermit(f),/PERMIT_INVALID/);
 f.profile.phases[0].equipment_requirements=[{equipment_ids:[14]},{equipment_ids:[15]}];
 assert(createSourceBookingPermit(f));
});
test('source exception cannot enable room sharing but preserves explicitly configured unlimited consultations',()=>{
 const context={doctors:new Map([[120,{allow_overlap_confirmation:true}]]),
  installations:new Map([[76,{allow_overlap_confirmation:true,overlap_capacity:null}]])};
 const profile={phases:[{installation_ids:[76],professionals:{mode:'any',ids:[120]}}]};
 assert.equal(preservesConfiguredConsultationSharing(context,profile,[]),true);
 assert.equal(preservesConfiguredConsultationSharing(context,profile,[14]),false);
 context.installations.get(76).overlap_capacity=2;
 assert.equal(preservesConfiguredConsultationSharing(context,profile,[]),false);
 context.installations.get(76).overlap_capacity=null;context.doctors.get(120).allow_overlap_confirmation=false;
 assert.equal(preservesConfiguredConsultationSharing(context,profile,[]),false);
});
