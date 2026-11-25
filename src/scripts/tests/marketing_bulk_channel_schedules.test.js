'use strict';

const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
// Add only the template model required by the genuine WhatsApp dispatch path;
// all database operations remain individually mocked or fail closed.
db.WhatsappTemplate = { findByPk() { throw new Error('UNEXPECTED_TEMPLATE_QUERY'); }, findAll() { throw new Error('UNEXPECTED_TEMPLATE_QUERY'); } };
const bulk = require('../../services/marketingBulkSends.service');
const email = require('../../services/marketingEmailDispatch.service');
const provider = require('../../services/emailProvider.service');
const whatsapp = require('../../services/whatsapp.service');
const health = require('../../services/whatsappAccountHealth.service');
const templateScope = require('../../services/whatsappTemplateScope.service');
const governance = require('../../services/whatsappDeliveryGovernance.service');
const jobs = require('../../services/jobRequests.service');
const quality = require('../../services/whatsappQueueQuality.service');
const scope = { scope: 'clinic', clinicIds: [21] };

function dates() {
  const next = new Date(Date.now() + 48 * 3600000); next.setUTCHours(12, 0, 0, 0);
  return { whatsapp: next.toISOString(), email: new Date(next.getTime() + 3600000).toISOString() };
}
function bundle(whatsapp, email) {
  const entry = value => value ? { mode: 'scheduled', scheduled_at: value } : { mode: 'now', scheduled_at: null };
  return { version: 1, timezone: 'Europe/Madrid', channels: { whatsapp: entry(whatsapp), email: entry(email) } };
}
function store(t) {
  let list; let items = []; const queued = [], events = [], immediate = [];
  const template = { id: 41, clinic_id: 21, name: 'offline_template', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola' }] };
  const emailTemplate = { id: 31, version: 1, name: 'Offline', subject: 'Hola', design: { content_mode: 'html', html_source: '<p>Hola</p>' } };
  const sender = { id: 51, status: 'active', verification_status: 'verified', email: 'offline@example.test', display_name: 'Offline', domain: { verification_status: 'verified', dkim_status: 'verified' } };
  t.mock.method(db.sequelize, 'transaction', async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(db.MarketingPatientList, 'create', async value => {
    list = { id: 77, ...value, get(key) { return typeof key === 'string' ? this[key] : { ...this }; }, async update(patch) { Object.assign(this, patch); return this; }, async reload() { return this; } };
    return list;
  });
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientList, 'update', async patch => { Object.assign(list, patch); return [1]; });
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => items);
  t.mock.method(db.MarketingPatientListItem, 'count', async ({ where } = {}) => ['queued', 'accepted', 'held_quality'].includes(where?.dispatch_status) ? 0 : items.length);
  t.mock.method(db.MarketingPatientListItem, 'update', async () => [0]);
  t.mock.method(db.MarketingPatientContactEvent, 'create', async value => { events.push(value); return value; });
  t.mock.method(db.Clinica, 'findByPk', async () => null);
  t.mock.method(db.WhatsappTemplate, 'findByPk', async () => template);
  t.mock.method(db.WhatsappTemplate, 'findAll', async () => [template]);
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => emailTemplate);
  t.mock.method(db.EmailSenderIdentity, 'findOne', async () => sender);
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(whatsapp, 'getClinicConfig', async () => ({ phoneNumberId: 'OFFLINE_PHONE', wabaId: 'OFFLINE_WABA', accessToken: 'OFFLINE_ONLY' }));
  t.mock.method(health, 'assertCanSend', async () => ({}));
  t.mock.method(templateScope, 'resolveTemplateInWaba', async () => template);
  t.mock.method(governance, 'getDispatchGate', async () => ({ allowed: true, effective_batch_size: 100 }));
  t.mock.method(quality, 'current', () => ({ read: async () => ({ max_opt_out_rate: 0.05, revision: 1 }) }));
  t.mock.method(jobs, 'enqueueJobRequest', async input => { queued.push(input); return { id: 100 + queued.length }; });
  const schedulerKey = require.resolve('../../services/jobScheduler.service'), previous = require.cache[schedulerKey];
  require.cache[schedulerKey] = { id: schedulerKey, filename: schedulerKey, loaded: true, exports: { triggerImmediate: async id => immediate.push(id) } };
  t.after(() => { if (previous) require.cache[schedulerKey] = previous; else delete require.cache[schedulerKey]; });
  return { get list() { return list; }, queued, events, immediate, setItems(value) { items = value; }, addItem() {
    items = [{ id: 2, list_id: 77, clinica_id: 21, name: 'Contacto ficticio', phone: '+34600000000', email: 'offline@example.test', status: 'ready', selected: true, custom_fields: {}, get() { return { ...this }; }, async update(patch) { Object.assign(this, patch); return this; } }];
  } };
}
async function create(t, schedules, channels = ['whatsapp', 'email']) {
  const f = store(t);
  await bulk.createCampaign(scope, { name: 'Prueba offline', channels, list_source: 'manual', whatsapp_template_id: 41, email_template_id: 31, email_sender_identity_id: 51, template_usage: 'notificacion', consent_acknowledged: true,
    ...(schedules ? { channel_schedules: schedules } : {}) }, 3);
  f.addItem();
  f.list.criteria.dispatch_config = { time_mode: 'specific_time', business_hours: { start_time: '00:00', end_time: '23:59', timezone: 'UTC' } };
  return f;
}

