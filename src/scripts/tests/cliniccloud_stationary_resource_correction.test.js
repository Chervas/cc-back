'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareCorrection,correctionValues}=require('../../lib/cliniccloud-import/stationary-resource-correction');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {normalizedRow}=require('../../lib/cliniccloud-import/appointments-apply');
function fixture(presso=false){
 const source={kind:'appointment',status:'pendiente',source_contact_id:'123',start_local:'2030-10-08T17:00:00',end_local:'2030-10-08T17:30:00',details:presso?'PRESO':'cyclone',service_key:presso?'PRESOTERAPIA CORPORAL 1 SESION':'CYCLONE CORPORAL 1 SESION',provenance:{row_sha256:'a'.repeat(64),file_sha256:'b'.repeat(64)}};
 return {before:{id_cita:1,paciente_id:2,clinica_id:72,doctor_id:142,instalacion_id:30,tratamiento_id:presso?623:611,estado:'pendiente',inicio:'2030-10-08T15:00:00.000Z',fin:'2030-10-08T15:30:00.000Z',source_system:'cliniccloud',source_reference:'appointment:456',import_metadata:{source_appointment_id:'456',source_contact_id:'123',raw:{idCita:'456',idContacto:'123',detalles:source.details}}},source,
 catalog:{clinica_id:72,clinical_config:{source_professional:'Aux. Piedad',source_catalog:{sheet:'Tratamientos individuales',source_row:presso?8:24},booking_profile:{phases:[{installation_ids:[presso?82:85],professionals:{ids:[221]}}]}}},doctorId:221,roomId:presso?82:85,equipmentId:presso?11:10,planSha256:'c'.repeat(64),reason:'Verified unchanged source slot and documentary staff/cabin assignment'};
}
for(const presso of [false,true])test('documented unchanged '+(presso?'presotherapy':'Cyclone')+' keeps all clinical/time/origin fields and HOLD',()=>{
 const x=fixture(presso),saved=JSON.stringify(x),r=prepareCorrection(x),values=correctionValues(x.before,r);
 assert.equal(JSON.stringify(x),saved);assert.equal(values.doctor_id,221);assert.equal(values.instalacion_id,presso?82:85);
 assert.deepEqual(Object.keys(values).sort(),['doctor_id','import_metadata','instalacion_id']);
 assert.deepEqual(values.import_metadata.raw,x.before.import_metadata.raw);
 assert.deepEqual(values.import_metadata.notification_suppression,{appointment_details:true,day_before:true,same_day:true});
});
for(const change of [x=>x.source.details='EMS',x=>x.source.details='INDIBA',x=>x.source.details='ondas',x=>x.source.details='EXION',x=>x.source.start_local='2030-10-08T17:15:00',x=>x.source.status='cancelada',x=>x.source.source_contact_id='999',x=>x.before.updated_by=4,x=>x.before.voucher_id=3,x=>x.before.import_metadata.booking={},x=>x.catalog.clinical_config.source_professional='Lidia',x=>x.roomId=87])test('ambiguous or changed evidence fails closed '+change.toString(),()=>{const x=fixture();change(x);assert.throws(()=>prepareCorrection(x),/REVIEW_REQUIRED/)});
test('receipt tampering and concurrent edits fail before writes',()=>{const x=fixture(),r=prepareCorrection(x);assert.throws(()=>correctionValues({...x.before,nota:'Edited'},r),/CONCURRENT_CHANGE/);assert.throws(()=>correctionValues(x.before,{...r,doctor_id:999}),/CONCURRENT_CHANGE/);assert.equal(r.before_sha256,hash(normalizedRow(x.before)));});
