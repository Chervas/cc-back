'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  presentMessages,
  stripInternalCapture,
  withoutCaptureEntityIds,
} = require('../../services/inboundLeadCapturePresentation.service');

function sample() {
  const execution = {
    id: 13,
    clinic_id: 41,
    idempotency_key: 'inbound_capture:41:7',
    trigger_entity_id: 7,
    status: 'completed',
    context: { trigger: { data: { message_id: 7, conversation_id: 3 } } },
  };
  const record = {
    executionId: 13,
    key: 'inbound_capture:41:7',
    leadId: 27,
    campaignId: 18,
    reason: 'interest',
    outcome: 'created',
  };
  const message = {
    id: 7,
    direction: 'inbound',
    conversation_id: 3,
    metadata: {
      inboundLeadCapture: record,
      inboundLeadCaptureClassification: { token: 'internal' },
      social: { type: 'dm' },
    },
  };
  const db = {
    FlowExecutionV2: {
      findAll: async (options) => {
        assert.equal(options.where.clinic_id, 41);
        return [execution];
      },
    },
    LeadIntake: {
      findAll: async (options) => {
        assert.deepEqual(options.where, { clinica_id: 41, id: [27], archived_at: null });
        return [{ id: 27 }];
      },
    },
  };
  return {
    execution,
    message,
    record,
    db,
    options: {
      db,
      actorId: 8,
      clinicId: 41,
      canSeeLeads: async (p) => p.featureKey === 'leads.sensitive.view',
    },
  };
}
test('message results validate the execution and local lead, preserve post metadata and leave existing receipts untouched', async () => {
  const { message, record, execution, options } = sample();
  let [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.leadId, 27);
  assert.equal(row.capture_result.outcome, 'created');
  assert.deepEqual(row.metadata, { social: { type: 'dm' } });
  assert.equal(record.executionId, 13);
  delete record.outcome;
  [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.outcome, 'captured');
  execution.context.trigger.data.conversation_id = 9;
  [row] = await presentMessages([message], options);
  assert.equal(row.capture_result, undefined);
  assert.equal(stripInternalCapture(message).metadata.inboundLeadCapture, undefined);
});
test('no Leads permission exposes neither the receipt nor a link or retry failure token', async () => {
  const { message, options } = sample();
  options.canSeeLeads = async () => false;
  options.db = null;
  const [row] = await presentMessages([message], options);
  assert.deepEqual(row.metadata, { social: { type: 'dm' } });
  assert.equal(row.capture_result, undefined);
  assert.deepEqual(
    withoutCaptureEntityIds({ outputs: { N2: { leadId: 27, campaignId: 18, reason: 'interest' } } }),
    { outputs: { N2: { reason: 'interest' } } }
  );
});
test('missing/archived links and exhausted or pending retries are distinguishable without consulting a model', async () => {
  const { message, options, execution } = sample();
  options.db.LeadIntake.findAll = async () => [];
  let [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.reason, 'lead_link_requires_review');
  delete message.metadata.inboundLeadCapture;
  execution.status = 'waiting';
  execution.waiting_meta = { kind: 'inbound_lead_capture_retry' };
  [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.outcome, 'retrying');
  execution.status = 'failed';
  execution.context.outputs = { N2: { capture_retry: { will_retry: false } } };
  [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.reason, 'capture_retry_exhausted');
});
test('campaign opt-in and manual repairs do not impersonate clinical V2 executions', async () => {
  const { message, options } = sample();
  options.db.FlowExecutionV2.findAll = async () => [];
  message.metadata = {
    whatsapp_campaign_attribution: {
      capture_origin: 'campaign_send_configuration',
      lead_id: 27,
      campaign_id: 18,
      outcome: 'linked',
    },
  };
  let [row] = await presentMessages([message], options);
  assert.equal(row.capture_result.source, 'campaign');
  assert.equal(row.capture_result.leadId, 27);
  message.metadata.manual_lead_recovery = { lead_id: 27 };
  [row] = await presentMessages([message], options);
  assert.equal(row.capture_result, undefined);
});