test('genuine create/update/prepare retain independent schedules and project only WhatsApp to legacy fields', async t => {
  const at = dates(), first = bundle(at.whatsapp, at.email), f = await create(t, first);
  assert.deepEqual(f.list.criteria.channel_schedules, first);
  assert.equal(f.list.criteria.scheduled_at, at.whatsapp);
  const changed = bundle(at.whatsapp, null);
  await bulk.updateCampaign(scope, f.list.id, { channel_schedules: changed }, 3);
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  assert.deepEqual(f.list.criteria.channel_schedules, changed);
  assert.equal(f.list.criteria.scheduled_at, at.whatsapp);
  await bulk.updateCampaign(scope, f.list.id, { schedule_mode: 'scheduled', scheduled_at: at.whatsapp }, 3);
  assert.deepEqual(f.list.criteria.channel_schedules, changed, 'unchanged legacy projection is compatible');
  await assert.rejects(bulk.updateCampaign(scope, f.list.id, { schedule_mode: 'now', scheduled_at: null }, 3), { code: 'channel_schedule_version_conflict' });
});

test('genuine mixed dispatch enqueues distinct channel dates and never sends a message in this test', async t => {
  const at = dates(), f = await create(t, bundle(at.whatsapp, at.email));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  // The template-approval continuation passes this persisted legacy projection.
  await bulk.startCampaignDispatch(scope, f.list.id, { scheduled_at: f.list.criteria.scheduled_at }, 3);
  assert.equal(f.queued.length, 2);
  const waJob = f.queued.find(job => job.type !== email.JOB_TYPE), emailJob = f.queued.find(job => job.type === email.JOB_TYPE);
  assert.equal(waJob.nextRunAt.toISOString(), at.whatsapp);
  assert.equal(emailJob.nextRunAt.toISOString(), at.email);
  assert.equal(f.list.criteria.dispatch.next_allowed_at, at.whatsapp);
  assert.equal(f.list.email_dispatch.next_allowed_at, at.email);
  assert.equal(f.immediate.length, 0);
  await assert.rejects(bulk.updateCampaign(scope, f.list.id, { channel_schedules: bundle(null, at.email) }, 3), { code: 'channel_schedule_already_queued' });
});

