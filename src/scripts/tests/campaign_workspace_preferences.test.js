'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260910170000-add-campaign-workspace-preferences');
const { preferenceDraft, saveWorkspacePreferences } = require('../../services/campaignWorkspacePreferences.service');
const { workspaceSignalDecision, CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');

const input = () => ({ expected_version: 1, preferences: { mode: 'measurement', signals: { enabled: true, events: ['qualified_lead', 'schedule'] }, optimization: null } });
function harness() {
  const accounts = [{ provider: 'google_ads', account_id: '20', include_future: true, campaign_ids: [] }];
  const state = { row: { id: 'settings', version: 1, accounts, preferences: null,
    activation: { schema_version: 1, mode: 'measurement', status: 'active', signals: { enabled: true, events: ['qualified_lead'] }, account_authorizations: accounts } },
  writes: [], audits: [], members: [{ id_clinica: 1 }], mapped: true };
  state.row.update = async values => { state.writes.push(values); Object.assign(state.row, values); return state.row; };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { Clinica: { findByPk: async () => ({ id_clinica: 1 }), findAll: async () => state.members },
    GrupoClinica: { findByPk: async () => ({ id: 1 }) }, CampaignWorkspaceSetting: { findOne: async () => state.row },
    CampaignWorkspaceEvent: { create: async (values, options) => { assert.equal(options.transaction, transaction); state.audits.push(values); } },
    sequelize: { transaction: async fn => fn(transaction) } };
  const loadInventory = async () => ({ google: state.mapped ? [{ customerId: '20' }] : [], meta: [], campaigns: [] });
  return { state, models, run: (body = input(), scope = { clinicIds: [1] }) => saveWorkspacePreferences({ models, scope, actorId: 7, input: body, loadInventory }) };
}
test('only known modes, CRM events and bounded optimization preferences enter a draft', () => {
  assert.equal(preferenceDraft(input()).schema_version, 1);
  for (const patch of [{ mode: 'managed' }, { signals: { enabled: true, events: [] } },
    { signals: { enabled: false, events: ['lead'] } }, { signals: { enabled: true, events: ['purchase'] } },
    { activation: { status: 'active' } }, { mode: 'optimize', optimization: null }]) {
    assert.throws(() => preferenceDraft({ ...input(), preferences: { ...input().preferences, ...patch } }), /invalid_workspace_preferences/);
  }
  assert.throws(() => preferenceDraft({ ...input(), scope: '99' }), /invalid_workspace_preferences/);
  const optimize = { mode: 'optimize', signals: { enabled: false, events: [] }, optimization: {
    actions: ['pause_underperforming_ads'], budget_changes: true, monthly_limit_cents: 10000,
  } };
  assert.equal(preferenceDraft({ ...input(), preferences: optimize }).optimization.max_budget_change_pct, 10);
  for (const monthly_limit_cents of [null, 9999, 5000001, 10000.5]) {
    assert.throws(() => preferenceDraft({ ...input(), preferences: { ...optimize, optimization: { ...optimize.optimization, monthly_limit_cents } } }), /invalid_workspace_preferences/);
  }
});
test('saving changes only the draft, version and authenticated audit, never live activation or senders', async () => {
  const h = harness(); const activation = structuredClone(h.state.row.activation);
  const result = await h.run();
  assert.equal(result.configuration.preferences.mode, 'measurement'); assert.equal(result.configuration.version, 2);
  assert.deepEqual(h.state.row.activation, activation);
  assert.deepEqual(Object.keys(h.state.writes[0]).sort(), ['preferences', 'signal_preparation', 'updated_by_user_id', 'version']);
  assert.equal(h.state.row.signal_preparation, null);
  assert.equal(h.state.audits[0].actor_user_id, 7); assert.equal(h.state.audits[0].event_type, 'preferences_saved');
  assert.equal(workspaceSignalDecision({ setting: h.state.row, provider: 'google_ads', accountId: '20', campaignId: '30',
    eventName: 'QualifiedLead', crmEventSource: CRM_MILESTONE_SOURCE }).allowed, true);
});
test('selecting signals in a draft cannot authorize their delivery', async () => {
  const h = harness(); h.state.row.activation.signals.enabled = false;
  await h.run();
  assert.equal(workspaceSignalDecision({ setting: h.state.row, provider: 'google_ads', accountId: '20', campaignId: '30',
    eventName: 'QualifiedLead', crmEventSource: CRM_MILESTONE_SOURCE }).allowed, false);
});
test('identical preferences are idempotent, and stale versions or revoked accounts cannot overwrite them', async () => {
  const h = harness(); await h.run();
  const again = await h.run({ ...input(), expected_version: 2 }); assert.equal(again.changed, false); assert.equal(h.state.writes.length, 1);
  await assert.rejects(h.run(), /workspace_version_conflict/);
  h.state.mapped = false;
  await assert.rejects(h.run({ ...input(), expected_version: 2 }), /workspace_account_not_mapped/);
});
test('new group members require fresh scope authorization before saving', async () => {
  const h = harness(); h.state.members.push({ id_clinica: 2 });
  await assert.rejects(h.run(input(), { groupId: 1, clinicIds: [1] }), /workspace_scope_changed/);
  assert.equal(h.state.writes.length, 0);
});
test('Google-only actions are rejected for Meta-only selections before writing a draft', async () => {
  const h = harness(); h.state.row.accounts = [{ provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] }];
  const body = { ...input(), preferences: { ...input().preferences, mode: 'optimize', optimization: {
    actions: ['negative_keywords'], budget_changes: false, monthly_limit_cents: null,
  } } };
  await assert.rejects(saveWorkspacePreferences({ models: h.models, scope: { clinicIds: [1] }, actorId: 7, input: body,
    loadInventory: async () => ({ google: [], meta: [{ metaAssetId: '20' }], campaigns: [] }) }), /workspace_google_account_required/);
  assert.equal(h.state.writes.length, 0);
});
test('the schema change is additive, idempotent and refuses incompatible or populated rollback', async () => {
  const columns = {}; const calls = [];
  const qi = { describeTable: async () => columns, addColumn: async (table, key, column) => {
    calls.push([table, key]); columns[key] = { type: 'JSON', allowNull: column.allowNull };
  }, sequelize: { query: async () => [[{ count: 1 }]] }, removeColumn: async () => assert.fail('cannot lose drafts') };
  await migration.up(qi, Sequelize); await migration.up(qi, Sequelize); assert.equal(calls.length, 1);
  await assert.rejects(migration.down(qi), /explicit archival/);
  columns.preferences.type = 'TEXT'; await assert.rejects(migration.up(qi, Sequelize), /incompatible column/);
});
