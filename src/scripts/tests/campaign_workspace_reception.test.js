'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { destinationKey, loadFormReceiptEvidence, combineReceptionEvidence } = require('../../services/campaignWorkspaceReception.service');
const now = new Date('2026-09-10T10:00:00Z');
const campaign = { id: 'g:1:2', assigned: true, clinicId: 1, destination: 'web', urls: ['https://clinic.example/landing'] };
const event = { clinic_id: 1, 'leadIntake.clinica_id': 1, page_url: campaign.urls[0], created_at: now };
async function load(rows, campaigns = [campaign], inspect = () => {}) {
  return loadFormReceiptEvidence({ models: { LeadIntake: {}, FormSubmissionEvent: { findAll: async options => { inspect(options); return rows; } } }, campaigns, now });
}

test('destination matching ignores advertising parameters, not functional page parameters', () => {
  assert.equal(destinationKey('https://www.clinic.example/landing/?utm_campaign=a&gclid=b#form'), destinationKey(campaign.urls[0]));
  assert.notEqual(destinationKey('https://clinic.example/landing?service=1'), destinationKey('https://clinic.example/landing?service=2'));
  assert.notEqual(destinationKey('https://clinic.example/landing'), destinationKey('http://clinic.example/landing'));
  assert.equal(destinationKey('javascript:alert(1)'), null);
});
test('receipt query is scoped, bounded and projects no patient data', async () => {
  const result = await load([event], [campaign], options => {
    assert.deepEqual(options.where.clinic_id[Op.in], [1]);
    assert.equal(options.where.created_at[Op.gte].toISOString(), '2026-09-03T10:00:00.000Z');
    assert.deepEqual(options.attributes, ['clinic_id', 'page_url', 'created_at']);
    assert.equal(options.include[0].required, true);
    assert.deepEqual(options.include[0].attributes, ['clinica_id']);
  });
  assert.equal(result.get(campaign.id).ready, true);
  assert.equal(JSON.stringify([...result]).includes('clinic.example'), false);
});
test('another clinic, another page or a cross-clinic lead cannot verify this destination', async () => {
  for (const row of [{ ...event, clinic_id: 2, 'leadIntake.clinica_id': 2 }, { ...event, page_url: 'https://clinic.example/contact' },
    { ...event, 'leadIntake.clinica_id': 2 }]) assert.equal((await load([row])).get(campaign.id).checked, false);
});
test('all advertised destinations need their own receipt; no event is not a proven failure', async () => {
  const result = await load([event], [{ ...campaign, urls: [...campaign.urls, 'https://clinic.example/second'] }]);
  assert.equal(result.get(campaign.id).checked, false);
  assert.equal((await load([])).get(campaign.id).checked, false);
});
test('old and future events are not current evidence; freshness uses server receipt time', async () => {
  for (const date of ['2026-08-01', '2026-09-11', 'invalid']) {
    assert.equal((await load([{ ...event, created_at: date }])).get(campaign.id).ready, false);
  }
});
test('native forms and unassigned shared campaigns never use web reception evidence', async () => {
  const result = await load([], [{ ...campaign, destination: 'native' }, { ...campaign, assigned: false }], () => assert.fail('must not query'));
  assert.equal(result.size, 0);
});
test('mixed campaigns retain web proof and require both reception channels, without inventing a failure for missing receipts', async () => {
  assert.equal((await load([event], [{ ...campaign, destination: 'mixed' }])).get(campaign.id).ready, true);
  const verified = { checked: true, ready: true, configured: true, state: 'verified' };
  const pending = { checked: true, ready: false, configured: true, state: 'pending_confirmation' };
  assert.equal(combineReceptionEvidence([verified, verified]).ready, true);
  assert.equal(combineReceptionEvidence([verified, pending]).state, 'pending_confirmation');
  assert.equal(combineReceptionEvidence([verified, undefined]).ready, false);
  assert.equal(combineReceptionEvidence([pending, { checked: true, ready: false, state: 'action_required' }]).state, 'action_required');
});
