'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appointmentImportReview } = require('../../lib/appointment-import-review');

test('inactive assigned cabin stays in review even when its original pending list was empty', () => {
  for (const activo of [false,0]) {
    const row={source_system:'cliniccloud',instalacion_id:80,instalacion:{activo},import_metadata:{cliniccloud_delta:{pending_assignment:[]}}};
    assert.deepEqual(appointmentImportReview(row),{source:'cliniccloud',reminders_held:true,pending_assignment:['installation'],installation_inactive:true});
    row.instalacion.activo=true;
    assert.deepEqual(appointmentImportReview(row).pending_assignment,[]);
  }
});
test('inactive room review is derived from current data, not a stale metadata assertion', () => {
  const row={source_system:'cliniccloud',instalacion_id:80,instalacion:{activo:true},import_metadata:{installation_inactive:true,cliniccloud_delta:{pending_assignment:['installation_id']}}};
  assert.deepEqual(appointmentImportReview(row).pending_assignment,[]);
  assert.equal(appointmentImportReview({...row,source_system:null}),null);
  delete row.instalacion;
  assert.deepEqual(appointmentImportReview(row).pending_assignment,[]);
});
test('import summary excludes raw source evidence and removes resolved assignments', () => {
  const row = { source_system: 'cliniccloud', doctor_id: 53, instalacion_id: null, tratamiento_id: 7,
    import_metadata: { source_contact_id: 'private', raw: 'private', cliniccloud_delta: { pending_assignment: ['doctor_id','installation_id','treatment_id','untrusted'] } } };
  assert.deepEqual(appointmentImportReview(row), { source: 'cliniccloud', reminders_held: true, pending_assignment: ['installation'] });
  row.instalacion_id = 13;
  assert.deepEqual(appointmentImportReview(row).pending_assignment, []);
});
test('native visits never acquire import warnings and malformed metadata fails closed without raw disclosure', () => {
  assert.equal(appointmentImportReview({}), null);
  assert.deepEqual(appointmentImportReview({ source_system: 'cliniccloud', import_metadata: '{broken' }), { source: 'cliniccloud', reminders_held: true, pending_assignment: [] });
});
test('source service is an explicitly bounded display label, not raw source evidence or a catalog assignment', () => {
  const row = { source_system: 'cliniccloud', tratamiento_id: null, import_metadata: JSON.stringify({
    cliniccloud_delta: { pending_assignment: ['treatment_id'], source: { service_key: '  CYCLONE CORPORAL 1 SESION  ', details: 'PRIVATE NOTE', source_contact_id: 'PRIVATE ID' } },
  }) };
  const result = appointmentImportReview(row);
  assert.equal(result.source_service, 'CYCLONE CORPORAL 1 SESION');
  assert.deepEqual(result.pending_assignment, ['treatment']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|source_contact_id|details|treatment_id/);
  assert.equal(row.tratamiento_id, null);
  assert.equal(appointmentImportReview({...row, source_system: null}), null);
});
test('missing, non-string and oversized service labels cannot disclose arbitrary imported objects', () => {
  for (const service_key of [null, 45, { private: 'value' }, ['private'], '  ']) {
    assert.equal(appointmentImportReview({ source_system: 'cliniccloud', titulo: 'NOT A SOURCE LABEL', import_metadata: {cliniccloud_delta: {source: {service_key}}} }).source_service, undefined);
  }
  assert.equal(appointmentImportReview({source_system: 'cliniccloud', import_metadata: {cliniccloud_delta: {source: {service_key:'x'.repeat(400)}}}}).source_service.length, 255);
});
test('the actual appointment response guard removes the source label without clinical-data access', () => {
  const source=fs.readFileSync(path.resolve(__dirname,'../../controllers/citas.controller.js'),'utf8');
  const start=source.indexOf('function protectAppointmentPayload(');
  const end=source.indexOf('\nasync function protectAppointmentsForRequest(',start);
  assert(start>=0&&end>start);
  const context={module:{exports:null},appointmentImportReview,bookingCapabilities:()=>({simple:false}),
    redactAppointmentPatient:()=>({privacy_redacted:true}),redactAppointmentLead:()=>null};
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=protectAppointmentPayload;',context);
  const row={source_system:'cliniccloud',titulo:'CLINICAL SOURCE SENTINEL',import_metadata:{cliniccloud_delta:{source:{service_key:'CLINICAL SOURCE SENTINEL'}}}};
  for(const input of [row,{...row,import_review:appointmentImportReview(row)}]){
    const hidden=context.module.exports(input,{patientSensitive:false,leadSensitive:false,consentView:false});
    assert.equal(hidden.import_review,null);
    assert.doesNotMatch(JSON.stringify(hidden),/CLINICAL SOURCE SENTINEL/);
    const visible=context.module.exports(input,{patientSensitive:true,leadSensitive:false,consentView:false});
    assert.equal(visible.import_review.source_service,'CLINICAL SOURCE SENTINEL');
    assert.equal(visible.consent_summary,null);
  }
});
