'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settings } = require('../../lib/marketing-email-engagement');

const base = 'clinicaclick-marketing';
const tracked = 'clinicaclick-marketing-engagement';
const env = { EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET: tracked };
const cutoff = '2026-11-25T13:00:00Z';
const legacy = { id: 983, created_at: new Date('2026-11-25T11:00:00Z') };

test('engagement remains off until an explicit campaign scope is configured', () => {
  assert.equal(settings(base, {}, legacy), null);
  assert.equal(settings(base, env, legacy), null);
  assert.equal(settings(base, { ...env, EMAIL_MARKETING_ENGAGEMENT_PILOT_LIST_ID: '985' }), null);
});

test('pilot permits exactly one campaign and overrides a configured rollout cutoff', () => {
  const pilot = { ...env, EMAIL_MARKETING_ENGAGEMENT_PILOT_LIST_ID: '985',
    EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: cutoff };
  assert.equal(settings(base, pilot, { id: 985 }), tracked);
  assert.equal(settings(base, pilot, legacy), null);
  assert.equal(settings(base, pilot, { id: 986, created_at: new Date('2026-11-26T00:00:00Z') }), null);
});

test('invalid pilot cannot fall through to a wider rollout', () => {
  for (const id of ['0', '-1', '985,986', '985x', '0985', '9007199254740992']) {
    assert.equal(settings(base, { ...env, EMAIL_MARKETING_ENGAGEMENT_PILOT_LIST_ID: id,
      EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: cutoff }, { id: 985, created_at: new Date('2026-11-26T00:00:00Z') }), null);
  }
});

test('rollout excludes every preexisting campaign including remaining recipients of 983', () => {
  const rollout = { ...env, EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: cutoff };
  assert.equal(settings(base, rollout, legacy), null);
  assert.equal(settings(base, rollout, { id: 984, created_at: new Date('2026-11-25T12:59:59.999Z') }), null);
  assert.equal(settings(base, rollout, { id: 985, created_at: new Date(cutoff) }), tracked);
  assert.equal(settings(base, rollout, { id: 986, created_at: '2026-11-25T13:00:00.001Z' }), tracked);
});

test('rollout fails closed for missing or ambiguous creation timestamps', () => {
  const rollout = { ...env, EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: cutoff };
  for (const created_at of [undefined, null, 0, '', '2026-11-25 14:00:00', '2026-11-25T14:00:00+01:00',
    '2026-02-30T14:00:00Z', new Date(NaN)]) {
    assert.equal(settings(base, rollout, { id: 985, created_at }), null);
  }
});

test('rollout requires a real canonical UTC cutoff and a persistent positive campaign ID', () => {
  const list = { id: 985, created_at: new Date('2026-11-26T00:00:00Z') };
  for (const from of [undefined, '', 'now', '2026-11-25', '2026-11-25T13:00:00+00:00', '2026-02-30T13:00:00Z']) {
    assert.equal(settings(base, { ...env, EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: from }, list), null);
  }
  for (const id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(settings(base, { ...env, EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: cutoff }, { ...list, id }), null);
  }
  assert.equal(settings(base, { ...env, EMAIL_MARKETING_ENGAGEMENT_CAMPAIGNS_FROM: '2026-11-25T13:00:00.000Z' }, list), tracked);
});

test('scoping never bypasses configuration-set validation or changes campaign data', () => {
  const source = { id: 985, created_at: new Date(cutoff) };
  const list = Object.freeze({ ...source });
  const pilot = Object.freeze({ ...env, EMAIL_MARKETING_ENGAGEMENT_PILOT_LIST_ID: '985' });
  assert.equal(settings(base, pilot, list), tracked);
  assert.equal(settings(base, { ...pilot, EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET: base }, list), null);
  assert.equal(settings(base, { ...pilot, EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET: 'bad set' }, list), null);
  assert.deepEqual(list, source);
});
