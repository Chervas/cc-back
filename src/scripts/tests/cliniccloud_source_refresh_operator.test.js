'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {hash,localToUtc}=require('../../lib/cliniccloud-import/adapter');
const {prepareSourceRefresh,patchSourceRefresh,storedSourceRefresh,sourceRefreshChanged,
  normalizedSourceRefreshRow}=require('../../lib/cliniccloud-import/source-refresh');
const {importTreatmentPending,appointmentImportReview,importReviewVersion}=require('../../lib/appointment-import-review');
const {importedEquipmentProfile}=require('../../lib/appointment-import-equipment');
const {occupancyForSolution}=require('../../lib/booking-profile-solver');

function fixture() {
  const now=Date.parse('2026-09-27T09:00:00Z');
  const before={id_cita:1,paciente_id:2,clinica_id:72,source_system:'cliniccloud',source_reference:'appointment:1001',
    inicio:'2026-09-28T08:00:00.000Z',fin:'2026-09-28T08:30:00.000Z',estado:'pendiente',
    doctor_id:3,instalacion_id:4,tratamiento_id:5,nota:'old source act',titulo:'Obsolete imported title',tipo_cita:'continuacion',
    created_at:'2026-09-01T00:00:00.000Z',updated_at:'2026-09-01T00:00:00.000Z',
    updated_by:null,voucher_id:null,lead_intake_id:null,es_provisional:0,hold_expires_at:null,
    import_metadata:{source_account:'cliniccloud-5880',source_contact_id:'101',source_appointment_id:'1001',source_service_id:'201',
      raw:{idCita:'1001',idContacto:'101',idAgenda:'301',fechaIni:'2026-09-28',horaIni:'10:00:00',
        fechaFin:'2026-09-28',horaFin:'10:30:00',estado:'0',detalles:'old source act'}}};
  const source={kind:'appointment',source_external_id:'1001',source_contact_id:'101',
    start_local:'2026-09-29T10:00:00',end_local:'2026-09-29T11:00:00',
    start_utc:'2026-09-29T08:00:00.000Z',end_utc:'2026-09-29T09:00:00.000Z',
    agenda_key:'SYNTHETIC ROOM',service_key:'SYNTHETIC OLD TITLE',status:'pendiente',details:'new source act',
    validation_errors:[],provenance:{source_row:2,file_sha256:hash('file'),row_sha256:hash('row'),row_key:'row-2'}};
  const detail={idEmpresa:5880,idCita:1001,idContacto:101,idAgenda:301,fechaIni:'2026-09-29',horaIni:'10:00:00',
    fechaFin:'2026-09-29',horaFin:'11:00:00',estado:0,agenda:{nombre:'Synthetic room'},
    cita_conceptos:[{idServicio:201,asunto:'Synthetic old title'}],detalles:source.details};
  return {before,source,detail,liveCapturedAt:new Date(now-1000).toISOString(),sourcePlanSha256:hash('plan'),
    coverage:{start:'2026-09-28',end:'2026-10-04'},
    resources:{doctor_id:3,installation_id:6,equipment_ids:[7],evidence_sha256:hash('reviewed physical resources')},
    operatorReview:{version:1,scope:'source_schedule_and_clinical_refresh',source_authoritative:true,
      notes_authoritative:true,regenerate_booking:true,clear_treatment:true},
    reviewedBy:'Synthetic operator',reason:'Exact authenticated source ID confirms the changed source act and schedule',now};
}
function staleBooking(f) {
  f.before.import_metadata.booking={version:1,profile:{version:2,phases:[{key:'appointment',label:'',duration_minutes:30,
    installation_ids:[4],professionals:{mode:'any',ids:[3],preferred_id:3},equipment_requirements:[{equipment_ids:[7]}]}]},
    phases:[{key:'appointment',label:'',start_at:f.before.inicio,end_at:f.before.fin,installation_id:4,
      doctor_ids:[3],equipment:[{id:7,turnaround_minutes:0}],staff_time_scope:'phase'}],warnings:[],priority_acknowledged:false};
  return f;
}

