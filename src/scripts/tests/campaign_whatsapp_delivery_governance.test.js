'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Op } = require('sequelize');
const db = require('../../../models');
const {
  HOLD_STATUS,
  buildRouteKey,
  handleWebhookChange,
  reconcileCurrentTemplateState,
  materializeFinalMessageStatus,
  parseCapacity,
  recordImmediateSendResponse,
  __testing,
} = require('../../services/whatsappDeliveryGovernance.service');
const marketingBulkSendsService = require('../../services/marketingBulkSends.service');

function matchesDeliveryWhere(row, where) {
  return Reflect.ownKeys(where).every(key => {
    const expected = where[key];
    if (key === Op.or) return expected.some(option => matchesDeliveryWhere(row, option));
    const raw = String(key).split('.').reduce((object, member) => object?.[member], row);
    const value = raw != null && String(key).startsWith('metadata.') ? String(raw) : raw;
    if (expected == null) return value == null;
    if (typeof expected !== 'object') return value === expected;
    return Reflect.ownKeys(expected).every(operation => {
      const operand = expected[operation];
      if (operation === Op.in) return operand.includes(value);
      if (operation === Op.gt) return value > operand;
      if (operation === Op.gte) return value >= operand;
      if (operation === Op.is) return value == null && operand === null;
      if (operation === Op.eq) return value === operand;
      if (operation === Op.or) return operand.some(option => matchesDeliveryWhere({ value }, { value: option }));
      return false;
    });
  });
}

test('historical warmup counts only final receipts with exact Meta acceptance and persisted bulk message identity', async t => {
  const template = { id: 6556, meta_template_id: 'meta-template-fixture', name: 'template_fixture', language: 'es' };
  const scope = { wabaId: 'waba-fixture', phoneNumberId: 'sender-fixture', template };
  const route = {
    waba_id: scope.wabaId, phone_number_id: scope.phoneNumberId,
    template_name: template.name, template_language: template.language,
  };
  const accepted = (message_id, changes = {}) => ({
    ...route, message_id, list_id: 1, item_id: message_id, meta_template_id: template.meta_template_id,
    event_type: 'message_accepted_by_meta', source: 'messages_api_response', occurred_at: new Date(), ...changes,
  });
  const receipt = (message_id, changes = {}) => ({
    ...route, message_id, id: message_id, meta_template_id: null, event_type: 'message_delivered',
    source: 'message_status_webhook', occurred_at: new Date(), ...changes,
  });
  const message = (id, changes = {}) => ({
    id, direction: 'outbound', metadata: {
      source: 'marketing_bulk_sends', kind: 'mass_campaign_send', template_id: template.id,
      template_name: template.name, template_language: template.language,
      wabaId: scope.wabaId, phoneNumberId: scope.phoneNumberId, ...changes,
    },
  });
  const messages = [
    message(2), message(3), message(4), message(5, { kind: 'mass_campaign_test' }),
    message(6, { template_id: 6555 }), message(7), message(8), message(9),
    message(10, { wabaId: 'other-waba' }), message(11, { template_language: 'ca' }),
    message(13, { test_send: true }),
  ];
  const events = [
    receipt(1, { meta_template_id: template.meta_template_id }),
    receipt(1, { meta_template_id: template.meta_template_id, event_type: 'message_read' }),
    accepted(2), receipt(2),
    accepted(3, { meta_template_id: 'different-version' }), receipt(3),
    accepted(4, { phone_number_id: 'different-sender' }), receipt(4),
    accepted(5), receipt(5), accepted(6), receipt(6),
    accepted(7), receipt(7), receipt(7, { event_type: 'message_failed' }),
    accepted(8), receipt(8, { meta_template_id: 'different-version' }),
    accepted(9), receipt(9, { template_name: 'different-template' }),
    accepted(10), receipt(10), accepted(11), receipt(11),
    receipt(12), // A matching legacy name alone proves nothing.
    accepted(13), receipt(13),
  ];
  t.mock.method(db.WhatsappDeliveryEvent, 'findAll', async query => {
    assert.strictEqual(query.limit, 2000);
    return events.filter(row => matchesDeliveryWhere(row, query.where));
  });
  t.mock.method(db.Message, 'findAll', async query => {
    assert.deepStrictEqual(query.attributes, ['id']);
    return messages.filter(row => matchesDeliveryWhere(row, query.where));
  });
  assert.deepStrictEqual(await __testing.getTemplateDeliverySignals(scope), { successful: 2, failed: 1 });
  assert.deepStrictEqual(await __testing.getTemplateDeliverySignals({ ...scope, phoneNumberId: null }),
    { successful: 1, failed: 0 }, 'without an exact sender, legacy receipts stay excluded');
});

