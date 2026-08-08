'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const db = require('../../../models');
const {
  HOLD_STATUS,
  buildRouteKey,
  handleWebhookChange,
  materializeFinalMessageStatus,
  parseCapacity,
  recordImmediateSendResponse,
  __testing,
} = require('../../services/whatsappDeliveryGovernance.service');

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
assert.strictEqual(warmup.effectiveDelayMs, 2 * 60 * 1000);

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

const repositoryRoot = path.resolve(__dirname, '../../..');
const phoneSyncSource = fs.readFileSync(path.join(repositoryRoot, 'src/services/whatsappPhones.service.js'), 'utf8');
const embeddedSource = fs.readFileSync(path.join(repositoryRoot, 'src/routes/whatsapp-embedded.routes.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(repositoryRoot, 'src/workers/queue.workers.js'), 'utf8');
const bulkSource = fs.readFileSync(path.join(repositoryRoot, 'src/services/marketingBulkSends.service.js'), 'utf8');

assert.match(phoneSyncSource, /whatsapp_business_manager_messaging_limit/);
assert.match(embeddedSource, /whatsapp_business_manager_messaging_limit/);
assert.doesNotMatch(phoneSyncSource, /messaging_limit_tier/);
assert.doesNotMatch(embeddedSource, /messaging_limit_tier/);
assert.match(workerSource, /provider_acceptance_status/);
assert.match(workerSource, /msg\.status = 'pending'/);
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

console.log('campaign_whatsapp_delivery_governance.test.js OK');
