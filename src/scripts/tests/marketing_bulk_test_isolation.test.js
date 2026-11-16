'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../services/marketingBulkSends.service.js'), 'utf8');
function functionSource(name, next) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf(`\n${next}`, start);
  assert(end > start, next);
  return source.slice(source.lastIndexOf('\n', start) + 1, end);
}
function fixture(extra = {}) {
  const events = [], sends = [], updates = [];
  const context = {
    Op: require('sequelize').Op,
    asPlainObject: value => value || {}, normalizeKey: value => String(value || '').toLowerCase(),
    normalizeDispatchContext: value => value, isReviewRequestList: () => true,
    isReviewRatingTriggerMessage: message => message.metadata.kind === 'mass_campaign_test',
    MarketingPatientContactEvent: { findAll: async () => events, create: async event => events.push(event) },
    MarketingPatientListItem: { findOne() { throw Error('test must not load or mutate a real recipient'); } },
    materializeReviewPrivateFeedback: async () => ({ applied: false }),
    sendReviewPrivateFeedbackAcknowledgement: async () => { sends.push('ack'); },
    sendReviewRatingFollowUpOrStoreInlineFeedback: async args => { sends.push(args); return { sent: true }; },
    Date, ...extra,
  };
  vm.createContext(context);
  for (const [name, next] of [
    ['isBulkSendTestMessage', 'function shouldScheduleReviewReminder'],
    ['computeCounters', 'function statusRank'],
    ['materializeMessageStatusFromWebhook', 'async function materializeTestInboundReply'],
    ['materializeTestInboundReply', 'async function materializeInboundReply'],
  ]) vm.runInContext(functionSource(name, next), context);
  return { context, events, sends, updates };
}

test('sent, delivered, read and failed test receipts never materialize onto campaign recipients', async () => {
  const f = fixture();
  for (const kind of ['mass_campaign_test', 'review_google_link_followup', 'review_private_feedback_ack']) {
    for (const mappedStatus of ['sent', 'delivered', 'read', 'failed']) {
      const result = await f.context.materializeMessageStatusFromWebhook({ message: {
        metadata: { source: 'marketing_bulk_sends', kind, test_send: kind !== 'mass_campaign_test', list_id: 827, item_id: 824749 },
      }, mappedStatus, status: {} });
      assert.equal(result.reason, 'test_send_isolated');
    }
  }
  assert.equal(f.events.length, 0);
});

test('a test rating still gets its follow-up but never changes the example patient or real statistics', async () => {
  const f = fixture();
  const args = {
    list: { id: 827 }, item: { id: 824749, paciente_id: 123, update() { throw Error('real item mutation'); } },
    conversation: { id: 1, clinic_id: 59 }, inboundMessage: { id: 200 },
    triggerMessage: { id: 199, metadata: { source: 'marketing_bulk_sends', kind: 'mass_campaign_test', recipient: '34600000000' } },
    repliedAt: new Date(), ratingDetails: { rating: 5, reason: '' },
  };
  const result = await f.context.materializeTestInboundReply(args);
  assert.equal(result.test_send, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].clinicId, 59);
  assert.deepEqual(f.events.map(event => event.event_type), ['mass_campaign_test_replied', 'review_test_rating_received', 'mass_campaign_test_reply_completed']);
  assert(f.events.every(event => event.paciente_id === null));
});

test('a duplicate test inbound does not send a second follow-up', async () => {
  const f = fixture({ MarketingPatientContactEvent: {
    findAll: async () => [{ event_type: 'mass_campaign_test_reply_completed', payload: { inbound_message_id: 200 } }], create() { throw Error('duplicate event'); },
  } });
  const result = await f.context.materializeTestInboundReply({ list: { id: 1 }, item: { id: 2 }, inboundMessage: { id: 200 } });
  assert.equal(result.reason, 'test_reply_already_processed');
  assert.equal(result.applied, true);
  assert.equal(f.sends.length, 0);
});

test('a continuation failing after the rating resumes on retry without a second rating or patient mutation',async()=>{
  let attempts=0;
  const f=fixture({sendReviewRatingFollowUpOrStoreInlineFeedback:async()=>{
    if(++attempts===1)throw Error('temporary_guard_read_failure');
    return {sent:true};
  }});
  const args={list:{id:1},item:{id:2},conversation:{id:3,clinic_id:44},inboundMessage:{id:200},
    triggerMessage:{id:199,metadata:{kind:'mass_campaign_test'}},repliedAt:new Date(),ratingDetails:{rating:5}};
  await assert.rejects(f.context.materializeTestInboundReply(args),/temporary_guard_read_failure/);
  assert.equal(f.events.length,2);
  assert.equal((await f.context.materializeTestInboundReply(args)).applied,true);
  assert.equal(f.events.length,3);assert.equal(attempts,2);
  assert.equal((await f.context.materializeTestInboundReply(args)).reason,'test_reply_already_processed');
  assert.equal(attempts,2);assert(f.events.every(event=>event.paciente_id===null));
});

test('synthetic rows cannot change totals, sent, delivered, replied, failed or exclusions', () => {
  const f = fixture();
  const actual = { status: 'ready', selected: true };
  const sample = { status: 'test_sample', selected: false, dispatch_status: 'replied', sent_at: new Date(), replied_at: new Date(), failed_at: new Date() };
  assert.equal(JSON.stringify(f.context.computeCounters([actual, sample])), JSON.stringify(f.context.computeCounters([actual])));
  assert.match(source, /if \(isReviewTemplateUsage\(templateUsage\)\) \{\s*item = await getOrCreateReviewTestSampleItem/);
});
