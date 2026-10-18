'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('sequelize');
const C = require('../../lib/patient-mobile-verification');

const ROOT = path.resolve(__dirname, '../../..');
const SERVICES = path.join(ROOT, 'src/services');
const LIB = path.join(ROOT, 'src/lib') + path.sep;
const NOW = Date.parse('2026-10-20T12:02:00Z');
const NAMESPACE = 'TESTONLY-mobile-isolation';
const unexpected = name => { throw new Error(`UNEXPECTED_ISOLATION_DEPENDENCY:${name}`); };
const blocked = name => new Proxy({}, { get: (_, key) => () => unexpected(`${name}.${String(key)}`) });

// Read native code, but never let its imports bootstrap models, queues or providers.
function loadNative(name, dependencies, env = {}) {
  const cache = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = vm.createContext({ Buffer, Date: Clock, URL, URLSearchParams, structuredClone,
    setTimeout, clearTimeout, setImmediate, clearImmediate,
    process: { env: { JOB_RUNTIME_NAMESPACE: NAMESPACE, RUNTIME_ROLE: 'gateway', ...env }, cwd: () => ROOT },
    console: { log() {}, warn() {}, error() {} } });
  function read(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const requireMock = request => {
      if (Object.hasOwn(dependencies, request)) return dependencies[request];
      if (request === 'sequelize') return S;
      if (['crypto', 'node:crypto', 'node:util'].includes(request)) return require(request);
      if (request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), request.replace(/\.js$/, '') + '.js');
        if (resolved.startsWith(LIB)) return read(resolved);
      }
      return blocked(request);
    };
    requireMock.resolve = request => path.resolve(path.dirname(filename), request);
    requireMock.cache = Object.create(null);
    const run = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`,
      context, { filename, timeout: 10000 });
    run(requireMock, module, module.exports);
    return module.exports;
  }
  return read(path.join(SERVICES, name + '.js'));
}

function mutable(values) {
  return { ...structuredClone(values), async update(patch) { Object.assign(this, structuredClone(patch)); return this; },
    toJSON() { return structuredClone(Object.fromEntries(Object.entries(this).filter(([, v]) => typeof v !== 'function'))); } };
}

function fixture() {
  const request = { id: 10, patient_id: 1, clinic_id: 2, actor_user_id: 3, event_type: C.REQUEST,
    source: 'privacy_profile_review', metadata: { schema_version: C.SCHEMA, phone: '34600000001',
      document_id: 4, snapshot_hash: 'TESTONLY-source', delivery_enabled: true, template_version_id: 100,
      response_timeout_minutes: 60, reply_token: 'a'.repeat(36) } };
  const patient = { id_paciente: 1, clinica_id: 2, nombre: 'TESTONLY', telefono_movil: request.metadata.phone };
  const clinic = { id_clinica: 2, nombre_clinica: 'TESTONLY Clinic' };
  const conversation = mutable({ id: 7, clinic_id: 2, patient_id: 1, channel: 'whatsapp', contact_id: request.metadata.phone });
  const sender = { originId: 30, phoneNumberId: 'TESTONLY-phone', wabaId: 'TESTONLY-waba', clinicId: 2,
    authorizedBroker: { clinicId: 2, assetId: 30, sendEnabled: true,
      phoneId: 'TESTONLY-phone', wabaId: 'TESTONLY-waba' } };
  const approved = { id: 117, clinic_id: 2, waba_id: sender.wabaId, name: C.TEMPLATE, language: 'es_ES',
    category: 'UTILITY', status: 'APPROVED', is_active: true,
    variables: [{ position: 1, name: 'nombre_clinica' }],
    components: [{ type: 'BODY', text: C.BODY },
      { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] };
  const outbound = mutable({ id: 1000, status: 'pending', direction: 'outbound', conversation_id: 7,
    message_type: 'template', content: C.BODY.replace('{{1}}', clinic.nombre_clinica), createdAt: '2026-10-20T12:00:00Z',
    automation_delivery_key: 'mobile-verification:10:outbound', metadata: { source: 'automations_v2',
      mobile_verification_request_id: 10, execution_id: 20, node_id: 'N2', wamid: 'wamid.TESTONLY.accepted',
      phoneNumberId: sender.phoneNumberId, wabaId: sender.wabaId,
      provider_acceptance_at: '2026-10-20T12:00:00Z', provider_acceptance_status: 'accepted' } });
  const inbound = mutable({ id: 201, conversation_id: 7, direction: 'inbound', message_type: 'text',
    content: 'Este es mi telefono correcto.', sent_at: '2026-10-20T12:01:01Z', metadata: { historical: false,
      automatic_actions_allowed: true, inbox_receipt: 'TESTONLY-receipt',
      fresh_inbound_dispatched_at: new Date(NOW).toISOString(), phone_number_id: sender.phoneNumberId,
      waba_id: sender.wabaId, context: { id: outbound.metadata.wamid } } });
  const template = { ...C.definition(2), id: 100 };
  const execution = mutable({ id: 20, trigger_type: C.REQUEST, trigger_entity_type: 'patient_operational_event',
    trigger_entity_id: 10, template_version_id: 100, clinic_id: 2, status: 'running', current_node_id: 'N7',
    context: { trigger: { type: C.REQUEST, data: { request_event_id: 10, patient_id: 1, clinic_id: 2,
      response_timeout_minutes: 60 } }, outputs: {}, last_prompt: outbound.content,
    mobile_verification: { request_event_id: 10, response_message_id: 201, response_message_ids: [201],
      response_version: '201', response_text: inbound.content, reply_answer: null, wait_node_id: 'N3',
      response_buffer_until: '2026-10-20T12:01:30Z' } } });
  execution.templateVersion = template;
  const transitions = [];
  const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' }, afterCommit() {} };
  const db = { Sequelize: S, sequelize: { QueryTypes: S.QueryTypes,
    transaction: async (...args) => args.at(-1)(transaction), query: async () => [] },
  PatientOperationalEvent: { findByPk: async () => request, findOne: async () => request,
    findAll: async () => transitions, create: async values => {
      const row = { ...values, id: 30 + transitions.length }; transitions.push(row); return row;
    } },
  Paciente: { findByPk: async () => patient }, Clinica: { findByPk: async () => clinic },
  PacienteClinica: { findOne: async () => null }, PatientConsentDocument: { findByPk: async () => ({
    paciente_id: 1, clinica_id: 2, status: 'signed', snapshot_hash: request.metadata.snapshot_hash }) },
  FlowExecutionV2: { findByPk: async () => execution, findOne: async () => execution },
  AutomationFlowTemplateV2: { findByPk: async () => template }, FlowExecutionLogV2: { findOne: async () => null },
  Message: { findOne: async () => outbound, findByPk: async id => Number(id) === inbound.id ? inbound : outbound,
    findAll: async () => [inbound] },
  Conversation: { findByPk: async () => conversation, findOne: async () => null, findAll: async () => [conversation] },
  WhatsappTemplate: { findByPk: async () => approved, findAll: async () => [approved] },
  Notification: { findAll: async () => [] } };
  const dependencies = { '../../models': db, '../lib/patient-mobile-verification': C,
    './socket.service': { getIO: () => null },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => NAMESPACE },
    '../lib/whatsappAuthorizedBrokerClient': { isManagedMessage: async () => false, assertMessageEligible() {} },
    '../lib/canonical-conversation': { findCanonicalWhatsappConversation: async () => conversation } };
  const service = loadNative('patientMobileVerification.service', dependencies);
  const runtime = service.createRuntime({ db, now: () => NOW, enabled: () => true,
    authorizeActor: async () => {}, patientHeld: async () => false, communicationAllowed: async () => {} });
  dependencies['./patientMobileVerification.service'] = { current: () => runtime };
  return { request, patient, clinic, conversation, sender, approved, outbound, inbound, template, execution,
    transitions, db, dependencies, runtime };
}

async function analyze(f, node = f.template.nodes.find(n => n.type === 'condition/ai_analysis')) {
  const calls = [];
  const engine = loadNative('flowEngineV2.service', { ...f.dependencies,
    './aiOrchestrator.service': { analyzeStructured: async args => {
      calls.push(args);
      const correct = !args.inputText.includes('No es correcto');
      return { intent: correct ? 'correct' : 'incorrect', confidence: 1, unequivocal: true, evidence: 'correcto' };
    } } });
  const result = await engine._processNode(node, f.execution.context, { execution: f.execution });
  f.execution.context.outputs[node.id] = result.output;
  return { result, calls };
}

async function confirm(f) {
  return f.runtime.resolveAction({ execution: f.execution,
    node: f.template.nodes.find(n => n.type === C.RESULT_ACTION && n.config.result === 'confirmed'),
    context: structuredClone(f.execution.context) });
}

test('a patient reply after reception leaves pending does not inherit the employee as its resolver', async () => {
  const f = fixture();
  f.transitions.push({ id: 30, event_type: C.TRANSITION, patient_id: 1, clinic_id: 2, actor_user_id: 16,
    metadata: { request_event_id: 10, state: 'pending', provenance: 'manual_pending', actor_user_id: 16,
      manually_resolved: false } });
  f.inbound.metadata.button = { payload: `pmv:${f.request.id}:${f.request.metadata.reply_token}:yes` };
  f.execution.context.mobile_verification.reply_answer = 'yes';
  const result = await confirm(f);
  assert.equal(result.output.applied, true);
  const snapshot = await f.runtime.state(f.request);
  assert.equal(snapshot.state, 'confirmed'); assert.equal(snapshot.provenance, 'patient_reply');
  assert.equal(snapshot.actor_user_id, null); assert.equal(snapshot.history[0].actor_user_id, 16);
});

test('appointment reply ownership excludes the mobile wait without cancelling either execution', async () => {
  const f = fixture();
  const wait = { id: 'W', type: 'delay/wait_response', config: { response_buffer_enabled: false } };
  const appointment = mutable({ id: 9, clinic_id: 2, status: 'waiting', current_node_id: 'W',
    trigger_type: 'appointment_reminder_window', trigger_entity_type: 'appointment', trigger_entity_id: 90,
    waiting_meta: { runtime_namespace: NAMESPACE }, context: { trigger: { data: { patient_id: 1 } },
      outputs: { S: { conversation_id: 7 } } }, templateVersion: { nodes: [wait] } });
  Object.assign(f.execution, { status: 'waiting', current_node_id: 'W', waiting_meta: { runtime_namespace: NAMESPACE },
    templateVersion: { nodes: [wait] } });
  f.inbound.metadata.context.id = 'wamid.TESTONLY.appointment';
  const appointmentMessage = { ...f.outbound.toJSON(), metadata: { wamid: f.inbound.metadata.context.id } };
  f.db.Message.findOne = async () => appointmentMessage;
  assert.equal((await f.runtime.inbound({ message: f.inbound, conversation: f.conversation })).handled, false);
  f.db.FlowExecutionV2.findAll = async () => [appointment, f.execution];
  const enqueued = [];
  const resume = loadNative('automationsV2Resume.service', { ...f.dependencies,
    './jobRequests.service': { getCurrentRuntimeNamespace: () => NAMESPACE,
      enqueueUniqueJobRequest: async args => { enqueued.push(args); return { created: true, job: { id: 300 } }; } },
    './jobScheduler.service': { triggerImmediate: async () => {} },
    './conversationPendingReply.service': { emitAutomationResponseProcessing() {} },
    './conversationAutomationState.service': { setState: async () => ({}) } });
  const result = await resume.enqueueInboundResponseResume({ clinicId: 2, conversationId: 7, patientId: 1,
    messageText: 'Confirmo mi cita', inboundMessageId: f.inbound.id });
  assert.deepEqual(Array.from(result.execution_ids), [appointment.id], 'only the appointment owns its reply');
  assert.equal(appointment.status, 'waiting', 'the appointment must not be superseded by the mobile wait');
  assert.equal(f.execution.status, 'waiting', 'the independent mobile wait must remain available');
  assert.deepEqual(Array.from(result.superseded_execution_ids), []);
  assert.deepEqual(enqueued.map(job => job.payload.execution_id), [appointment.id]);
});

test('a restart at the result action cannot confirm before the response buffer closes', async () => {
  const f = fixture();
  f.execution.context.mobile_verification.response_buffer_until = '2026-10-20T12:03:30Z';
  await analyze(f);
  const result = await confirm(f);
  assert.notEqual(result.output.applied, true, 'matching response_version does not mean the buffer has closed');
  assert.equal(result.next_node_id, 'N3', 'return the restarted worker to the native wait');
  assert.equal(f.transitions.length, 0, 'no terminal result may be written during the buffer');
});

test('an AI result from another input cannot prove a contradictory current response', async () => {
  const f = fixture();
  f.inbound.content = 'No es correcto, no es mi telefono.';
  f.execution.context.mobile_verification.response_text = f.inbound.content;
  f.execution.context.unrelated_history = 'Este es mi telefono correcto.';
  const node = f.template.nodes.find(n => n.type === 'condition/ai_analysis');
  node.config.context_sources = [{ key: 'patient_reply', path: '{{unrelated_history}}' }];
  await analyze(f, node);
  const result = await confirm(f);
  assert.notEqual(result.output.applied, true, 'an overlapping evidence substring cannot attest to a different AI input');
  assert.equal(f.transitions.length, 0);
});

test('post-publication marker failure cannot overwrite a provider acceptance with stale send metadata', async () => {
  const f = fixture();
  let stored = null, producer = null, publications = 0, injectedFailure = false;
  const row = snapshot => ({ ...structuredClone(snapshot), async update(patch) {
    if (Object.hasOwn(patch.metadata || {}, 'mobile_verification_transport_queued_at') && !injectedFailure) {
      injectedFailure = true; throw new Error('TESTONLY-marker-write-failed');
    }
    Object.assign(stored, structuredClone(patch)); Object.assign(this, structuredClone(patch)); return this;
  }, async reload() { Object.assign(this, structuredClone(stored)); return this; } });
  f.db.Message.findOne = async () => stored ? row(stored) : null;
  f.db.Message.findByPk = async () => row(stored);
  f.db.Message.findOrCreate = async ({ defaults }) => {
    stored = { id: 1000, createdAt: new Date(NOW).toISOString(), ...structuredClone(defaults) };
    producer = row(stored); return [producer, true];
  };
  const stop = { prepareMessageForDispatch: async (message, patch) => message.update({ status: patch.status,
    metadata: { ...message.metadata, ...patch.metadata } }), assertMessageCanDispatch: async () => {}, isStop: () => false };
  const engine = loadNative('flowEngineV2.service', { ...f.dependencies,
    '../lib/automation-runtime-stop': stop,
    './queue.service': { queues: { outboundWhatsApp: { add: async () => {
      publications += 1;
      stored.status = 'pending';
      stored.metadata = { ...stored.metadata, wamid: 'wamid.TESTONLY.fast-worker',
        provider_acceptance_at: new Date(NOW).toISOString(), provider_acceptance_status: 'accepted' };
      return { id: 'TESTONLY-transport' };
    } } } },
    './whatsapp.service': { normalizePhoneNumber: value => C.phone(value), checkOutboundLimit: async () => ({}) },
    './patientDirection.service': { resolveOutboundPolicy: async () => ({ clinicConfig: f.sender }) },
    './appointmentVisitManaged.service': { current: () => ({}) },
    './marketingOptOut.service': { assertAutomationCommunicationAllowed: async () => {} },
    './googleLocalLinks.service': { resolveClinicGoogleLocalLinks: async () => ({}), mergeClinicLinksIntoContext: value => value } });
  let error;
  try { await engine._processNode(f.template.nodes.find(n => n.type === 'action/send_whatsapp'),
    f.execution.context, { execution: f.execution }); } catch (caught) { error = caught; }
  assert.equal(publications, 1, error?.stack || 'the native send must reach the mocked queue');
  assert.equal(injectedFailure, true, 'the queue succeeded before the marker write failed');
  assert.equal(stored.metadata.wamid, 'wamid.TESTONLY.fast-worker', 'provider acceptance must survive the producer catch path');
  assert.equal(stored.metadata.provider_acceptance_at, new Date(NOW).toISOString());
  assert.notEqual(stored.status, 'failed', 'a bookkeeping failure is not a delivery failure');
});

test('canonical AI input and an elapsed buffer produce one auditable positive result', async () => {
  const f = fixture();
  const { calls } = await analyze(f);
  assert.equal(calls.length, 1);
  assert(calls[0].inputText.includes(f.inbound.content));
  const result = await confirm(f);
  assert.equal(result.output.applied, true, JSON.stringify(result.output));
  assert.equal(f.transitions.length, 1);
  assert.equal(f.transitions[0].metadata.state, 'confirmed');
  assert.equal(f.transitions[0].metadata.provenance, 'patient_reply');
  assert.equal(f.transitions[0].metadata.inbound_message_id, f.inbound.id);
  assert.equal((await confirm(f)).output.applied, false, 'replaying the same proof must not write another result');
  assert.equal(f.transitions.length, 1);
});
