'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');
const modular = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { createRuntime } = require('../../services/patientProgramBookingNotice.service');
const A = require('../../lib/patient-program-appointment-flow');
const C = require('../../lib/patient-program-booking-confirmation');

test('native appointment programs keep audited reception follow-up after the first visit starts, without stale confirmations or another send', {
  skip: process.env.PROGRAM_FOLLOWUP_MYSQL_TEST !== '1', timeout: 240000,
}, async () => withIsolatedCampaignMysql(async scope => {
  assert(process.env.PROGRAM_NATIVE_FLOW_FIXTURE?.startsWith('/home/ubuntu/secure-imports/'));
  const sources = JSON.parse(fs.readFileSync(process.env.PROGRAM_NATIVE_FLOW_FIXTURE, 'utf8'));
  assert.equal(sources.length, 2);
  let runtime;
  const f = await createOwnedProgramResumeFixture(scope, { sessionCount: 3, programName: 'TESTONLY follow-up',
    bookingNoticeAdapter: { recordBookingReceipt: values => runtime.recordBookingReceipt(values) } });
  const { sql, models: db, report } = scope, D = S.DataTypes;
  for (const [model, fields] of [[db.Paciente, { clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING, email: D.STRING, telefono_movil: D.STRING, idioma_preferido: D.STRING }],
    [db.Clinica, { direccion: D.STRING, telefono: D.STRING, url_web: D.STRING, url_ficha_local: D.STRING }],
    [db.Usuario, { email: D.STRING, email_usuario: D.STRING, rol_usuario: D.STRING }],
    [db.Tratamiento, { automation_template_bindings: D.JSON, appointment_automation_template_key: D.STRING }]]) {
    for (const [name, type] of Object.entries(fields)) if (!model.rawAttributes[name]) {
      await sql.getQueryInterface().addColumn(model.getTableName(), name, { type, allowNull: true });
      model.rawAttributes[name] = { type, allowNull: true }; model.refreshAttributes();
    }
  }
  const t = await modular(scope, { preserveClinicalModels: true });
  const clock = at => { t.clock = new Date(at); f.advance(t.clock); };
  clock('2030-01-02T08:00:00Z'); t.enabled = true;
  await db.Clinica.update({ nombre_clinica: 'TESTONLY clinic' }, { where: { id_clinica: 100 } });
  await db.Paciente.update({ clinica_id: 100, nombre: 'TESTONLY', apellidos: 'Follow-up', telefono_movil: '34600000001', idioma_preferido: 'es' }, { where: { id_paciente: 1 } });
  await db.UsuarioClinica.create({ id_clinica: 100, id_usuario: 1, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' });
  const templates = {}, graphHashes = {};
  for (const source of sources) {
    const adapted = A.adapt(source); delete adapted.id;
    Object.assign(adapted, { public_id: 'TESTONLY-followup-' + source.trigger_type, version: 1, clinic_id: 100, group_id: 50,
      template_key: source.template_key.replace(/__clinic_\d+$/, '__clinic_100'), is_active: true, published_at: t.clock, created_by: 1 });
    Object.assign(adapted.trigger_config[A.POLICY], { configured: true, enabled_after: '2030-01-01T07:00:00Z' });
    adapted.nodes.find(node => node.id === adapted.entry_node_id).config[A.POLICY] = structuredClone(adapted.trigger_config[A.POLICY]);
    assert(A.graphValid(adapted), 'Persisted draft fixture must configure both trigger projections');
    templates[source.trigger_type] = await db.AutomationFlowTemplateV2.create(adapted);
    graphHashes[source.trigger_type] = C.hash(adapted.nodes);
  }
  await db.WhatsappTemplate.create({ waba_id: t.sender.wabaId, name: C.TEMPLATE, language: 'es_ES', category: 'UTILITY', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] });
  const stop = require('../../lib/automation-runtime-stop');
  const dependencies = { ...t.dependencies, '../lib/automation-runtime-stop': stop,
    './patientProgramBookingNotice.service': { current: () => runtime },
    './appointmentPatientLinks.service': require('../../services/appointmentPatientLinks.service') };
  const filename = require.resolve('../../services/flowEngineV2.service'), actual = createRequire(filename), module = { exports: {} };
  const forbidden = new Proxy({}, { get: (_target, key) => () => { throw Error('UNEXPECTED_FOLLOWUP_DEPENDENCY:' + String(key)); } });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: t.Clock, Buffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone, process: { env: { JOB_RUNTIME_NAMESPACE: 'TESTONLY' } },
    console: { log() {}, warn() {}, error() {} }, require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name.startsWith('../lib/') || name.startsWith('../config/') || ['sequelize', 'crypto'].includes(name) ? actual(name) : forbidden }, { filename, timeout: 10000 });
  const engine = module.exports;
  runtime = createRuntime({ db, nativeOnly: true, engine, stop, now: () => t.clock, enabled: () => t.enabled,
    enqueueJob: t.requests.enqueueUniqueJobRequest, deliveryReady: async () => true,
    authorizeActor: async () => {}, communicationAllowed: async () => {},
    resolveAppointmentTemplate: async (_appointment, event) => templates[event] });
  const run = async id => {
    const row = await db.FlowExecutionV2.findByPk(id);
    const result = await engine.runExecution(id, row.status === 'waiting' ? { resumeMode: 'retry_current_node' } : {});
    if (result.status === 'failed') {
      const logs = await db.FlowExecutionLogV2.findAll({ where: { flow_execution_id: id, status: 'error' }, raw: true });
      throw Error('TESTONLY_FOLLOWUP_ENGINE:' + logs.map(row => row.error_message).join(','));
    }
    return result;
  };
  const initial = await f.book({ request_key: 'TESTONLY-followup-initial', sessions: [{ key: 's0', start_at: '2030-01-02T09:00:00Z' },
    { key: 's1', start_at: '2030-01-09T09:00:00Z' }] });
  assert(initial.communication.event_id);
  const baseReceipt = await db.PatientProgramBookingRequest.findOne({ order: [['id', 'ASC']] });
  const clinic = await db.Clinica.findByPk(100);
  let sequence = 0;
  async function produce(event) {
    clock('2030-01-02T08:00:00Z');
    return sql.transaction(async transaction => {
      await db.PatientVoucher.findByPk(f.voucher.id, { transaction, lock: transaction.LOCK.UPDATE });
      const result = structuredClone(baseReceipt.result); delete result.communication;
      if (event === 'appointment_rescheduled') {
        result.reschedule_reason = 'clinic_schedule';
        result.sessions = result.sessions.map(row => ({ ...row, action: 'rescheduled', previous_appointment: {
          start_at: new Date(C.time(row.start_at) - 3600000).toISOString(), end_at: new Date(C.time(row.end_at) - 3600000).toISOString() } }));
      }
      const receipt = await db.PatientProgramBookingRequest.create({ voucher_id: f.voucher.id, request_key: 'TESTONLY-followup-' + ++sequence,
        request_sha256: C.hash({ sequence }), created_by: 1, result }, { transaction });
      const state = await runtime.recordBookingReceipt({ receipt, voucher: f.voucher, snapshot: f.operational, clinic, actorId: 1, transaction });
      return db.PatientOperationalEvent.findByPk(state.event_id, { transaction });
    });
  }
  async function send(event) {
    const request = await produce(event);
    assert.equal(request.event_type, event); assert.equal(request.metadata.response_timeout_minutes, 240);
    const jobs = await Promise.all(Array.from({ length: 3 }, () => runtime.dispatch({ request_event_id: request.id, clinic_id: 100 })));
    assert.equal(new Set(jobs.map(row => row.result.execution_id)).size, 1);
    const execution = await db.FlowExecutionV2.findByPk(jobs[0].result.execution_id);
    await run(execution.id);
    const message = await db.Message.findOne({ where: { automation_delivery_key: `program-booking-notice:100:${request.id}:outbound` } });
    assert(message);
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
  const transitions = request => db.PatientOperationalEvent.findAll({ where: { event_type: C.TRANSITION,
    [S.Op.and]: S.where(S.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.request_event_id'))"), String(request.id)) } });
  const states = async () => (await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })).map(row => row.estado);
  const originalFlag = process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED;
  process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED = 'true';
  try {
    for (const event of A.EVENTS) {
      for (const scenario of ['silence', 'delivery_failed', 'buffered_positive', 'buffered_unclear', 'positive_after_start', 'changes_after_start', 'analysis_crosses_start']) {
        const bundle = await send(event), before = await states();
        const queued = t.queued.size, notifications = await db.Notification.count();
        if (scenario.startsWith('buffered_')) {
          clock('2030-01-02T08:59:30Z');
          const text = scenario === 'buffered_positive' ? 'Todos los datos son correctos' : 'Tengo una pregunta';
          t.aiOutput = { intent: scenario === 'buffered_positive' ? 'correct' : 'unclear', confidence: 0.99,
            unequivocal: scenario === 'buffered_positive', evidence: text };
          assert((await reply(bundle, text)).correlated);
        }
        clock('2030-01-02T09:01:01Z');
        assert.equal(await runtime.current(bundle.request), null, 'strict send/confirmation validity is unchanged');
        assert.equal((await runtime.sendPreflight({ execution: bundle.execution })).suppressed, true);
        if (scenario === 'delivery_failed') await bundle.message.update({ status: 'failed' });
        if (scenario === 'silence') {
          assert.equal((await runtime.waitContext({ execution: bundle.execution })).status, 'awaiting_response');
          clock('2030-01-02T12:00:01Z');
        }
        if (scenario.endsWith('_after_start')) assert((await reply(bundle, scenario, scenario.startsWith('positive') ? 'yes' : 'no')).correlated);
        if (scenario === 'analysis_crosses_start') {
          clock('2030-01-02T08:58:29Z');
          t.aiOutput = { intent: 'correct', confidence: 0.99, unequivocal: true, evidence: 'Todo correcto' };
          assert((await reply(bundle, 'Todo correcto')).correlated);
          clock('2030-01-02T08:59:59Z');
          t.aiDuringCall = async () => clock('2030-01-02T09:00:01Z');
        }
        const races = await Promise.allSettled([run(bundle.execution.id), run(bundle.execution.id)]);
        assert(races.some(result => result.status === 'fulfilled'));
        for (const result of races) if (result.status === 'rejected') assert.equal(result.reason.code, 'flow_execution_changed');
        t.aiDuringCall = null;
        await run(bundle.execution.id);
        const results = await transitions(bundle.request);
        assert.equal(results.length, 1, event + ':' + scenario);
        const expected = scenario === 'silence' ? 'no_response' : scenario === 'delivery_failed' ? 'delivery_failed'
          : scenario === 'buffered_unclear' ? 'response_unclear' : scenario === 'changes_after_start' ? 'patient_requested_changes' : 'appointment_started';
        assert.equal(results[0].metadata.state, 'review_required'); assert.equal(results[0].metadata.reason, expected);
        assert.equal(results[0].actor_user_id, null); assert.deepEqual(results[0].metadata.updated_appointment_ids, []);
        assert.equal(results[0].metadata.attendance_confirmed, false); assert.deepEqual(await states(), before);
        assert((await db.Notification.count()) > notifications, 'Reception must receive the existing notification node');
        const notified = await db.Notification.count(); await run(bundle.execution.id); assert.equal(await db.Notification.count(), notified);
        assert.equal((await runtime.waitContext({ execution: bundle.execution })).status, 'superseded', 'resolved follow-up is terminal');
        assert.equal(t.queued.size, queued, 'No second WhatsApp on any follow-up branch');
        report.checks.push(event + ':' + scenario + ': audited once, reception notified, no appointment mutations, no second send');
      }
      for (const invalidate of ['new_receipt', 'changed_phone', 'manual_stop', 'gate_closed']) {
        const bundle = await send(event), notifications = await db.Notification.count();
        if (invalidate === 'new_receipt') await produce(event);
        if (invalidate === 'changed_phone') await db.Paciente.update({ telefono_movil: '34600000002' }, { where: { id_paciente: 1 } });
        if (invalidate === 'manual_stop') await templates[event].update({ is_active: false });
        if (invalidate === 'gate_closed') t.enabled = false;
        clock('2030-01-02T12:00:01Z');
        assert.equal((await runtime.waitContext({ execution: bundle.execution })).status, 'superseded');
        const node = templates[event].nodes.find(row => row.type === C.ACTION && row.config.reason === 'no_response');
        const outcome = await runtime.resolveAction({ execution: bundle.execution, node, context: bundle.execution.context })
          .catch(error => { assert.equal(invalidate, 'manual_stop'); assert(stop.isStop(error)); return null; });
        if (outcome) assert.equal(outcome.output.applied, false);
        assert.equal((await transitions(bundle.request)).length, 0);
        let invoked = false;
        await runtime.withNotification({ execution: bundle.execution, node: { outputs: {} } }, async () => { invoked = true; });
        assert.equal(invoked, false); assert.equal(await db.Notification.count(), notifications);
        t.enabled = true; await templates[event].update({ is_active: true });
        await db.Paciente.update({ telefono_movil: '34600000001' }, { where: { id_paciente: 1 } });
        report.checks.push(event + ':' + invalidate + ': no stale closure, notification or confirmation');
      }
      const future = await send(event); clock('2030-01-02T08:30:00Z');
      assert((await reply(future, 'Confirmar datos', 'yes')).correlated); await run(future.execution.id);
      assert.equal((await transitions(future.request))[0].metadata.state, 'confirmed');
      assert((await states()).every(state => state === 'info_confirmada'));
      assert.equal(C.hash((await db.AutomationFlowTemplateV2.findByPk(templates[event].id)).nodes), graphHashes[event]);
      report.checks.push(event + ': future confirmation remains valid and graph unchanged');
    }
    assert.equal(await db.ConsentDeliveryEvent.count(), 0);
    report.checks.push('Owned MySQL only, real captured native graphs, simulated AI/transport, no consent deliveries.');
    report.syntheticTransports = t.queued.size;
  } finally {
    if (originalFlag === undefined) delete process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED;
    else process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED = originalFlag;
  }
}));
