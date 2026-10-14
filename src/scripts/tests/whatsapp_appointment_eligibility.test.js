'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assertAppointmentEligibility: check, assertAutomatedMessageEligibility: dispatch, importHeld } = require('../../lib/whatsappAppointmentEligibility');
const now = Date.parse('2026-09-15T17:00:00Z');
const base = () => ({ appointment: { id_cita: 1, clinica_id: 2, paciente_id: 3, estado: 'info_confirmada', inicio: '2026-09-16T09:00:00Z' }, execution: { trigger_entity_id: 1, context: { appointment: { inicio: '2026-09-16T09:00:00Z' } } }, clinicId: 2, patientId: 3, templateName: 'clinicaclick_recordatorio_dia_antes_v1', now });
test('details confirmed still receives day-before; attendance confirmed does not', () => {
  assert.equal(check(base()), true);
  const v=base();v.appointment.estado='recordatorio_confirmado';assert.throws(()=>check(v),{code:'whatsapp_appointment_already_confirmed'});
});
test('safe blocked-send diagnostic distinguishes past, provisional, status and changed schedule without changing eligibility', () => {
  for (const [changes, reason] of [[{ now: Date.parse('2026-09-16T10:00Z') }, 'whatsapp_appointment_past'],
    [{ appointment: { es_provisional: true } }, 'whatsapp_appointment_provisional'],
    [{ appointment: { estado: 'cambio_solicitado' } }, 'whatsapp_appointment_status_ineligible'],
    [{ appointment: { inicio: 'invalid' } }, 'whatsapp_appointment_start_invalid'],
    [{ appointment: { inicio: '2026-09-17T09:00Z' } }, 'whatsapp_appointment_rescheduled']]) {
    const value = base(); Object.assign(value.appointment, changes.appointment); if (changes.now) value.now = changes.now;
    assert.throws(() => check(value), error => error.retryable === false && error.details?.reason_code === reason);
  }
  const D = require('../../lib/whatsapp-failure-diagnostic');
  assert.equal(D.reasonCode({ code: 'whatsapp_authorized_message_ineligible' }), null);
  assert.deepEqual(D.diagnosticMetadata({ details: { reason_code: 'SQL_SECRET_INVALID' } }), {});
  assert.deepEqual(D.diagnosticMetadata({ details: { reason_code: 'whatsapp_appointment_past' } }),
    { technical_failure_reason_code: 'whatsapp_appointment_past' });
});
test('same-day reminder includes confirmed and unconfirmed appointments', () => {
  for(const estado of ['info_confirmada','recordatorio_confirmado','pendiente','recordatorio_enviado']) {
    const v=base();v.appointment.estado=estado;v.templateName='clinicaclick_recordatorio_mismo_dia_primera_visita_v9';v.now=Date.parse('2026-09-16T06:00Z');assert.equal(check(v),true);
  }
});
test('weekly reminders use seven Madrid calendar days, including spring/autumn DST boundaries', () => {
  for (const [clock, start] of [
    ['2026-09-15T17:00:00Z', '2026-09-22T09:00:00Z'],
    ['2026-10-24T22:30:00Z', '2026-11-01T09:00:00Z'],
    ['2026-03-22T22:30:00Z', '2026-03-29T09:00:00Z'],
  ]) {
    const v = base(); v.now = Date.parse(clock); v.templateName = 'clinicaclick_recordatorio_semana_antes_v1';
    v.appointment.inicio = start; v.execution.context.appointment.inicio = start;
    assert.equal(check(v), true);
    const wrong = structuredClone(v); wrong.now += 2 * 86400000;
    assert.throws(() => check(wrong), { code: 'whatsapp_appointment_wrong_day' });
  }
});
test('weekly reminders preserve current scope/start/future/lifecycle and both manual suppression aliases', () => {
  const weekly = () => {
    const v = base(); v.templateName = 'clinicaclick_recordatorio_semana_antes_v1';
    v.appointment.inicio = '2026-09-22T09:00:00Z'; v.execution.context.appointment.inicio = v.appointment.inicio;
    return v;
  };
  for (const patch of [{ estado: 'cancelada' }, { estado: 'completada' }, { estado: 'recordatorio_confirmado' },
    { es_provisional: true }, { clinica_id: 4 }, { paciente_id: 5 },
    { inicio: '2026-09-22T09:01:00Z' }, { import_metadata: { historical_registration: true } },
    { import_metadata: { notification_suppression: { week_before: true } } },
    { import_metadata: { notification_suppression: { weekBefore: true } } }]) {
    const v = weekly(); Object.assign(v.appointment, patch); assert.throws(() => check(v));
  }
  const past = weekly(); past.now = Date.parse('2026-09-22T10:00:00Z');
  assert.throws(() => check(past), { code: 'whatsapp_appointment_ineligible' });
  const ack = weekly(); ack.templateName = null; ack.execution.context.trigger = { schedule_moment: 'week_before' };
  ack.appointment.estado = 'cancelada'; assert.equal(check(ack), true, 'the parent weekly flow cannot turn an ACK into a new reminder');
});
test('imports, nested holds, cancellations, past appointments and scope changes fail', () => {
  for(const change of [{source_system:'cliniccloud'},{source_reference:'import:1'},{import_metadata:{cliniccloud_reconciliation:{automation_policy:'hold'}}},{estado:'cancelada'},{estado:'cambio_solicitado'},{estado:'completada'},{clinica_id:4},{paciente_id:5},{inicio:'2026-09-17T09:00Z'},{es_provisional:true},{import_metadata:{notification_suppression:{day_before:true}}}]) {
    const v=base();Object.assign(v.appointment,change);assert.throws(()=>check(v));
  }
  const v=base();v.now=Date.parse('2026-09-16T10:00Z');assert.throws(()=>check(v));
});
test('imported patient hold is checked even for native appointments', async () => {
  await assert.rejects(dispatch({message:{metadata:{execution_id:1}},conversation:{patient_id:3,clinic_id:2},patientHeld:async()=>true,
    loadExecution:async()=>({id:1,clinic_id:2,trigger_entity_type:'entity'})}),{code:'whatsapp_patient_import_held'});
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

test('appointment details also reject cancelled, past or rescheduled instances',()=>{
 for(const suffix of ['24_v16','reprogramada_48_v2','hoy_sin_respuesta_v1']) {
  const v=base();v.templateName='clinicaclick_confirmacion_datos_cita_'+suffix;assert.equal(check(v),true);
  for(const change of [{estado:'cancelada'},{estado:'completada'},{estado:'cambio_solicitado'},{inicio:'2026-09-17T09:00:00Z'}]) {
   const input=structuredClone(v);Object.assign(input.appointment,change);assert.throws(()=>check(input));
  }
  v.now=Date.parse('2026-09-16T10:00Z');assert.throws(()=>check(v));
 }
});
test('a text followup after timeout has the same current-appointment protection as a template',()=>{
 const v=base();v.templateName=null;v.confirmationTimeout=true;assert.equal(check(v),true);
 v.now=Date.parse('2026-09-16T10:00Z');assert.throws(()=>check(v));
 v.now=now;v.appointment.estado='recordatorio_confirmado';assert.throws(()=>check(v));
});
test('final timeout transport uses scoped reception readiness and still blocks pending input',async()=>{
 const start=new Date(Date.now()+3600000).toISOString();
 const input={message:{metadata:{execution_id:1,appointment_timeout:true}},conversation:{clinic_id:2,patient_id:3},patientHeld:async()=>false,
  loadExecution:async()=>({id:1,clinic_id:2,trigger_entity_type:'appointment',trigger_entity_id:1,context:{appointment:{inicio:start}}}),
  loadAppointment:async()=>({id_cita:1,clinica_id:2,paciente_id:3,inicio:start,estado:'info_enviada'})};
 assert.equal(await dispatch({...input,getReceptionState:async()=>({healthy:true,readyForTimeout:true})}),true);
 await assert.rejects(dispatch({...input,getReceptionState:async()=>({healthy:true,readyForTimeout:false})}),{code:'whatsapp_inbox_reception_delayed'});
});

test('BS Medical and Capilar block manual and existing queued consent/review sends before any automation fast path', async () => {
  for (const clinic_id of [66, 72]) for (const name of ['clinicaclick_consentimiento_estetica_v1',
    'clinicaclick_solicitud_resena_v1', 'clinicaclick_solicitud_reseña_v1', 'clinicaclick_review_request_v1']) {
    for (const status of ['pending', 'failed']) {
      await assert.rejects(dispatch({ message: { id: 100, direction: 'outbound', status, metadata: {} },
        conversation: { clinic_id, patient_id: null }, payload: { type: 'template', template: { name } },
        patientHeld: async () => { throw Error('patient_hold_should_not_be_needed'); } }), error =>
        error.code === 'whatsapp_appointment_nonoperational_clinic_held' && error.retryable === false
          && error.details.reason_code === 'whatsapp_appointment_nonoperational_clinic_held');
    }
  }
  assert.deepEqual(require('../../lib/whatsapp-failure-diagnostic').diagnosticMetadata({
    code: 'whatsapp_appointment_nonoperational_clinic_held' }),
  { technical_failure_reason_code: 'whatsapp_appointment_nonoperational_clinic_held' });
});

test('the clinic veto recognizes actual/persisted purposes, review text followups and specific consent/document IDs', async () => {
  const purposes = [{ template_name: 'custom_consent_link' }, { fallback_template_name: 'custom_review_request' },
    { communication_scope: 'clinical_consent' }, { communicationScope: 'customer-review_requests' },
    { communication_purpose: 'CUSTOM_CONSENT_scope' }, { communicationPurpose: 'reviewRequest' },
    { template_usage: 'solicitud_resena' }, { kind: 'review_private_feedback_ack' },
    { dispatch_context: 'review_request' }, { consent_request_id: 4 }, { consent_package_id: '5' },
    { consent_document_id: 6 }, { patient_consent_document_id: 'document-uuid' },
    { consent_package_public_id: 'package-uuid' }, { review_request_id: 8 }, { review_list_id: 9 },
    { review_request: true }];
  for (const clinic_id of [66, 72]) for (const metadata of purposes) {
    await assert.rejects(dispatch({ message: { metadata: JSON.stringify({ communication_scope: 'care', ...metadata }) },
      conversation: { clinic_id, patient_id: 3 }, payload: { type: 'text', text: { body: 'Workflow text' } },
      patientHeld: async () => false }), { code: 'whatsapp_appointment_nonoperational_clinic_held' });
  }
  await assert.rejects(dispatch({ message: { metadata: { template_name: 'ordinary_confirmation' } },
    conversation: { clinic_id: 66 }, payload: { type: 'template', template: { name: 'actual_review_request' } } }),
  { code: 'whatsapp_appointment_nonoperational_clinic_held' });
  await assert.rejects(dispatch({ message: { metadata: {} }, conversation: { clinic_id: 72 },
    payload: { type: 'text', metadata: { consent_request_id: 20 }, text: { body: 'Consent link' } } }),
  { code: 'whatsapp_appointment_nonoperational_clinic_held' });
});

test('conversation scope is authoritative and ordinary marketing/clinical messages retain their independent eligibility', async () => {
  const blocked = { message: { metadata: { clinic_id: 2, recipient_clinic_id: 2 } }, conversation: { clinic_id: 66 },
    payload: { type: 'template', template: { name: 'custom_consent_link' } } };
  await assert.rejects(dispatch(blocked), { code: 'whatsapp_appointment_nonoperational_clinic_held' });
  assert.equal(await dispatch({ ...blocked, message: { metadata: { clinic_id: 66 } }, conversation: { clinic_id: 2 } }), true);
  for (const clinic_id of [66, 72]) for (const metadata of [{}, { template_category: 'MARKETING', template_usage: 'promocion' },
    { communication_scope: 'marketing', template_name: 'clinicaclick_promocion_v1' },
    { package_id: 8, document_id: 9, consent_package_id: null, consent_document_id: 0, purpose: 'preview' }]) {
    assert.equal(await dispatch({ message: { metadata }, conversation: { clinic_id, patient_id: 3 },
      payload: { type: 'text', text: { body: 'Ordinary clinical response', preview_url: false } },
      patientHeld: async () => false }), true);
  }
});

test('a loaded consent_required execution cannot evade the BS clinic veto by using an ordinary text payload', async () => {
  for (const clinic_id of [66, 72]) for (const entity of ['appointment', 'patient']) {
    await assert.rejects(dispatch({ message: { metadata: { execution_id: 10 } }, conversation: { clinic_id, patient_id: 3 },
      payload: { type: 'text', text: { body: 'Signature link' } }, patientHeld: async () => false,
      loadExecution: async () => ({ id: 10, clinic_id, trigger_type: 'consent_required', trigger_entity_type: entity }),
      loadAppointment: async () => { throw Error('appointment_load_not_needed'); } }),
    { code: 'whatsapp_appointment_nonoperational_clinic_held' });
  }
  assert.equal(await dispatch({ message: { metadata: { execution_id: 10 } }, conversation: { clinic_id: 2, patient_id: 3 },
    payload: { type: 'text', text: { body: 'Signature link' } }, patientHeld: async () => false,
    loadExecution: async () => ({ id: 10, clinic_id: 2, trigger_type: 'consent_required', trigger_entity_type: 'patient' }) }), true);
});
