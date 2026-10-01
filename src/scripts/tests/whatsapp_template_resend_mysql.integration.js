'use strict';
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER,
    channel: D.STRING, contact_id: D.STRING }, { timestamps: false });
  models.Message = require('../../../models/message')(sql, D);
  await models.Conversation.sync();
  await models.Message.sync();
  models.JobRequest = require('../../../models/jobrequest')(sql, D); await models.JobRequest.sync();
  await models.Conversation.create({ id: 1, clinic_id: 66, channel: 'whatsapp', contact_id: '+34000000000' });
  const original = await models.Message.create({ conversation_id: 1, direction: 'outbound', message_type: 'template', status: 'failed', content: 'Fictitious template', metadata: {
    template_id: 7, template_name: 'FICTITIOUS_TEMPLATE', template_language: 'es', template_params: { 1: 'Fictitious' },
    wabaId: '101', phoneNumberId: '201', recipient: '+34000000000', execution_id: 11, quiet_hours_enabled: true,
    wamid: 'FICTITIOUS_WAMID', wa_status: { status: 'failed', errors: [{ code: 131042 }] },
  } });
  const { createService } = require('../../services/whatsappTemplateResend.service');
  let checks = 0, deny = false, at = new Date('2026-10-01T21:30:00Z'); const enqueued = [];
  const service = createService({ models, namespace: () => 'isolated-test', now: () => at,
    checkReady: async ({ message }) => { checks++; assert.equal(message.metadata.execution_id, 11); if (deny) throw Object.assign(Error('blocked'), { status: 409 }); },
    enqueue: async (payload, options) => { enqueued.push({ payload, options }); } });
  const input = { messageId: original.id, userId: 99, authorize: async c => assert.equal(c.clinic_id, 66) };
  const results = await Promise.all([service.resend(input), service.resend(input), service.resend(input)]);
  assert.equal(new Set(results.map(r => r.message.id)).size, 1); assert.equal(await models.Message.count(), 2);
  assert.equal(await models.JobRequest.count(), 1); assert.equal(checks, 1);
  const job = await models.JobRequest.findOne(); assert.equal(job.type, 'whatsapp_manual_template_resend');
  assert.equal(job.next_run_at.toISOString(), '2026-10-02T05:00:00.000Z');
  assert.deepEqual(job.payload, { message_id: results[0].message.id, __runtime_namespace: 'isolated-test' });
  report.checks.push('Three concurrent clicks produce one new template and one atomic dispatch request, with quiet hours and runtime isolation');
  await original.reload(); assert.equal(original.status, 'failed'); assert.equal(original.metadata.wamid, 'FICTITIOUS_WAMID');
  const retry = results[0].message; assert.equal(retry.metadata.wamid, undefined); assert.equal(retry.metadata.template_params[1], 'Fictitious');
  await service.dispatch(job.payload); await service.dispatch(job.payload);
  assert.equal(enqueued.length, 2); assert.equal(enqueued[0].options.jobId, enqueued[1].options.jobId);
  assert.equal(enqueued[0].options.attempts, 1); assert.equal(enqueued[0].payload.resolveClinicConfigAtSend, true);
  await retry.update({ status: 'sent', metadata: { ...retry.metadata, wamid: 'FICTITIOUS_NEW_WAMID' } });
  await service.dispatch(job.payload); assert.equal(enqueued.length, 2);
  report.checks.push('Lost queue acknowledgement reuses the same broker/job identity; an accepted attempt cannot be resent');
  await retry.update({ status: 'failed', metadata: { ...retry.metadata, delivery_unknown: true } });
  await assert.rejects(service.resend({ ...input, messageId: retry.id }), { code: 'whatsapp_template_retry_not_safe' });
  await assert.rejects(service.resend({ ...input, authorize: async () => { throw Error('forbidden'); } }), /forbidden/);
  assert.equal(await models.Message.count(), 2); assert.equal(await models.JobRequest.count(), 1);
  report.checks.push('Unknown outcome and unauthorized replay do not create rows or dispatch requests');
  await retry.update({ status: 'pending', metadata: { ...retry.metadata, wamid: null, delivery_unknown: false } });
  deny = true; await service.dispatch(job.payload); await retry.reload();
  assert.equal(retry.status, 'failed'); assert.equal(enqueued.length, 2);
  report.checks.push('Changed preflight stops the pending retry before any provider request');
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
