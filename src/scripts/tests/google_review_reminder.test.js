'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime, allowedSlot, definition, DELAY_MS } = require('../../services/googleReviewReminder.service');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const engine = loadSource('flowEngineV2.service', { '../../models': {}, './jobRequests.service': { getCurrentRuntimeNamespace: () => 'test' } }, {}, 10000);
const now = new Date('2026-10-20T12:00:00Z');
const quiet = engine.computeQuietHoursDelayMs;

function fixture() {
  const p = { status: 'sent', kind: 'review_google_link_followup', google_publication_reminder_enabled: true,
    test_send: false, google_link_sent_at: '2026-10-19T16:00:00Z', google_review_url: 'https://search.google.com/local/writereview?placeid=fake',
    clinic_id: 59, conversation_id: 3, sender_origin_id: 4, phoneNumberId: 'secondary', wabaId: 'waba',
    recipient: '34600000000', app_message_id: 8, provider_message_id: 'wamid.test' };
  const state = { event: { id: 9, event_type: 'review_rating_followup_sent', list_id: 1, item_id: 2, paciente_id: 7, payload: p },
    list: { id: 1, clinica_id: 59, criteria: {} }, item: { id: 2, list_id: 1, clinica_id: 59, phone: '34600000000', paciente_id: 7 },
    conversation: { id: 3, clinic_id: 59, patient_id: 7 }, source: { id: 8, conversation_id: 3, status: 'read', metadata: { wamid: 'wamid.test' } },
    sender: { originId: 4, phoneNumberId: 'secondary' }, window: { open: true, matchedBy: 'message_phone_number_id', lastInboundAt: '2026-10-19T15:55:00Z' },
    publication: { state: 'not_detected' }, templates: [], executions: [], jobs: [], messages: [], transport: [], reads: 0, optedOut: false };
  const save = values => ({ ...values, update: async function (patch) { Object.assign(this, patch); return this; } });
  const model = key => ({ findByPk: async () => state[key] });
  const db = { Sequelize: { Op: { ne: Symbol('ne'), and: Symbol('and') } },
    MarketingPatientContactEvent: { ...model('event'), findOne: async () => null, create: async values => { state.event = { id: 9, ...values }; return state.event; } },
    MarketingPatientList: model('list'), MarketingPatientListItem: model('item'), Conversation: model('conversation'), Message: model('source'),
    AutomationFlowTemplateV2: { findOne: async ({ where }) => state.templates.find(t => t.template_key === where.template_key),
      findOrCreate: async ({ defaults }) => { const row = { id: state.templates.length + 1, ...defaults }; state.templates.push(row); return [row, true]; } },
    FlowExecutionV2: { findOne: async ({ where }) => state.executions.find(e => e.idempotency_key === where.idempotency_key), findByPk: async () => state.executions[0] },
    sequelize: { where: () => ({}), json: () => ({}) } };
  const bulk = {
    assertReviewRequestCommunicationAllowed: async () => { if (state.optedOut) throw Error('opt_out'); },
    reviewReminderAllowedAt: async (_list, reference) => ({ at: state.clinicAt || reference }),
    getGoogleReviewPublicationState: async () => { state.reads++; if (state.readFailure) throw Error('read_failure'); return state.publication; },
  };
  const runtime = createRuntime({ db, bulk, now: () => now, normalizePhone: v => String(v || '').replace(/\D/g, ''), serviceWindow: async args => {
    assert.equal(args.activePhoneNumberId, 'secondary'); return state.window;
  }, engine: { computeQuietHoursDelayMs: quiet, resolveScheduledWhatsappSenderConfig: async () => state.sender,
    findOrCreateAutomationWhatsappMessage: async ({ values, deliveryKey }) => {
      let msg = state.messages.find(m => m.key === deliveryKey); if (msg) return { message: msg, created: false };
      msg = save({ id: 10, key: deliveryKey, ...values }); state.messages.push(msg); return { message: msg, created: true };
    }, enqueueAutomationWhatsappTransport: async args => { state.transport.push(args); args.msg.metadata.automation_transport_job_id = 'stable'; } },
    enqueueJob: async args => { let job = state.jobs.find(j => j.dedupeScope === args.dedupeScope); if (!job) { job = { id: 1, ...args }; state.jobs.push(job); } return { job }; },
    triggerJob: async () => {}, stop: { createExecution: async values => { const row = { id: 5, ...values }; state.executions.push(row); return row; }, isStop: () => false } });
  return { state, runtime, inspect: args => runtime.inspect({ eventId: 9, clinicId: 59, conversationId: 3, now, ...args }), save };
}

