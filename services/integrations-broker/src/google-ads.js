'use strict';
const { createHash, randomUUID } = require('node:crypto');
const contract = require('./google-ads-contract');
const { fail } = require('./errors');
// Google fixes provider pages at 10,000 rows. Hold bounded projected pages only
// in memory and serve small authenticated slices; never put metrics in SQLite.
function createGoogleAdsOperations({ http, cursor, withDeveloperSecret, now = Date.now, maxBytes = 64 * 1024 * 1024, maxEntries = 16 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024
    || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 16) fail('invalid_request');
  const pages = new Map(); let bytes = 0;
  const drop = id => { const entry = pages.get(id); if (entry) { bytes -= entry.bytes; pages.delete(id); } };
  const prune = () => { for (const [id, entry] of pages) if (entry.expiresAt <= now()) drop(id); };
  const scopeKey = (context, operation) => JSON.stringify([context.principalId, context.tenantRef, context.binding.connectionRef,
    context.assetRef, operation, context.policyVersion]);
  const operations = Object.fromEntries(contract.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: contract.PROVIDER, effect: 'read', persistResult: false, requiredScopes: contract.SCOPES,
    validate: payload => contract.validate(operation, payload),
    async execute(context) {
      const { payload, binding, assetRef, signal, secret } = context;
      const account = contract.resource(binding, assetRef); const name = contract.family(operation);
      const query = contract.query(name, payload); const scope = { ...context, operation };
      const queryHash = createHash('sha256').update(query).digest('hex');
      return withDeveloperSecret(binding, async developerToken => {
        if (!Buffer.isBuffer(secret) || !Buffer.isBuffer(developerToken) || signal?.aborted) fail('connection_blocked');
        const epoch = createHash('sha256').update(secret).update(Buffer.from([0])).update(developerToken).digest('hex');
        const key = scopeKey(context, operation); let entry; let offset = 0;
        prune();
        if (payload.pageToken != null) {
          let page; try { page = JSON.parse(cursor.open(payload.pageToken, scope)); } catch { fail('invalid_request'); }
          if (!page || Object.keys(page).sort().join(',') !== 'id,offset' || typeof page.id !== 'string'
            || !Number.isInteger(page.offset) || page.offset < 0) fail('invalid_request');
          entry = pages.get(page.id); offset = page.offset;
          if (!entry || entry.key !== key || entry.epoch !== epoch || entry.queryHash !== queryHash || offset > entry.rows.length) fail('invalid_request');
        }
        if (!entry || offset === entry.rows.length) {
          if (entry && !entry.nextPageToken) fail('invalid_request');
          const next = entry?.nextPageToken || null;
          const previous = entry?.seenTokens || [];
          if (next && previous.includes(next) || previous.length >= Math.ceil(contract.rowLimit(name) / contract.PROVIDER_PAGE_SIZE) + 1) fail('provider_failed');
          const raw = await http({ hostname: 'googleads.googleapis.com', path: `/${contract.API_VERSION}/customers/${account.customerId}/googleAds:search`,
            token: secret, developerToken, loginCustomerId: account.loginCustomerId, signal,
            json: { query, ...(next ? { pageToken: next } : {}) } });
          if (signal?.aborted) fail('connection_blocked');
          const page = contract.projectPage(name, raw, payload, account);
          const count = (entry?.count || 0) + page.results.length;
          const maximum = contract.rowLimit(name);
          if (count > maximum || count === maximum && page.nextPageToken
            || page.nextPageToken && [...previous, next].includes(page.nextPageToken)) fail('provider_failed');
          const size = Buffer.byteLength(JSON.stringify(page.results));
          if (size > maxBytes) fail('rate_limited');
          while (pages.size && (pages.size >= maxEntries || bytes + size > maxBytes)) drop(pages.keys().next().value);
          entry = { id: randomUUID(), key, epoch, queryHash, connectionRef: binding.connectionRef,
            assetRef, tenantRef: context.tenantRef, rows: page.results,
            nextPageToken: page.nextPageToken, count, seenTokens: [...previous, ...(next ? [next] : [])],
            bytes: size, expiresAt: now() + 600000 };
          pages.set(entry.id, entry); bytes += size; offset = 0;
        }
        const results = []; let resultBytes = 2;
        for (const row of entry.rows.slice(offset, offset + contract.PAGE_SIZE)) {
          const size = Buffer.byteLength(JSON.stringify(row)) + (results.length ? 1 : 0);
          if (resultBytes + size > 780000) break;
          results.push(row); resultBytes += size;
        }
        if (!results.length && entry.rows.length) fail('provider_failed');
        const end = offset + results.length;
        const nextPageToken = end < entry.rows.length || entry.nextPageToken
          ? cursor.seal(JSON.stringify({ id: entry.id, offset: end }), scope) : null;
        return { results, nextPageToken, ...(name === 'conversion_settings' ? {
          dataManagerConfiguration: { quotaProjectConfigured: Boolean(binding.googleDataManager?.quotaProjectId) },
        } : {}) };
      }, { signal });
    },
    project(result) {
      const settings = contract.family(operation) === 'conversion_settings';
      if (!result || Object.keys(result).sort().join(',') !== (settings ? 'dataManagerConfiguration,nextPageToken,results' : 'nextPageToken,results') || !Array.isArray(result.results)
        || result.results.length > contract.PAGE_SIZE || Buffer.byteLength(JSON.stringify(result)) > 786432) fail('provider_failed');
      if (settings) contract.dataManagerConfiguration(result.dataManagerConfiguration);
      return structuredClone(result);
    },
  })]));
  operations[contract.REVOKE_OPERATION] = Object.freeze({ provider: contract.PROVIDER, control: 'revoke_asset', validate: require('./contracts').schema({}),
    onRevoked(request) { for (const [id, entry] of pages) if (entry.connectionRef === request.connectionRef
      && entry.assetRef === request.assetRef && entry.tenantRef === request.tenantRef) drop(id); } });
  return { operations,
    invalidate(ref) { for (const [id, entry] of pages) if (entry.connectionRef === ref) drop(id); },
    close() { for (const id of [...pages.keys()]) drop(id); },
  };
}
module.exports = { createGoogleAdsOperations };
