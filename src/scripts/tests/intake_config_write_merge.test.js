'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  mergeIntakeConfigForEditorWrite,
  overlayNormalizedGoogleAdsConfig,
} = require('../../lib/intake-config-write-merge');
const {
  normalizeGoogleAdsConfig,
  normalizeMetaAdsConfig,
} = require('../../services/effectiveMarketingAssets.service');

function currentConfig() {
  return {
    campaigns: { active_mode: 'connect_only', managed_by: 'server' },
    goal_policy: { version: 3, primary: 'qualified_lead' },
    future_server_block: { keep: true },
    meta_ads: {
      enabled: true,
      pixel_id: 'old-pixel',
      future_server_field: { keep: true },
    },
    features: {
      chat_enabled: true,
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
      ad_personalization_enabled: true,
      ad_personalization_consent_source: 'visitor_choice',
      ad_personalization_activation_audit: { reconciliation_key: 'audit-key' },
      google_ads_user_data_enabled: true,
      google_ads_user_data_disclosure_confirmed: true,
      google_ads_user_data_runtime_enabled: true,
    },
    google_ads: {
      enabled: true,
      customer_id: '1851215478',
      currency: 'EUR',
      goal_policy: {
        version: 4,
        owner: 'managed_campaign_runtime',
        cohort: 'qualified_lead',
      },
      user_data_enabled: true,
      enhanced_conversions: {
        enabled: true,
        activation_audit: { reconciliation_key: 'enhanced-key' },
      },
      future_server_field: { keep: true },
      events: {
        lead: {
          enabled: true,
          conversion_action_id: '1',
          currency: 'EUR',
          destinations: [{ customer_id: '1851215478', conversion_action_id: '1' }],
          user_data_enabled: true,
          value: 0,
          value_kind: 'campaign_optimization_reporting',
          value_is_revenue: false,
        },
        qualified_lead: {
          enabled: true,
          conversion_action_id: '3',
          user_data_enabled: true,
          value: 10,
        },
      },
    },
  };
}

function testEditorAllowlistPreservesLatestServerState() {
  const merged = mergeIntakeConfigForEditorWrite(currentConfig(), {
    config: {
      campaigns: { active_mode: 'stale-browser-value' },
      goal_policy: { version: 0 },
      future_server_block: { keep: false },
      meta_ads: {
        enabled: false,
        pixel_id: 'new-pixel',
        future_server_field: { keep: false },
      },
      features: {
        chat_enabled: false,
        consent_provider: 'external_cmp',
        ad_personalization_enabled: false,
        ad_personalization_consent_source: 'stale',
        ad_personalization_activation_audit: null,
        google_ads_user_data_enabled: false,
        google_ads_user_data_disclosure_confirmed: false,
        google_ads_user_data_runtime_enabled: false,
      },
      google_ads: {
        enabled: false,
        customer_id: '5992356722',
        user_data_enabled: false,
        enhanced_conversions: { enabled: false },
        future_server_field: { keep: false },
        events: {
          lead: {
            enabled: false,
            conversion_action_id: '22',
            currency: 'USD',
            destinations: [],
            user_data_enabled: false,
            value: 999,
            value_kind: 'client',
            value_is_revenue: true,
          },
          qualified_lead: {
            enabled: false,
            conversion_action_id: '999',
            user_data_enabled: false,
            value: 999,
          },
        },
      },
    },
  }, normalizeGoogleAdsConfig, normalizeMetaAdsConfig);

  assert.deepEqual(merged.campaigns, { active_mode: 'connect_only', managed_by: 'server' });
  assert.deepEqual(merged.goal_policy, { version: 3, primary: 'qualified_lead' });
  assert.deepEqual(merged.future_server_block, { keep: true });
  assert.equal(merged.meta_ads.enabled, false);
  assert.equal(merged.meta_ads.pixel_id, 'new-pixel');
  assert.deepEqual(merged.meta_ads.future_server_field, { keep: true });
  assert.equal(merged.features.chat_enabled, false);
  assert.equal(merged.features.consent_provider, 'external_cmp');
  assert.equal(merged.features.ad_personalization_enabled, true);
  assert.equal(merged.features.ad_personalization_consent_source, 'visitor_choice');
  assert.deepEqual(merged.features.ad_personalization_activation_audit, { reconciliation_key: 'audit-key' });
  assert.equal(merged.features.google_ads_user_data_enabled, true);
  assert.equal(merged.features.google_ads_user_data_disclosure_confirmed, true);
  assert.equal(merged.features.google_ads_user_data_runtime_enabled, true);

  assert.equal(merged.google_ads.enabled, false);
  assert.equal(merged.google_ads.customer_id, '5992356722');
  assert.equal(merged.google_ads.user_data_enabled, true);
  assert.equal(merged.google_ads.enhanced_conversions.enabled, true);
  assert.deepEqual(merged.google_ads.goal_policy, currentConfig().google_ads.goal_policy);
  assert.deepEqual(merged.google_ads.future_server_field, { keep: true });
  assert.equal(merged.google_ads.events.lead.enabled, false);
  assert.equal(merged.google_ads.events.lead.conversion_action_id, '22');
  assert.equal(merged.google_ads.events.lead.currency, 'USD');
  assert.equal(merged.google_ads.events.lead.user_data_enabled, true);
  assert.equal(merged.google_ads.events.lead.value, 0);
  assert.equal(merged.google_ads.events.lead.value_kind, 'campaign_optimization_reporting');
  assert.equal(merged.google_ads.events.lead.value_is_revenue, false);
  assert.deepEqual(merged.google_ads.events.lead.destinations, [
    { customer_id: '1851215478', conversion_action_id: '1' },
  ]);
  assert.deepEqual(merged.google_ads.events.qualified_lead, currentConfig().google_ads.events.qualified_lead);
}

