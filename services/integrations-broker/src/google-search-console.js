'use strict';
const contract = require('./google-search-console-contract'); const { fail } = require('./errors');
const discovery = require('./google-property-discovery-contract');
function createSearchConsoleOperations({ http, cursor }) {
  const reads = Object.fromEntries(contract.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: contract.PROVIDER, effect: 'read', persistResult: false, validate: payload => contract.validate(operation, payload),
    async execute(context) {
      const { payload, secret, signal, binding, assetRef } = context;
      const resource = contract.resource(binding, assetRef); const family = operation.slice(contract.PREFIX.length).split('.')[0];
      if (family === 'discovery') return discovery.projectSC(await http({ hostname: 'www.googleapis.com',
        path: `/webmasters/v3/sites/${encodeURIComponent(resource.siteUrl)}`, token: secret, signal }), resource.siteUrl);
      if (family === 'inspection') {
        const raw = await http({ hostname: 'searchconsole.googleapis.com', path: '/v1/urlInspection/index:inspect', token: secret, signal,
          json: { siteUrl: resource.siteUrl, inspectionUrl: resource.inspectionUrl, languageCode: 'en-US' } });
        return contract.project(family, raw, payload);
      }
      let startRow = family === 'pages' ? payload.startRow : 0; const scope = { ...context, operation };
      if (family === 'queries' && payload.pageToken !== null) {
        let parsed; try { parsed = JSON.parse(cursor.open(payload.pageToken, scope)); } catch { fail('invalid_request'); }
        if (!parsed || Object.keys(parsed).sort().join(',') !== 'endDate,startDate,startRow'
          || parsed.startDate !== payload.startDate || parsed.endDate !== payload.endDate || !Number.isInteger(parsed.startRow)
          || parsed.startRow < contract.PAGE_SIZE || parsed.startRow >= contract.MAX_ROWS || parsed.startRow % contract.PAGE_SIZE !== 0) fail('invalid_request');
        startRow = parsed.startRow;
      }
      const rowLimit = family === 'timeseries' ? 550 : family === 'queries' ? contract.PAGE_SIZE : payload.rowLimit;
      const raw = await http({ hostname: 'www.googleapis.com', path: `/webmasters/v3/sites/${encodeURIComponent(resource.siteUrl)}/searchAnalytics/query`,
        token: secret, signal, json: { startDate: payload.startDate, endDate: payload.endDate,
          dimensions: family === 'timeseries' ? ['date'] : family === 'queries' ? ['date', 'query', 'page'] : ['page'],
          rowLimit, startRow, dataState: 'final', type: 'web', aggregationType: 'auto' } });
      const result = contract.project(family, raw, payload);
      if (family === 'queries') {
        const next = startRow + rowLimit; result.rowLimitReached = result.rows.length === rowLimit && next === contract.MAX_ROWS;
        result.nextPageToken = result.rows.length === rowLimit && next < contract.MAX_ROWS
          ? cursor.seal(JSON.stringify({ startDate: payload.startDate, endDate: payload.endDate, startRow: next }), scope) : null;
      }
      return result;
    },
    project(result) {
      if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > 790528) fail('provider_failed');
      return structuredClone(result);
    },
  })]));
  return { ...reads, [contract.REVOKE_OPERATION]: Object.freeze({ provider: contract.PROVIDER, control: 'revoke_asset',
    validate: require('./contracts').schema({}) }) };
}
module.exports = { createSearchConsoleOperations };
