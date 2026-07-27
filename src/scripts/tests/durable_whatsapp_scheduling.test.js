#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const jobRequestsService = require('../../services/jobRequests.service');
const flowEngineV2Service = require('../../services/flowEngineV2.service');
const whatsappTemplatesService = require('../../services/whatsappTemplates.service');
const jobExecutor = require('../../services/jobExecutor.service');
const { BACKGROUND_INTEGRATION_JOB_TYPES } = require('../../config/scheduledJobCatalog');
const { queues } = require('../../services/queue.service');
const db = require('../../../models');
const whatsappService = require('../../services/whatsapp.service');

const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');

async function testQuietHoursUsesDurableJobRequest() {
  const originalEnqueue = jobRequestsService.enqueueUniqueJobRequest;
  let captured = null;
  jobRequestsService.enqueueUniqueJobRequest = async (options) => {
    captured = options;
    return { created: true, job: { id: 7101, ...options } };
  };

  try {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    const job = await flowEngineV2Service.enqueueQuietHoursWhatsappJob({
      messageId: 501,
      conversationId: 601,
      scheduledAt,
    });
    assert.equal(job.id, 7101);
    assert.equal(captured.type, 'automation_whatsapp_quiet_send');
    assert.equal(captured.status, 'waiting');
    assert.equal(captured.priority, 'high');
    assert.equal(captured.maxAttempts, 5);
    assert.equal(captured.dedupeScope, 'message:501');
    assert.equal(captured.nextRunAt.toISOString(), scheduledAt.toISOString());
    assert.deepEqual(captured.payload, {
      message_id: 501,
      conversation_id: 601,
      scheduled_for: scheduledAt.toISOString(),
    });
    assert.doesNotMatch(JSON.stringify(captured.payload), /recipient|phone|token|content|body/i);
  } finally {
    jobRequestsService.enqueueUniqueJobRequest = originalEnqueue;
  }

  const source = read('services/flowEngineV2.service.js');
  const delayedStart = source.indexOf('if (quietWindow.delayMs > 0)');
  const immediateStart = source.indexOf('\n  try {\n    const waResponse', delayedStart);
  const delayedBlock = source.slice(delayedStart, immediateStart);
  assert.match(delayedBlock, /enqueueQuietHoursWhatsappJob/);
  assert.doesNotMatch(delayedBlock, /outboundWhatsApp\.add[\s\S]*?delay:/);
}

function testOutsideSendWindowDiscardSkipsMaterialization() {
  const source = read('services/flowEngineV2.service.js');
  assert.match(source, /normalizeOutsideSendWindowPolicy/);
  assert.match(source, /status:\s*'skipped_outside_send_window'/);
  assert.match(source, /outside_send_window_policy:\s*selectedOutsideSendWindowPolicy/);

  const discardStart = source.indexOf("status: 'skipped_outside_send_window'");
  const conversationLookupStart = source.indexOf('const targetPatientId = toIntOrNull', discardStart);
  const materializationStart = source.indexOf('findOrCreateAutomationWhatsappMessage', discardStart);
  assert.ok(discardStart > 0);
  assert.ok(conversationLookupStart > discardStart);
  assert.ok(materializationStart > conversationLookupStart);
}

