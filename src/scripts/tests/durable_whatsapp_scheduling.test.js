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
  const fakeMessage = {
    id: 501,
    conversation_id: 601,
    status: 'pending',
    content: 'Mensaje ya persistido',
    message_type: 'template',
    metadata: {
      recipient: '+34600000000',
      template_name: 'recordatorio',
      template_language: 'es_ES',
      template_params: { 1: 'Paciente' },
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
    whatsappService.getClinicConfig = async () => ({
      phoneNumberId: 'phone-55',
      accessToken: 'runtime-only-token',
      wabaId: 'waba-55',
    });
    queues.outboundWhatsApp.add = async (...args) => {
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
    assert.equal(queueCall[1].clinicConfig.accessToken, 'runtime-only-token');
    assert.equal(queueCall[2].jobId, 'automation-whatsapp-501');
    assert.equal(queueCall[2].delay, undefined);
    assert.equal(updates.at(-1).metadata.quiet_hours_transport_job_id, 'automation-whatsapp-501');
  } finally {
    db.Message.findByPk = originals.messageFind;
    db.Conversation.findByPk = originals.conversationFind;
    whatsappService.getClinicConfig = originals.getClinicConfig;
    queues.outboundWhatsApp.add = originals.queueAdd;
  }
}

async function testHandlersAndLaneInventory() {
  assert.equal(Object.keys(jobExecutor.JOB_HANDLERS).length, 47);
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
  await testDelayedTemplateSyncUsesDurableJobRequestWithoutToken();
  await testQuietHoursHandlerWaitsAndDispatchesIdempotentTransportJob();
  await testHandlersAndLaneInventory();
  console.log('durable_whatsapp_scheduling.test.js: OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeQueues);
