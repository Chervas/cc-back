'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const { isWhatsappRoutingConfigAvailable } = require('../../lib/whatsapp-channel-role');
const config = (sendEnabled = true) => ({ clinicId: 123, clinicaId: 123, originId: 456, phoneNumberId: '401', wabaId: '501',
  authorizedBroker: { connectionRef: 'wa:qa', authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 123,
    assetId: 456, phoneId: '401', wabaId: '501', revision: 1, sendEnabled } });
const source = file => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function patientDirectionFixture(clinicConfig) {
  const calls = { queue: [], messages: [], updates: [], events: [] };
  const assignment = { id: 15, clinic_id: 123, status: 'handoff_pending', conversation_id: 71, conversation: { id: 71, contact_id: '34000000123' },
    clinic_phone_asset_id: 456, director_phone_asset_id: 456, handoff_state: 'sent', metadata: {},
    update: async values => { calls.updates.push(values); } };
  const db = { PatientDirectionAssignment: { findByPk: async () => assignment }, ClinicMetaAsset: { findByPk: async () => ({ id: 456, additionalData: {}, metaAssetName: 'Synthetic QA' }) },
    PatientDirectionEvent: { create: async values => { calls.events.push(values); } },
    Message: { create: async values => { calls.messages.push(values); return { ...values, id: 77 }; } },
    WhatsappTemplate: { findOne: async () => ({ id: 9, name: 'synthetic_handoff', language: 'es' }) } };
  const modules = { sequelize: { Op: { or: Symbol('or') } }, '../../models': db,
    './whatsapp.service': { getConfigByAssetId: async () => clinicConfig, normalizePhoneNumber: value => value },
    './queue.service': { queues: { outboundWhatsApp: { add: async (...args) => { calls.queue.push(args); } } } },
    '../lib/role-helpers': { isGlobalAdmin: () => false }, '../lib/whatsapp-channel-role': { isWhatsappRoutingConfigAvailable } };
  const context = { module: { exports: {} }, require: name => { assert(Object.hasOwn(modules, name), name); return modules[name]; }, console };
  vm.runInNewContext(source('../../services/patientDirection.service.js'), context);
  return { service: context.module.exports, calls };
}
test('patient direction handoff and old-number notice accept enabled tokenless configs and retain durable queue identities', async () => {
  for (const method of ['queueHandoff', 'sendOldNumberNotice']) {
    const f = patientDirectionFixture(config()); const result = await f.service[method](15);
    assert.equal(result.messageId, 77); assert.equal(f.calls.queue.length, 1); assert.equal(f.calls.messages.length, 1);
    assert.equal(f.calls.queue[0][1].messageId, 77); assert.equal(f.calls.queue[0][1].clinicConfig.authorizedBroker.phoneId, '401');
    assert.equal(Object.hasOwn(f.calls.queue[0][1].clinicConfig, 'accessToken'), false);
  }
});
test('patient direction paused or mismatched binding stops before Message creation and queueing', async () => {
  for (const method of ['queueHandoff', 'sendOldNumberNotice']) for (const clinicConfig of [config(false), { ...config(), phoneNumberId: '402' }]) {
    const f = patientDirectionFixture(clinicConfig); const result = await f.service[method](15);
    assert.equal(result.queued || result.sent || false, false); assert.equal(f.calls.queue.length, 0); assert.equal(f.calls.messages.length, 0);
  }
});
function conversationFixture(clinicConfig, { access = true } = {}) {
  const calls = { queue: [], messages: [], saves: 0, commits: 0, rollbacks: 0 };
  const conversation = { id: 71, clinic_id: 123, channel: 'whatsapp', contact_id: '34000000123', save: async () => { calls.saves++; } };
  const msg = { id: 77, conversation_id: 71, direction: 'outbound', message_type: 'text', status: 'pending', content: 'Synthetic QA',
    metadata: { queued_by_quiet_hours: true }, save: async () => { calls.saves++; } };
  const transaction = { commit: async () => { calls.commits++; }, rollback: async () => { calls.rollbacks++; } };
  const context = { exports: {}, console, isWhatsappRoutingConfigAvailable,
    db: { sequelize: { transaction: async () => transaction } },
    Conversation: { findByPk: async () => conversation },
    Message: { findByPk: async () => msg, create: async values => { calls.messages.push(values); return { ...values, id: 77 }; }, update: async () => {} },
    findCanonicalWhatsappConversation: async () => null,
    getUserClinics: async () => ({ clinicIds: [123], isAggregateAllowed: false }), ensureAccess: () => access,
    ensureQuickChatConversationReadAccess: async () => {}, getIO: () => null,
    whatsappService: { getClinicConfig: async () => clinicConfig, normalizePhoneNumber: value => value,
      checkOutboundLimit: async () => ({ limitReached: false, limitedMode: false }) },
    patientDirectionService: { resolveOutboundPolicy: async () => ({ clinicConfig, requiresTakeConfirmation: false }) },
    resolveWhatsappServiceWindow: async () => ({ open: true }),
    queues: { outboundWhatsApp: { add: async (...args) => { calls.queue.push(args); } } },
    markBufferedResponseExecutionsForHumanReply: async () => {}, resolveAutomationAttentionForConversation: async () => ({ updated: 0 }),
    completeAutomationStateAfterHumanReplyForConversation: async () => ({ completed: false }), process: { env: {} } };
  const whole = source('../../controllers/conversation.controller.js');
  // Execute the actual complete public handlers with synthetic collaborators.
  vm.runInNewContext(whole.slice(whole.indexOf('exports.postMessage ='), whole.indexOf('exports.createInternalMessage =')), context);
  const req = { userData: { userId: 1 }, params: { id: '71', messageId: '77' }, body: { message: 'Synthetic QA' } };
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { controller: context.exports, calls, req, res };
}
test('QuickChat new message and scheduled send accept tokenless routing and queue one durable Message', async () => {
  for (const method of ['postMessage', 'sendScheduledMessageNow']) {
    const f = conversationFixture(config()); await f.controller[method](f.req, f.res);
    assert.equal(f.res.statusCode, 200); assert.equal(f.calls.queue.length, 1); assert.equal(f.calls.queue[0][1].messageId, 77);
    assert.deepEqual(clone(f.calls.queue[0][1].clinicConfig), config());
    if (method === 'postMessage') { assert.equal(f.calls.commits, 1); assert.equal(f.calls.messages.length, 1); }
  }
});
test('QuickChat pause and forged sender stop before mutation, commit or queue', async () => {
  for (const method of ['postMessage', 'sendScheduledMessageNow']) for (const clinicConfig of [config(false), { ...config(), phoneNumberId: '402' }]) {
    const f = conversationFixture(clinicConfig); await f.controller[method](f.req, f.res);
    assert.equal(f.res.statusCode, 500); assert.equal(f.res.body.error, 'whatsapp_config_missing');
    assert.equal(f.calls.queue.length, 0); assert.equal(f.calls.messages.length, 0); assert.equal(f.calls.commits, 0); assert.equal(f.calls.saves, 0);
  }
});
test('QuickChat clinic access control still precedes routing and send', async () => {
  for (const method of ['postMessage', 'sendScheduledMessageNow']) {
    const f = conversationFixture(config(), { access: false }); await f.controller[method](f.req, f.res);
    assert.equal(f.res.statusCode, 403); assert.equal(f.calls.queue.length, 0); assert.equal(f.calls.messages.length, 0);
  }
});