async function testDelayedTemplateSyncUsesDurableJobRequestWithoutToken() {
  const originalEnqueue = jobRequestsService.enqueueUniqueJobRequest;
  let captured = null;
  jobRequestsService.enqueueUniqueJobRequest = async (options) => {
    captured = options;
    return { created: true, job: { id: 7201, ...options } };
  };

  try {
    const job = await whatsappTemplatesService.enqueueSyncTemplatesJob({
      wabaId: 'waba_123',
      accessToken: 'must-never-enter-job-request',
      trigger: 'propagate_followup',
    }, {
      delayMs: 12 * 60 * 1000,
      dedupeWindowMs: 12 * 60 * 1000,
    });
    assert.equal(job.id, 7201);
    assert.equal(captured.type, 'whatsapp_template_sync_delayed');
    assert.equal(captured.status, 'waiting');
    assert.equal(captured.maxAttempts, 5);
    assert.match(captured.dedupeScope, /^sync-waba_123-followup-\d+$/);
    assert.equal(captured.payload.wabaId, 'waba_123');
    assert.equal(captured.payload.trigger, 'propagate_followup');
    assert.ok(new Date(captured.payload.scheduled_for).getTime() > Date.now());
    assert.doesNotMatch(JSON.stringify(captured.payload), /must-never-enter|accessToken|token/i);
  } finally {
    jobRequestsService.enqueueUniqueJobRequest = originalEnqueue;
  }

  const source = read('services/whatsappTemplates.service.js');
  const delayedStart = source.indexOf('if (delayMs > 0)');
  const immediateStart = source.indexOf('\n  return queues.whatsappTemplateSync.add', delayedStart);
  const delayedBlock = source.slice(delayedStart, immediateStart);
  assert.match(delayedBlock, /enqueueUniqueJobRequest/);
  assert.doesNotMatch(delayedBlock, /queues\.whatsappTemplateSync\.add/);

  const future = new Date(Date.now() + 60 * 60 * 1000);
  const waiting = await whatsappTemplatesService.runDelayedSyncTemplatesJob({
    wabaId: 'waba_123',
    scheduled_for: future.toISOString(),
  });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.nextAllowedAt.toISOString(), future.toISOString());
}

