'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalized,validateScope,verifyCommitted}=require('../qa/crm-program-resume-fixture');
const fixture=()=>({clinic:{id_clinica:82,configuracion:{qa_demo:{key:'bs-medical-accounting-demo-v1',synthetic_data_only:true}}},
 patient:{public_id:'demo_bsmedical_capillary_v1',id_paciente:2812,clinica_id:82},
 voucher:{public_id:'9a959236-3a68-484f-90ea-b09fbed81591',id:941,clinic_id:82,patient_id:2812,budget_id:1,source_system:'treatment_program',available_units:'2.00'},
 budget:{id:1,clinic_id:82,source_reference:'program-booking-20260914-v1-regression'},
 appointment:{id_cita:75147,clinica_id:82,paciente_id:2812,voucher_id:941,estado:'reprogramada',source_system:'treatment_program',import_metadata:{automation_policy:'hold',notification_suppression:{same_day:true,day_before:true,appointment_details:true}}},
 session:{session_key:'session_2',voucher_id:941,appointment_id:75147,consumption_movement_id:null}});
test('accepts only the existing synthetic interrupted-session fixture',()=>validateScope(fixture()));
for(const [name,change] of [
 ['real clinic',f=>f.clinic.id_clinica=72],['missing synthetic marker',f=>f.clinic.configuracion.qa_demo.synthetic_data_only=false],
 ['other patient',f=>f.patient.public_id='real-patient'],['foreign patient owner',f=>f.voucher.patient_id=999],
 ['other purchase',f=>f.voucher.public_id='another-purchase'],['edited budget',f=>f.budget.source_reference='human-purchase'],
 ['different appointment',f=>f.appointment.id_cita=1],['already changed attendance',f=>f.appointment.estado='completada'],
 ['communications active',f=>f.appointment.import_metadata.automation_policy='normal'],['reminder flag removed',f=>delete f.appointment.import_metadata.notification_suppression.day_before],
 ['consumed session',f=>f.session.consumption_movement_id=1],['other session',f=>f.session.session_key='session_1'],
])test('rejects '+name,()=>{const f=fixture();change(f);assert.throws(()=>validateScope(f));});
test('SQL string and ORM timestamps normalize equally without mutating metadata',()=>{
 const raw={inicio:'2026-10-01 06:00:00',updated_at:'2026-09-14 10:00:00',import_metadata:'{"automation_policy":"hold"}'};
 assert.deepEqual(normalized(raw),normalized({...raw,inicio:new Date('2026-10-01T06:00:00Z'),updated_at:new Date('2026-09-14T10:00:00Z'),import_metadata:{automation_policy:'hold'}}));
 assert.equal(typeof raw.import_metadata,'string');
 assert.deepEqual(normalized({es_provisional:0}),normalized({es_provisional:false}));
});
test('readback accepts DATETIME(0) precision, not another second or a collateral edit',()=>{
 const expected={estado:'no_asistio',updated_at:'2026-09-26T09:55:17.774Z'};
 verifyCommitted({...expected,updated_at:'2026-09-26T09:55:17.000Z'},expected);
 assert.throws(()=>verifyCommitted({...expected,updated_at:'2026-09-26T09:55:18.000Z'},expected));
 assert.throws(()=>verifyCommitted({...expected,estado:'cancelada',updated_at:'2026-09-26T09:55:17.000Z'},expected));
});
