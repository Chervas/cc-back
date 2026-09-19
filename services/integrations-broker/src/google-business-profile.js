'use strict';
const contract = require('./google-business-profile-contract'); const { fail } = require('./errors');
function createGoogleBusinessProfileOperations({ http, cursor, oauth }) {
  const reads = Object.fromEntries(contract.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: contract.PROVIDER, effect: 'read', persistResult: false, validate: value => contract.validate(operation, value),
    async execute(context) {
      const { payload, secret, signal } = context; const resource = contract.asset(context.assetRef);
      const family = operation.slice(contract.PREFIX.length).split('.')[0]; const scope = { ...context, operation };
      if (family === 'discovery') {
        // Both resources come from the exact signed grant. No provider-wide enumeration.
        const account = await http({ hostname: 'mybusinessaccountmanagement.googleapis.com', path: `/v1/accounts/${resource.accountId}`, token: secret, signal });
        if (account?.name !== `accounts/${resource.accountId}`) fail('scope_denied');
        if (signal?.aborted) fail('provider_timeout');
        const query = new URLSearchParams({ readMask: contract.READ_MASK });
        const location = await http({ hostname: 'mybusinessbusinessinformation.googleapis.com', path: `/v1/${resource.location}?${query}`, token: secret, signal });
        return contract.project(operation, { account, location }, resource, payload);
      }
      let hostname = 'mybusiness.googleapis.com'; let path; const params = new URLSearchParams();
      if (family === 'metrics') {
        hostname = 'businessprofileperformance.googleapis.com'; path = `/v1/${resource.location}:fetchMultiDailyMetricsTimeSeries`;
        for (const metric of contract.METRICS) params.append('dailyMetrics', metric);
        for (const [key, date] of [['start_date', payload.startDate], ['end_date', payload.endDate]]) {
          const [year, month, day] = date.split('-').map(Number);
          for (const [part, value] of Object.entries({ year, month, day })) params.append(`dailyRange.${key}.${part}`, String(value));
        }
      } else if (family === 'details') {
        hostname = 'mybusinessbusinessinformation.googleapis.com'; path = `/v1/${resource.location}`; params.set('readMask', contract.READ_MASK);
      } else if (family === 'verification') {
        hostname = 'mybusinessverifications.googleapis.com'; path = `/v1/${resource.location}/VoiceOfMerchantState`;
      } else {
        const segment = family === 'posts' ? 'localPosts' : family;
        path = `/v4/${resource.parent}/${segment}`; params.set('pageSize', family === 'reviews' ? '50' : '100');
        if (payload.pageToken !== null) params.set('pageToken', cursor.open(payload.pageToken, scope));
      }
      const raw = await http({ hostname, path: path + (params.size ? '?' + params : ''), token: secret, signal });
      const projected = contract.project(operation, raw, resource, payload);
      if (Object.hasOwn(payload, 'pageToken')) {
        if (raw.nextPageToken !== undefined && raw.nextPageToken !== null && typeof raw.nextPageToken !== 'string') fail('provider_failed');
        projected.nextPageToken = raw.nextPageToken ? cursor.seal(raw.nextPageToken, scope) : null;
      }
      return projected;
    },
    project(value) {
      // execute has already checked resource-bound provider fields; the broker then
      // checks for the active credential before persisting this JSON-only result.
      if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 790528) fail('provider_failed');
      return structuredClone(value);
    },
  })]));
  const oauthContract = require('./google-oauth-contract');
  const controls = oauthContract.controlsFor(contract.PROVIDER, oauth);
  return { ...reads, ...controls, [contract.REVOKE_OPERATION]: Object.freeze({ provider: contract.PROVIDER, control: 'revoke_asset',
    validate: require('./contracts').schema({}) }) };
}
module.exports = { createGoogleBusinessProfileOperations };