test('the saved manual WhatsApp window moves the first batch into its Madrid schedule and leaves email unchanged', async t => {
  const due = new Date(Date.now() + 7 * 86400000);
  due.setUTCHours(12, 0, 0, 0);
  if (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + (due.getUTCDay() === 6 ? 2 : 1));
  const at = due.toISOString();
  const f = await create(t, bundle(at, at));
  const window = { mode: 'custom', start_time: '14:30', end_time: '17:00', include_weekends: false };
  await bulk.updateCampaign(scope, f.list.id, { whatsapp_dispatch_window: window, whatsapp_cadence: { batch_size: 12, delay_ms: 300000 } }, 3);
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  await bulk.startCampaignDispatch(scope, f.list.id, {}, 3);
  const whatsapp = f.queued.find(job => job.type !== email.JOB_TYPE);
  const emailJob = f.queued.find(job => job.type === email.JOB_TYPE);
  const clock = new Intl.DateTimeFormat('en-GB', {hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Europe/Madrid'});
  assert.equal(clock.format(whatsapp.nextRunAt), '14:30');
  assert.equal(emailJob.nextRunAt.toISOString(), at);
  assert.deepEqual(f.list.criteria.whatsapp_dispatch_window, window);
  assert.equal(f.list.criteria.dispatch.batch_size, 12);
  assert.equal(f.list.criteria.dispatch.delay_ms, 300000);
  await assert.rejects(bulk.updateCampaign(scope, f.list.id, { whatsapp_dispatch_window: { mode: 'clinic_hours' } }, 3), { status: 409 });
});

test('expired or conflicting channel intent fails before either job is enqueued', async t => {
  const at = dates(), f = await create(t, bundle(at.whatsapp, new Date(Date.now() - 1000).toISOString()));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  await assert.rejects(bulk.startCampaignDispatch(scope, f.list.id, {}, 3), { code: 'channel_schedule_expired' });
  assert.equal(f.queued.length, 0);
  f.list.criteria.channel_schedules = bundle(at.whatsapp, at.email);
  await assert.rejects(bulk.startCampaignDispatch(scope, f.list.id, { scheduled_at: at.email }, 3), { code: 'channel_schedule_version_conflict' });
  assert.equal(f.queued.length, 0);
});

test('email now and WhatsApp future expose an active global campaign without advancing WhatsApp', async t => {
  const at = dates(), f = await create(t, bundle(at.whatsapp, null));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  await bulk.startCampaignDispatch(scope, f.list.id, {}, 3);
  assert.equal(f.list.status, 'sending');
  assert.equal(f.list.criteria.dispatch.status, 'scheduled');
  assert.equal(f.list.email_dispatch.status, 'queued');
  assert.equal(f.queued.find(job => job.type === email.JOB_TYPE).nextRunAt, null);
  assert.equal(f.queued.find(job => job.type !== email.JOB_TYPE).nextRunAt.toISOString(), at.whatsapp);
  assert.equal(f.immediate.length, 1);
});

test('explicit WhatsApp resume respects a future original date and does not change an email future job', async t => {
  const at = dates(), f = await create(t, bundle(at.whatsapp, at.email));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  f.list.status = 'paused'; f.list.criteria.dispatch.status = 'paused';
  f.list.email_dispatch = { status: 'scheduled', job_id: 55, next_allowed_at: at.email };
  await bulk.resumeCampaignDispatch(scope, f.list.id, {}, 3);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].nextRunAt.toISOString(), at.whatsapp);
  assert.equal(f.list.email_dispatch.job_id, 55);
});

test('WhatsApp worker completion retains a future email job and campaign state', async t => {
  const at = dates(), f = await create(t, bundle(null, at.email));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  f.list.status = 'sending'; f.list.criteria.dispatch.status = 'queued';
  f.list.criteria.dispatch.time_mode = 'specific_time';
  f.list.email_dispatch = { status: 'scheduled', job_id: 55, next_allowed_at: at.email };
  f.setItems([]);
  const result = await bulk.runDispatchJob({ list_id: f.list.id, scope });
  assert.equal(result.result.completed, true);
  assert.equal(f.list.criteria.dispatch.status, 'completed');
  assert.equal(f.list.status, 'scheduled');
  assert.equal(f.list.email_dispatch.job_id, 55);
});

