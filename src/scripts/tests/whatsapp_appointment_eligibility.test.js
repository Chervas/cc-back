'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assertAppointmentEligibility: check, assertAutomatedMessageEligibility: dispatch, importHeld } = require('../../lib/whatsappAppointmentEligibility');
const now = Date.parse('2026-09-15T17:00:00Z');
const base = () => ({ appointment: { id_cita: 1, clinica_id: 2, paciente_id: 3, estado: 'info_confirmada', inicio: '2026-09-16T09:00:00Z' }, execution: { trigger_entity_id: 1, context: { appointment: { inicio: '2026-09-16T09:00:00Z' } } }, clinicId: 2, patientId: 3, templateName: 'clinicaclick_recordatorio_dia_antes_v1', now });
test('details confirmed still receives day-before; attendance confirmed does not', () => {
  assert.equal(check(base()), true);
  const v=base();v.appointment.estado='recordatorio_confirmado';assert.throws(()=>check(v),{code:'whatsapp_appointment_already_confirmed'});
});
test('same-day reminder includes confirmed and unconfirmed appointments', () => {
  for(const estado of ['info_confirmada','recordatorio_confirmado','pendiente','recordatorio_enviado']) {
    const v=base();v.appointment.estado=estado;v.templateName='clinicaclick_recordatorio_mismo_dia_primera_visita_v9';v.now=Date.parse('2026-09-16T06:00Z');assert.equal(check(v),true);
  }
});
test('imports, nested holds, cancellations, past appointments and scope changes fail', () => {
  for(const change of [{source_system:'cliniccloud'},{source_reference:'import:1'},{import_metadata:{cliniccloud_reconciliation:{automation_policy:'hold'}}},{estado:'cancelada'},{estado:'cambio_solicitado'},{estado:'completada'},{clinica_id:4},{paciente_id:5},{inicio:'2026-09-17T09:00Z'},{es_provisional:true},{import_metadata:{notification_suppression:{day_before:true}}}]) {
    const v=base();Object.assign(v.appointment,change);assert.throws(()=>check(v));
  }
  const v=base();v.now=Date.parse('2026-09-16T10:00Z');assert.throws(()=>check(v));
});
test('imported patient hold is checked even for native appointments', async () => {
  await assert.rejects(dispatch({message:{metadata:{execution_id:1}},conversation:{patient_id:3},patientHeld:async()=>true}),{code:'whatsapp_patient_import_held'});
  assert.equal(importHeld({import:{automation_policy:'hold'}}),true);
});
test('an import hold prevents automation even with no patient link on the conversation', async () => {
  await assert.rejects(dispatch({message:{metadata:{execution_id:1}},conversation:{clinic_id:2},patientHeld:async()=>true,
    loadExecution:async()=>({id:1,clinic_id:2,trigger_entity_type:'appointment',trigger_entity_id:1}),loadAppointment:async()=>base().appointment}),{code:'whatsapp_patient_import_held'});
});
test('manual replies and appointment cancellation acknowledgements retain their existing handling',async()=>{
  assert.equal(await dispatch({message:{metadata:{}},conversation:{}}),true);
  const v=base();v.appointment.estado='cancelada';v.templateName=null;assert.equal(check(v),true);
});