test('bulk dispatch persists the remote template identity before transport', () => {
  const service = fs.readFileSync(path.resolve(__dirname, '../../services/marketingBulkSends.service.js'), 'utf8');
  const send = service.slice(service.indexOf('async function sendDispatchItem('), service.indexOf('async function runDispatchJob('));
  assert.match(send, /await Message\.create\([\s\S]*meta_template_id: template\.meta_template_id \|\| null[\s\S]*await whatsappService\.sendMessage/);
});

assert.strictEqual(HOLD_STATUS, 'held_for_quality_assessment');
assert.strictEqual(parseCapacity('TIER_250'), 250);
assert.strictEqual(parseCapacity('TIER_1K'), 1000);
assert.strictEqual(parseCapacity('TIER_10K'), 10000);
assert.strictEqual(parseCapacity('TIER_100K'), 100000);
assert.strictEqual(parseCapacity('TIER_UNLIMITED'), null);
assert.strictEqual(parseCapacity(null), null);

const routeA = buildRouteKey({
  businessPortfolioId: 'portfolio-1',
  wabaId: 'waba-1',
  phoneNumberId: 'phone-1',
  templateName: 'review_request',
  language: 'es',
});
const routeB = buildRouteKey({
  businessPortfolioId: 'portfolio-2',
  wabaId: 'waba-1',
  phoneNumberId: 'phone-1',
  templateName: 'review_request',
  language: 'es',
});
assert.strictEqual(routeA.length, 64);
assert.notStrictEqual(routeA, routeB, 'el portfolio debe formar parte de la identidad del regulador');

const slowSchedule = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 1,
  requestedDelayMs: 10 * 60 * 1000,
  templateQuality: 'UNKNOWN',
  successfulMessages: 0,
});
assert.strictEqual(slowSchedule.effectiveBatchSize, 1);
assert.strictEqual(slowSchedule.effectiveDelayMs, 10 * 60 * 1000, 'el regulador no puede acelerar una cola lenta');

const dailySchedule = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 1,
  requestedDelayMs: 24 * 60 * 60 * 1000,
  templateQuality: 'UNKNOWN',
  successfulMessages: 0,
});
assert.strictEqual(dailySchedule.effectiveBatchSize, 1);
assert.strictEqual(dailySchedule.effectiveDelayMs, 24 * 60 * 60 * 1000, 'el regulador no puede acelerar un envío diario');

const warmup = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 100,
  requestedDelayMs: 2 * 60 * 1000,
  templateQuality: 'YELLOW',
  successfulMessages: 200,
});
assert.strictEqual(warmup.effectiveBatchSize, 5);
assert.strictEqual(warmup.effectiveDelayMs, 3 * 60 * 60 * 1000);

const capacityBound = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 50,
  requestedDelayMs: 60000,
  templateQuality: 'GREEN',
  successfulMessages: 500,
  availableCapacity: 3,
});
assert.strictEqual(capacityBound.effectiveBatchSize, 3, 'el lote debe respetar la capacidad restante del portfolio');

const firstSharedQueue = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 5,
  requestedDelayMs: 60000,
  templateQuality: 'GREEN',
  successfulMessages: 500,
  availableCapacity: 8,
});
const secondSharedQueue = __testing.computeEffectiveDispatchPolicy({
  requestedBatchSize: 5,
  requestedDelayMs: 60000,
  templateQuality: 'GREEN',
  successfulMessages: 500,
  availableCapacity: 8 - firstSharedQueue.effectiveBatchSize,
});
assert.strictEqual(firstSharedQueue.effectiveBatchSize, 5);
assert.strictEqual(secondSharedQueue.effectiveBatchSize, 3);
assert.strictEqual(firstSharedQueue.effectiveBatchSize + secondSharedQueue.effectiveBatchSize, 8);

