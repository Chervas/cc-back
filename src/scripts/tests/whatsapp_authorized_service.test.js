'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const vm = require('node:vm'); const path = require('node:path');
const { createWhatsappAuthorizedBrokerClient } = require('../../lib/whatsappAuthorizedBrokerClient');
const roles = require('../../lib/whatsapp-channel-role');
const { requestIdFor } = require('../../lib/whatsappBrokerClient');
const { Op } = require('sequelize');
const clone = value => JSON.parse(JSON.stringify(value));
const binding = () => ({ connectionRef: 'wa:qa:123', authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 123, assetId: 456,
  phoneId: '401', wabaId: '501', revision: 1, sendEnabled: true });
function fixture() {
  const state = { assets: [{ id: 456, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 123, grupoClinicaId: null,
    phoneNumberId: '401', wabaId: '501', waAccessToken: null, isActive: false, additionalData: {} }], healthBlocked: false, optOut: false,
    config: { version: 1, origin: 'https://broker.example.invalid:8445', keyId: 'staging-whatsapp', audience: 'authorized-wa',
      messageNotBefore: '2026-09-15T00:00:00Z',
      privateKeyFile: '/etc/clinicaclick-whatsapp-authorized/staging/private.pem', caFile: '/etc/clinicaclick-whatsapp-authorized/staging/ca.pem', bindings: [binding()] } };
  const calls = { graph: [], broker: [], health: [], optOut: [], failures: [], queries: [] };
  const match = (asset, where) => Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(condition => match(asset, condition));
    if (where[key] && typeof where[key] === 'object' && where[key][Op.in]) return where[key][Op.in].includes(asset[key]);
    return asset[key] === where[key];
  });
  const clinic = { id_clinica: 123, grupoClinicaId: 42 };
  const db = { Clinica: { findByPk: async id => Number(id) === 123 ? { ...clinic } : null },
    ClinicMetaAsset: { findAll: async query => { calls.queries.push(query); return clone(state.assets.filter(a => match(a, query.where))); },
      findOne: async query => { calls.queries.push(query); const value = state.assets.find(a => match(a, query.where)); return value ? clone(value) : null; } },
    MarketingContactOptOut: { findOne: async query => { calls.optOut.push(query); return state.optOut ? { id: 99, reason_text: 'Synthetic restriction' } : null; } },
    sequelize: { query: async () => { throw Error('Unexpected database access'); } } };
  const broker = createWhatsappAuthorizedBrokerClient({ environment: () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' }),
    loadConfiguration: () => clone(state.config), loadAsset: async id => clone(state.assets.find(a => a.id === id)),
    loadClinic: async id => id === 123 ? { ...clinic } : null, isBlocked: async () => false,
    loadMessage: async id => ({ id, conversation_id: 71, direction: 'outbound', status: 'pending', createdAt: '2026-09-15T00:01:00Z', metadata: {} }),
    loadConversation: async id => ({ id, clinic_id: 123 }),
    createTransport: () => ({ execute: async command => { calls.broker.push(command); return { requestId: command.requestId, replayed: false,
      data: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'accepted' }] } }; } }) });
  const modules = { './securityMonitoring.service': { assertTemplateAllowed: async () => {} }, '../lib/metaQuarantineHttp': { post: async (...args) => { calls.graph.push(args); throw Object.assign(Error('meta_integration_quarantined'), { code: 'META_INTEGRATION_QUARANTINED' }); } },
    '../../models': db, '../lib/phone': require('../../lib/phone'), '../lib/whatsapp-channel-role': roles, sequelize: { Op },
    '../lib/whatsappAuthorizedBrokerClient': broker,
    './whatsappChannelBindings.service': { applyClinicBindings: async (_id, assets) => assets },
    './whatsappAccountHealth.service': { summarizeAssetHealth: () => ({ can_send: !state.healthBlocked }),
      assertCanSend: async context => { calls.health.push(context); if (state.healthBlocked) throw Object.assign(Error('health_blocked'), { code: 'health_blocked' }); },
      recordProviderFailure: async value => { calls.failures.push(value); } } };
  const context = { module: { exports: {} }, require: name => { assert(Object.hasOwn(modules, name), 'unexpected module ' + name); return modules[name]; },
    process: { env: {} }, Buffer, URL, console };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../services/whatsapp.service.js'), 'utf8'), context);
  return { service: context.module.exports, state, calls };
}
test('inactive exact authorization resolves a tokenless config without changing containment rows', async () => {
  const f = fixture(); const original = clone(f.state.assets);
  const config = await f.service.getClinicConfig(123); const direct = await f.service.getConfigByAssetId(456, { clinicId: 123 });
  assert.equal(config.originId, 456); assert.equal(config.authorizedBroker.authorizationId, binding().authorizationId);
  assert.equal(Object.hasOwn(config, 'accessToken'), false); assert.equal(Object.hasOwn(direct, 'accessToken'), false);
  assert.equal(roles.isWhatsappRoutingConfigAvailable(config), true); assert.deepEqual(f.state.assets, original);
  assert.equal(await f.service.getConfigByAssetId(456, { clinicId: 999 }), null);
  f.state.config.bindings = [];
  assert.equal(await f.service.getClinicConfig(123), null); assert.equal(await f.service.getConfigByAssetId(456, { clinicId: 123 }), null);
});
test('all paused authorizations remain unavailable and cannot dispatch or use legacy tokens', async () => {
  const f = fixture(); f.state.config.bindings[0].sendEnabled = false; f.state.assets[0].waAccessToken = 'SYNTHETIC_LEGACY_FORBIDDEN';
  const config = await f.service.getClinicConfig(123);
  assert.equal(config.routingUnavailable, true); assert.equal(roles.isWhatsappRoutingConfigAvailable(config), false);
  await assert.rejects(f.service.sendMessage({ to: '34000000123', body: 'Synthetic QA', useTemplate: false, clinicConfig: config,
    healthContext: { messageId: 123 } }), { code: 'whatsapp_authorized_send_paused' });
  assert.equal(f.calls.broker.length, 0); assert.equal(f.calls.graph.length, 0);
});
test('common send preserves text, template and CTA payloads plus status and durable Message identity', async () => {
  const f = fixture(); const clinicConfig = await f.service.getClinicConfig(123);
  const cases = [
    { args: { body: 'Synthetic QA', previewUrl: true, useTemplate: false }, payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '34000000123', type: 'text', text: { body: 'Synthetic QA', preview_url: true } } },
    { args: { useTemplate: true, templateName: 'synthetic_confirmation', templateLanguage: 'es', templateParams: { 2: '10:00', 1: 'QA' } },
      payload: { messaging_product: 'whatsapp', to: '34000000123', type: 'template', template: { name: 'synthetic_confirmation', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'QA' }, { type: 'text', text: '10:00' }] }] } } },
    { args: { body: 'Synthetic CTA', useTemplate: false, interactiveCtaUrl: 'https://example.invalid/qa', interactiveCtaText: 'Abrir' },
      payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '34000000123', type: 'interactive', interactive: { type: 'cta_url', body: { text: 'Synthetic CTA' }, action: { name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://example.invalid/qa' } } } } },
  ];
  for (let i = 0; i < cases.length; i++) {
    const result = await f.service.sendMessage({ ...cases[i].args, to: '34000000123', clinicConfig, healthContext: { messageId: 123 + i, jobId: 'qa' } });
    assert.deepEqual(clone(result), { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'accepted' }] });
    assert.deepEqual(f.calls.broker[i].payload.message, cases[i].payload); assert.equal(f.calls.broker[i].requestId, requestIdFor(String(123 + i)));
    assert.equal(f.calls.health[i].messageId, 123 + i);
  }
  assert.equal(f.calls.graph.length, 0); assert.equal(f.calls.optOut.length, 3);
});
test('template explicit components, including header and quick reply, remain unchanged', async () => {
  const f = fixture(); const clinicConfig = await f.service.getClinicConfig(123);
  const components = [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.invalid/qa.png' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'QA' }] }, { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'synthetic_confirm' }] }];
  await f.service.sendMessage({ to: '34000000123', useTemplate: true, templateName: 'synthetic_confirmation', templateLanguage: 'es', templateComponents: components,
    clinicConfig, healthContext: { messageId: 123 } });
  assert.deepEqual(f.calls.broker[0].payload.message.template.components, components); assert.equal(f.calls.graph.length, 0);
});
test('health and recipient optout remain mandatory ahead of the authorized adapter', async () => {
  for (const block of ['healthBlocked', 'optOut']) {
    const f = fixture(); const clinicConfig = await f.service.getClinicConfig(123); f.state[block] = true;
    await assert.rejects(f.service.sendMessage({ to: '34000000123', body: 'Synthetic QA', useTemplate: false, clinicConfig, healthContext: { messageId: 123 } }));
    assert.equal(f.calls.broker.length, 0); assert.equal(f.calls.graph.length, 0);
  }
});
test('missing durable Message ID and injected token/phone cannot silently take the legacy path', async () => {
  for (const scenario of ['message', 'token', 'phone', 'clinic']) {
    const f = fixture(); const clinicConfig = await f.service.getClinicConfig(123);
    if (scenario === 'token') clinicConfig.accessToken = 'SYNTHETIC_FORBIDDEN';
    if (scenario === 'phone') clinicConfig.phoneNumberId = '402';
    if (scenario === 'clinic') clinicConfig.clinicId = 999;
    await assert.rejects(f.service.sendMessage({ to: '34000000123', body: 'Synthetic QA', useTemplate: false, clinicConfig,
      healthContext: scenario === 'message' ? {} : { messageId: 123 } }));
    assert.equal(f.calls.broker.length, 0); assert.equal(f.calls.graph.length, 0); assert.equal(f.calls.failures.length, 1);
  }
});
test('legacy configuration still uses the existing quarantine transport', async () => {
  const f = fixture(); f.state.config.bindings = []; f.state.assets[0].isActive = true; f.state.assets[0].waAccessToken = 'SYNTHETIC_LEGACY';
  const clinicConfig = await f.service.getClinicConfig(123);
  await assert.rejects(f.service.sendMessage({ to: '34000000123', body: 'Synthetic QA', useTemplate: false, clinicConfig }), { code: 'META_INTEGRATION_QUARANTINED' });
  assert.equal(f.calls.broker.length, 0); assert.equal(f.calls.graph.length, 1);
  assert.equal(f.calls.graph[0][0], 'https://graph.facebook.com/v24.0/401/messages');
});
test('broker routing preserves secondary pause/fallback and does not bypass pause via a stale token', () => {
  const primary = { id: 555, phoneNumberId: '405', waAccessToken: 'SYNTHETIC_LEGACY', additionalData: {} };
  const secondary = { id: 456, phoneNumberId: '401', whatsappAuthorizedBinding: binding(), additionalData: { routing: {
    whatsapp_channel_role: 'secondary', secondary_purposes: ['bulk_campaigns'], secondary_unavailable_action: 'pause' } } };
  assert.equal(roles.selectWhatsappPhoneAsset({ clinicAssets: [primary, secondary], purpose: 'bulk_campaigns' }).id, 456);
  assert.equal(roles.selectWhatsappPhoneAsset({ clinicAssets: [primary, secondary], purpose: null }).id, 555);
  secondary.whatsappAuthorizedBinding.sendEnabled = false; secondary.waAccessToken = 'SYNTHETIC_STALE';
  assert.equal(roles.selectWhatsappPhoneAsset({ clinicAssets: [primary, secondary], purpose: 'bulk_campaigns' }).routing_unavailable, true);
  secondary.additionalData.routing.secondary_unavailable_action = 'fallback_primary';
  assert.equal(roles.selectWhatsappPhoneAsset({ clinicAssets: [primary, secondary], purpose: 'bulk_campaigns' }).id, 555);
});
