'use strict';
const { createHash } = require('node:crypto');
const contract = require('./google-analytics-contract'); const { fail } = require('./errors');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createAnalyticsOperations({ http, cursor }) {
  return Object.fromEntries(contract.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: contract.PROVIDER, effect: 'read', persistResult: false, validate: payload => contract.validate(operation, payload),
    async execute(context) {
      const { payload, secret, signal, binding, assetRef } = context;
      const resource = contract.resource(binding, assetRef); const family = operation.slice(contract.PREFIX.length).split('.')[0];
      const scope = { ...context, operation }; let previous = null; let offset = 0;
      if (payload.pageToken !== null) {
        try { previous = JSON.parse(cursor.open(payload.pageToken, scope)); } catch { fail('invalid_request'); }
        if (!previous || Object.keys(previous).sort().join(',') !== 'endDate,metadataHash,offset,rowCount,startDate'
          || previous.startDate !== payload.startDate || previous.endDate !== payload.endDate
          || !Number.isInteger(previous.offset) || previous.offset < contract.PAGE_SIZE || previous.offset >= contract.MAX_ROWS || previous.offset % contract.PAGE_SIZE
          || !Number.isSafeInteger(previous.rowCount) || previous.rowCount <= previous.offset || previous.rowCount > 2147483647
          || !/^[a-f0-9]{64}$/.test(previous.metadataHash)) fail('invalid_request');
        offset = previous.offset;
      }
      const dims = contract.dimensions(family);
      const raw = await http({ hostname: 'analyticsdata.googleapis.com', path: `/v1beta/${resource.propertyName}:runReport`, token: secret, signal,
        json: { dateRanges: [{ startDate: payload.startDate, endDate: payload.endDate }], dimensions: dims.map(name => ({ name })),
          metrics: contract.METRICS.map(name => ({ name })), limit: String(contract.PAGE_SIZE), offset: String(offset),
          orderBys: dims.map(dimensionName => ({ dimension: { dimensionName, orderType: 'ALPHANUMERIC' }, desc: false })),
          keepEmptyRows: false, returnPropertyQuota: false } });
      const result = contract.project(family, raw, payload); const hash = fingerprint(result.metadata);
      if (previous && (previous.rowCount !== result.rowCount || previous.metadataHash !== hash)
        || result.rows.length !== Math.min(contract.PAGE_SIZE, Math.max(0, result.rowCount - offset))) fail('provider_failed');
      const next = offset + result.rows.length;
      result.rowLimitReached = result.rowCount > contract.MAX_ROWS && next === contract.MAX_ROWS;
      result.nextPageToken = next < result.rowCount && next < contract.MAX_ROWS
        ? cursor.seal(JSON.stringify({ startDate: payload.startDate, endDate: payload.endDate, offset: next, rowCount: result.rowCount, metadataHash: hash }), scope) : null;
      return result;
    },
    project(result) {
      if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > 790528) fail('provider_failed');
      return structuredClone(result);
    },
  })]));
}
module.exports = { createAnalyticsOperations };
