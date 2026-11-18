'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../lib/marketing-channel-schedules');
const at = '2026-11-18T12:00:00.000Z';
const later = '2026-11-19T09:00:00.000Z';
const latest = '2026-11-20T11:00:00.000Z';
const both = ['whatsapp', 'email'];
const bundle = () => ({ version: 1, timezone: 'Europe/Madrid', channels: {
  whatsapp: { mode: 'scheduled', scheduled_at: latest }, email: { mode: 'scheduled', scheduled_at: later },
} });
test('independent due dates survive persistence without bringing WhatsApp forward', () => {
  const raw = bundle(), copy = structuredClone(raw);
  const criteria = C.persistScheduleCriteria({}, { channel_schedules: raw }, both, { requireFuture: true, now: Date.parse(at) });
  assert.equal(criteria.scheduled_at, latest);
  assert.equal(C.scheduledAtFor(criteria.channel_schedules, 'email'), later);
  assert.deepEqual(C.resolveSchedules(criteria, {}, both), copy);
  assert.deepEqual(raw, copy);
});
test('legacy drafts retain common timing and do not acquire a new contract implicitly', () => {
  const legacy = { schedule_mode: 'scheduled', scheduled_at: later };
  const resolved = C.resolveSchedules(legacy, {}, both);
  assert.equal(C.scheduledAtFor(resolved, 'email'), later);
  assert.equal(C.scheduledAtFor(resolved, 'whatsapp'), later);
  assert.deepEqual(C.persistScheduleCriteria(legacy, {}, both), {});
});
test('both channels validate before any scheduling caller can use their dates', () => {
  const raw = bundle(); raw.channels.whatsapp.scheduled_at = '2026-11-17T12:00:00Z';
  assert.throws(() => C.resolveSchedules({}, { channel_schedules: raw }, both,
    { requireFuture: true, now: Date.parse(at) }), { code: 'channel_schedule_expired' });
  assert.doesNotThrow(() => C.resolveSchedules({}, { channel_schedules: raw }, both));
});
test('malformed dates, unknown versions/timezones and absent selected-channel entries are rejected', () => {
  for (const change of [b => b.version = 2, b => b.timezone = 'UTC', b => delete b.channels.email,
    b => b.channels.email.scheduled_at = '19/11/2026 10:00', b => b.channels.email.scheduled_at = '2027-02-30T10:00:00Z',
    b => b.channels.email.scheduled_at = '2027-01-20T24:00:00Z', b => b.channels.email.mode = 'eventually']) {
    const b = bundle(); change(b); assert.throws(() => C.normalizeBundle(b, both), { code: 'channel_schedule_invalid' });
  }
});
test('a legacy client cannot silently overwrite independent dates', () => {
  const criteria = { ...C.legacyProjection(bundle()), channel_schedules: bundle() };
  assert.throws(() => C.resolveSchedules(criteria, { schedule_mode: 'now', scheduled_at: null }, both),
    { code: 'channel_schedule_version_conflict' });
  assert.deepEqual(C.resolveSchedules(criteria, { scheduled_at: latest }, both), bundle());
});
test('saving settings does not reschedule jobs that already exist', () => {
  const criteria = { channel_schedules: bundle(), dispatch: { job_id: 41, cursor: 3 } };
  const changed = bundle(); changed.channels.email.scheduled_at = latest;
  assert.throws(() => C.persistScheduleCriteria(criteria, { channel_schedules: changed }, both,
    { list: { criteria, email_dispatch: { job_id: 42 } } }), { code: 'channel_schedule_already_queued' });
  const patch = C.persistScheduleCriteria(criteria, { channel_schedules: bundle() }, both, { list: { criteria } });
  assert.equal(criteria.dispatch.cursor, 3);
  assert.equal(patch.dispatch, undefined);
});
test('explicit resume preserves a future date but does not replay the old due date', () => {
  assert.equal(C.scheduledAtFor(bundle(), 'email', { resume: true, now: Date.parse(at) }), later);
  assert.equal(C.scheduledAtFor(bundle(), 'email', { resume: true, now: Date.parse(latest) }), null);
});
test('finishing either channel preserves the other future or paused channel', () => {
  const list = { status: 'sending', criteria: { channels: both, channel_schedules: bundle(), dispatch: { status: 'scheduled' } }, email_dispatch: { status: 'sending' } };
  assert.equal(C.campaignStatus(list, { email: 'completed' }), 'scheduled');
  assert.equal(C.campaignStatus(list, { whatsapp: 'completed' }), 'sending');
  assert.equal(C.campaignStatus(list, { whatsapp: 'completed', email: 'paused' }), 'paused');
  assert.equal(C.campaignStatus(list, { whatsapp: 'completed', email: 'completed' }), 'completed');
  list.status = 'archived';
  assert.equal(C.campaignStatus(list, { whatsapp: 'completed', email: 'completed' }, 'completed'), 'archived');
  list.status = 'sending';
  delete list.criteria.channel_schedules;
  assert.equal(C.campaignStatus(list, { email: 'completed' }, 'legacy'), 'legacy');
});