async function testQuietHoursHandlerWaitsAndDispatchesIdempotentTransportJob() {
  const originals = {
    messageFind: db.Message.findByPk,
    conversationFind: db.Conversation.findByPk,
    getClinicConfig: whatsappService.getClinicConfig,
    queueAdd: queues.outboundWhatsApp.add,
  };
  const updates = [];
  let clinicConfigReads = 0;
  const fakeMessage = {
    id: 501,
    conversation_id: 601,
    status: 'pending',
    content: 'Mensaje ya persistido',
    message_type: 'template',
    metadata: {
      recipient: '+34600000000',
      access_guidance_variant_requested: true,
      template_name: 'recordatorio',
      template_language: 'es_ES',
      template_params: { 1: 'Paciente' },
      template_components: [
        {
          type: 'header',
          parameters: [{ type: 'image', image: { link: 'https://media.clinicaclick.com/access.jpg' } }],
        },
        { type: 'body', parameters: [{ type: 'text', text: 'Paciente' }] },
      ],
    },
    async update(patch) {
      updates.push(patch);
      Object.assign(this, patch);
    },
  };
  let queueCall = null;

  try {
    db.Message.findByPk = async () => fakeMessage;
    db.Conversation.findByPk = async () => ({ id: 601, clinic_id: 55 });
    whatsappService.getClinicConfig = async () => {
      clinicConfigReads += 1;
      return {
        phoneNumberId: 'phone-55',
        accessToken: 'runtime-only-token',
        wabaId: 'waba-55',
      };
    };
    queues.outboundWhatsApp.add = async (...args) => {
      assert.equal(fakeMessage.status, 'pending');
      assert.equal(fakeMessage.metadata.automation_transport_job_id, 'automation-whatsapp-501');
      queueCall = args;
      return { id: args[2]?.jobId };
    };

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const waiting = await flowEngineV2Service.runScheduledWhatsappSendJob({
      message_id: 501,
      conversation_id: 601,
      scheduled_for: future.toISOString(),
    });
    assert.equal(waiting.status, 'waiting');
    assert.equal(queueCall, null);

    const completed = await flowEngineV2Service.runScheduledWhatsappSendJob({
      message_id: 501,
      conversation_id: 601,
      scheduled_for: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(completed.status, 'completed');
    assert.equal(queueCall[0], 'send');
    assert.equal(queueCall[1].messageId, 501);
    assert.equal(queueCall[1].resolveClinicConfigAtSend, true);
    assert.equal(queueCall[1].clinicId, 55);
    assert.equal(Object.hasOwn(queueCall[1], 'clinicConfig'), false);
    assert.doesNotMatch(JSON.stringify(queueCall[1]), /runtime-only-token|accessToken/i);
    assert.deepEqual(queueCall[1].templateComponents, fakeMessage.metadata.template_components);
    assert.equal(queueCall[1].retryOnFailure, true);
    assert.equal(queueCall[2].jobId, 'automation-whatsapp-501');
    assert.equal(queueCall[2].attempts, 5);
    assert.deepEqual(queueCall[2].backoff, { type: 'exponential', delay: 60000 });
    assert.deepEqual(queueCall[2].removeOnComplete, { age: 86400, count: 1000 });
    assert.deepEqual(queueCall[2].removeOnFail, { age: 604800, count: 5000 });
    assert.equal(queueCall[2].delay, undefined);
    assert.equal(updates.at(-1).metadata.quiet_hours_transport_job_id, 'automation-whatsapp-501');
    assert.equal(clinicConfigReads, 0, 'las credenciales se resuelven en el worker, no en el productor');
  } finally {
    db.Message.findByPk = originals.messageFind;
    db.Conversation.findByPk = originals.conversationFind;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    queues.outboundWhatsApp.add = originals.queueAdd;
  }
}

async function testImmediateTransportPersistsBeforePublishAndKeepsImageSnapshot() {
  const originalQueueAdd = queues.outboundWhatsApp.add;
  let queueCall = null;
  let persisted = false;
  const templateComponents = [
    {
      type: 'header',
      parameters: [{ type: 'image', image: { link: 'https://media.clinicaclick.com/access.jpg' } }],
    },
    { type: 'body', parameters: [{ type: 'text', text: 'Paciente' }] },
  ];
  const msg = {
    id: 502,
    conversation_id: 602,
    status: 'created',
    content: 'Mensaje inmediato ya persistido',
    message_type: 'template',
    metadata: {
      recipient: '+34600000001',
      template_name: 'recordatorio_acceso',
      template_language: 'es_ES',
      template_params: { 1: 'Paciente' },
      template_components: templateComponents,
    },
    async update(patch) {
      Object.assign(this, patch);
      persisted = true;
    },
  };

  try {
    queues.outboundWhatsApp.add = async (...args) => {
      assert.equal(persisted, true, 'el Message debe quedar durable antes de publicar a Redis');
      assert.equal(msg.metadata.immediate_transport_job_id, 'automation-whatsapp-502');
      queueCall = args;
      return { id: args[2].jobId };
    };

    const result = await flowEngineV2Service.enqueueAutomationWhatsappTransport({
      msg,
      conversation: { id: 602, clinic_id: 66 },
      recipient: '+34600000001',
      dispatchKind: 'immediate',
    });

    assert.equal(result.transportJobId, 'automation-whatsapp-502');
    assert.equal(queueCall[1].resolveClinicConfigAtSend, true);
    assert.equal(queueCall[1].clinicId, 66);
    assert.deepEqual(queueCall[1].templateComponents, templateComponents);
    assert.equal(queueCall[1].retryOnFailure, true);
    assert.equal(Object.hasOwn(queueCall[1], 'clinicConfig'), false);
  } finally {
    queues.outboundWhatsApp.add = originalQueueAdd;
  }
}

async function testReplayMaterializationUsesOneGlobalDeliveryKey() {
  const originalFindOrCreate = db.Message.findOrCreate;
  const stored = new Map();
  const calls = [];
  db.Message.findOrCreate = async (options) => {
    calls.push(options);
    const key = options.where.automation_delivery_key;
    if (stored.has(key)) return [stored.get(key), false];
    const message = { id: 8801, ...options.defaults };
    stored.set(key, message);
    return [message, true];
  };

  try {
    const deliveryKey = flowEngineV2Service.buildAutomationWhatsappDeliveryKey(
      { id: 9001 },
      { id: 'send-reminder' }
    );
    const sharedSlotKey = flowEngineV2Service.buildAutomationWhatsappDeliveryKey(
      { id: 9001 },
      { id: 'send-access', config: { delivery_slot: 'same_day_first_visit_reminder' } }
    );
    const sharedSlotKeyFromOtherBranch = flowEngineV2Service.buildAutomationWhatsappDeliveryKey(
      { id: 9001 },
      { id: 'send-base', config: { delivery_slot: 'same_day_first_visit_reminder' } }
    );
    assert.equal(deliveryKey, 'flow:9001:node:send-reminder');
    assert.equal(sharedSlotKey, 'flow:9001:slot:same_day_first_visit_reminder');
    assert.equal(sharedSlotKeyFromOtherBranch, sharedSlotKey);
    const values = {
      conversation_id: 601,
      direction: 'outbound',
      message_type: 'template',
      status: 'pending',
      metadata: { automation_delivery_key: sharedSlotKey },
    };
    const [first, raced] = await Promise.all([
      flowEngineV2Service.findOrCreateAutomationWhatsappMessage({
        deliveryKey: sharedSlotKey,
        messageType: 'template',
        values,
      }),
      flowEngineV2Service.findOrCreateAutomationWhatsappMessage({
        deliveryKey: sharedSlotKeyFromOtherBranch,
        messageType: 'template',
        values,
      }),
    ]);
    assert.equal(first.message.id, raced.message.id);
    assert.equal([first.created, raced.created].filter(Boolean).length, 1);
    assert.equal(stored.size, 1);
    assert.equal(
      calls[0].where.automation_delivery_key,
      'flow:9001:slot:same_day_first_visit_reminder:outbound'
    );

    const migrationSource = fs.readFileSync(
      path.resolve(__dirname, '../../../migrations/20260714121000-add-message-automation-delivery-key.js'),
      'utf8'
    );
    assert.match(migrationSource, /unique:\s*true/);
  } finally {
    db.Message.findOrCreate = originalFindOrCreate;
  }
}

async function testReplayRestoresQuietHoursWithoutEarlyBullDispatch() {
  const originals = {
    conversationFind: db.Conversation.findByPk,
    enqueue: jobRequestsService.enqueueUniqueJobRequest,
    queueAdd: queues.outboundWhatsApp.add,
  };
  const future = new Date(Date.now() + 60 * 60 * 1000);
  let bullCalls = 0;
  let jobRequestPayload = null;
  const imageComponents = [{
    type: 'header',
    parameters: [{ type: 'image', image: { link: 'https://media.clinicaclick.com/access.jpg' } }],
  }];
  const message = {
    id: 8802,
    conversation_id: 602,
    status: 'failed',
    metadata: {
      recipient: '+34600000002',
      queued_by_quiet_hours: true,
      scheduled_for: future.toISOString(),
      enqueue_error: 'redis_temporarily_unavailable',
      access_guidance_variant_requested: true,
      template_components: imageComponents,
    },
    async update(patch) {
      this.status = patch.status ?? this.status;
      this.metadata = patch.metadata ?? this.metadata;
    },
  };

  try {
    db.Conversation.findByPk = async () => ({
      id: 602,
      clinic_id: 66,
      async update() {},
    });
    jobRequestsService.enqueueUniqueJobRequest = async (options) => {
      jobRequestPayload = options;
      return { job: { id: 8803 }, created: true };
    };
    queues.outboundWhatsApp.add = async () => {
      bullCalls += 1;
      return { id: 'unexpected' };
    };

    const result = await flowEngineV2Service.reuseExistingAutomationWhatsappMessage({
      existingMessage: message,
      node: { id: 'send-reminder', outputs: { on_success: 'done' } },
    });
    assert.equal(result.output.status, 'scheduled');
    assert.equal(result.output.job_request_id, 8803);
    assert.equal(bullCalls, 0);
    assert.equal(jobRequestPayload.dedupeScope, 'message:8802');
    assert.equal(jobRequestPayload.nextRunAt.toISOString(), future.toISOString());
    assert.deepEqual(message.metadata.template_components, imageComponents);
    assert.equal(message.metadata.enqueue_error, null);
  } finally {
    db.Conversation.findByPk = originals.conversationFind;
    jobRequestsService.enqueueUniqueJobRequest = originals.enqueue;
    queues.outboundWhatsApp.add = originals.queueAdd;
  }
}

async function testReplayRecoversImmediateEnqueueFailureWithSameSnapshot() {
  const originals = {
    conversationFind: db.Conversation.findByPk,
    queueAdd: queues.outboundWhatsApp.add,
  };
  let queuePayload = null;
  const imageComponents = [{
    type: 'header',
    parameters: [{ type: 'image', image: { link: 'https://media.clinicaclick.com/access-immediate.jpg' } }],
  }];
  const message = {
    id: 8804,
    conversation_id: 604,
    status: 'failed',
    content: 'Snapshot',
    message_type: 'template',
    metadata: {
      recipient: '+34600000004',
      enqueue_error: 'redis_temporarily_unavailable',
      access_guidance_variant_requested: true,
      template_name: 'recordatorio_acceso_v1',
      template_language: 'es_ES',
      template_params: { 1: 'QA' },
      template_components: imageComponents,
    },
    async update(patch) {
      this.status = patch.status ?? this.status;
      this.metadata = patch.metadata ?? this.metadata;
    },
  };

  try {
    db.Conversation.findByPk = async () => ({
      id: 604,
      clinic_id: 66,
      async update() {},
    });
    queues.outboundWhatsApp.add = async (_name, payload, options) => {
      queuePayload = payload;
      return { id: options.jobId };
    };
    const result = await flowEngineV2Service.reuseExistingAutomationWhatsappMessage({
      existingMessage: message,
      node: { id: 'send-reminder' },
    });
    assert.equal(result.output.status, 'queued');
    assert.equal(result.output.transport_job_id, 'automation-whatsapp-8804');
    assert.equal(queuePayload.retryOnFailure, true);
    assert.deepEqual(queuePayload.templateComponents, imageComponents);
    assert.equal(message.metadata.enqueue_error, null);
  } finally {
    db.Conversation.findByPk = originals.conversationFind;
    queues.outboundWhatsApp.add = originals.queueAdd;
  }
}

function testFlowHandoffRetryIsBoundedAndUsesExistingJobLane() {
  const now = new Date('2026-07-14T10:00:00.000Z');
  const first = flowEngineV2Service.buildWhatsappTransportHandoffRetryState({
    errorMessage: 'whatsapp_enqueue_failed:redis_down',
    now,
  });
  assert.equal(first.retry_attempt, 1);
  assert.equal(first.backoff_ms, 60000);
  assert.equal(first.retry_at.toISOString(), '2026-07-14T10:01:00.000Z');

  const fourth = flowEngineV2Service.buildWhatsappTransportHandoffRetryState({
    errorMessage: 'whatsapp_enqueue_failed:redis_down',
    previousRetryAttempt: 3,
    now,
  });
  assert.equal(fourth.retry_attempt, 4);
  assert.equal(fourth.backoff_ms, 8 * 60 * 1000);

  const exhausted = flowEngineV2Service.buildWhatsappTransportHandoffRetryState({
    errorMessage: 'whatsapp_enqueue_failed:redis_down',
    previousRetryAttempt: 4,
    now,
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.retry_attempt, 5);
  assert.equal(flowEngineV2Service.buildWhatsappTransportHandoffRetryState({
    errorMessage: 'whatsapp_template_not_approved',
    now,
  }), null);

  const engineSource = read('services/flowEngineV2.service.js');
  const executorSource = read('services/jobExecutor.service.js');
  assert.match(engineSource, /resume_mode:\s*'retry_current_node'/);
  assert.match(executorSource, /waitingResumeMode === 'retry_current_node'/);
}

async function testScheduledSenderRejectsWabaSnapshotDrift() {
  const originals = {
    assetFindOne: db.ClinicMetaAsset.findOne,
    assetFindByPk: db.ClinicMetaAsset.findByPk,
  };
  try {
    db.ClinicMetaAsset.findOne = async () => ({ id: 9901 });
    db.ClinicMetaAsset.findByPk = async () => ({
      id: 9901,
      assetType: 'whatsapp_phone_number',
      isActive: true,
      assignmentScope: 'clinic',
      clinicaId: 66,
      phoneNumberId: 'phone-66',
      waAccessToken: 'runtime-token',
      wabaId: 'waba-new',
      additionalData: {},
      metaAssetName: 'QA',
    });

    await assert.rejects(
      () => flowEngineV2Service.resolveScheduledWhatsappSenderConfig({
        clinicId: 66,
        metadata: {
          phoneNumberId: 'phone-66',
          wabaId: 'waba-original',
        },
      }),
      /whatsapp_sender_snapshot_waba_mismatch/
    );
  } finally {
    db.ClinicMetaAsset.findOne = originals.assetFindOne;
    db.ClinicMetaAsset.findByPk = originals.assetFindByPk;
  }
}

async function testRuntimeRevalidatesClinicAccessPublicMediaAsset() {
  const originalFindOne = db.PublicMediaAsset.findOne;
  let whereSeen = null;
  try {
    db.PublicMediaAsset.findOne = async ({ where }) => {
      whereSeen = where;
      return {
        id: 991,
        public_url: 'https://media.clinicaclick.com/clinics/66/access.jpg',
      };
    };
    const valid = await flowEngineV2Service.validateAccessGuidancePublicMediaAsset({
      clinicId: 66,
      accessGuidance: {
        enabled: true,
        directions: 'Entrada lateral.',
        image_asset_id: 991,
        image_url: 'https://media.clinicaclick.com/clinics/66/access.jpg',
      },
    });
    assert.equal(valid, null);
    assert.deepEqual(whereSeen, {
      id: 991,
      scope_type: 'clinic',
      clinica_id: 66,
      purpose: 'clinic_access_image',
      sensitivity: 'public',
      status: 'active',
    });

    db.PublicMediaAsset.findOne = async () => ({
      id: 991,
      public_url: 'https://media.clinicaclick.com/other.jpg',
    });
    const mismatch = await flowEngineV2Service.validateAccessGuidancePublicMediaAsset({
      clinicId: 66,
      accessGuidance: {
        enabled: true,
        directions: 'Entrada lateral.',
        image_asset_id: 991,
        image_url: 'https://media.clinicaclick.com/clinics/66/access.jpg',
      },
    });
    assert.equal(mismatch, 'access_guidance_image_asset_url_mismatch');
  } finally {
    db.PublicMediaAsset.findOne = originalFindOne;
  }
}

async function testHandlersAndLaneInventory() {
  assert.equal(Object.keys(jobExecutor.JOB_HANDLERS).length, 65);
  assert.equal(typeof jobExecutor.JOB_HANDLERS.lead_auto_reply_backfill, 'function');
  assert.equal(typeof jobExecutor.JOB_HANDLERS.automation_whatsapp_quiet_send, 'function');
  assert.equal(typeof jobExecutor.JOB_HANDLERS.whatsapp_template_sync_delayed, 'function');
  assert.equal(BACKGROUND_INTEGRATION_JOB_TYPES.includes('whatsapp_template_sync_delayed'), true);
  assert.equal(BACKGROUND_INTEGRATION_JOB_TYPES.includes('automation_whatsapp_quiet_send'), false);

  const originalFlowRun = flowEngineV2Service.runScheduledWhatsappSendJob;
  const originalTemplateRun = whatsappTemplatesService.runDelayedSyncTemplatesJob;
  const received = {};
  flowEngineV2Service.runScheduledWhatsappSendJob = async (payload) => {
    received.flow = payload;
    return { status: 'completed', result: { ok: true } };
  };
  whatsappTemplatesService.runDelayedSyncTemplatesJob = async (payload) => {
    received.template = payload;
    return { status: 'completed', result: { ok: true } };
  };
  try {
    await jobExecutor.JOB_HANDLERS.automation_whatsapp_quiet_send({ message_id: 501 });
    await jobExecutor.JOB_HANDLERS.whatsapp_template_sync_delayed({ wabaId: 'waba_123' });
    assert.deepEqual(received.flow, { message_id: 501 });
    assert.deepEqual(received.template, { wabaId: 'waba_123' });
  } finally {
    flowEngineV2Service.runScheduledWhatsappSendJob = originalFlowRun;
    whatsappTemplatesService.runDelayedSyncTemplatesJob = originalTemplateRun;
  }
}

async function closeQueues() {
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
}

async function run() {
  await testQuietHoursUsesDurableJobRequest();
  testOutsideSendWindowDiscardSkipsMaterialization();
  await testDelayedTemplateSyncUsesDurableJobRequestWithoutToken();
  await testQuietHoursHandlerWaitsAndDispatchesIdempotentTransportJob();
  await testImmediateTransportPersistsBeforePublishAndKeepsImageSnapshot();
  await testReplayMaterializationUsesOneGlobalDeliveryKey();
  await testReplayRestoresQuietHoursWithoutEarlyBullDispatch();
  await testReplayRecoversImmediateEnqueueFailureWithSameSnapshot();
  testFlowHandoffRetryIsBoundedAndUsesExistingJobLane();
  await testScheduledSenderRejectsWabaSnapshotDrift();
  await testRuntimeRevalidatesClinicAccessPublicMediaAsset();
  await testHandlersAndLaneInventory();
  console.log('durable_whatsapp_scheduling.test.js: OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeQueues);