test('legacy campaign scheduling stays uniform and does not acquire a versioned bundle', async t => {
  const at = dates(), f = await create(t, null);
  await bulk.prepareCampaign(scope, f.list.id, { schedule_mode: 'scheduled', scheduled_at: at.whatsapp }, 3);
  await bulk.startCampaignDispatch(scope, f.list.id, {}, 3);
  assert.equal(f.list.criteria.channel_schedules, undefined);
  assert.equal(f.queued.length, 2);
  assert.ok(f.queued.every(job => job.nextRunAt.toISOString() === at.whatsapp));
});

test('explicit resume can release a past WhatsApp due date while preserving the future email job', async t => {
  const at = dates(), f = await create(t, bundle(new Date(Date.now() - 3600000).toISOString(), at.email));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  f.list.status = 'paused'; f.list.criteria.dispatch.status = 'paused';
  f.list.email_dispatch = { status: 'scheduled', job_id: 55, next_allowed_at: at.email };
  await bulk.resumeCampaignDispatch(scope, f.list.id, {}, 3);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].nextRunAt, null);
  assert.equal(f.list.email_dispatch.job_id, 55);
  assert.equal(f.list.email_dispatch.next_allowed_at, at.email);
});

test('managed-call mock keeps its legacy timing fields without acquiring an email/WhatsApp bundle', async t => {
  const at = dates(), f = await create(t, null, ['managed_calls']);
  await bulk.updateCampaign(scope, f.list.id, { schedule_mode: 'scheduled', scheduled_at: at.whatsapp }, 3);
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  assert.equal(f.list.criteria.scheduled_at, at.whatsapp);
  assert.equal(f.list.criteria.schedule_mode, 'scheduled');
  assert.equal(f.list.criteria.channel_schedules, undefined);
  assert.equal(f.queued.length, 0);
});

test('resuming future WhatsApp while email is already queued keeps the global campaign active', async t => {
  const at = dates(), f = await create(t, bundle(at.whatsapp, null));
  await bulk.prepareCampaign(scope, f.list.id, {}, 3);
  f.list.status = 'paused'; f.list.criteria.dispatch.status = 'paused';
  f.list.email_dispatch = { status: 'queued', job_id: 55 };
  await bulk.resumeCampaignDispatch(scope, f.list.id, {}, 3);
  assert.equal(f.list.criteria.dispatch.status, 'scheduled');
  assert.equal(f.list.criteria.dispatch.next_allowed_at, at.whatsapp);
  assert.equal(f.list.email_dispatch.job_id, 55);
  assert.equal(f.list.status, 'sending');
});

for (const scenario of [
  { name: 'WhatsApp already scheduled', whatsappStatus: 'scheduled', channels: ['whatsapp', 'email'], alreadyRunning: true },
  { name: 'WhatsApp completed', whatsappStatus: 'completed', channels: ['whatsapp', 'email'] },
  { name: 'email only', channels: ['email'] },
]) {
  test(`resuming paused email with ${scenario.name} exposes queued email as active`, async t => {
    const at = dates(), f = await create(t, bundle(at.whatsapp, null), scenario.channels);
    await bulk.prepareCampaign(scope, f.list.id, {}, 3);
    f.list.status = 'paused';
    if (scenario.whatsappStatus) {
      f.list.criteria.dispatch.status = scenario.whatsappStatus;
      f.list.criteria.dispatch.job_id = 66;
    }
    if (scenario.alreadyRunning) t.mock.method(db.JobRequest, 'findByPk', async id => ({ id, status: 'waiting' }));
    f.list.email_dispatch = { status: 'paused', job_id: 55 };
    const result = await bulk.resumeCampaignDispatch(scope, f.list.id, {}, 3);
    assert.equal(f.queued.length, 1);
    assert.equal(f.queued[0].type, email.JOB_TYPE);
    assert.equal(f.queued[0].nextRunAt, null);
    assert.equal(f.list.email_dispatch.status, 'queued');
    assert.equal(f.list.status, 'sending');
    if (scenario.alreadyRunning) assert.equal(result.already_running, true);
    if (scenario.whatsappStatus) assert.equal(f.list.criteria.dispatch.job_id, 66);
  });
}
