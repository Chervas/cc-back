'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maybeUploadGoogleConversion } = require('../../services/googleAdsConversionUpload.service');
const { resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');

function fixture() {
  const account = { provider: 'google_ads', account_id: '123', include_future: false, campaign_ids: ['7'] };
  const setting = { id: 'setting-1', scope_type: 'clinic', scope_id: 1, version: 4, accounts: [account], activation: {
    schema_version: 1, mode: 'measurement', status: 'active', signals: { enabled: true, events: ['Lead'] }, account_authorizations: [account],
  } };
  const record = { id: 10, assignment_scope: 'clinic', clinic_id: 1, config: { features: { consent_mode_enabled: true },
    campaigns: { workspace_policy: { schema_version: 1, setting_id: setting.id, scope_type: 'clinic', scope_id: 1 } } } };
  const audits = []; const uploads = [];
  const dependencies = {
    auditModel: {
      findOne: async ({ where }) => audits.find(row => row.dedupeKey === where.dedupeKey),
      create: async values => { const row = { ...values, id: audits.length + 1, update: async patch => { Object.assign(row, patch); return row; } }; audits.push(row); return row; },
    },
    resolveWorkspaceSignalPolicy: input => resolveWorkspaceSignalPolicy({ ...input, loadSetting: async () => setting }),
    resolveRuntime: async () => ({ accessToken: 'test', connection: { id: 2 } }),
    uploadConversion: async payload => { uploads.push(payload); return { requestId: 'test-request' }; },
  };
  const input = { cfgRecord: record, googleAdsConfig: { enabled: true, customer_id: '123', events: { lead: { enabled: true, conversion_action_id: '900' } } },
    eventName: 'Lead', eventId: 'lead-1', customData: { gclid: 'test-click', campaign_id: '7' }, consent: { ad_user_data: 'granted' },
    clinicId: 1, assignmentScope: 'clinic', consentModeEnabled: true, dependencies };
  return { input, setting, record, audits, uploads };
}

test('Google upload applies the explicit workspace grant and audits its version', async () => {
  const f = fixture();
  const result = await maybeUploadGoogleConversion(f.input);
  assert.equal(result.sent, true); assert.equal(f.uploads.length, 1);
  assert.equal(f.audits[0].requestMetadata.workspace_policy_version, 4);
});
test('revoking signals prevents a subsequent Google upload and records the reason', async () => {
  const f = fixture(); f.setting.activation.signals.enabled = false;
  const result = await maybeUploadGoogleConversion(f.input);
  assert.equal(result.sent, false); assert.equal(f.uploads.length, 0);
  assert.equal(result.reason, 'workspace_signals_disabled'); assert.equal(f.audits[0].status, 'skipped');
});
test('an unapproved campaign cannot reuse a selected account conversion', async () => {
  const f = fixture(); f.input.customData.campaign_id = '8';
  const result = await maybeUploadGoogleConversion(f.input);
  assert.equal(result.reason, 'workspace_campaign_not_authorized'); assert.equal(f.uploads.length, 0);
});
test('workspace authorization never replaces visitor consent or existing conversion gates', async () => {
  const f = fixture(); f.input.consent.ad_user_data = 'denied';
  const result = await maybeUploadGoogleConversion(f.input);
  assert.equal(result.reason, 'consent_not_granted'); assert.equal(f.uploads.length, 0);
});
test('the advertiser policy record can differ from the website installation record', async () => {
  const f = fixture(); f.setting.activation.signals.enabled = false;
  const result = await maybeUploadGoogleConversion({ ...f.input, cfgRecord: { ...f.record, config: { features: { consent_mode_enabled: true } } }, signalPolicyRecord: f.record });
  assert.equal(result.reason, 'workspace_signals_disabled'); assert.equal(f.uploads.length, 0);
});
test('an inherited advertiser config cannot bypass the website scope CRM authorization', async () => {
  const f = fixture(); f.setting.activation.signals.enabled = false;
  const result = await maybeUploadGoogleConversion({ ...f.input, signalPolicyRecord: { config: { google_ads: f.input.googleAdsConfig } } });
  assert.equal(result.reason, 'workspace_signals_disabled'); assert.equal(f.uploads.length, 0);
});
test('public event fields cannot forge a CRM appointment, but the lifecycle can upload it', async () => {
  const f = fixture();
  f.setting.activation.signals.events.push('Schedule');
  f.input.eventName = 'Schedule';
  f.input.googleAdsConfig.events = { schedule: { enabled: true, conversion_action_id: '901' } };
  f.input.customData.crmEventSource = 'campaign_crm_milestone';
  let result = await maybeUploadGoogleConversion(f.input);
  assert.equal(result.reason, 'workspace_crm_milestone_required'); assert.equal(f.uploads.length, 0);
  result = await maybeUploadGoogleConversion({ ...f.input, eventId: 'appointment-1', crmEventSource: CRM_MILESTONE_SOURCE });
  assert.equal(result.sent, true); assert.equal(f.uploads.length, 1);
});
