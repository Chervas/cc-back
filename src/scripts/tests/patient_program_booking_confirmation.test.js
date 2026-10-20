'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/patient-program-booking-confirmation');
const { createRuntime } = require('../../services/patientProgramBookingNotice.service');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(count = 5) {
  const voucher = { id: 27, public_id: 'voucher-program-fictitious', source_system: 'treatment_program', patient_id: 123, clinic_id: 66, name: 'Programa de ejemplo' };
  const snapshot = { sha256: 'a'.repeat(64), name: 'Programa de ejemplo', appointments: Array.from({ length: count }, (_, position) => ({ key: `s${position + 1}` })) };
  const appointments = snapshot.appointments.map((definition, position) => ({ id_cita: 601 + position, voucher_id: 27, paciente_id: 123, clinica_id: 66,
    inicio: new Date(Date.UTC(2027, 0, position * 7 + 4, 9)).toISOString(), fin: new Date(Date.UTC(2027, 0, position * 7 + 4, 9, 45)).toISOString(),
    estado: 'pendiente', doctor_id: 7, instalacion_id: 8, tratamiento_id: 9, source_system: 'treatment_program', source_reference: `program-session:${101 + position}:booking-request-1` }));
  const sessions = appointments.map((row, position) => ({ id: 101 + position, voucher_id: 27, position, session_key: snapshot.appointments[position].key,
    snapshot_sha256: snapshot.sha256, appointment_id: row.id_cita, consumption_movement_id: null }));
  const receipt = { id: 77, voucher_id: 27, request_key: 'booking-request-1', request_sha256: 'b'.repeat(64), created_by: 7,
    result: { voucher_id: voucher.public_id, reminders_enabled: false, replayed: false, sessions: [{ key: 's5', appointment_id: 605,
      action: 'created', start_at: appointments.at(-1).inicio, end_at: appointments.at(-1).fin }] } };
  return { receipt, voucher, snapshot, clinic: { id_clinica: 66, nombre_clinica: 'Clínica de ejemplo' }, sessions, appointments,
    actorId: 7, occurredAt: '2026-10-20T12:00:00.000Z', timeZone: 'Europe/Madrid', communicationLanguage: 'es' };
}
test('summary includes every future reservation, not just the latest receipt, and canonical unassigned count excludes completed visits', () => {
  const input = fixture(); input.sessions[0].consumption_movement_id = 9; input.appointments[0].estado = 'completada';
  input.sessions[2].appointment_id = null; input.appointments.splice(2, 1);
  input.appointments.find(row => row.id_cita === 604).estado = 'no_asistio';
  const before = clone(input), result = C.projection(input);
  assert.deepEqual(input, before); assert.equal(result.appointment_count, 2); assert.equal(result.pending_count, 2); assert.equal(result.completed_count, 1);
  assert.deepEqual(result.appointments.map(row => row.number), [2, 5]);
  assert.match(result.body, /Hemos reservado estas citas/); assert.match(result.body, /podría cambiar por necesidades de agenda/);
  assert.match(result.body, /Quedan 2 citas por asignar/);
  assert.match(result.parameters[2], /^2\) 11\/01\/27 10:00; 5\)/); assert.equal(result.summary_policy, 'each_booking');
});
test('receipt business hash ignores only communication projection, not its dates or actual booking intent', () => {
  const input = fixture(), first = C.projection(input);
  input.receipt.result.communication = { status: 'pending', sent: false };
  assert.deepEqual(C.projection(input), first);
  input.receipt.result.sessions[0].start_at = '2027-02-04T09:00:00.000Z';
  assert.notEqual(C.projection(input).snapshot_sha256, first.snapshot_sha256);
});
test('details/reminder states do not invalidate dates; moving, adding, replacing or changing the receipt does', () => {
  const input = fixture(), before = C.projection(input);
  for (const state of ['info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'ha_acudido', 'en_atencion']) {
    const changed = clone(input); changed.appointments[0].estado = state;
    assert.equal(C.projection(changed).snapshot_sha256, before.snapshot_sha256, state);
  }
  for (const mutate of [value => value.receipt.id++, value => value.appointments[0].doctor_id++, value => value.appointments[0].instalacion_id++,
    value => { value.appointments[0].inicio = '2027-01-04T10:00:00.000Z'; value.appointments[0].fin = '2027-01-04T10:45:00.000Z'; }]) {
    const changed = clone(input); mutate(changed); assert.notEqual(C.projection(changed).snapshot_sha256, before.snapshot_sha256);
  }
});
test('thirty numbered appointments and long clinic/program names fit a single plain Meta parameter/body without truncation', () => {
  const input = fixture(30); input.clinic.nombre_clinica = 'C'.repeat(80); input.snapshot.name = 'P'.repeat(120);
  const result = C.projection(input); assert.equal(result.appointment_count, 30); assert(result.body.length <= 1024, result.body.length);
  assert.match(result.parameters[2], /30\)/); assert.equal(result.parameters[2].split('; ').length, 30);
  assert.equal(/[\r\n\t\u2028\u2029]| {5}/.test(result.parameters.join('')), false);
});
test('clinic zone determines dates across DST and no source identity, clinic or duplicate membership may leak', () => {
  const input = fixture(); input.timeZone = 'America/New_York';
  assert.match(C.projection(input).parameters[2], /^1\) 04\/01\/27 04:00/);
  for (const mutate of [value => value.appointments[0].paciente_id++, value => value.appointments[0].clinica_id++,
    value => value.sessions[0].voucher_id++, value => value.sessions.push(clone(value.sessions[0])), value => value.sessions[0].position = 1]) {
    const changed = fixture(); mutate(changed); assert.throws(() => C.projection(changed), /program_details_/);
  }
});
test('only published approved exact Utility body/buttons are eligible; proposal and modular graph remain inactive', () => {
  const source = C.catalogPreparation(); assert.equal(source.flow.is_active, false); assert.equal(source.flow.published_at, null);
  assert.equal(source.whatsapp.is_active, false); assert(C.graphValid(source.flow.nodes)); assert.equal(C.configValid(source.flow.trigger_config), false);
  const approved = { ...source.whatsapp, language: 'es_ES', status: 'APPROVED', is_active: true };
  assert(C.templateValid(approved));
  for (const patch of [{ category: 'MARKETING' }, { status: 'PENDING' }, { name: 'other' }, { is_active: false }, { language: 'en_US' }]) assert.equal(C.templateValid({ ...approved, ...patch }), false);
  const changed = clone(source.flow.nodes); changed[6].type = 'action/change_status'; assert.equal(C.graphValid(changed), false);
});
test('gate closed is schema-independent and causes no event, outbox, patient read or provider access', async () => {
  const forbidden = new Proxy({}, { get() { throw Error('DATABASE_ACCESS_FORBIDDEN'); } });
  const runtime = createRuntime({ db: { Sequelize: { Op: {} }, PatientOperationalEvent: forbidden }, enabled: () => false });
  assert.deepEqual(await runtime.recordBookingReceipt({}), { status: 'not_available', reason: 'runtime_disabled', sent: false });
});
test('queueing never means sent; only accepted persisted provider evidence reports sent', () => {
  const request = { id: 9, metadata: { notice: { appointment_count: 2, pending_count: 3 }, delivery_enabled: true } };
  assert.equal(C.publicState(request).status, 'queued'); assert.equal(C.publicState(request).sent, false);
  const accepted = { metadata: { wamid: 'wamid.fictitious', provider_acceptance_at: '2026-10-20T12:00:00.000Z' } };
  assert.equal(C.publicState(request, null, accepted).status, 'accepted'); assert.equal(C.publicState(request, null, accepted).sent, false);
  assert.equal(C.publicState(request, null, { ...accepted, status: 'sent' }).sent, true);
});
test('native registry validates this modular source, preserves trigger settings and rejects unrelated mutations', async () => {
  const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
  const proposal = C.catalogPreparation();
  const controller = loadSource('../controllers/automationsV2.controller', { '../../models': {
    Sequelize: require('sequelize'), WhatsappTemplate: { findAll: async () => [] },
    WhatsappTemplateCatalog: { findAll: async () => [{ id: 999, ...proposal.whatsapp }] },
  } }, {}, 10000);
  const result = await controller.validateFlowPayloadForInternalUse(proposal.flow);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.trigger_config.configured, false); assert.equal(result.trigger_type, C.REQUEST);
  const configured = C.definition(); configured.nodes[0].config = { summary_policy: 'each_booking', response_timeout_minutes: 1440,
    enabled_after: '2026-10-20T12:00:00.000Z' };
  const valid = await controller.validateFlowPayloadForInternalUse(configured);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors)); assert.equal(valid.trigger_config.configured, true);
  configured.nodes[0].config.summary_policy = 'when_complete';
  assert.equal((await controller.validateFlowPayloadForInternalUse(configured)).ok, false);
});
function replyFixture() {
  const request = { id: 10, patient_id: 123, clinic_id: 66, metadata: { phone: '34600000123', reply_token: 'a'.repeat(36), response_timeout_minutes: 60 } };
  const conversation = { id: 9, patient_id: 123, clinic_id: 66, channel: 'whatsapp', contact_id: request.metadata.phone, lead_id: null };
  const outbound = { id: 90, conversation_id: 9, automation_delivery_key: 'program-booking-notice:66:10:outbound', status: 'sent', metadata: {
    program_booking_request_event_id: 10, wamid: 'wamid.TESTONLY', provider_acceptance_at: '2026-10-20T12:00:00.000Z', phoneNumberId: 'PHONE', wabaId: 'WABA' } };
  const inbound = (id, answer, at = '2026-10-20T12:30:00.000Z') => ({ id, conversation_id: 9, direction: 'inbound', content: answer,
    sent_at: at, metadata: { historical: false, automatic_actions_allowed: true, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: at,
      phone_number_id: 'PHONE', waba_id: 'WABA', context: { id: outbound.metadata.wamid },
      button: { payload: `ppb:10:${request.metadata.reply_token}:${answer}` } } });
  const rows = [inbound(101, 'yes'), inbound(102, 'no')];
  const runtime = createRuntime({ db: { Sequelize: require('sequelize'), Message: { findAll: async () => rows } }, enabled: () => true,
    now: () => new Date('2026-10-20T14:00:00.000Z') });
  return { request, conversation, outbound, inbound, rows, runtime };
}
test('reply deadline is authenticated against provider acceptance, including before a delayed timeout job', async () => {
  const f = replyFixture();
  assert(await f.runtime.replyProof(f.request, f.outbound, f.inbound(101, 'yes', '2026-10-20T13:00:00.000Z'), f.conversation));
  assert.equal(await f.runtime.replyProof(f.request, f.outbound, f.inbound(101, 'yes', '2026-10-20T13:00:00.001Z'), f.conversation), null);
  const forged = f.inbound(101, 'yes'); forged.metadata.historical = true;
  assert.equal(await f.runtime.replyProof(f.request, f.outbound, forged, f.conversation), null);
  f.outbound.metadata.provider_acceptance_at = '2026-10-20T12:00:00.678Z';
  assert(await f.runtime.replyProof(f.request, f.outbound, f.inbound(101, 'yes', '2026-10-20T12:00:00.000Z'), f.conversation));
  assert.equal(await f.runtime.replyProof(f.request, f.outbound, f.inbound(101, 'yes', '2026-10-20T11:59:59.999Z'), f.conversation), null);
});
test('contradictory authenticated buttons are deterministic conflict, never a positive AI authorization', async () => {
  const f = replyFixture();
  const batch = await f.runtime.replyBatch(f.request, f.outbound, [101, 102], f.conversation);
  assert.equal(batch.reply_conflict, true); assert.equal(batch.reply_answer, null); assert.equal(batch.response_version, '101:102');
});
test('latest event is checked after the voucher mutex with a CURRENT read, even if a new receipt leaves dates identical', async () => {
  const sequence = [], request = { id: 10, clinic_id: 66, patient_id: 123, event_type: C.REQUEST,
    metadata: { schema_version: C.SCHEMA, notice: { schema_version: C.SCHEMA, voucher_id: 27 } } };
  const S = require('sequelize'), tx = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  let unlocked = false;
  const runtime = createRuntime({ db: { Sequelize: S, PatientVoucher: { findOne: async options => {
    assert.equal(options.lock, 'UPDATE'); sequence.push('voucher_mutex'); unlocked = true; return { id: 27 }; } },
  PatientOperationalEvent: { findOne: async options => { sequence.push('latest_event'); assert(unlocked); assert.equal(options.lock, 'SHARE');
    assert.equal(options.where.patient_id, 123); assert.equal(options.where.clinic_id, 66); return { id: 11 }; } } }, enabled: () => true });
  assert.equal(await runtime.current(request, tx, true), null); assert.deepEqual(sequence, ['voucher_mutex', 'latest_event']);
});
test('import HOLD exception is purpose-specific and never enables consent, reviews or an unauthenticated program batch', async () => {
  const eligibility = require('../../lib/whatsappAppointmentEligibility');
  const input = { message: { metadata: { execution_id: 71, communication_scope: 'care', template_name: C.TEMPLATE } },
    conversation: { clinic_id: 72, patient_id: 1923 }, payload: { type: 'template', template: { name: C.TEMPLATE } },
    loadExecution: async () => ({ id: 71, clinic_id: 72, trigger_type: C.REQUEST, trigger_entity_type: 'patient_operational_event' }),
    patientHeld: async () => true, authorizeProgramBatch: async () => true };
  assert.equal(await eligibility.assertAutomatedMessageEligibility(input), true);
  await assert.rejects(eligibility.assertAutomatedMessageEligibility({ ...input, authorizeProgramBatch: async () => false }), /whatsapp_program_batch_ineligible/);
  await assert.rejects(eligibility.assertAutomatedMessageEligibility({ ...input, authorizeProgramBatch: undefined }), /whatsapp_program_batch_ineligible/);
  for (const name of ['consentimiento_alta', 'solicitar_review']) {
    await assert.rejects(eligibility.assertAutomatedMessageEligibility({ ...input, payload: { template: { name } } }), /whatsapp_appointment_nonoperational_clinic_held/);
  }
  await assert.rejects(eligibility.assertAutomatedMessageEligibility({ ...input,
    loadExecution: async () => ({ id: 71, clinic_id: 72, trigger_type: 'patient.created', trigger_entity_type: 'patient' }) }), /whatsapp_patient_import_held/);
});
module.exports = { fixture };