function testBackendNormalizedOverlayPreservesUnknownFields() {
  const current = currentConfig().google_ads;
  const normalized = normalizeGoogleAdsConfig({
    enabled: true,
    customer_id: '5992356722',
    events: { lead: { enabled: true, conversion_action_id: '44', currency: 'EUR' } },
  });
  const merged = overlayNormalizedGoogleAdsConfig(current, normalized);
  assert.equal(merged.customer_id, '5992356722');
  assert.equal(merged.user_data_enabled, true);
  assert.deepEqual(merged.enhanced_conversions, current.enhanced_conversions);
  assert.deepEqual(merged.goal_policy, current.goal_policy);
  assert.equal(merged.events.lead.conversion_action_id, '44');
  assert.equal(merged.events.lead.user_data_enabled, true);
  assert.equal(merged.events.lead.value_kind, 'campaign_optimization_reporting');
}

function testWritersUseLockedLatestRowAndPublicConfigIsSanitized() {
  const intakeSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8',
  );
  const intakeStart = intakeSource.indexOf('exports.upsertIntakeConfig =');
  const intakeEnd = intakeSource.indexOf('// ======================================', intakeStart);
  const intakeUpsert = intakeSource.slice(intakeStart, intakeEnd);
  assert.match(intakeUpsert, /db\.sequelize\.transaction/);
  assert.match(intakeUpsert, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(intakeUpsert, /mergeIntakeConfigForEditorWrite/);
  assert.match(intakeUpsert, /\}, \{ transaction \}\)/);
  assert.match(intakeUpsert, /body\.mutation_kind === 'snippet_verification'/);
  assert.match(intakeUpsert, /body\.mutation_kind === 'domain_add'/);
  assert.match(intakeUpsert, /canonicalizeIntakeDomains\(\[\.\.\.existingDomains, domainToAdd\]\)/);
  assert.match(intakeUpsert, /partialMutation && !existing/);
  assert.match(intakeSource, /locationIds\.has\(parsedClinicId\)/);
  assert.match(intakeUpsert, /if \(partialMutation\) \{[\s\S]*scope = 'group';[\s\S]*groupId = sharedWebContext\.groupId;/);
  assert.match(intakeUpsert, /clinic_id: scope === 'clinic' \? \(clinicId \|\| null\) : null/);
  assert.match(intakeUpsert, /verificationOnlyMutation[\s\S]*existing\?\.domains/);
  assert.match(intakeUpsert, /verificationOnlyMutation[\s\S]*\{ \.\.\.existingConfig \}/);

  const campaignSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8',
  );
  const writerStart = campaignSource.indexOf('async function upsertIntakeGoogleAdsForScope');
  const writerEnd = campaignSource.indexOf('async function upsertIntakeMetaAdsForScope', writerStart);
  const writer = campaignSource.slice(writerStart, writerEnd);
  assert.match(writer, /db\.sequelize\.transaction/);
  assert.match(writer, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(writer, /overlayNormalizedGoogleAdsConfig/);
  const campaignSettingsStart = campaignSource.indexOf('async function upsertCampaignSettingsForScope');
  const campaignSettingsEnd = campaignSource.indexOf('async function listClinicIdsForGroup', campaignSettingsStart);
  const campaignSettingsWriter = campaignSource.slice(campaignSettingsStart, campaignSettingsEnd);
  assert.match(campaignSettingsWriter, /db\.sequelize\.transaction/);
  assert.match(campaignSettingsWriter, /lock: transaction\.LOCK\.UPDATE/);
  const metaWriterStart = campaignSource.indexOf('async function upsertIntakeMetaAdsForScope');
  const metaWriterEnd = campaignSource.indexOf('function extractSendToFromTagSnippets', metaWriterStart);
  const metaWriter = campaignSource.slice(metaWriterStart, metaWriterEnd);
  assert.match(metaWriter, /db\.sequelize\.transaction/);
  assert.match(metaWriter, /lock: transaction\.LOCK\.UPDATE/);

  assert.match(intakeSource, /payload\.config = includeAllLocations[\s\S]*snippet_verification: payload\.snippet_verification/);
  assert.match(intakeSource, /ad_personalization_activation_audit: _personalizationAudit/);
  assert.doesNotMatch(intakeSource, /payload\.config = cfg;/);
}

testEditorAllowlistPreservesLatestServerState();
testBackendNormalizedOverlayPreservesUnknownFields();
testWritersUseLockedLatestRowAndPublicConfigIsSanitized();
console.log('intake_config_write_merge.test.js: OK');
