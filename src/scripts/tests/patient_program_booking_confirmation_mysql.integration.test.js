'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const S = require('sequelize');
const C = require('../../lib/patient-program-booking-confirmation');
const { createRuntime } = require('../../services/patientProgramBookingNotice.service');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const createHarness = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const enrollment = require('../../lib/patient-program-enrollment');
test('native V2 program summary: owned SQL receipt/outbox, whole graph, replay, batch confirmation, stale/late/ambiguous replies and format failure', {
  skip: process.env.PROGRAM_CONFIRMATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async scope => {
  const t = await createHarness(scope), { db, requests } = t, { sql, report } = scope, D = S.DataTypes;
  for (const [name, file] of Object.entries({ PatientVoucher: 'patientvoucher', PatientProgramSession: 'patientprogramsession', PatientProgramBookingRequest: 'patientprogrambookingrequest' })) {
    db[name] = require('../../../models/' + file)(sql, D);
  }
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, clinica_id: D.INTEGER,
    paciente_id: D.INTEGER, voucher_id: D.INTEGER, doctor_id: D.INTEGER, instalacion_id: D.INTEGER, tratamiento_id: D.INTEGER,
    inicio: D.DATE, fin: D.DATE, estado: D.STRING, source_system: D.STRING, source_reference: D.STRING, import_metadata: D.JSON,
    care_legacy_attendance: D.BOOLEAN, arrived_at: D.DATE, care_started_at: D.DATE }, { tableName: 'CitasPacientes', timestamps: true });
  await sql.sync();
  const source = C.definition(72); source.nodes[0].config = { summary_policy: 'each_booking', response_timeout_minutes: 60, enabled_after: '2026-10-20T11:00:00.000Z' };
  const template = await db.AutomationFlowTemplateV2.create({ ...source, is_active: true, published_at: t.clock,
    trigger_config: { ...source.nodes[0].config, configured: true } });
  const approved = await db.WhatsappTemplate.create({ ...C.catalogPreparation().whatsapp, waba_id: t.sender.wabaId,
    language: 'es_ES', status: 'APPROVED', category: 'UTILITY', is_active: true });
  let runtime, engine;
  const dependencies = { ...t.dependencies, './patientProgramBookingNotice.service': { current: () => runtime } };
  const filename = require.resolve('../../services/flowEngineV2.service'), actual = createRequire(filename), module = { exports: {} };
  const forbidden = new Proxy({}, { get: (_target, key) => () => { throw Error('UNEXPECTED_PROGRAM_DEPENDENCY:' + String(key)); } });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: t.Clock, Buffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone, process: { env: { JOB_RUNTIME_NAMESPACE: 'TESTONLY' } },
    console: { log() {}, warn() {}, error() {} }, require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name.startsWith('../lib/') || name.startsWith('../config/') || ['sequelize', 'crypto'].includes(name) ? actual(name) : forbidden }, { filename, timeout: 10000 });
  engine = module.exports;
  const emitted = [], deps = { db, engine, stop: t.dependencies['../lib/automation-runtime-stop'], now: () => t.clock,
    enabled: () => t.enabled, enqueueJob: requests.enqueueUniqueJobRequest, deliveryReady: async () => !t.blocked,
    authorizeActor: async () => { if (t.blocked) throw Error('TESTONLY_ACCESS_BLOCKED'); }, communicationAllowed: async () => { if (t.blocked) throw Error('TESTONLY_CHANNEL_BLOCKED'); },
    emitAppointments: rows => emitted.push(...rows.map(row => row.id_cita)), wake: async (execution, transaction, dueAt) => sql.query(
      "UPDATE JobRequests SET next_run_at=:dueAt WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:id",
      { replacements: { dueAt, id: String(execution.id) }, transaction }) };
  runtime = createRuntime(deps); t.enabled = true;
  const patient = await db.Paciente.create({ id_paciente: 201, clinica_id: 72, nombre: 'TESTONLY', apellidos: 'Program patient', telefono_movil: '34600000201', idioma_preferido: 'es' });
  const program = { id: '9c175afe-bbb9-4625-bb7d-c9ea80e161aa', clinic_id: 72, version: 1, kind: 'program', status: 'active', name: 'Programa ficticio',
    commercial_ready: true, total_price: 150, price_profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null },
    summary: { issues: [] }, appointments: Array.from({ length: 5 }, (_, position) => ({ key: 's' + position, label: 'Sesión ' + position,
      offset_days: position * 7, treatment_ids: [30], duration_minutes: 30, treatments: [{ id: 30, name: 'Ficticio', duration_minutes: 30,
        booking_profile: { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [101], professionals: { mode: 'any', ids: [1], preferred_id: 1 } }] } }] })) };
  const request = enrollment.enrollmentRequest({ clinic_id: 72, program_id: program.id, program_version: 1, request_key: 'TESTONLY-enrollment' }, { clinicId: 72, patientId: 201, actorId: 15 });
  const frozen = enrollment.freezeProgramEnrollment(program, request, t.clock);
  const voucher = await db.PatientVoucher.create({ public_id: 'c4f3fdb8-35d7-4bc8-9c0a-b8f7b8a0b945', clinic_id: 72, patient_id: 201,
    budget_id: null, budget_line_key: null, program_snapshot: frozen, name: frozen.name, total_units: 5, available_units: 5, sold_amount: 0,
    activation_rule: 'manual', status: 'active', created_by: 15, source_system: 'treatment_program', source_reference: request.source_reference });
  const snapshot = enrollment.readProgramEnrollment(voucher, { required: true }), clinic = await db.Clinica.findByPk(72);
  const appointments = [];
  for (let position = 0; position < 3; position++) {
    const session = await db.PatientProgramSession.create({ voucher_id: voucher.id, session_key: 's' + position, position,
      snapshot_sha256: snapshot.sha256, snapshot: snapshot.appointments[position] });
    const appointment = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: patient.id_paciente, voucher_id: voucher.id,
      doctor_id: 1, instalacion_id: 101, tratamiento_id: 30, inicio: new Date(Date.UTC(2027, 0, 4 + position * 7, 9)), fin: new Date(Date.UTC(2027, 0, 4 + position * 7, 9, 30)),
      estado: 'pendiente', source_system: 'treatment_program', source_reference: `program-session:${session.id}:TESTONLY-booking`,
      import_metadata: { automation_policy: 'hold', notification_suppression: { appointment_details: true, day_before: true, same_day: true } } });
    await session.update({ appointment_id: appointment.id_cita }); appointments.push(appointment);
  }
  let sequence = 0;
  async function produce({ tooLong = false, rollback = false } = {}) {
    return sql.transaction(async transaction => {
      await db.PatientVoucher.findByPk(voucher.id, { transaction, lock: transaction.LOCK.UPDATE });
      const receipt = await db.PatientProgramBookingRequest.create({ voucher_id: voucher.id, request_key: 'TESTONLY-booking-' + ++sequence,
        request_sha256: C.hash({ sequence }), created_by: 15, result: { voucher_id: voucher.public_id, replayed: false, reminders_enabled: false,
          sessions: [{ key: 's2', action: 'created', appointment_id: appointments[2].id_cita,
            start_at: appointments[2].inicio.toISOString(), end_at: appointments[2].fin.toISOString() }] } }, { transaction });
      const communication = await runtime.recordBookingReceipt({ receipt, voucher, snapshot: tooLong ? { ...snapshot, name: 'P'.repeat(2000) } : snapshot,
        clinic, actorId: 15, transaction });
      await receipt.update({ result: { ...receipt.result, communication } }, { transaction });
      if (rollback) throw Error('TESTONLY_ROLLBACK');
      return db.PatientOperationalEvent.findByPk(communication.event_id, { transaction });
    });
  }
  const before = { events: await db.PatientOperationalEvent.count(), jobs: await db.JobRequest.count() };
  await assert.rejects(produce({ rollback: true }), /TESTONLY_ROLLBACK/);
  assert.equal(await db.PatientOperationalEvent.count(), before.events); assert.equal(await db.JobRequest.count(), before.jobs);
  const blocked = await produce({ tooLong: true }); assert.equal(blocked.metadata.delivery_enabled, false);
  assert.equal(blocked.metadata.delivery_disabled_reason, 'program_details_body_too_long');
  assert.equal(await db.CitaPaciente.count(), 3);
  const event = await produce(); assert.equal(event.metadata.notice.appointment_count, 3); assert.equal(event.metadata.notice.pending_count, 2);
  assert.equal(event.metadata.delivery_enabled, true);
  assert.equal(await db.JobRequest.count({ where: { type: 'patient_program_booking_notice_dispatch' } }), 1);
  const dispatches = await Promise.all(Array.from({ length: 5 }, () => runtime.dispatch({ request_event_id: event.id, clinic_id: 72 })));
  assert.equal(new Set(dispatches.map(row => row.result.execution_id)).size, 1);
  const executionId = dispatches[0].result.execution_id;
  const run = async id => { const execution = await db.FlowExecutionV2.findByPk(id); return engine.runExecution(id,
    execution.status === 'waiting' ? { resumeMode: 'retry_current_node' } : {}); };
  const started = await run(executionId);
  if (started.status !== 'waiting') {
    const logs = await db.FlowExecutionLogV2.findAll({ where: { flow_execution_id: executionId, status: 'error' }, raw: true });
    throw Error('TESTONLY_GRAPH_SEND_FAILED:' + logs.map(row => row.error_message).join(','));
  }
  assert.equal(started.current_node_id, 'N3'); assert.equal(t.queued.size, 1);
  const outbound = await db.Message.findOne({ where: { automation_delivery_key: `program-booking-notice:72:${event.id}:outbound` } });
  assert(outbound); assert.equal(outbound.metadata.kind, 'patient_program_booking_notice');
  await engine._processNode(source.nodes[1], started.context, { execution: started }); assert.equal(t.queued.size, 1);
  const accepted = t.clock.toISOString(); await outbound.update({ status: 'sent', metadata: { ...outbound.metadata,
    wamid: 'wamid.TESTONLY.program.' + outbound.id, provider_acceptance_at: accepted } });
  await run(executionId);
  async function reply(target, answer, extra = {}) {
    const request = await db.PatientOperationalEvent.findByPk(target.metadata.program_booking_request_event_id);
    const message = await db.Message.create({ conversation_id: target.conversation_id, direction: 'inbound', message_type: 'text', status: 'delivered',
      content: answer === 'yes' ? 'Los datos son correctos' : answer === 'no' ? 'Quiero cambiar las fechas' : answer, sent_at: t.clock,
      metadata: { historical: false, automatic_actions_allowed: true, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: t.clock.toISOString(),
        phone_number_id: t.sender.phoneNumberId, waba_id: t.sender.wabaId, context: { id: target.metadata.wamid },
        ...(answer === 'yes' || answer === 'no' ? { button: { payload: `ppb:${target.metadata.program_booking_request_event_id}:${request.metadata.reply_token}:${answer}` } } : {}), ...extra } });
    const conversation = await db.Conversation.findByPk(message.conversation_id);
    return { message, conversation, outcome: await runtime.inbound({ message, conversation }) };
  }
  await appointments[1].update({ estado: 'recordatorio_confirmado' });
  const yes = await reply(outbound, 'yes'); assert.equal(yes.outcome.correlated, true);
  await run(executionId);
  const statuses = (await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })).map(row => row.estado);
  assert.deepEqual(statuses, ['info_confirmada', 'recordatorio_confirmado', 'info_confirmada']);
  assert.equal(emitted.length, 2); assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: C.TRANSITION } }), 1);
  assert.equal((await runtime.inbound({ message: yes.message, conversation: yes.conversation })).ignored, true);
  assert.equal(await db.PatientProgramSession.count({ where: { consumption_movement_id: { [S.Op.ne]: null } } }), 0);
  report.checks.push('Owned SQL receipt/event/outbox rollback atomically; overlong summary blocks communication only; all three future reservations plus two pending appear; concurrent dispatch and restart reuse one V2 execution/message; native graph confirms only details and preserves attendance/reminder state.');

  // Same dates, fresh receipt: old correlation must never become current again.
  const next = await produce(); assert.notEqual(next.id, event.id);
  assert.equal(await runtime.current(event), null);
  const old = await runtime.inbound({ message: yes.message, conversation: yes.conversation }); assert(old.ignored);
  const currentProof = { ...event.toJSON(), metadata: { ...event.metadata } };
  const atDeadline = new Date(C.time(accepted) + 60 * 60000 + 1); t.clock = atDeadline;
  const late = { ...yes.message.toJSON(), sent_at: atDeadline };
  assert.equal(await runtime.replyProof(currentProof, outbound, late, yes.conversation), null);
  const badWaba = { ...yes.message.toJSON(), metadata: { ...yes.message.metadata, waba_id: 'OTHER-WABA' } };
  assert.equal(await runtime.replyProof(currentProof, outbound, badWaba, yes.conversation), null);
  report.checks.push('A new receipt with identical dates supersedes the old token; old correlated replies are claimed/ignored, and deadline+1ms / different WABA cannot prove a confirmation before a timeout job runs.');
  assert.equal(t.aiCalls.length, 0);
  async function begin() {
    await db.CitaPaciente.update({ estado: 'pendiente' }, { where: { voucher_id: voucher.id } });
    for (const appointment of appointments) await appointment.reload();
    const request = await produce(), dispatch = await runtime.dispatch({ request_event_id: request.id, clinic_id: 72 });
    const executionId = dispatch.result.execution_id, waiting = await run(executionId);
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.current_node_id, 'N3');
    const message = await db.Message.findOne({ where: { automation_delivery_key: `program-booking-notice:72:${request.id}:outbound` } });
    assert(message); await message.update({ status: 'sent', metadata: { ...message.metadata,
      wamid: 'wamid.TESTONLY.program.' + message.id, provider_acceptance_at: t.clock.toISOString() } });
    await run(executionId);
    return { request, executionId, message };
  }
  async function resolution(request) {
    return db.PatientOperationalEvent.findOne({ where: { event_type: C.TRANSITION,
      [S.Op.and]: S.where(S.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.request_event_id'))"), String(request.id)) } });
  }
  async function unchanged() {
    assert.deepEqual((await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })).map(row => row.estado), ['pendiente', 'pendiente', 'pendiente']);
  }
  const refusal = await begin(); const refused = await reply(refusal.message, 'no'); assert.equal(refused.outcome.correlated, true, JSON.stringify(refused.outcome));
  const refusedRun = await run(refusal.executionId);
  assert(await resolution(refusal.request), 'TESTONLY_REFUSAL:' + JSON.stringify(refusedRun.toJSON ? refusedRun.toJSON() : refusedRun));
  assert.equal((await resolution(refusal.request)).metadata.reason, 'patient_requested_changes'); await unchanged();
  const notifications = await db.Notification.count(); assert(notifications >= 2);
  await run(refusal.executionId); assert.equal(await db.Notification.count(), notifications);
  const silence = await begin(); t.clock = new Date(+t.clock + 60 * 60000 + 1); await run(silence.executionId);
  assert.equal((await resolution(silence.request)).metadata.reason, 'no_response'); await unchanged();
  const contradictory = await begin(); await reply(contradictory.message, 'yes'); await reply(contradictory.message, 'no');
  t.clock = new Date(+t.clock + 90001); t.aiOutput = { intent: 'correct', confidence: 1, unequivocal: true, evidence: 'Los datos son correctos' };
  const conflicted = await db.FlowExecutionV2.findByPk(contradictory.executionId);
  assert.equal(conflicted.context.program_confirmation.reply_conflict, true);
  // Even a maliciously injected positive AI result cannot override buttons.
  const forced = await runtime.resolveAction({ execution: conflicted, node: source.nodes.find(node => node.id === 'N7'),
    context: { ...conflicted.context, outputs: { N5: { ...t.aiOutput,
      _program_confirmation_response_version: conflicted.context.program_confirmation.response_version } } } });
  assert.equal(forced.output.result, 'review_required'); assert.deepEqual(forced.output.appointment_ids, []);
  assert.equal((await resolution(contradictory.request)).metadata.reason, 'response_unclear'); await unchanged();
  assert.equal(t.aiCalls.length, 0);
  const natural = await begin(); await reply(natural.message, 'Sí, los datos de todas las citas son correctos');
  t.aiOutput = { intent: 'correct', confidence: 0.99, unequivocal: true, evidence: 'los datos de todas las citas son correctos' };
  const buffering = await run(natural.executionId); assert.equal(buffering.status, 'waiting');
  t.clock = new Date(+t.clock + 90001); await run(natural.executionId);
  assert.equal((await resolution(natural.request)).metadata.state, 'confirmed'); assert.equal(t.aiCalls.length, 1);
  report.checks.push('The real graph handles negative buttons and provider-based silence through persistent reception review without changing appointments; repeated execution does not duplicate notifications. Contradictory buttons cannot be overridden even by injected positive AI proof; natural text uses the native 90-second buffer and attested complete-batch analysis.');

  const broker = await begin(), execution = await db.FlowExecutionV2.findByPk(broker.executionId);
  const conversation = await db.Conversation.findByPk(broker.message.conversation_id);
  const send = { message: broker.message, conversation, execution, payload: { type: 'template', template: { name: C.TEMPLATE,
    components: broker.message.metadata.template_components } } };
  assert.equal(await runtime.authorizeEligibility(send), true);
  assert.equal(await runtime.authorizeEligibility({ ...send, payload: { type: 'template', template: { ...send.payload.template, components: [] } } }), false);
  const transport = { message: broker.message, to: patient.telefono_movil, sender: t.sender, useTemplate: true,
    templateName: C.TEMPLATE, templateLanguage: 'es_ES', templateComponents: broker.message.metadata.template_components };
  assert.equal((await runtime.authorizeTransport(transport)).allowed, true);
  assert.equal((await runtime.authorizeTransport({ ...transport, to: '34600000999' })).allowed, false);
  t.blocked = true; assert.equal((await runtime.authorizeTransport(transport)).allowed, false); t.blocked = false;
  t.enabled = false; assert.equal((await runtime.authorizeTransport(transport)).allowed, false); t.enabled = true;
  const originalPhone = patient.telefono_movil;
  await patient.update({ telefono_movil: '34600000998' });
  assert.equal((await runtime.authorizeTransport(transport)).allowed, false);
  assert.equal((await reply(broker.message, 'yes')).outcome.ignored, true);
  await patient.update({ telefono_movil: originalPhone });
  await appointments[0].update({ estado: 'cancelada' });
  assert.equal(await runtime.current(broker.request), null);
  assert.equal((await reply(broker.message, 'yes')).outcome.ignored, true);
  await appointments[0].update({ estado: 'pendiente' });
  const deliveryFailure = await begin();
  await deliveryFailure.message.update({ status: 'failed', metadata: { ...deliveryFailure.message.metadata,
    wamid: null, provider_acceptance_at: null, error: 'TESTONLY_PROVIDER_REJECTION' } });
  t.clock = new Date(+t.clock + 60001);
  await run(deliveryFailure.executionId);
  assert.equal((await resolution(deliveryFailure.request)).metadata.reason, 'delivery_failed'); await unchanged();
  report.checks.push('Broker/transport authorizes only the exact frozen template, recipient, current gate and communication permission; changed phone or cancellation invalidates the old response. Native failed delivery becomes reception review, never confirmation, and no patient HOLD or consent state is changed.');
  assert.equal(await db.PatientConsentDocument.count(), 0);
  assert.equal((await runtime.view({ voucherId: voucher.id })).status, 'review_required');
  const gated = await begin(), counts = { events: await db.PatientOperationalEvent.count(), jobs: await db.JobRequest.count() };
  t.enabled = false;
  await sql.transaction(async transaction => {
    await db.PatientVoucher.findByPk(voucher.id, { transaction, lock: transaction.LOCK.UPDATE });
    const previousReceipt = await db.PatientProgramBookingRequest.findByPk(gated.request.metadata.notice.receipt_id, { transaction });
    const receipt = await db.PatientProgramBookingRequest.create({ voucher_id: voucher.id, request_key: 'TESTONLY-gate-off',
      request_sha256: C.hash({ gate: false }), created_by: 15, result: C.receiptResult(previousReceipt.result) }, { transaction });
    assert.equal((await runtime.recordBookingReceipt({ receipt, voucher, snapshot, clinic, actorId: 15, transaction })).reason, 'runtime_disabled');
  });
  assert.equal(await db.PatientOperationalEvent.count(), counts.events); assert.equal(await db.JobRequest.count(), counts.jobs);
  t.enabled = true;
  assert.equal(await runtime.current(gated.request), null);
  assert.equal((await reply(gated.message, 'yes')).outcome.ignored, true);
  report.checks.push('A booking receipt created while the gate is OFF creates zero events/jobs, yet permanently supersedes the previous token when the gate later reopens.');
  assert.equal(approved.status, 'APPROVED'); // Synthetic SQL only, never a Meta approval.
}));
