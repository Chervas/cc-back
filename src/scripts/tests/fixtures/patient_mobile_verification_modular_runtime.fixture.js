'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const S = require('sequelize');
const C = require('../../../lib/patient-mobile-verification');
const { createRuntime } = require('../../../services/patientMobileVerification.service');
const { loadSource } = require('./business_profile_flow_runtime.fixture');

module.exports = async function modularRuntime({ sql, models: db }) {
  db.Sequelize = S;
  const D = S.DataTypes, pk = () => ({ type: D.INTEGER, primaryKey: true, autoIncrement: true });
  const simple = (name, fields, table = name + 's') => sql.define(name, fields, { tableName: table, timestamps: false });
  for (const [name, file] of Object.entries({ PatientOperationalEvent: 'patientoperationalevent', AutomationFlowTemplateV2: 'automationflowtemplatev2',
    FlowExecutionV2: 'flowexecutionv2', FlowExecutionLogV2: 'flowexecutionlogv2', Message: 'message', Notification: 'notification',
    AutomationFlowCatalog: 'automationflowcatalog', WhatsappTemplateCatalog: 'whatsapptemplatecatalog', JobRequest: 'jobrequest' })) {
    db[name] = require('../../../../models/' + file)(sql, D);
  }
  db.Clinica = simple('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
    grupoClinicaId: D.INTEGER, direccion: D.STRING, telefono: D.STRING, url_web: D.STRING, url_ficha_local: D.STRING, configuracion: D.JSON }, 'Clinicas');
  db.Paciente = simple('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    telefono_movil: D.STRING, nombre: D.STRING, apellidos: D.STRING, email: D.STRING, idioma_preferido: D.STRING }, 'Pacientes');
  db.PacienteClinica = simple('PacienteClinica', { id: pk(), paciente_id: D.INTEGER, clinica_id: D.INTEGER });
  db.PatientConsentDocument = simple('PatientConsentDocument', { id: pk(), paciente_id: D.INTEGER, clinica_id: D.INTEGER,
    status: D.STRING, revoked_at: D.DATE, snapshot_hash: D.STRING });
  db.Conversation = simple('Conversation', { id: pk(), clinic_id: D.INTEGER, patient_id: D.INTEGER, lead_id: D.INTEGER,
    channel: D.STRING, contact_id: D.STRING, unread_count: D.INTEGER, last_message_at: D.DATE, last_inbound_at: D.DATE, updatedAt: D.DATE });
  db.WhatsappTemplate = simple('WhatsappTemplate', { id: pk(), waba_id: D.STRING, clinic_id: D.INTEGER,
    catalog_template_id: D.INTEGER, name: D.STRING, language: D.STRING, status: D.STRING, category: D.STRING, is_active: D.BOOLEAN, components: D.JSON });
  db.UsuarioClinica = simple('UsuarioClinica', { id: pk(), id_clinica: D.INTEGER, id_usuario: D.INTEGER, rol_clinica: D.STRING, subrol_clinica: D.STRING });
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_modular_mobile_${i}`; });
  db.FlowExecutionV2.belongsTo(db.AutomationFlowTemplateV2, { foreignKey: 'template_version_id', as: 'templateVersion' });
  db.WhatsappTemplate.belongsTo(db.WhatsappTemplateCatalog, { foreignKey: 'catalog_template_id', as: 'catalog' });
  await sql.sync();
  await sql.getQueryInterface().addIndex('AutomationFlowTemplatesV2', ['public_id', 'version'], { unique: true });
  await sql.getQueryInterface().addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  const t = { clock: new Date('2026-10-20T12:00:00Z'), enabled: false, blocked: false, held: false,
    queueFailures: 0, markerFailure: false, acceptOnPublication: false, queued: new Map(), aiCalls: [], emitted: [],
    aiOutput: { intent: 'unclear', confidence: 0, unequivocal: false, evidence: '' } };
  db.Message.addHook('beforeCreate', row => { row.createdAt = t.clock; });
  const requests = loadSource('jobRequests.service', { '../../models': db }, { JOB_RUNTIME_NAMESPACE: 'TESTONLY' });
  const sender = { originId: 30, phoneNumberId: 'TESTONLY-PHONE', wabaId: 'TESTONLY-WABA', accessToken: 'TESTONLY-NOT-A-CREDENTIAL' };
  const whatsapp = { normalizePhoneNumber: C.phone, checkOutboundLimit: async () => ({}),
    sendMessage: async () => { throw Error('DIRECT_PROVIDER_CALL_FORBIDDEN'); } };
  const canonical = loadSource('../lib/canonical-conversation', { '../../models': db, '../services/whatsapp.service': whatsapp,
    './phone': require('../../../lib/phone'),
    '../services/temporaryPatientDirection.service': { observeConversation: async c => c } }, {});
  const stop = { isStop: e => e.code === 'TESTONLY_STOP', createExecution: v => db.FlowExecutionV2.create(v),
    assertExecutionActive: async execution => {
      const template = await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id);
      if (!t.enabled || !template.is_active) throw Object.assign(Error('TESTONLY_STOP'), { code: 'TESTONLY_STOP' });
    }, prepareMessageForDispatch: async (message, patch) => message.update({ ...patch, metadata: { ...message.metadata, ...patch.metadata } }) };
  let runtime;
  const dependencies = { '../../models': db, './jobRequests.service': requests, './socket.service': { getIO: () => null },
    './notificationsRealtime.service': { emitNotificationCreated(n) { t.emitted.push(n.id); }, emitNotificationUpdated(n) { t.emitted.push(n.id); } },
    './whatsapp.service': whatsapp, '../lib/canonical-conversation': canonical,
    './googleLocalLinks.service': { resolveClinicGoogleLocalLinks: async () => ({}), mergeClinicLinksIntoContext: c => c },
    './patientDirection.service': { resolveOutboundPolicy: async () => ({ clinicConfig: sender }) },
    './marketingOptOut.service': { assertAutomationCommunicationAllowed: async () => { if (t.blocked) throw Error('TESTONLY_BLOCKED'); } },
    './appointmentVisitManaged.service': { current: () => ({}) },
    '../lib/whatsappAuthorizedBrokerClient': { isManagedMessage: async () => false, assertMessageEligible() {} },
    '../lib/automation-runtime-stop': stop, './patientMobileVerification.service': { current: () => runtime },
    './conversationPendingReply.service': { emitAutomationResponseProcessing() {}, findHumanReplyAfterMessage: async () => null },
    './queue.service': { queues: { outboundWhatsApp: { add: async (_name, payload, options) => {
      if (t.queueFailures-- > 0) throw Error('TESTONLY_QUEUE_FAILURE');
      t.queued.set(options.jobId, payload);
      if (t.acceptOnPublication) {
        const row = await db.Message.findByPk(payload.messageId);
        await row.update({ metadata: { ...row.metadata, wamid: 'wamid.TESTONLY.' + row.id, provider_acceptance_at: t.clock.toISOString() } });
      }
      return { id: options.jobId };
    } } } },
    './aiOrchestrator.service': { analyzeStructured: async args => {
      t.aiCalls.push(args);
      if (t.aiDuringCall) await t.aiDuringCall();
      if (t.aiOutput instanceof Error) throw t.aiOutput;
      return structuredClone(t.aiOutput);
    } } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [t.clock])); } static now() { return +t.clock; } }
  const filename = require.resolve('../../../services/flowEngineV2.service'), actual = createRequire(filename);
  const fail = new Proxy({}, { get: (_o, key) => () => { throw Error('UNEXPECTED_MODULAR_DEPENDENCY:' + String(key)); } });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: Clock, Buffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone, process: { env: { JOB_RUNTIME_NAMESPACE: 'TESTONLY' } },
    console: { log() {}, warn() {}, error() {} }, require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name.startsWith('../lib/') || name.startsWith('../config/') || ['sequelize', 'crypto'].includes(name) ? actual(name) : fail }, { filename, timeout: 10000 });
  const engine = module.exports;
  db.Message.addHook('beforeUpdate', row => {
    if (t.markerFailure && row.metadata?.mobile_verification_transport_queued_at) {
      t.markerFailure = false; throw Error('TESTONLY_MARKER_WRITE_FAILURE');
    }
  });
  const deps = { db, engine, stop, now: () => t.clock, enabled: () => t.enabled, enqueueJob: requests.enqueueUniqueJobRequest,
    deliveryReady: (...args) => t.deliveryReady ? t.deliveryReady(...args) : true,
    authorizeActor: async () => { if (t.blocked) throw Error('TESTONLY_ACCESS_DENIED'); }, patientHeld: async () => t.held,
    communicationAllowed: async () => { if (t.blocked) throw Error('TESTONLY_COMMUNICATION_BLOCKED'); },
    checkCorrection: async args => {
      if (t.checkCorrection) return t.checkCorrection(args);
      if (t.blocked) throw Error('TESTONLY_COLLISION');
    }, groupClinicIds: async () => [72, 73],
    wake: async (execution, transaction) => sql.query("UPDATE JobRequests SET next_run_at=:at WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:id", {
      replacements: { at: execution.wait_until, id: String(execution.id) }, transaction }) };
  runtime = createRuntime(deps);
  await db.Clinica.bulkCreate([{ id_clinica: 72, nombre_clinica: 'TESTONLY Medical' }, { id_clinica: 73, nombre_clinica: 'TESTONLY Other' }]);
  await db.UsuarioClinica.bulkCreate([15, 16].map(id => ({ id_clinica: 72, id_usuario: id, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' })));
  const template = await db.AutomationFlowTemplateV2.create({ ...C.definition(72), is_active: true, published_at: t.clock,
    trigger_config: { configured: true, enabled_after: '2026-10-20T11:00:00Z', response_timeout_minutes: 60 } });
  const approved = await db.WhatsappTemplate.create({ waba_id: sender.wabaId, name: C.TEMPLATE, language: 'es_ES',
    category: 'UTILITY', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] });
  let seq = 100;
  return Object.assign(t, { db, engine, requests, template, approved, sender, get runtime() { return runtime; },
    restart() { runtime = createRuntime(deps); t.runtime = runtime; },
    async source({ clinic = 72, phone, patientId } = {}) {
      const patient = patientId ? await db.Paciente.findByPk(patientId) : await db.Paciente.create({ id_paciente: ++seq,
        clinica_id: clinic, telefono_movil: phone || '34600' + String(seq).padStart(6, '0'), nombre: 'TESTONLY', apellidos: 'Patient' });
      const document = await db.PatientConsentDocument.create({ paciente_id: patient.id_paciente, clinica_id: clinic, status: 'signed', snapshot_hash: 'TESTONLY-' + seq });
      return sql.transaction(transaction => runtime.recordRequest({ patient_id: patient.id_paciente, clinic_id: clinic, actor_user_id: 15,
        source: 'privacy_profile_review', channel: 'internal', occurred_at: t.clock, metadata: { document_id: document.id,
          snapshot_hash: document.snapshot_hash, previous_phone: '34699000000', phone: patient.telefono_movil } }, { transaction }));
    } });
};