test('explicit source review clears the obsolete treatment and copies source notes without altering original evidence',()=>{
  const f=fixture(),original=structuredClone(f),receipt=prepareSourceRefresh(f),after=patchSourceRefresh(f.before,receipt,f.now);
  assert.equal(after.tratamiento_id,null);assert.equal(after.nota,f.source.details);
  assert.equal(after.titulo,f.source.service_key);assert.equal(receipt.previous_title,f.before.titulo);
  assert.equal(after.inicio,f.source.start_utc);assert.equal(after.fin,f.source.end_utc);
  for(const key of Object.keys(f.before).filter(k=>!['inicio','fin','nota','titulo','tratamiento_id','instalacion_id','updated_at','import_metadata'].includes(k))) {
    assert.deepEqual(after[key],f.before[key]);
  }
  for(const key of Object.keys(f.before.import_metadata))assert.deepEqual(after.import_metadata[key],f.before.import_metadata[key]);
  assert.equal(storedSourceRefresh(after,after.import_metadata).clinical_sha256,receipt.clinical_sha256);
  assert(importTreatmentPending(after));
  const review=appointmentImportReview(after);
  assert(review.pending_assignment.includes('treatment'));assert(review.resources_need_review);
  assert.equal(review.source_service,f.source.service_key);
  assert.doesNotMatch(JSON.stringify(review),/new source act|old source act/);
  assert.doesNotThrow(()=>importedEquipmentProfile(after,{equipment_ids:[7],expected_version:importReviewVersion(after),source_sha256:hash('proof')}));
  assert.deepEqual(f,original);
});

test('a source-generated single-phase snapshot can be retired while its immutable before-image is kept in the receipt',()=>{
  const f=staleBooking(fixture()),prior=structuredClone(f.before.import_metadata.booking),receipt=prepareSourceRefresh(f);
  const after=patchSourceRefresh(f.before,receipt,f.now);
  assert.deepEqual(receipt.previous_booking,prior);assert.equal(after.import_metadata.booking,undefined);
  assert.equal(after.import_metadata.raw.detalles,'old source act');
  assert.equal(sourceRefreshChanged(after,storedSourceRefresh(after,after.import_metadata)),false);
  const tampered=structuredClone(f.before);tampered.import_metadata.booking.phases[0].doctor_ids=[9];
  assert.throws(()=>patchSourceRefresh(tampered,receipt,f.now));
  const malformed=staleBooking(fixture());malformed.before.import_metadata.booking.profile.phases.push(
    structuredClone(malformed.before.import_metadata.booking.profile.phases[0]));
  assert.throws(()=>prepareSourceRefresh(malformed),{code:'SOURCE_REFRESH_BOOKING_SNAPSHOT_REQUIRES_REVIEW'});
});

test('the exact known legacy import note format is reconciled, while a local note edit remains protected',()=>{
  const f=fixture();f.before.nota='Detalles ClinicCloud: old source act\nConceptos importados: Synthetic old title';
  assert.equal(patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now).nota,f.source.details);
  f.before.nota+='\nLocal care instruction';
  assert.throws(()=>prepareSourceRefresh(f),{code:'SOURCE_REFRESH_LOCAL_NOTE_PROTECTED'});
});

test('changed legacy service identity requires an earlier exact source detail, never a name match',()=>{
  const f=fixture();
  f.originalDetail={...structuredClone(f.detail),fechaIni:'2026-09-28',fechaFin:'2026-09-28',horaFin:'10:30:00',detalles:'old source act'};
  f.originalDetailCapturedAt=new Date(f.now-2000).toISOString();
  f.source.service_key='SYNTHETIC NEW TITLE';f.detail.cita_conceptos=[{idServicio:202,asunto:'Synthetic new title'}];
  const after=patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now);
  assert.equal(appointmentImportReview(after).source_service,'SYNTHETIC NEW TITLE');
  assert.equal(after.import_metadata.source_service_id,'201');
  assert.equal(after.import_metadata.raw.detalles,'old source act');
  const missing=structuredClone(f);delete missing.originalDetail;delete missing.originalDetailCapturedAt;
  assert.throws(()=>prepareSourceRefresh(missing));
  const foreign=structuredClone(f);foreign.originalDetail.idCita=999;
  assert.throws(()=>prepareSourceRefresh(foreign),{code:'SOURCE_REFRESH_BASELINE_DETAIL_INVALID'});
});

test('source review preserves an existing open canonical status and retains HOLD',()=>{
  const f=fixture();f.before.estado='info_confirmada';
  const after=patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now);
  assert.equal(after.estado,'info_confirmada');
  assert.equal(after.import_metadata.cliniccloud_reconciliation.automation_policy,'hold');
  assert.equal(sourceRefreshChanged(after,storedSourceRefresh(after,after.import_metadata)),false);
});