test('native catalog is a readable five-node V2 flow, no model calls or paid-template fallback', () => {
  const d = definition(); assert.equal(d.trigger_type, 'review_google_link_sent'); assert.equal(d.nodes.length, 5);
  assert.deepEqual(d.nodes[2].outputs, { on_found: 'N5', on_not_detected: 'N4', on_unknown: 'N5' });
  assert.equal(d.nodes[1].config.datetime_expression, '{{trigger.data.followup_due_at}}'); assert.equal(DELAY_MS, 72000000);
  assert(!JSON.stringify(d).includes('ai_analysis'));
});
test('the installed graph passes the actual administrator API validator without database or provider access', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const file = require.resolve('../../controllers/automationsV2.controller'), local = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Date, Buffer,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require: name => name.startsWith('../lib/') || ['crypto', 'sequelize'].includes(name) ? local(name) : {},
  }, { filename: file, timeout: 10000 });
  const result = await module.exports.validateFlowPayloadForInternalUse(definition());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});
test('activation applies to future confirmed real links only, with one native durable execution and normal-priority job', async () => {
  const f = fixture(); await f.runtime.schedule(f.state.event); await f.runtime.schedule(f.state.event);
  assert.equal(f.state.executions.length, 1); assert.equal(f.state.jobs.length, 1);
  assert.equal(f.state.jobs[0].priority, 'normal'); assert.equal(f.state.jobs[0].status, 'waiting');
  assert.equal(f.state.jobs[0].nextRunAt.toISOString(), now.toISOString()); assert.equal(f.state.templates.length, 2);
  assert.equal(f.state.transport.length, 0);
  f.state.templates[1].is_active = false;
  assert.equal((await f.runtime.schedule(f.state.event)).reason, 'automation_deactivated');
});
test('old links, failed links, tests and missing sender snapshots never schedule', async () => {
  for (const patch of [{ google_publication_reminder_enabled: undefined }, { test_send: true }, { status: 'failed' }, { kind: 'review_private_feedback_request' }, { phoneNumberId: '' }, { sender_origin_id: null }]) {
    const f = fixture(); Object.assign(f.state.event.payload, patch); assert.equal((await f.runtime.schedule(f.state.event)).skipped, true); assert.equal(f.state.jobs.length, 0);
  }
});
test('disabled administrator master is not recreated or reactivated', async () => {
  const f = fixture(); await f.runtime.ensureCatalog(); f.state.templates[0].is_active = false;
  assert.equal((await f.runtime.schedule(f.state.event)).reason, 'automation_deactivated'); assert.equal(f.state.templates.length, 1);
});
test('a valid same-secondary-number reply, current local observation and permitted hours can send', async () => {
  const f = fixture(); const r = await f.inspect(); assert.equal(r.state, 'ready'); assert.equal(r.sender.phoneNumberId, 'secondary');
});
test('scope, test, failed-source, wrong patient, changed recipient and archived list cannot send', async () => {
  const cases = [f => f.state.event.payload.test_send = true, f => f.state.event.payload.clinic_id = 72,
    f => f.state.list = null, f => f.state.list.status = 'archived', f => f.state.list.criteria.dispatch = { cancel_requested: true },
    f => f.state.item.list_id = 88, f => f.state.item.clinica_id = 72, f => f.state.item.phone = '34600000001',
    f => f.state.conversation.clinic_id = 72, f => f.state.conversation.patient_id = 88,
    f => f.state.source.status = 'failed', f => f.state.source.metadata.wamid = 'another',
    f => f.state.event.payload.google_review_url = 'javascript:alert(1)', f => f.state.sender.phoneNumberId = 'primary'];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.equal((await f.inspect()).state, 'skip'); assert.equal(f.state.transport.length, 0); }
});
test('opt-out, any Google rating, ambiguity and stale/failed observation stop the optional follow-up', async () => {
  const f = fixture(); f.state.optedOut = true; assert.equal((await f.inspect()).reason, 'communication_not_allowed');
  for (const state of ['found', 'unknown']) { const g = fixture(); g.state.publication = { state }; assert.equal((await g.inspect()).state, 'skip'); }
  const bad = fixture(); bad.state.readFailure = true;
  const r = await bad.runtime.action({ execution: { clinic_id: 59 }, context: { trigger: { data: { link_event_id: 9, conversation_id: 3 } } }, node: { id: 'N4', outputs: { on_success: 'N5' } } });
  assert.equal(r.output.reason, 'review_guard_unavailable'); assert.equal(bad.state.transport.length, 0);
});
test('expired, wrong-number and unproven legacy windows never send', async () => {
  for (const patch of [{ open: false }, { matchedBy: 'different_phone_number_id' }, { matchedBy: 'legacy_conversation_timestamp' }, { lastInboundAt: '2026-10-19T11:59:00Z' }]) {
    const f = fixture(); Object.assign(f.state.window, patch); assert.equal((await f.inspect()).state, 'skip');
  }
});
test('20 h is a minimum; next clinic slot is persisted only if it is still inside the actual WhatsApp window', async () => {
  const f = fixture(); f.state.clinicAt = new Date('2026-10-20T14:00:00Z');
  assert.equal((await f.inspect()).state, 'waiting'); assert.equal(f.state.reads, 0);
  f.state.clinicAt = new Date('2026-10-20T16:00:00Z');
  assert.equal((await f.inspect()).reason, 'no_allowed_slot_before_whatsapp_expiry');
});
test('Madrid quiet hours cover summer/winter, weekends and both DST transitions without a paid fallback', async () => {
  const dates = ['2026-10-23T21:00:00Z','2026-10-24T21:30:00Z','2026-10-25T02:30:00Z','2027-03-28T01:30:00Z','2026-07-01T21:00:00Z'];
  for (const at of dates) {
    const start = new Date(at), next = quiet({ now: start }); assert(next.delayMs > 0);
    assert.equal(new Intl.DateTimeFormat('es', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(next.scheduledAt), '07');
    const r = await allowedSlot({ now: start, dueAt: start, expiresAt: new Date(+start + 12 * 3600000), clinicSlot: async t => ({ at: t }), quietWindow: quiet });
    assert.equal(+r.at, +next.scheduledAt);
    const noSlot = await allowedSlot({ now: start, dueAt: start, expiresAt: new Date(+start + 30 * 60000), clinicSlot: async t => ({ at: t }), quietWindow: quiet });
    assert.equal(noSlot.reason, 'no_allowed_slot_before_whatsapp_expiry');
  }
});
test('split shifts, a closed weekend and missing clinic calendar cannot bypass the intersection', async () => {
  const start = now;
  const closed = await allowedSlot({ now: start, dueAt: start, expiresAt: new Date(+start + 3 * 3600000), clinicSlot: async () => ({ at: new Date(+start + 48 * 3600000) }), quietWindow: quiet });
  assert.equal(closed.reason, 'no_allowed_slot_before_whatsapp_expiry');
  const missing = await allowedSlot({ now: start, dueAt: start, expiresAt: new Date(+start + 3 * 3600000), clinicSlot: async () => ({ reason: 'clinic_schedule_unavailable' }), quietWindow: quiet });
  assert.equal(missing.reason, 'clinic_schedule_unavailable');
});
test('native V2 action is idempotent and contains no real transport in simulation', async () => {
  const f = fixture(); await f.runtime.schedule(f.state.event);
  const args = { execution: f.state.executions[0], context: f.state.executions[0].context, node: { id: 'N4', outputs: { on_success: 'N5' } } };
  const first = await f.runtime.action(args), duplicate = await f.runtime.action(args);
  assert.equal(first.output.status, 'queued'); assert.equal(duplicate.output.status, 'already_recorded');
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.transport.length, 1);
  assert.equal(f.state.messages[0].message_type, 'text'); assert.equal(f.state.messages[0].metadata.phoneNumberId, 'secondary');
  assert(!f.state.messages[0].content.includes('5 estrellas'));
  const simulated = await f.runtime.action({ ...args, context: { __simulation: true } }); assert.equal(simulated.output.no_send, true);
  assert.equal(f.state.transport.length, 1);
});
test('actual transport rechecks review, opt-out and original sender; a delayed job may only be omitted', async () => {
  const f = fixture(); await f.runtime.schedule(f.state.event);
  const makeMessage = () => f.save({ id: 11, conversation_id: 3, metadata: { execution_id: 5, google_review_link_event_id: 9 } });
  const msg = makeMessage();
  const args = { message: msg, to: f.state.item.phone, sender: f.state.sender, useTemplate: false, now };
  assert.equal((await f.runtime.authorizeTransport(args)).allowed, true);
  f.state.publication = { state: 'found' };
  assert.equal((await f.runtime.authorizeTransport(args)).reason, 'google_review_found'); assert.equal(msg.metadata.google_review_reminder_skipped, true);
  f.state.publication = { state: 'not_detected' };
  assert.equal((await f.runtime.authorizeTransport(args)).allowed, false); // A skipped job never resurrects.
  assert.equal((await f.runtime.authorizeTransport({ ...args, message: makeMessage(), useTemplate: true })).allowed, false);
  f.state.optedOut = true;
  assert.equal((await f.runtime.authorizeTransport({ ...args, message: makeMessage() })).reason, 'communication_not_allowed');
  f.state.optedOut = false;
  assert.equal((await f.runtime.authorizeTransport({ ...args, message: makeMessage(), now: new Date('2026-10-20T16:00:00Z') })).allowed, false);
});
test('unrelated outbound jobs retain their existing behavior without new reads', async () => {
  const f = fixture(); assert.deepEqual(await f.runtime.authorizeTransport({ message: { metadata: {} } }), { allowed: true }); assert.equal(f.state.reads, 0);
});
test('both actual transport paths guard immediately before a new POST, not before unknown-outcome reconciliation', () => {
  const fs = require('node:fs'), path = require('node:path');
  const worker = fs.readFileSync(path.resolve(__dirname, '../../workers/queue.workers.js'), 'utf8');
  const retry = fs.readFileSync(path.resolve(__dirname, '../../services/whatsappDispatchWait.service.js'), 'utf8');
  assert(worker.indexOf('googleReviewReminder.service') < worker.indexOf('const waResponse = await whatsappService.sendMessage', worker.indexOf('googleReviewReminder.service')));
  assert(retry.indexOf('broker.sendReceipt') < retry.indexOf('authorizeTransport'));
  assert(retry.indexOf('authorizeTransport') < retry.indexOf('result = await broker.send(wait.intent)'));
});
