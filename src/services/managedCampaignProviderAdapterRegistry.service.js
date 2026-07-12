'use strict';

const crypto = require('node:crypto');
const {
  buildGoogleAdsDryRunAdapter,
  canonicalStringify,
} = require('./managedCampaignGoogleAdsDryRunAdapter.service');
const {
  buildMetaAdsDryRunAdapter,
} = require('./managedCampaignMetaAdsDryRunAdapter.service');

const REGISTRY_SCHEMA_VERSION = 'managed-provider-dry-run-adapter-registry/v1';
const registry = new Map([
  ['google_ads:google_search', buildGoogleAdsDryRunAdapter],
  ['google_ads:google_pmax', buildGoogleAdsDryRunAdapter],
  ['meta_ads:meta_reach', buildMetaAdsDryRunAdapter],
  ['meta_ads:meta_instant_form', buildMetaAdsDryRunAdapter],
]);

function clean(value, max = 128) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const result = String(value).trim();
  return result ? result.slice(0, max) : null;
}

function unsupportedManifest(provider, family) {
  const manifest = {
    schema_version: REGISTRY_SCHEMA_VERSION,
    adapter_version: null,
    provider,
    family,
    mode: 'dry_run',
    dry_run_adapter_available: false,
    execution_adapter_available: false,
    provider_call_performed: false,
    network_calls_performed: 0,
    readiness: {
      ready: false,
      blockers: [{
        code: 'dry_run_adapter_unavailable',
        field: 'provider',
        message: 'Este proveedor o familia todavía no tiene adaptador dry-run explícito.',
      }],
      warnings: [],
    },
    operations: [],
    safety: {
      requires_future_explicit_execution_authorization: true,
    },
  };
  return {
    ...manifest,
    manifest_hash: crypto.createHash('sha256').update(canonicalStringify(manifest)).digest('hex'),
  };
}

function buildManagedCampaignDryRunAdapter({ provider, family, specification } = {}) {
  const normalizedProvider = clean(provider, 32);
  const normalizedFamily = clean(family, 64);
  const builder = registry.get(`${normalizedProvider}:${normalizedFamily}`);
  if (!builder) return unsupportedManifest(normalizedProvider, normalizedFamily);
  return builder({ family: normalizedFamily, specification });
}

function hasManagedCampaignDryRunAdapter(provider, family) {
  return registry.has(`${clean(provider, 32)}:${clean(family, 64)}`);
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  buildManagedCampaignDryRunAdapter,
  hasManagedCampaignDryRunAdapter,
};
