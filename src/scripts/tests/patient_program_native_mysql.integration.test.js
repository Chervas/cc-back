'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const modular = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { createRuntime } = require('../../services/patientProgramBookingNotice.service');
const A = require('../../lib/patient-program-appointment-flow'), C = require('../../lib/patient-program-booking-confirmation');
test('actual booking coordinator -> actual published appointment graph adapted -> standard send/wait/AI/atomic resolution, owned SQL only', {
  skip: process.env.PROGRAM_NATIVE_MYSQL_TEST !== '1', timeout: 240000,
}, async () => withIsolatedCampaignMysql(async scope => {
  assert(process.env.PROGRAM_NATIVE_FLOW_FIXTURE?.startsWith('/home/ubuntu/secure-imports/'));
  const sources = JSON.parse(fs.readFileSync(process.env.PROGRAM_NATIVE_FLOW_FIXTURE, 'utf8'));
  assert.equal(sources.length, 2); assert(sources.every(source => A.EVENTS.includes(source.trigger_type)));
  let runtime;
  const f = await createOwnedProgramResumeFixture(scope, { sessionCount: 30, programName: 'TESTONLY '.padEnd(160, 'P'),
    bookingNoticeAdapter: { recordBookingReceipt: values => runtime.recordBookingReceipt(values) } });
  const { sql, models: db, report } = scope, D = S.DataTypes;
  // Add only missing fixture fields on this private, newly created database.
  for (const [model, fields] of [[db.Paciente, { clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING, email: D.STRING, telefono_movil: D.STRING, idioma_preferido: D.STRING }],
    [db.Clinica, { direccion: D.STRING, telefono: D.STRING, url_web: D.STRING, url_ficha_local: D.STRING }], [db.Usuario, { email: D.STRING, email_usuario: D.STRING, rol_usuario: D.STRING }],
    [db.Tratamiento, { automation_template_bindings: D.JSON, appointment_automation_template_key: D.STRING }]]) {
    for (const [name, type] of Object.entries(fields)) if (!model.rawAttributes[name]) {
      await sql.getQueryInterface().addColumn(model.getTableName(), name, { type, allowNull: true });
      model.rawAttributes[name] = { type, allowNull: true }; model.refreshAttributes();
    }
  }
  const t = await modular(scope, { preserveClinicalModels: true });
  t.enabled = true; t.clock = new Date('2030-01-01T08:00:00Z'); f.advance(t.clock);
  await db.Clinica.update({ nombre_clinica: 'TESTONLY '.padEnd(80, 'C') }, { where: { id_clinica: 100 } });
  await db.Paciente.update({ clinica_id: 100, nombre: 'TESTONLY', apellidos: 'Programme', telefono_movil: '34600000001', idioma_preferido: 'es' }, { where: { id_paciente: 1 } });
  await db.UsuarioClinica.create({ id_clinica: 100, id_usuario: 1, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' });
  const templates = {};
  for (const source of sources) {
    const adapted = A.adapt(source); delete adapted.id;
    Object.assign(adapted, { public_id: 'TESTONLY-' + source.trigger_type, version: 1, clinic_id: 100, group_id: 50,
      template_key: source.template_key.replace(/__clinic_\d+$/, '__clinic_100'), is_active: true, published_at: t.clock, created_by: 1 });
    Object.assign(adapted.trigger_config[A.POLICY], { configured: true, enabled_after: '2030-01-01T07:00:00Z' });
    adapted.nodes.find(node => node.id === adapted.entry_node_id).config[A.POLICY] = structuredClone(adapted.trigger_config[A.POLICY]);
    assert(A.graphValid(adapted), 'Persisted draft fixture must configure both trigger projections');
    templates[source.trigger_type] = await db.AutomationFlowTemplateV2.create(adapted);
  }
  await db.WhatsappTemplateCatalog.create({ id: 119, ...C.catalogPreparation().whatsapp, is_active: true, is_generic: true });
  await db.WhatsappTemplate.create({ waba_id: t.sender.wabaId, catalog_template_id: 119, name: C.TEMPLATE + '_v6', language: 'es', category: 'UTILITY', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] });
  const stop = require('../../lib/automation-runtime-stop');
  const appointmentRuntime = loadSource('appointmentAutomationV2Runtime.service', { '../../models': db, './socket.service': { getIO: () => null },
    './jobRequests.service': t.requests, './jobScheduler.service': { triggerImmediate: async () => {} } }, { JOB_RUNTIME_NAMESPACE: 'TESTONLY' });
  const filename = require.resolve('../../services/flowEngineV2.service'), local = createRequire(filename), module = { exports: {} };
  const dependencies = { ...t.dependencies, '../lib/automation-runtime-stop': stop, './patientProgramBookingNotice.service': { current: () => runtime },
    './appointmentPatientLinks.service': require('../../services/appointmentPatientLinks.service') };
  const forbidden = new Proxy({}, { get: (_target, key) => () => { throw Error('UNEXPECTED_NATIVE_PROGRAM_DEPENDENCY:' + String(key)); } });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: t.Clock, Buffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone, process: { env: { JOB_RUNTIME_NAMESPACE: 'TESTONLY' } },
    console: { log() {}, warn() {}, error() {} }, require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name.startsWith('../lib/') || name.startsWith('../config/') || ['sequelize', 'crypto'].includes(name) ? local(name) : forbidden }, { filename, timeout: 10000 });
  const engine = module.exports;
  const deps = { db, nativeOnly: true, engine, stop, enabled: () => t.enabled, now: () => t.clock,
    enqueueJob: (...args) => { if (t.failOutbox) throw Error('TESTONLY_OUTBOX_ROLLBACK'); return t.requests.enqueueUniqueJobRequest(...args); },
    resolveAppointmentTemplate: appointmentRuntime.resolveTemplateForCitaEvent,
    deliveryReady: async () => !t.senderBlocked, authorizeActor: async () => { if (t.accessDenied) throw Error('TESTONLY_ACCESS_DENIED'); },
    communicationAllowed: async () => { if (t.preferenceDenied) throw Error('TESTONLY_CHANNEL_DENIED'); } };
  runtime = createRuntime(deps);
  const flag = process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED;
  process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED = 'true';
  let sequence = 0;
  const advance = milliseconds => { t.clock = new Date(+t.clock + milliseconds); f.advance(t.clock); };
  const run = async id => {
    const row = await db.FlowExecutionV2.findByPk(id);
    const result = await engine.runExecution(id, row.status === 'waiting' ? { resumeMode: 'retry_current_node' } : {});
    if (result.status === 'failed') {
      const logs = await db.FlowExecutionLogV2.findAll({ where: { flow_execution_id: id, status: 'error' }, raw: true });
      throw Error('TESTONLY_NATIVE_ENGINE:' + logs.map(row => row.error_message).join(','));
    }
    return result;
  };
  async function send(result) {
    assert(result.communication?.event_id, JSON.stringify(result));
    const request = await db.PatientOperationalEvent.findByPk(result.communication.event_id);
    const dispatched = await Promise.all(Array.from({ length: 3 }, () => runtime.dispatch({ request_event_id: request.id, clinic_id: 100 })));
    assert.equal(new Set(dispatched.map(row => row.result.execution_id)).size, 1);
    const execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: `program-booking-notice:100:${request.id}` } });
    assert(execution); assert.equal(execution.trigger_type, request.event_type); assert(A.nativeFlow(execution));
    if (t.clock.getUTCHours() >= 20 || t.clock.getUTCHours() < 7) {
      const next = new Date(t.clock); next.setUTCDate(next.getUTCDate() + 1); next.setUTCHours(8, 0, 0, 0); advance(+next - +t.clock);
    }
    await run(execution.id);
    const message = await db.Message.findOne({ where: { automation_delivery_key: `program-booking-notice:100:${request.id}:outbound` } });
    assert(message, 'native message missing');
    await message.update({ status: 'sent', metadata: { ...message.metadata, wamid: 'wamid.TESTONLY.' + message.id, provider_acceptance_at: t.clock.toISOString() } });
    await run(execution.id);
    return { request, execution, message };
  }
  async function reply(bundle, text, answer) {
    const message = await db.Message.create({ conversation_id: bundle.message.conversation_id, direction: 'inbound', message_type: 'text', status: 'delivered', content: text, sent_at: t.clock,
      metadata: { historical: false, automatic_actions_allowed: true, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: t.clock.toISOString(),
        phone_number_id: t.sender.phoneNumberId, waba_id: t.sender.wabaId, context: { id: bundle.message.metadata.wamid },
        ...(answer ? { button: { payload: `ppb:${bundle.request.id}:${bundle.request.metadata.reply_token}:${answer}` } } : {}) } });
    return runtime.inbound({ message, conversation: await db.Conversation.findByPk(message.conversation_id) });
  }
  async function resolution(request) {
    return db.PatientOperationalEvent.findOne({ where: { event_type: C.TRANSITION,
      [S.Op.and]: S.where(S.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.request_event_id'))"), String(request.id)) } });
  }
  async function move(reason = 'clinic_schedule', scope = 'single', chooseSend = true) {
    const plan = await f.read(), source = plan.sessions.find(row => row.scheduling_status === 'reserved');
    const base = { mode: 'reschedule', reschedule_scope: scope, replan_from_key: source.key, expected_plan_revision: plan.plan_revision, reschedule_reason: reason };
    ++sequence;
    const target = new Date(new Date(source.start_at).getTime() + 86400000);
    while ([0, 6].includes(target.getUTCDay())) target.setUTCDate(target.getUTCDate() + 1);
    const preview = await f.propose({ ...base, reschedule_start_local: require('../../lib/program-reschedule').civilLocal(target, 'Europe/Madrid') });
    const payload = { ...base, request_key: 'TESTONLY-move-' + sequence, sessions: preview.proposals.map(row => ({ key: row.key, start_at: row.solution.start_at, selections: row.selections })) };
    try { return await f.book(payload); } catch (error) {
      if (error.code !== 'appointment_notice_already_sent_today') throw error;
      const rejected = { ...payload, notice_decision: { send: chooseSend, acknowledgement: error.details.acknowledgement } };
      return f.book(rejected);
    }
  }
  try {
    const input = { request_key: 'TESTONLY-native-first', sessions: [{ key: 's0', start_at: '2030-03-04T09:00:00Z' },
      { key: 's2', start_at: '2030-03-18T09:00:00Z' }, { key: 's4', start_at: '2030-04-01T08:00:00Z' }] };
    const values = await Promise.all([f.book(input), f.book(input)]);
    assert.equal(await db.PatientProgramBookingRequest.count(), 1);
    assert.equal(await db.JobRequest.count({ where: { type: 'patient_program_booking_notice_dispatch' } }), 1);
    const first = await send(values[0]); assert.equal(first.request.metadata.notice.appointment_count, 3); assert.equal(first.request.metadata.notice.pending_count, 27);
    assert.match(first.message.content, /1\) 04-03-2030 10:00/); assert.match(first.message.content, /5\) 01-04-2030 10:00/);
    await run(first.execution.id); assert.equal(t.queued.size, 1);
    await (await f.appointment('s2')).update({ estado: 'recordatorio_confirmado' });
    assert((await reply(first, 'Confirmar datos', 'yes')).correlated); await run(first.execution.id);
    assert.equal((await resolution(first.request)).metadata.state, 'confirmed');
    assert.equal((await f.appointment('s0')).estado, 'info_confirmada'); assert.equal((await f.appointment('s2')).estado, 'recordatorio_confirmado');
    assert.equal((await f.appointment('s4')).estado, 'info_confirmada');
    const more = await f.book({ request_key: 'TESTONLY-native-more', sessions: [{ key: 's1', start_at: '2030-03-11T09:00:00Z' }, { key: 's3', start_at: '2030-03-25T09:00:00Z' }] });
    const second = await send(more); assert.equal(second.request.metadata.notice.appointment_count, 5); assert.equal(second.request.metadata.notice.pending_count, 25);
    assert((await reply(first, 'Confirmar datos', 'yes')).ignored);
    const beforePartial = await db.CitaPaciente.findAll({ raw: true });
    t.aiOutput = { intent: 'changes', confidence: 0.98, unequivocal: true, evidence: 'menos el jueves' };
    assert((await reply(second, 'Todas bien menos el jueves')).correlated); advance(90001); await run(second.execution.id);
    assert.equal((await resolution(second.request)).metadata.reason, 'patient_requested_changes');
    assert.deepEqual((await db.CitaPaciente.findAll({ raw: true })).map(row => row.estado), beforePartial.map(row => row.estado));
    const moved = await send(await move('patient_request'));
    assert.equal(moved.execution.trigger_type, 'appointment_rescheduled'); assert.equal(moved.request.metadata.notice.appointment_count, 5);
    assert((await reply(second, 'Confirmar datos', 'yes')).ignored);
    runtime = createRuntime(deps); await run(moved.execution.id);
    assert.equal(await db.Message.count({ where: { automation_delivery_key: moved.message.automation_delivery_key } }), 1);
    const silence = moved; advance((silence.request.metadata.response_timeout_minutes + 1) * 60000); await run(silence.execution.id);
    assert.equal((await resolution(silence.request)).metadata.reason, 'no_response');
    assert.equal(await db.Message.count({ where: { direction: 'outbound', message_type: 'template' } }), 3, 'Silence never sends another request');
    const declined = await move('clinic_schedule', 'following', false); assert.equal(declined.communication.status, 'not_requested');
    const count = await db.FlowExecutionV2.count();
    const administrative = await move('administrative_error'); assert.equal(administrative.communication.reason, 'administrative_error');
    assert.equal(await db.FlowExecutionV2.count(), count);
    const failed = await send(await move('clinic_schedule'));
    await failed.message.update({ status: 'failed' }); advance(60001); await run(failed.execution.id);
    assert.equal((await resolution(failed.request)).metadata.reason, 'delivery_failed');
    const pending = await send(await move('clinic_schedule'));
    const transport = { message: pending.message, to: '34600000001', sender: t.sender, useTemplate: true,
      templateName: pending.message.metadata.template_name, templateLanguage: pending.message.metadata.template_language, templateComponents: pending.message.metadata.template_components };
    assert.equal(transport.templateName, C.TEMPLATE + '_v6'); assert.equal(transport.templateLanguage, 'es');
    assert.equal(transport.templateComponents[0].parameters.length, 3);
    assert.equal((await runtime.authorizeTransport(transport)).allowed, true);
    const eligibility = { message: pending.message, conversation: await db.Conversation.findByPk(pending.message.conversation_id),
      payload: { type: 'template', template: { name: transport.templateName, components: transport.templateComponents } },
      loadExecution: id => db.FlowExecutionV2.findByPk(id), patientHeld: async () => true,
      authorizeProgramBatch: runtime.authorizeEligibility };
    const guard = require('../../lib/whatsappAppointmentEligibility');
    assert.equal(await guard.assertAutomatedMessageEligibility(eligibility), true, 'Only the attested native summary has the narrow HOLD exception');
    await assert.rejects(guard.assertAutomatedMessageEligibility({ ...eligibility,
      payload: { type: 'template', template: { name: 'clinicaclick_resena', components: transport.templateComponents } } }), { code: 'whatsapp_program_batch_ineligible' });
    await assert.rejects(guard.assertAutomatedMessageEligibility({ ...eligibility, authorizeProgramBatch: undefined }), { code: 'whatsapp_program_batch_ineligible' });
    assert.equal((await runtime.authorizeTransport({ ...transport, to: '34600000002' })).allowed, false);
    assert.equal((await runtime.authorizeTransport({ ...transport, sender: { ...t.sender, wabaId: 'TESTONLY-FOREIGN' } })).allowed, false);
    assert.equal((await runtime.authorizeTransport({ ...transport, templateComponents: [] })).allowed, false);
    assert.equal((await runtime.authorizeTransport({ ...transport, templateName: C.TEMPLATE + '_v7' })).allowed, false);
    assert.equal((await runtime.authorizeTransport({ ...transport, templateLanguage: 'es_ES' })).allowed, false);
    for (const denied of ['accessDenied', 'preferenceDenied', 'senderBlocked']) {
      t[denied] = true; assert.equal((await runtime.authorizeTransport(transport)).allowed, false, denied); t[denied] = false;
    }
    await templates.appointment_rescheduled.update({ is_active: false });
    assert.equal((await runtime.authorizeTransport(transport)).allowed, false);
    await templates.appointment_rescheduled.update({ is_active: true });
    await db.Paciente.update({ telefono_movil: '34600000002' }, { where: { id_paciente: 1 } });
    assert.equal(await runtime.current(pending.request), null); assert((await reply(pending, 'Confirmar datos', 'yes')).ignored);
    assert.equal((await runtime.authorizeTransport(transport)).allowed, false);
    await db.Paciente.update({ telefono_movil: '34600000001' }, { where: { id_paciente: 1 } });
    const remainder = { request_key: 'TESTONLY-native-remaining', sessions: Array.from({ length: 25 }, (_, i) => ({ key: 's' + (i + 5),
      start_at: new Date(Date.UTC(2030, 2, 4 + (i + 5) * 7, 9)).toISOString() })) };
    const beforeRollback = await f.databaseState(); t.failOutbox = true;
    await assert.rejects(f.book(remainder), /TESTONLY_OUTBOX_ROLLBACK/); t.failOutbox = false;
    assert.deepEqual(await f.databaseState(), beforeRollback, 'Clinical writes, receipt, event and outbox roll back together');
    const large = await f.book(remainder);
    const oversized = await db.PatientOperationalEvent.findByPk(large.communication.event_id);
    assert.equal(oversized.metadata.notice.appointment_count, 30);
    assert.equal(oversized.metadata.delivery_disabled_reason, 'program_details_body_too_long');
    assert.equal(await db.CitaPaciente.count({ where: { voucher_id: f.voucher.id } }), 30, 'An unprintable summary cannot roll back a valid booking');
    const beforeOversized = t.queued.size, notifications = await db.Notification.count();
    const blocked = await runtime.dispatch({ request_event_id: oversized.id, clinic_id: 100 });
    await run(blocked.result.execution_id);
    assert.equal((await resolution(oversized)).metadata.reason, 'delivery_failed');
    assert.equal(t.queued.size, beforeOversized); assert((await db.Notification.count()) > notifications);
    assert.equal(await db.Message.count({ where: { automation_delivery_key: `program-booking-notice:100:${oversized.id}:outbound` } }), 0);
    const ordinary = await engine._processNode(templates.appointment_created.nodes.find(node => node.id === A.programNode(templates.appointment_created, 0)), { program_confirmation: {} }, {});
    assert.equal(ordinary.next_node_id, templates.appointment_created.trigger_config[A.POLICY].normal_target);
    assert.equal(await db.PatientVoucherMovement.count(), 0); assert.equal(await db.EconomicPayment.count(), 0);
    assert.equal(await db.ConsentDeliveryEvent.count(), 0);
    assert.equal(await db.FlowExecutionV2.count({ where: { trigger_type: C.REQUEST } }), 0);
    report.checks.push('Actual coordinator, real resource solver/booking transactions, actual existing source graphs adapted, native selector and createExecution: double click, partial booking, later sessions, whole-set details confirmation with later-state preservation.');
    report.checks.push('Actual send/wait/AI/comparators/resolver/notification graph: partial acceptance -> reception without status changes; reschedule owner only; old correlation rejected; restart reuses message; silence only notifies; explicit no-send and administrative reason produce no execution.');
    report.checks.push('Provider failure differs from silence; changed recipient blocks old summary; ordinary route preserved; zero parallel trigger, payments, consent delivery or real provider connections.');
    report.checks.push('Transport revalidates actor, care preference, active family, sender, WABA, recipient and complete components. Actual 30-session coordinator: outbox failure rolls back all writes, retry books all dates, oversize summary routes to reception without creating a Message or transport.');
    report.programExecutions = await db.FlowExecutionV2.count({ where: { trigger_type: { [S.Op.in]: A.EVENTS } } });
    report.syntheticTransports = t.queued.size;
  } finally { if (flag === undefined) delete process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED; else process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED = flag; }
}));
