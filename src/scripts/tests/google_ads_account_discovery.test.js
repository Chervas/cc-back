'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'), {
    module, exports: module.exports, require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    }, ...globals,
  });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
function client(axios, env = {}) {
  const counter = { requestCount: 0, usageDate: new Date().toISOString().slice(0, 10),
    async update(values) { Object.assign(this, values); } };
  return load('lib/googleAdsClient.js', { axios, '../../models': {
    ApiUsageCounter: { findOrCreate: async () => [counter, false] },
  } }, { process: { env: { GOOGLE_ADS_DEVELOPER_TOKEN: 'test-token', GOOGLE_ADS_MANAGER_ID: '9999999999', ...env } } });
}
const shared = { googleAdsRequest: () => assert.fail('Live provider forbidden'), normalizeCustomerId: value => String(value || '').replace(/\D/g, '') };
const { googleAdsSearchRows } = load('lib/googleAdsSearchRows.js', { './googleAdsClient': shared });
const { discoverGoogleAdsAccountSelection: discover } = load('services/googleAdsAccountDiscovery.service.js', {
  '../lib/googleAdsClient': shared, '../lib/googleAdsSearchRows': { googleAdsSearchRows },
});

test('shared transport defaults to v24 and never probes retired versions or undocumented paths', async () => {
  const calls = [];
  const api = client(async options => { calls.push(options); return { data: { resourceNames: [] } }; },
    { GOOGLE_ADS_API_VERSION_FALLBACKS: 'v21,v20,v19' });
  assert.deepEqual(plain(api.buildBaseUrls()), ['https://googleads.googleapis.com/v24']);
  await api.googleAdsRequest('GET', 'customers:listAccessibleCustomers', { accessToken: 'scope-token', loginCustomerId: '123-456-7890', timeoutMs: 500 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url, 'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers');
  assert.equal(calls[0].headers.Authorization, 'Bearer scope-token');
  assert.equal(calls[0].headers['login-customer-id'], '1234567890');
  assert.equal(calls[0].headers['developer-token'], 'test-token');
  assert.equal(calls[0].timeout, 500); assert.equal(calls[0].maxRedirects, 0);
});
test('provider failures and ambiguous mutations are returned without retries', async () => {
  for (const [method, status] of ['GET', 'POST'].flatMap(method => [301, 401, 403, 404, 405, 429, 500].map(status => [method, status]))) {
    const error = { response: { status } }; const calls = [];
    const api = client(async options => { calls.push(options); throw error; });
    await assert.rejects(api.googleAdsRequest(method, method === 'POST' ? 'customers/1234567890/campaigns:mutate' : 'customers:listAccessibleCustomers', {
      accessToken: 'scope', data: { operations: [{ update: { status: 'PAUSED' } }] },
    }), failure => failure === error);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, method);
  }
});
test('explicit deployments and conversion version overrides retain the configured host', async () => {
  const api = client(() => assert.fail('invalid config must not call provider'), {
    GOOGLE_ADS_API_VERSION: 'v23', GOOGLE_ADS_API_BASE_URL: 'https://ads-proxy.example/v23/',
  });
  assert.deepEqual(plain(api.buildBaseUrls()), ['https://ads-proxy.example/v23']);
  assert.deepEqual(plain(api.buildBaseUrls('v24')), ['https://ads-proxy.example/v24']);
  assert.throws(() => api.buildBaseUrls('../v24'));
  await assert.rejects(api.googleAdsRequest(['GET', 'POST'], 'unused'), /Invalid Google Ads HTTP method/);
  assert.throws(() => client(() => {}, { GOOGLE_ADS_API_VERSION: '../v24' }).buildBaseUrls());
});
test('account selection reads a manager hierarchy once, paginates and deduplicates direct and indirect accounts', async () => {
  const calls = [];
  const { accounts } = await discover({ accessToken: 'scope-token', request: async (method, requestPath, options) => {
    calls.push({ method, requestPath, options });
    assert.equal(options.accessToken, 'scope-token'); assert.ok(options.timeoutMs <= 8000);
    assert.equal(options.singleAttempt, true); assert.ok(!requestPath.includes('mutate'));
    if (method === 'GET') return { resourceNames: ['customers/1111111111', 'customers/2222222222', 'customers/3333333333'] };
    if (options.data.query.includes('FROM customer_client')) {
      assert.equal(options.loginCustomerId, '1111111111');
      if (options.data.pageToken) return { results: [{ customerClient: { clientCustomer: 'customers/3333333333', descriptiveName: 'Clínica', currencyCode: 'EUR' } }] };
      return { results: [{ customerClient: { clientCustomer: 'customers/2222222222', manager: true } }], nextPageToken: 'page2' };
    }
    return { results: [{ customer: { id: '1111111111', manager: true } }] };
  } });
  assert.equal(calls.length, 4);
  assert.equal(accounts.length, 3);
  assert.equal(accounts.find(account => account.customerId === '3333333333').loginCustomerId, '1111111111');
  assert.equal(accounts.filter(account => !account.isManager).length, 1);
  assert.ok(calls.every(call => !call.options.data?.query.includes('customer_manager_link')));
});
test('discovery handles a standalone account, empty access, and hidden accounts without inventing a manager', async () => {
  assert.deepEqual(plain(await discover({ accessToken: 'scope', request: async () => ({}) })), { accounts: [], unavailableAccountCount: 0 });
  const { accounts } = await discover({ accessToken: 'scope', request: async method => method === 'GET'
    ? { resourceNames: ['customers/1234567890'] }
    : { results: [{ customer: { id: '1234567890', descriptiveName: 'Clínica' } }] } });
  assert.equal(accounts[0].isManager, false); assert.equal(accounts[0].loginCustomerId, null);
  const hidden = await discover({ accessToken: 'scope', request: async (method, path, options) => method === 'GET'
    ? { resourceNames: ['customers/1234567890'] } : options.data.query.includes('FROM customer_client')
      ? { results: [{ customerClient: { clientCustomer: 'customers/2222222222', hidden: true } },
        { customerClient: { clientCustomer: 'customers/3333333333', status: 'CLOSED' } }] }
      : { results: [{ customer: { id: '1234567890', manager: true } }] } });
  assert.equal(hidden.accounts.length, 1);
  assert.equal(hidden.unavailableAccountCount, 1);
});
test('an explicitly disabled account does not hide available accounts; other authorization failures still block discovery', async () => {
  for (const reason of ['CUSTOMER_NOT_ENABLED', 'USER_PERMISSION_DENIED', 'DEVELOPER_TOKEN_NOT_APPROVED']) {
    const discovery = discover({ accessToken: 'scope', request: async (method, path) => {
      if (method === 'GET') return { resourceNames: ['customers/1111111111', 'customers/2222222222'] };
      if (path.includes('1111111111')) throw { response: { status: 403, data: { error: { details: [
        { errors: [{ errorCode: { authorizationError: reason } }] },
      ] } } } };
      return { results: [{ customer: { id: '2222222222' } }] };
    } });
    if (reason === 'CUSTOMER_NOT_ENABLED') {
      const result = await discovery;
      assert.equal(result.accounts.length, 1); assert.equal(result.unavailableAccountCount, 1);
    } else await assert.rejects(discovery);
  }
});
test('malformed, failed or incomplete discovery never returns a partial or falsely empty account list', async () => {
  for (const response of [null, [], { resourceNames: {} }, { error: {} }, { resourceNames: ['wrong/123'] }]) {
    await assert.rejects(discover({ accessToken: 'scope', request: async () => response }), /could not be completed/);
  }
  for (const response of [{}, { results: [{ customer: { id: '9999999999' } }] }, { results: [{ customer: { id: '1234567890', manager: 'false' } }] }]) {
    await assert.rejects(discover({ accessToken: 'scope', request: async method => method === 'GET'
      ? { resourceNames: ['customers/1234567890'] } : response }), /could not be completed/);
  }
  await assert.rejects(discover({ accessToken: 'scope', request: async (method, path, options) => method === 'GET'
    ? { resourceNames: ['customers/1234567890'] } : options.data.query.includes('FROM customer_client')
      ? { results: [], nextPageToken: 'cycle' } : { results: [{ customer: { id: '1234567890', manager: true } }] } }), /could not be completed/);
  let elapsed = 0;
  await assert.rejects(discover({ accessToken: 'scope', now: () => elapsed, request: async () => { elapsed = 40001; return {}; } }), /could not be completed/);
  await assert.rejects(discover({ accessToken: 'scope', maxAccounts: 1, request: async () => ({ resourceNames: ['customers/1234567890', 'customers/2222222222'] }) }), /could not be completed/);
  await assert.rejects(discover({ accessToken: 'scope', maxRequests: 1, request: async () => ({ resourceNames: ['customers/1234567890'] }) }), /could not be completed/);
});
test('selection endpoint keeps scope authorization and tokens ahead of discovery, without loading mappings', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  const start = source.indexOf("router.get('/google/ads/accounts'");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start > 0 && end > start);
  for (const scenario of ['success', 'unauthenticated', 'no_connection', 'scope_denied', 'forbidden', 'provider_failed']) {
    let handler; const calls = [];
    vm.runInNewContext(source.slice(start, end), { router: { get: (path, fn) => { handler = fn; } }, console: { error() {} }, GOOGLE_ADS_SCOPE: 'ads',
      resolveGoogleRequestConnection: async req => {
        calls.push('authorize'); assert.equal(req.query.group_id, '28');
        if (scenario === 'forbidden') throw new Error('forbidden');
        return { userId: scenario === 'unauthenticated' ? null : 7, connection: scenario === 'no_connection' ? null : { scopes: 'ads' } };
      }, hasScopeText: () => scenario !== 'scope_denied', ensureGoogleAdsAccess: async () => { calls.push('token'); return { accessToken: 'scope-token' }; },
      discoverGoogleAdsAccountSelection: async options => {
        calls.push('discovery'); assert.equal(options.accessToken, 'scope-token');
        if (scenario === 'provider_failed') throw new Error('sensitive provider response');
        return { accounts: [{ customerId: '1234567890', isManager: false }], unavailableAccountCount: 1 };
      } });
    let status = 200; let body;
    const res = { status: value => { status = value; return res; }, json: value => { body = value; return res; } };
    await handler({ query: { view: 'selection', group_id: '28' } }, res);
    assert.equal(body.success, scenario === 'success');
    if (scenario === 'success') { assert.equal(body.accounts.length, 1); assert.equal(body.unavailableAccountCount, 1); }
    if (scenario === 'success' || scenario === 'provider_failed') assert.deepEqual(calls, ['authorize', 'token', 'discovery']);
    else assert.deepEqual(calls, ['authorize']);
    if (scenario === 'provider_failed') { assert.equal(status, 502); assert.equal(body.error, 'google_ads_discovery_incomplete'); }
    assert.ok(!JSON.stringify(body).includes('sensitive'));
  }
});