test('later source refreshes retain original treatment clearance, both receipts and all old intervals',()=>{
  const f=fixture(),first=prepareSourceRefresh(f),after=patchSourceRefresh(f.before,first,f.now);
  const next={...f,before:after,now:f.now+10000,liveCapturedAt:new Date(f.now+9000).toISOString(),
    operatorReview:{...f.operatorReview,clear_treatment:false},
    source:{...f.source,start_local:'2026-09-30T10:00:00',end_local:'2026-09-30T11:00:00',
      start_utc:'2026-09-30T08:00:00.000Z',end_utc:'2026-09-30T09:00:00.000Z'},
    detail:{...f.detail,fechaIni:'2026-09-30',fechaFin:'2026-09-30'}};
  const saved=patchSourceRefresh(next.before,prepareSourceRefresh(next),next.now);
  assert.deepEqual(saved.import_metadata.cliniccloud_source_refreshes.receipts[0],first);
  assert.equal(storedSourceRefresh(saved,saved.import_metadata).entries.length,3);
  assert(importTreatmentPending(saved));
});

for(const [label,change,code] of [
  ['no explicit authorization',f=>{delete f.operatorReview;}],
  ['arbitrary review option',f=>{f.operatorReview.force=true;},'SOURCE_REFRESH_OPERATOR_SCOPE_INVALID'],
  ['missing note authority',f=>{f.operatorReview.notes_authoritative=false;},'SOURCE_REFRESH_OPERATOR_SCOPE_INVALID'],
  ['mismatched exact source ID',f=>{f.source.source_external_id='1002';}],
  ['keeping an obsolete treatment',f=>{f.operatorReview.clear_treatment=false;},'SOURCE_REFRESH_TREATMENT_CLEAR_REQUIRED'],
  ['local editor',f=>{f.before.updated_by=9;},'SOURCE_REFRESH_LOCAL_EDITOR_PROTECTED'],
  ['care already started',f=>{f.before.care_started_at='2026-09-26T09:00:00Z';},'SOURCE_REFRESH_CLINICAL_CARE_PROTECTED'],
  ['completed care',f=>{f.before.estado='completada';}],
  ['clinical resource approval',f=>{f.before.import_metadata.import_resource_resolution={version:1};}],
  ['clinical treatment approval',f=>{f.before.import_metadata.import_treatment_resolution={version:1};}],
  ['program ownership',f=>{f.before.voucher_id=9;}],
  ['native appointment',f=>{f.before.source_system=null;}],
  ['stale source proof',f=>{f.now+=3600001;}],
])test('operator source refresh rejects '+label,()=>{
  const f=fixture();change(f);assert.throws(()=>prepareSourceRefresh(f),code?{code}:/SOURCE_REFRESH_REVIEW_REQUIRED/);
});

test('malformed or drifted refresh evidence cannot grant treatment review or disclose a current source label',()=>{
  const f=fixture(),after=patchSourceRefresh(f.before,prepareSourceRefresh(f),f.now);
  for(const change of [r=>{r.nota='Local edited note';},r=>{r.import_metadata.raw.detalles='Changed';},
    r=>{r.import_metadata.cliniccloud_source_refreshes.receipts[0].operator_review.clear_treatment=false;}]) {
    const row=structuredClone(after);change(row);
    assert.equal(importTreatmentPending(row),false);
    assert.equal(appointmentImportReview(row).source_service,undefined);
  }
});

