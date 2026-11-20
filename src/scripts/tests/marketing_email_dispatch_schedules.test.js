'use strict';

const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const dispatch = require('../../services/marketingEmailDispatch.service');
const jobs = require('../../services/jobRequests.service');
const provider = require('../../services/emailProvider.service');
const emailDelivery = require('../../services/emailDelivery.service');
const marketingEmail = require('../../services/marketingEmail.service');

function campaign(emailAt, whatsappAt) {
  return {
    id: 27, status: 'scheduled',
    criteria: {
      channels: ['whatsapp', 'email'], schedule_mode: 'scheduled', scheduled_at: whatsappAt,
      dispatch: { status: 'scheduled', job_id: 99, next_allowed_at: whatsappAt },
      channel_schedules: { version: 1, timezone: 'Europe/Madrid', channels: {
        email: { mode: 'scheduled', scheduled_at: emailAt },
        whatsapp: { mode: 'scheduled', scheduled_at: whatsappAt },
      } },
    },
    email_dispatch: {}, async update(value) { Object.assign(this, value); return this; },
    async reload() { return this; },
  };
}

test('email enqueue uses its channel due date rather than the legacy WhatsApp projection', async t => {
  const emailAt = new Date(Date.now() + 2 * 3600000).toISOString();
  const whatsappAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const list = campaign(emailAt, whatsappAt);
  t.mock.method(jobs, 'enqueueJobRequest', async input => {
    assert.equal(input.type, dispatch.JOB_TYPE);
    assert.equal(input.nextRunAt.toISOString(), emailAt);
    assert.equal(input.status, 'waiting');
    return { id: 87 };
  });
  t.mock.method(db.MarketingPatientContactEvent, 'create', async () => ({}));
  await dispatch.enqueueDispatch(list, { userId: 3 });
  assert.equal(list.email_dispatch.next_allowed_at, emailAt);
  assert.equal(list.criteria.dispatch.next_allowed_at, whatsappAt);
});

test('resuming email retains its future due date without changing WhatsApp', async t => {
  const emailAt = new Date(Date.now() + 2 * 3600000).toISOString();
  const whatsappAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const list = campaign(emailAt, whatsappAt);
  list.email_dispatch = { status: 'paused', job_id: 11 };
  t.mock.method(jobs, 'enqueueJobRequest', async input => {
    assert.equal(input.nextRunAt.toISOString(), emailAt);
    return { id: 88 };
  });
  t.mock.method(db.MarketingPatientContactEvent, 'create', async () => ({}));
  await dispatch.resumeDispatch(list, { userId: 3 });
  assert.equal(list.email_dispatch.status, 'scheduled');
  assert.equal(list.criteria.dispatch.job_id, 99);
});

test('finishing email leaves the campaign scheduled while WhatsApp is still scheduled', async t => {
  const emailAt = new Date(Date.now() - 3600000).toISOString();
  const whatsappAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const list = campaign(emailAt, whatsappAt);
  list.status = 'sending';
  list.email_dispatch = { status: 'awaiting_delivery', job_id: 11 };
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => [{ channel_status: { email: { status: 'delivered' } } }]);
  assert.equal(await dispatch.reconcileEmailDispatchCompletion(list.id), true);
  assert.equal(list.email_dispatch.status, 'completed');
  assert.equal(list.status, 'scheduled');
  assert.equal(list.criteria.dispatch.job_id, 99);
  assert.equal(list.criteria.dispatch.next_allowed_at, whatsappAt);
});

test('completion re-read preserves a concurrently paused email dispatch', async t => {
  const list = campaign(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  list.scope_type = 'clinic'; list.clinica_id = 21;
  list.email_dispatch = { status: 'sending', job_id: 11 };
  list.reload = async () => { list.email_dispatch = { status: 'paused', job_id: 11, paused_by: 3 }; return list; };
  list.update = async () => { throw new Error('must not replace concurrent pause'); };
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(db.EmailSenderIdentity, 'findOne', async () => ({ status: 'active', verification_status: 'verified', domain: { verification_status: 'verified', dkim_status: 'verified' } }));
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => ({ id: 31, subject: 'Hola', rendered_html: '<p>Hola</p>', rendered_text: 'Hola' }));
  t.mock.method(db.MarketingPatientListItem, 'count', async () => 1);
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => []);
  const result = await dispatch.runDispatchJob({ list_id: list.id });
  assert.equal(result.result.interrupted, 'paused');
  assert.equal(list.email_dispatch.paused_by, 3);
});

test('a previously bounced address is excluded before another outbox or unsubscribe link is created', async t => {
  const list = campaign(null, null);
  list.scope_type = 'clinic';
  list.clinica_id = 21;
  list.email_dispatch = { status: 'queued', job_id: 11 };
  const item = {
    id: 31, email: 'fictitious@example.test', clinica_id: 21,
    channel_status: { whatsapp: { status: 'sent' } },
    async update(patch) { Object.assign(this, patch); },
  };
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => [item]);
  t.mock.method(db.MarketingPatientListItem, 'count', async () => 1);
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(db.EmailSenderIdentity, 'findOne', async () => ({ status: 'active', verification_status: 'verified', domain: { verification_status: 'verified', dkim_status: 'verified' } }));
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => ({ id: 31, subject: 'Hola', rendered_html: '<p>Hola</p>', rendered_text: 'Hola' }));
  t.mock.method(emailDelivery, 'hashEmail', () => 'fixture-email-hash');
  t.mock.method(emailDelivery, 'findActiveSuppression', async ({ clinicaId, stream }) => {
    assert.equal(clinicaId, 21);
    assert.equal(stream, 'marketing');
    return { reason: 'bounce' };
  });
  const queues = t.mock.method(emailDelivery, 'queueEmail', async () => { throw Error('Must never queue this address'); });
  const tokens = t.mock.method(marketingEmail, 'issueUnsubscribe', async () => { throw Error('Must never issue a new unsubscribe link'); });
  const events = t.mock.method(db.MarketingPatientContactEvent, 'create', async () => ({}));

  const result = await dispatch.runDispatchJob({ list_id: list.id });
  assert.equal(result.status, 'completed');
  assert.equal(queues.mock.callCount(), 0);
  assert.equal(tokens.mock.callCount(), 0);
  assert.equal(item.channel_status.email.status, 'suppressed');
  assert.equal(item.channel_status.email.suppression_reason, 'bounce');
  assert.equal(item.channel_status.whatsapp.status, 'sent');
  assert.equal(events.mock.calls[0].arguments[0].payload.suppressed, 1);
});