const warmupCounters = marketingBulkSendsService.__testing.computeCounters([
  { status: 'excluded_opt_out', exclusion_reason: 'opt_out', selected: false },
  { status: 'ready', dispatch_status: 'sent', sent_at: new Date(), opt_out_at: new Date() },
  { status: 'ready', dispatch_status: 'sent', sent_at: new Date() },
]);
assert.strictEqual(warmupCounters.opt_out, 2, 'el informe conserva exclusiones preventivas y bajas recibidas');
assert.strictEqual(warmupCounters.sent_opt_out, 1, 'el calentamiento solo cuenta bajas de destinatarios enviados');

const repositoryRoot = path.resolve(__dirname, '../../..');
const phoneSyncSource = fs.readFileSync(path.join(repositoryRoot, 'src/services/whatsappPhones.service.js'), 'utf8');
const embeddedSource = fs.readFileSync(path.join(repositoryRoot, 'src/routes/whatsapp-embedded.routes.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(repositoryRoot, 'src/workers/queue.workers.js'), 'utf8');
const bulkSource = fs.readFileSync(path.join(repositoryRoot, 'src/services/marketingBulkSends.service.js'), 'utf8');

assert.match(phoneSyncSource, /whatsapp_business_manager_messaging_limit/);
assert.match(embeddedSource, /whatsapp_business_manager_messaging_limit/);
assert.match(embeddedSource, /source:\s*'embedded_signup_reconnect'/);
assert.match(embeddedSource, /explicitRecovery:\s*true/,
  'an explicit Embedded Signup reconnect must clear a stale offboarded health block');
assert.doesNotMatch(phoneSyncSource, /messaging_limit_tier/);
assert.doesNotMatch(embeddedSource, /messaging_limit_tier/);
assert.match(workerSource, /provider_acceptance_status/);
assert.match(workerSource, /msg\.status = 'pending'/);
assert.match(
  workerSource,
  /const marketingBulkSendsService = require\('\.\.\/services\/marketingBulkSends\.service'\);/,
  'el worker debe importar el servicio que materializa los estados de campañas',
);
assert.match(bulkSource, /held_for_quality_assessment/);
assert.match(bulkSource, /dispatch_status: immediate\.held \? 'held_quality' : 'accepted'/);
assert.match(bulkSource, /\['held_meta', 'paused_review', 'awaiting_delivery'\]\.includes\(dispatchStatus\)/);
assert.match(bulkSource, /deliveryGate\.allowed/);
assert.match(bulkSource, /getDeliveryGateBlockedMessage\(deliveryGate\.reason\)/);

test('materializa señales Meta de calidad, pausa, capacidad, pacing y descarte', async () => {
  const modelMethods = [
    [db.ClinicMetaAsset, 'findAll'],
    [db.ClinicMetaAsset, 'findOne'],
    [db.WhatsappDeliverySnapshot, 'findOne'],
    [db.WhatsappDeliverySnapshot, 'create'],
    [db.WhatsappDeliveryEvent, 'findOrCreate'],
    [db.WhatsappTemplate, 'findOne'],
    [db.MarketingPatientList, 'findAll'],
  ];
  const originals = modelMethods.map(([model, method]) => [model, method, model[method]]);
  const snapshots = [];
  const events = [];
  const updates = [];
  try {
    db.ClinicMetaAsset.findAll = async () => [];
    db.ClinicMetaAsset.findOne = async () => null;
    db.WhatsappDeliverySnapshot.findOne = async () => null;
    db.WhatsappDeliverySnapshot.create = async (payload) => {
      snapshots.push(payload);
      return payload;
    };
    db.WhatsappDeliveryEvent.findOrCreate = async ({ defaults }) => {
      events.push(defaults);
      return [defaults, true];
    };
    db.WhatsappTemplate.findOne = async () => ({
      id: 51,
      status: 'APPROVED',
      quality_score: 'GREEN',
      pause_count: 0,
      update: async (payload) => updates.push(payload),
    });
    db.MarketingPatientList.findAll = async () => [];

    const qualityResult = await handleWebhookChange({
      entry: { id: 'waba-qa', time: 1786228200 },
      change: { field: 'message_template_quality_update' },
      value: {
        previous_quality_score: 'GREEN',
        new_quality_score: 'RED',
        message_template_id: 'template-qa',
        message_template_name: 'review_request',
        message_template_language: 'es',
      },
    });
    assert.strictEqual(qualityResult.handled, true);
    assert.strictEqual(updates.at(-1).quality_score, 'RED');
    assert.strictEqual(snapshots.at(-1).template_quality, 'RED');

    const pauseResult = await handleWebhookChange({
      entry: { id: 'waba-qa', time: 1786228300 },
      change: { field: 'message_template_status_update' },
      value: {
        event: 'PAUSED',
        message_template_id: 'template-qa',
        message_template_name: 'review_request',
        message_template_language: 'es',
      },
    });
    assert.strictEqual(pauseResult.handled, true);
    assert.strictEqual(updates.at(-1).status, 'PAUSED');

    const capabilityResult = await handleWebhookChange({
      entry: { id: 'waba-qa', time: 1786228400 },
      change: { field: 'business_capability_update' },
      value: { max_daily_conversations_per_business: 1000 },
    });
    assert.strictEqual(capabilityResult.handled, true);
    assert.strictEqual(snapshots.at(-1).capacity_limit, 1000);

    const heldResult = await recordImmediateSendResponse({
      response: { messages: [{ id: 'wamid-held', message_status: HOLD_STATUS }] },
      wabaId: 'waba-qa',
      phoneNumberId: 'phone-qa',
      template: { id: 51, meta_template_id: 'template-qa', name: 'review_request', language: 'es' },
      listId: 700,
      itemId: 701,
      messageId: 702,
    });
    assert.strictEqual(heldResult.held, true);
    assert.strictEqual(heldResult.providerMessageId, 'wamid-held');

    await materializeFinalMessageStatus({
      message: {
        id: 702,
        metadata: {
          wabaId: 'waba-qa',
          phoneNumberId: 'phone-qa',
          meta_template_id: 'template-qa',
          template_name: 'review_request',
          template_language: 'es',
          list_id: 700,
          item_id: 701,
        },
      },
      status: { timestamp: '1786228500', errors: [{ code: 132015 }] },
      mappedStatus: 'failed',
    });
    assert.ok(events.some((event) => event.event_type === 'message_failed' && event.reason_code === '132015'));
  } finally {
    originals.forEach(([model, method, original]) => { model[method] = original; });
  }
});

test('la conciliación actual pausa solo colas de su plantilla y es idempotente', async t => {
  const notifications = require('../../services/notifications.service');
  const updates = [];
  const events = [];
  const makeList = (id, templateId) => ({
    id,
    clinica_id: id,
    status: 'sending',
    criteria: { dispatch: { whatsapp_template_id: templateId,
      template_snapshot: { id: templateId, name: 'same_catalog_name', language: 'es' } } },
    async update(patch) { updates.push({ id, patch }); Object.assign(this, patch); },
  });
  const own = makeList(700, 51);
  const other = makeList(701, 52);
  t.mock.method(db.MarketingPatientList, 'findAll', async () => [own, other]);
  t.mock.method(db.MarketingPatientContactEvent, 'create', async payload => events.push(payload));
  t.mock.method(notifications, 'dispatchEvent', async () => {});

  const template = { id: 51, meta_template_id: 'meta-51', name: 'same_catalog_name',
    language: 'es', status: 'APPROVED', quality_score: 'RED' };
  assert.deepStrictEqual(await reconcileCurrentTemplateState({ template }), { paused: 1 });
  assert.deepStrictEqual(await reconcileCurrentTemplateState({ template }), { paused: 0 });
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].id, 700);
  assert.strictEqual(updates[0].patch.criteria.dispatch.status, 'paused_quality');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(__testing.listMatchesTemplate(other, { id: 51, name: 'same_catalog_name' }), false);
  const sharedRemote = makeList(702, 52);
  sharedRemote.criteria.dispatch.template_snapshot.meta_template_id = 'meta-51';
  assert.strictEqual(__testing.listMatchesTemplate(sharedRemote,
    { id: 51, metaTemplateId: 'meta-51', name: 'same_catalog_name' }), true);
});

console.log('campaign_whatsapp_delivery_governance.test.js OK');