function refreshModule(command,availability) {
  const filename=path.resolve(__dirname,'../../lib/cliniccloud-import/refresh-reviewed-appointment.js');
  const localRequire=createRequire(filename),context={module:{exports:{}},require:id=>{
    if(id==='../../services/appointmentBookingCommand.service')return command;
    if(id==='../../services/appointmentBookingAvailability.service')return availability;
    if(id==='./source-booking-permit')return {mutateSourceImportedBooking:command.mutateSourceImportedBooking,
      inspectSourceBookingPermit:command.inspectSourceBookingPermit};
    return localRequire(id);
  },Date};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});return context.module.exports;
}
test('refresh regenerates canonical machine attention under locks and preserves every other appointment field',async()=>{
  const f=staleBooking(fixture()),receipt=prepareSourceRefresh(f),before=structuredClone(f.before),
    state={current:structuredClone(before),occupancy:[],calls:[]};
  const transaction={options:{isolationLevel:'READ COMMITTED'},LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}};
  const row={id_cita:1,toJSON:()=>structuredClone(state.current),reload:async()=>row,
    update:async(values,options)=>{assert.deepEqual(Array.from(options.fields),['import_metadata']);assert.equal(options.hooks,false);
      state.current={...state.current,...structuredClone(values)};return row;}};
  const db={CitaPaciente:{findByPk:async()=>row},Clinica:{findByPk:async()=>({id_clinica:72})},
    Tratamiento:{findByPk:async()=>{throw Error('The obsolete treatment must not be loaded');}},
    AppointmentBookingOccupancy:{findAll:async()=>structuredClone(state.occupancy)},sequelize:{query:async(sql,{replacements})=>{
      state.calls.push('sql');const fields=sql.match(/SET (.*) WHERE/)[1].split(',').map(p=>p.split('=')[0]);
      assert.equal(replacements.at(-1),1);
      for(const [i,k]of fields.entries())state.current[k]=k==='import_metadata'?JSON.parse(replacements[i]):
        replacements[i] instanceof Date?replacements[i].toISOString():replacements[i];
    }}};
  const permit=Object.freeze({opaque:'synthetic permit'});
  const command={inspectSourceBookingPermit:()=>({profile:null}),lockBookingResources:async({resourceKeys})=>{state.calls.push('locks');
    assert(resourceKeys.includes('doctor:3'));assert(resourceKeys.includes('installation:6'));assert(resourceKeys.includes('equipment:7'));},
    mutateSourceImportedBooking:async options=>{
      state.calls.push('canonical');assert.equal(options.transaction,transaction);
      assert.equal(options.sourceImportPermit,permit);assert.equal(state.current.import_metadata.booking,undefined);
      const profile=importedEquipmentProfile(state.current,{equipment_ids:options.equipmentIds,
        expected_version:importReviewVersion(state.current),source_sha256:receipt.resources.evidence_sha256});
      const start=Date.parse(state.current.inicio),end=Date.parse(state.current.fin);
      const solution={start_at:state.current.inicio,end_at:state.current.fin,warnings:[],phases:[{key:'appointment',label:'',
        start_at:state.current.inicio,end_at:state.current.fin,installation_id:6,doctor_ids:[3],equipment:[{id:7,turnaround_minutes:0}],
        staff_intervals:[{start_at:new Date(start).toISOString(),end_at:new Date(start+5*60000).toISOString()},
          {start_at:new Date(end-5*60000).toISOString(),end_at:new Date(end).toISOString()}]}]};
      const values={...state.current,import_metadata:{...state.current.import_metadata,
        cliniccloud_source_booking:{version:'cliniccloud-source-booking/1',policy:'preserve_source_interval_report_conflicts'},
        booking:{version:1,profile,phases:solution.phases}}};
      const saved=await options.persist({existing:row,values,solution});
      state.occupancy=occupancyForSolution(solution,new Map([[6,'installation:6']]));return saved;
    }};
  const helper=refreshModule(command,{resolveInstallationKeys:async()=>({keys:new Map([[4,'installation:4'],[6,'installation:6']])})});
  const saved=await helper.refreshReviewedAppointment({db,receipt,transaction,sourceImportPermit:permit,now:f.now,
    beforeUpdate:async({before:locked})=>{assert.equal(hash(locked),hash(before));state.calls.push('guard');}});
  assert.deepEqual(state.calls,['locks','guard','sql','canonical']);assert.equal(saved.id_cita,1);
  assert.equal(state.current.tratamiento_id,null);assert.equal(state.current.nota,f.source.details);
  assert.equal(state.occupancy.filter(r=>r.resource_kind==='doctor').length,2);
  for(const kind of ['installation','equipment']){
    const occupation=state.occupancy.find(r=>r.resource_kind===kind);
    assert.equal(occupation.start_at,f.source.start_utc);assert.equal(occupation.end_at,f.source.end_utc);
  }
  assert.deepEqual(state.current.import_metadata.cliniccloud_source_refreshes.receipts[0].previous_booking,before.import_metadata.booking);
});

