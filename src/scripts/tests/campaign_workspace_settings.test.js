'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settingScope, validateAccountSelection, saveWorkspaceAccounts, campaignIncluded } = require('../../services/campaignWorkspaceSettings.service');

const scope = { clinicIds: [1], groupId: null };
const account = { provider: 'google_ads', account_id: '1234', include_future: true, campaign_ids: ['42'] };
const campaign = { provider: 'google_ads', account_id: '1234', campaign_id: '42' };
const inventory = { google: [{ customerId: '1234' }], meta: [], campaigns: [campaign] };
const input = { expected_version: 0, accounts: [account] };

test('settings need a single clinic or a whole group, never an ambiguous aggregate', () => {
  assert.deepEqual(settingScope(scope), { scope_type: 'clinic', scope_id: 1 });
  assert.deepEqual(settingScope({ clinicIds: [1, 2], groupId: 5 }), { scope_type: 'group', scope_id: 5 });
  assert.throws(() => settingScope({ clinicIds: [1, 2] }), /single_workspace_scope_required/);
});
test('account selection rejects mutation grants and any unrecognized fields', () => {
  assert.throws(() => validateAccountSelection({ ...input, activate: true }, inventory), /invalid_workspace_settings/);
  assert.throws(() => validateAccountSelection({ ...input, accounts: [{ ...account, signals: true }] }, inventory), /invalid_workspace_settings/);
});
test('selection requires a mapped account and campaign in scope', () => {
  assert.throws(() => validateAccountSelection(input, { ...inventory, google: [] }), /workspace_account_not_mapped/);
  assert.throws(() => validateAccountSelection(input, { ...inventory, campaigns: [] }), /workspace_campaign_not_in_scope/);
});
test('duplicate and malformed identifiers cannot bypass account scope checks', () => {
  assert.throws(() => validateAccountSelection({ ...input, accounts: [account, account] }, inventory), /duplicate_workspace_account/);
  assert.throws(() => validateAccountSelection({ ...input, accounts: [{ ...account, account_id: '1234x' }] }, inventory), /invalid_workspace_settings/);
});
test('including future campaigns is an explicit saved preference', () => {
  const next = { ...campaign, campaign_id: '99' };
  assert.equal(campaignIncluded(next, { accounts: [account] }), true);
  assert.equal(campaignIncluded(next, { accounts: [{ ...account, include_future: false }] }), false);
  assert.equal(campaignIncluded(campaign, { accounts: [{ ...account, include_future: false }] }), true);
  assert.equal(campaignIncluded({ ...next, account_id: '999' }, { accounts: [account] }), false);
});

function harness(current = null) {
  const calls = [];
  const rows = { setting: current };
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async (id, options) => { calls.push(['lock', id, options.lock]); return { id_clinica: id }; } },
    CampaignWorkspaceSetting: {
      findOne: async () => current,
      create: async value => { rows.setting = value; calls.push(['create', value]); return value; },
    },
    CampaignWorkspaceEvent: { create: async value => { calls.push(['audit', value]); return value; } },
  };
  return { models, calls, rows, save: value => saveWorkspaceAccounts({ models, scope, actorId: 7, input: value || input,
    loadInventory: async () => { calls.push(['inventory']); return inventory; }, now: () => new Date('2026-09-10T10:00:00Z') }) };
}
test('first save locks the owner, creates settings and records the exact consented selection atomically', async () => {
  const h = harness(); const result = await h.save();
  assert.equal(result.configuration.version, 1); assert.equal(result.configuration.activation, null);
  assert.equal(result.changed, true); assert.deepEqual(h.calls[0], ['lock', 1, 'UPDATE']);
  const audit = h.calls.find(([kind]) => kind === 'audit')[1];
  assert.equal(audit.event_type, 'accounts_selected'); assert.equal(audit.actor_user_id, 7);
  assert.deepEqual(audit.changes.accounts.after, [account]);
});
test('stale versions fail before reading inventory or writing settings', async () => {
  const h = harness({ id: '1', version: 3, accounts: [account] });
  await assert.rejects(h.save(), /workspace_version_conflict/);
  assert.equal(h.calls.length, 1);
});
test('saving an unchanged selection is idempotent and does not create audit noise', async () => {
  const h = harness({ id: '1', version: 3, accounts: [account] });
  const result = await h.save({ ...input, expected_version: 3 });
  assert.equal(result.changed, false); assert.equal(result.configuration.version, 3);
  assert.equal(h.calls.some(([kind]) => kind === 'create' || kind === 'audit'), false);
});
test('no selected accounts excludes campaigns without changing provider configurations', () => {
  assert.equal(campaignIncluded(campaign, { accounts: [] }), false);
});
test('changing the saved selection invalidates technical conversion evidence', async () => {
  const current = { id: '1', version: 3, accounts: [account], signal_preparation: { google_ads: {} },
    async update(values) { Object.assign(this, values); return this; } };
  const h = harness(current); await h.save({ expected_version: 3, accounts: [{ ...account, include_future: false }] });
  assert.equal(current.signal_preparation, null);
});
