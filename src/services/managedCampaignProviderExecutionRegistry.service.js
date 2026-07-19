'use strict';

const googleSearch = require('./managedCampaignGoogleSearchExecutionAdapter.service');

const EXECUTION_REGISTRY_SCHEMA_VERSION = 'managed-provider-execution-registry/v1';
const registry = new Map([
  ['google_ads:google_search:create_new', googleSearch],
]);

function key(provider, family, operation) {
  return [provider, family, operation].map((value) => String(value || '').trim().toLowerCase()).join(':');
}

function getManagedCampaignExecutionAdapter(provider, family, operation) {
  return registry.get(key(provider, family, operation)) || null;
}

function hasManagedCampaignExecutionAdapter(provider, family, operation = 'create_new') {
  return registry.has(key(provider, family, operation));
}

/**
 * Managed provider execution is an exclusive lifecycle lane. Once a campaign
 * is configured as Piloto/autopilot and has a real create adapter, generic
 * status transitions must not be able to impersonate provider creation or
 * activation, even before the first execution row has been persisted.
 */
function requiresManagedCampaignProviderExecutionPath(campaign) {
  return campaign?.management_mode === 'autopilot'
    && campaign?.operation_mode === 'managed'
    && hasManagedCampaignExecutionAdapter(campaign?.provider, campaign?.family, 'create_new');
}

function executionCapability(provider, family, operation = 'create_new') {
  const adapter = getManagedCampaignExecutionAdapter(provider, family, operation);
  return {
    schema_version: EXECUTION_REGISTRY_SCHEMA_VERSION,
    registered: Boolean(adapter),
    provider: String(provider || '').trim().toLowerCase() || null,
    family: String(family || '').trim().toLowerCase() || null,
    operation: String(operation || '').trim().toLowerCase() || null,
    adapter_version: adapter?.ADAPTER_VERSION || null,
    safety: adapter
      ? {
          create_only: true,
          initial_campaign_status: 'PAUSED',
          update_existing: false,
          activation_supported: true,
          activation_requires_separate_job: true,
          targeting_materialized: true,
          schedule_materialized: true,
          customer_currency_and_time_zone_readback: true,
          optimization_goal_required: 'qualified_lead',
          optimization_goal_verified_before_activation: true,
        }
      : {
          create_only: false,
          initial_campaign_status: null,
          update_existing: false,
          activation_supported: false,
          activation_requires_separate_job: false,
          targeting_materialized: false,
          schedule_materialized: false,
          customer_currency_and_time_zone_readback: false,
          optimization_goal_required: null,
          optimization_goal_verified_before_activation: false,
        },
  };
}

module.exports = {
  EXECUTION_REGISTRY_SCHEMA_VERSION,
  executionCapability,
  getManagedCampaignExecutionAdapter,
  hasManagedCampaignExecutionAdapter,
  requiresManagedCampaignProviderExecutionPath,
};