test('clinical dependency guard failures perform no source patch or canonical booking',async()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f),calls=[];
  const row={id_cita:1,toJSON:()=>structuredClone(f.before),reload:async()=>row};
  const db={CitaPaciente:{findByPk:async()=>row},Clinica:{findByPk:async()=>({})},
    AppointmentBookingOccupancy:{findAll:async()=>[]},sequelize:{query:async()=>calls.push('write')}};
  const helper=refreshModule({lockBookingResources:async()=>{},mutateAppointmentBooking:async()=>calls.push('canonical')},
    {resolveInstallationKeys:async()=>({keys:new Map([[4,'installation:4'],[6,'installation:6']])})});
  await assert.rejects(helper.refreshReviewedAppointment({db,receipt,now:f.now,
    transaction:{options:{isolationLevel:'READ COMMITTED'},LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}},
    beforeUpdate:async()=>{throw Error('DEPENDENT_HISTORY:AppointmentClinicalReports');}}),/DEPENDENT_HISTORY/);
  assert.deepEqual(calls,[]);
});

test('a source permit persists its audit and booking snapshot when the appointment has no machine',async()=>{
  const f=fixture();f.resources.equipment_ids=[];
  const receipt=prepareSourceRefresh(f),state={row:structuredClone(f.before),occupancy:[],metadataWrites:0};
  const row={id_cita:1,toJSON:()=>structuredClone(state.row),reload:async()=>row,
    update:async(values,options)=>{assert.equal(options.hooks,false);state.metadataWrites++;
      state.row={...state.row,...structuredClone(values)};return row;}};
  const db={CitaPaciente:{findByPk:async()=>row},Clinica:{findByPk:async()=>({})},
    AppointmentBookingOccupancy:{findAll:async()=>state.occupancy},sequelize:{query:async(sql,{replacements})=>{
      const fields=sql.match(/SET (.*) WHERE/)[1].split(',').map(p=>p.split('=')[0]);
      for(const[i,k]of fields.entries())state.row[k]=k==='import_metadata'?JSON.parse(replacements[i]):
        replacements[i] instanceof Date?replacements[i].toISOString():replacements[i];
    }}};
  const helper=refreshModule({inspectSourceBookingPermit:()=>({profile:null}),lockBookingResources:async()=>{},mutateSourceImportedBooking:async({values,existing,persist})=>{
    const solution={start_at:values.inicio,end_at:values.fin,warnings:[],phases:[{key:'appointment',label:'',
      start_at:values.inicio,end_at:values.fin,doctor_ids:[3],installation_id:6}]};
    const audit={version:'cliniccloud-source-booking/1',policy:'preserve_source_interval_report_conflicts'};
    const saved=await persist({existing,solution,values:{...values,import_metadata:{...values.import_metadata,
      cliniccloud_source_booking:audit,booking:{version:1,phases:solution.phases}}}});
    state.occupancy=occupancyForSolution(solution,new Map([[6,'installation:6']]));return saved;
  }},{resolveInstallationKeys:async()=>({keys:new Map([[4,'installation:4'],[6,'installation:6']])})});
  await helper.refreshReviewedAppointment({db,receipt,now:f.now,sourceImportPermit:{},
    transaction:{options:{isolationLevel:'READ COMMITTED'},LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}},beforeUpdate:async()=>{}});
  assert.equal(state.metadataWrites,1);assert(state.row.import_metadata.booking);
  assert.equal(state.row.import_metadata.cliniccloud_source_booking.policy,'preserve_source_interval_report_conflicts');
  assert.equal(state.occupancy.length,2);
});

test('a changed guarded row prevents every source write even if the dependency callback returns successfully',async()=>{
  const f=fixture(),receipt=prepareSourceRefresh(f),state={row:structuredClone(f.before),writes:0};
  const row={id_cita:1,toJSON:()=>structuredClone(state.row),reload:async()=>row};
  const db={CitaPaciente:{findByPk:async()=>row},Clinica:{findByPk:async()=>({})},
    AppointmentBookingOccupancy:{findAll:async()=>[]},sequelize:{query:async()=>state.writes++}};
  const helper=refreshModule({lockBookingResources:async()=>{},mutateAppointmentBooking:async()=>{throw Error('Must not book');}},
    {resolveInstallationKeys:async()=>({keys:new Map([[4,'installation:4'],[6,'installation:6']])})});
  await assert.rejects(helper.refreshReviewedAppointment({db,receipt,now:f.now,
    transaction:{options:{isolationLevel:'READ COMMITTED'},LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}},
    beforeUpdate:async()=>{state.row.nota='Concurrent local clinical edit';}}),/SOURCE_REFRESH_GUARDED_ROW_CHANGED/);
  assert.equal(state.writes,0);
});
