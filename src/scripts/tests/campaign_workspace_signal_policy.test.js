'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspaceSignalDecision, resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');
const account = { provider: 'google_ads', account_id: '123', include_future: false, campaign_ids: ['7'] };
const setting = () => ({ id: 'setting-1', scope_type: 'clinic', scope_id: 1, version: 3, accounts: [account], activation: {
  schema_version: 1, mode: 'measurement', status: 'active', signals: { enabled: true, events: ['Lead', 'Contact', 'Schedule'] },
  account_authorizations: [account],
} });
const decide = (row, extra = {}) => workspaceSignalDecision({ setting: row, provider: 'google_ads', accountId: '123', campaignId: '7', eventName: 'Lead', ...extra });
const record = { assignment_scope: 'clinic', clinic_id: 1, config: { campaigns: { workspace_policy: {
  schema_version: 1, setting_id: 'setting-1', scope_type: 'clinic', scope_id: 1,
} } } };

test('measurement authorizes selected CRM events without requiring optimize', () => {
  assert.equal(decide(setting()).allowed, true);
  assert.equal(decide(setting(), { eventName: 'Schedule', crmEventSource: CRM_MILESTONE_SOURCE }).allowed, true);
  assert.equal(decide(setting(), { eventName: 'Purchase' }).reason, 'workspace_event_not_authorized');
});
test('web payloads cannot declare an authorized CRM milestone', () => {
  for (const eventName of ['QualifiedLead', 'Schedule', 'Purchase']) {
    const row = setting(); row.activation.signals.events.push(eventName);
    for (const crmEventSource of [null, 'campaign_crm_milestone', true, { trusted: true }]) {
      assert.equal(decide(row, { eventName, crmEventSource }).reason, 'workspace_crm_milestone_required');
    }
    assert.equal(decide(row, { eventName, crmEventSource: CRM_MILESTONE_SOURCE }).allowed, true);
  }
});
test('signals disabled, paused or malformed activations fail closed', () => {
  const row = setting(); row.activation.signals.enabled = false;
  assert.equal(decide(row).reason, 'workspace_signals_disabled');
  row.activation.status = 'paused'; assert.equal(decide(row).reason, 'workspace_activation_inactive');
  row.activation.schema_version = 99; assert.equal(decide(row).reason, 'workspace_activation_invalid');
  row.activation = null; assert.equal(decide(row).allowed, false);
});
test('adding an account to the report does not extend the activation grant', () => {
  const row = setting(); row.accounts.push({ ...account, account_id: '456', include_future: true });
  assert.equal(decide(row, { accountId: '456' }).reason, 'workspace_account_not_authorized');
});
test('future import is operationally authorized only when selected and approved', () => {
  const row = setting(); row.accounts = [{ ...account, include_future: true }];
  assert.equal(decide(row, { campaignId: '8' }).allowed, false);
  row.activation.account_authorizations = [{ ...account, include_future: true }];
  assert.equal(decide(row, { campaignId: '8' }).allowed, true);
  row.accounts = [account]; assert.equal(decide(row, { campaignId: '8' }).allowed, false);
});
test('unknown campaigns cannot bypass a restricted campaign list', () => {
  assert.equal(decide(setting(), { campaignId: null }).allowed, false);
  assert.equal(decide(setting(), { campaignId: '999' }).allowed, false);
});
test('provider/account identity is exact, including Meta act_ normalization', () => {
  assert.equal(decide(setting(), { provider: 'meta_ads' }).allowed, false);
  const row = setting(); row.accounts = [{ ...account, provider: 'meta_ads' }]; row.activation.account_authorizations = row.accounts;
  assert.equal(decide(row, { provider: 'meta_ads', accountId: 'act_123' }).allowed, true);
  assert.equal(decide(row, { provider: 'meta_ads', accountId: '123junk' }).allowed, false);
});
test('existing configurations keep their existing gates without an implicit migration', async () => {
  const result = await resolveWorkspaceSignalPolicy({ records: [{ config: {} }], eventName: 'Lead', loadSetting: () => assert.fail('no database call') });
  assert.equal(result.applicable, false);
});
test('web visit tracking is independent of the CRM milestone authorization', async () => {
  const result = await resolveWorkspaceSignalPolicy({ records: [record], eventName: 'ViewContent', loadSetting: () => assert.fail('no database call') });
  assert.equal(result.applicable, false);
});
test('policy references cannot borrow a grant from another clinic or group', async () => {
  const result = await resolveWorkspaceSignalPolicy({ records: [record], provider: 'google_ads', accountId: '123', campaignId: '7', eventName: 'Lead',
    loadSetting: async () => ({ ...setting(), scope_id: 2 }) });
  assert.equal(result.reason, 'workspace_policy_scope_mismatch');
});
test('missing or malformed references are not treated as old unconfigured workspaces', async () => {
  const malformed = { ...record, config: { campaigns: { workspace_policy: null } } };
  assert.equal((await resolveWorkspaceSignalPolicy({ records: [malformed], eventName: 'Lead' })).reason, 'workspace_policy_reference_invalid');
  assert.equal((await resolveWorkspaceSignalPolicy({ records: [record], eventName: 'Lead', loadSetting: async () => null })).reason, 'workspace_policy_scope_mismatch');
});
test('revocation is read on every request, not cached for a browser or job session', async () => {
  const row = setting(); let reads = 0;
  const input = { records: [record], provider: 'google_ads', accountId: '123', campaignId: '7', eventName: 'Lead', loadSetting: async () => { reads++; return row; } };
  assert.equal((await resolveWorkspaceSignalPolicy(input)).allowed, true);
  row.activation.signals.enabled = false;
  assert.equal((await resolveWorkspaceSignalPolicy(input)).allowed, false); assert.equal(reads, 2);
});
test('every authorizing scope retains its own revision, even when the last scope is unchanged', async () => {
  const clinic = setting();
  const group = { ...setting(), id: 'setting-group', scope_type: 'group', scope_id: 8, version: 10 };
  const groupRecord = { assignment_scope: 'group', group_id: 8, config: { campaigns: { workspace_policy: {
    schema_version: 1, setting_id: group.id, scope_type: 'group', scope_id: 8,
  } } } };
  const input = { records: [record, groupRecord, groupRecord], provider: 'google_ads', accountId: '123', campaignId: '7', eventName: 'Lead',
    loadSetting: async id => id === clinic.id ? clinic : group };
  const before = await resolveWorkspaceSignalPolicy(input); assert.equal(before.policyRefs.length, 2);
  clinic.version++;
  const after = await resolveWorkspaceSignalPolicy(input); assert.equal(after.version, before.version);
  assert.notDeepEqual(after.policyRefs, before.policyRefs);
  clinic.version = NaN; assert.equal((await resolveWorkspaceSignalPolicy(input)).reason, 'workspace_policy_version_invalid');
});
