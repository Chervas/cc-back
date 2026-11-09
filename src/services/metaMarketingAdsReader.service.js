'use strict';
// Typed, metadata-authorized Ads reads. Credentials remain in the broker.
const { randomUUID } = require('node:crypto');
const A = require('../../services/integrations-broker/src/meta-marketing-ads-contract');
const { createConfiguredMetaMarketingClient, forModels: metadataForModels } = require('./metaMarketingBrokerReader.service');
const SAFE = new Set(['broker_cohort_disabled', 'meta_ads_sync_disabled', 'meta_broker_binding_invalid',
  'meta_broker_scope_changed', 'meta_broker_not_active', 'broker_response_invalid', 'broker_configuration_invalid',
  'broker_timeout', 'broker_unavailable', 'connection_blocked', 'asset_revoked', 'scope_denied', 'operation_denied',
  'invalid_request', 'secret_unavailable', 'secret_version_changed', 'credential_revoked', 'provider_failed', 'provider_timeout',
  'provider_unauthorized', 'rate_limited', 'audit_unavailable', 'meta_ads_sync_failed', 'meta_ads_persistence_failed', 'meta_credential_renewal_required','meta_business_activation_uncertain']);
const fail = code => { throw Object.assign(Error(code), { code }); };
function validateJobFilters(options) {
  for (const key of ['clinicIds', 'groupIds']) {
    const ids = options?.[key];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !['number', 'string'].includes(typeof id)
      || !/^[1-9][0-9]{0,9}$/.test(String(id)) || Number(id) > 2147483647)) fail('invalid_request');
  }
}
function safeError(error, fallback = 'meta_broker_binding_invalid') {
  const code = SAFE.has(error?.code) ? error.code : (SAFE.has(fallback) ? fallback : 'meta_broker_binding_invalid');
  const result = Object.assign(Error(code), { code, retryable: false });
  if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 86400000) result.retryAfterMs = error.retryAfterMs;
  return result;
}
function createMetaMarketingAdsReader({ scope, client, enabled = () => process.env.META_MARKETING_ADS_SYNC_ENABLED === 'true', now = Date.now }) {
  if (!scope || typeof scope.prepare !== 'function' || typeof scope.assertContext !== 'function' || typeof client?.execute !== 'function') fail('broker_configuration_invalid');
  async function assert(context, options) {
    if(options!==undefined&&(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).join(',')!=='transaction'||!options.transaction))fail('invalid_request');
    if (!enabled()) fail('meta_ads_sync_disabled');
    const state = await scope.assertContext(context, options);
    if (state.kind !== 'ad_account') fail('scope_denied');
    if (!enabled()) fail('meta_ads_sync_disabled');
    return state;
  }
  async function prepare(mappingId) {
    if (!enabled()) fail('meta_ads_sync_disabled');
    const context = await scope.prepare(mappingId);
    await assert(context);
    return context;
  }
  async function read(context, family, payload, { requestId = randomUUID(), timeoutMs = 30000 } = {}) {
    let observed;
    try {
      const operation = A.OPERATIONS[family];
      if (!operation || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_request');
      A.validate(operation, payload);
      const deadline = now() + timeoutMs;
      const before = await assert(context); observed = before;
      if (now() >= deadline) fail('broker_timeout');
      const response = await client.execute({ requestId, operation, connectionRef: before.connectionRef,
        assetRef: before.assetRef, tenantRef: before.tenantRef, payload: structuredClone(payload) }, { timeoutMs: deadline - now() });
      await assert(context);
      if (now() >= deadline) fail('broker_timeout');
      if (response?.requestId !== requestId) fail('broker_response_invalid');
      try { A.validatePage(operation, response.data, payload); } catch { fail('broker_response_invalid'); }
      return structuredClone(response.data);
    } catch (error) {
      if (observed && typeof scope.recordCredentialFailure === 'function') try { await scope.recordCredentialFailure(observed, error); } catch {}
      throw safeError(error);
    }
  }
  async function sourceForAsset(mappingId) {
    const context = await prepare(mappingId);
    let usage = { usagePct: 0, nextAllowedAt: 0, pauseUntil: 0 };
    return Object.freeze({
      assert: options => assert(context, options),
      async readPage(family, payload) { const page = await read(context, family, payload); usage = page.usage; return page; },
      async *pages(family, range = {}) {
        const seen = new Set(); let pageToken = null;
        for (let pageCount = 0; pageCount < 200; pageCount++) {
          const page = await read(context, family, { ...range, pageToken }); usage = page.usage;
          // The check runs again immediately before the caller's persistence.
          await assert(context);
          yield page.results;
          pageToken = page.nextPageToken;
          if (pageToken === null) return;
          if (seen.has(pageToken)) fail('broker_response_invalid');
          seen.add(pageToken);
        }
        fail('broker_response_invalid');
      },
      usage: () => structuredClone(usage),
    });
  }
  return { prepare, assert, read, sourceForAsset };
}
const instances = new WeakMap();
function forModels(models) {
  if (!models || typeof models !== 'object') fail('broker_configuration_invalid');
  if (!instances.has(models)) instances.set(models, createMetaMarketingAdsReader({ scope: metadataForModels(models), client: createConfiguredMetaMarketingClient() }));
  return instances.get(models);
}
module.exports = { createMetaMarketingAdsReader, forModels, safeError, validateJobFilters };
