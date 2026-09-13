'use strict';
const { randomUUID } = require('node:crypto');
const contract = require('../../services/integrations-broker/src/google-ads-contract');
const SAFE = new Set(['broker_binding_invalid', 'broker_cohort_disabled', 'broker_response_invalid', 'broker_configuration_invalid',
  'broker_timeout', 'broker_unavailable', 'connection_blocked', 'asset_revoked', 'scope_denied', 'operation_denied',
  'invalid_request', 'secret_unavailable', 'credential_revoked', 'provider_failed', 'provider_timeout',
  'provider_unauthorized', 'rate_limited', 'audit_unavailable']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_ads_broker_read_failed';
const fail = code => { throw Object.assign(Error(code), { code }); };
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);

// assertContext must resolve an opaque, server-owned authorization context on
// every call. No caller-supplied tenant/account object grants access by itself.
function createGoogleAdsBrokerReader({ client, assertContext, now = Date.now }) {
  if (typeof client?.execute !== 'function' || typeof assertContext !== 'function') fail('broker_configuration_invalid');
  return { async read(context, family, input, { timeoutMs = 90000 } = {}) {
    try {
      if (!contract.FAMILIES.includes(family) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 450000
        || !input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'pageToken')) fail('invalid_request');
      const operation = contract.PREFIX + family + '.read.v1';
      const basePayload = structuredClone(input);
      contract.validate(operation, { ...basePayload, ...(family === 'account' ? {} : { pageToken: null }) });
      const deadline = now() + timeoutMs;
      const captured = await assertContext(context);
      if (!captured || !reference(captured.connectionRef) || !/^clinic:[1-9]\d{0,9}$/.test(captured.tenantRef)
        || !contract.customer(captured.customerId) || captured.assetRef !== 'ads:' + captured.customerId) fail('broker_binding_invalid');
      const identity = { connectionRef: captured.connectionRef, tenantRef: captured.tenantRef,
        customerId: captured.customerId, assetRef: captured.assetRef };
      const verify = async () => {
        const fresh = await assertContext(context);
        if (!fresh || Object.keys(identity).some(key => fresh[key] !== identity[key])) fail('broker_binding_invalid');
        if (now() >= deadline) fail('broker_timeout');
      };
      const rows = []; const seen = new Set(); const tokens = new Set(); const resources = new Map();
      let pageToken = null; let bytes = 0;
      // Byte-adaptive broker slices may be smaller than 250 rows. Enforce the
      // row limit independently and cap total calls; never silently truncate.
      for (let page = 0; page < 2000; page++) {
        await verify();
        const payload = { ...basePayload, ...(family === 'account' ? {} : { pageToken }) };
        const requestId = randomUUID();
        const response = await client.execute({ requestId, operation, connectionRef: identity.connectionRef,
          tenantRef: identity.tenantRef, assetRef: identity.assetRef, payload }, { timeoutMs: Math.min(30000, deadline - now()) });
        await verify();
        const data = response?.data;
        if (response?.requestId !== requestId || !data || Object.keys(data).sort().join(',') !== 'nextPageToken,results'
          || !Array.isArray(data.results) || data.results.length > contract.PAGE_SIZE
          || Buffer.byteLength(JSON.stringify(data)) > 786432) fail('broker_response_invalid');
        const next = data.nextPageToken;
        if (next !== null && (typeof next !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(next)
          || !data.results.length || family === 'account' || tokens.has(next))) fail('broker_response_invalid');
        let projected;
        try { projected = contract.projectPage(family, { results: data.results }, payload, identity).results; }
        catch { fail('broker_response_invalid'); }
        bytes += Buffer.byteLength(JSON.stringify(projected));
        if (bytes > 64 * 1024 * 1024 || rows.length + projected.length > contract.rowLimit(family)) fail('broker_response_invalid');
        for (const row of projected) {
          const key = contract.rowKey(row);
          if (seen.has(key)) fail('broker_response_invalid');
          for (const [ref, value] of [[row.campaign && `campaign:${row.campaign.id}`, row.campaign],
            [row.adGroup && `group:${row.campaign.id}:${row.adGroup.id}`, row.adGroup],
            [row.adGroupAd && `ad:${row.campaign.id}:${row.adGroup.id}:${row.adGroupAd.ad.id}`, row.adGroupAd]]) {
            if (!ref) continue;
            const serialized = JSON.stringify(value);
            if (resources.has(ref) && resources.get(ref) !== serialized) fail('broker_response_invalid');
            resources.set(ref, serialized);
          }
          seen.add(key); rows.push(row);
        }
        if (next === null) { await verify(); return rows; }
        if (rows.length === contract.rowLimit(family)) fail('broker_response_invalid');
        tokens.add(next); pageToken = next;
      }
      fail('broker_response_invalid');
    } catch (error) { fail(safe(error)); }
  } };
}
module.exports = { createGoogleAdsBrokerReader, safe };
