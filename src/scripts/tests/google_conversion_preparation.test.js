'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const db = require('../../../models');
const { googleAdsSearchRows } = require('../../lib/googleAdsSearchRows');
const { assertGoogleConversionMutationAccess } = require('../../lib/googleConversionMutationAccess');
const { buildBaseUrls, GOOGLE_ADS_CONVERSIONS_API_VERSION } = require('../../lib/googleAdsClient');
const { __test: { buildClinicaclickManagedMapping, ensureConversionActionsInternal } } = require('../../controllers/campaignOnboarding.controller');
after(() => db.sequelize.close());

test('conversion requests pin a supported version without changing the version used by other jobs', () => {
  const keys = ['GOOGLE_ADS_API_VERSION', 'GOOGLE_ADS_API_BASE_URL', 'GOOGLE_ADS_API_ENDPOINT'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GOOGLE_ADS_API_VERSION = 'v21'; delete process.env.GOOGLE_ADS_API_BASE_URL;
    process.env.GOOGLE_ADS_API_ENDPOINT = 'https://googleads.googleapis.com';
    assert.equal(buildBaseUrls()[0], 'https://googleads.googleapis.com/v21');
    assert.deepEqual(buildBaseUrls(GOOGLE_ADS_CONVERSIONS_API_VERSION), ['https://googleads.googleapis.com/v24']);
    process.env.GOOGLE_ADS_API_BASE_URL = 'https://googleads.googleapis.com/v21';
    assert.deepEqual(buildBaseUrls('v24'), ['https://googleads.googleapis.com/v24']);
    assert.throws(() => buildBaseUrls('../v24'));
    process.env.GOOGLE_ADS_API_BASE_URL = 'https://googleads.googleapis.com/proxy';
    assert.throws(() => buildBaseUrls('v24'));
  } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});

test('Google Search follows page tokens with an unchanged query and the scoped credential', async () => {
  const calls = [];
  const rows = await googleAdsSearchRows({ customerId: '123-456-7890', accessToken: 'scoped-test', loginCustomerId: '1231231231', apiVersion: 'v24', query: 'SELECT conversion_action.id FROM conversion_action',
    request: async (method, path, options) => { calls.push({ method, path, options }); return calls.length === 1 ? { results: [{ id: 1 }], nextPageToken: 'page2' } : { results: [{ id: 2 }] }; } });
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls[0].path, 'customers/1234567890/googleAds:search');
  assert.equal(calls[1].options.data.query, calls[0].options.data.query); assert.equal(calls[1].options.data.pageToken, 'page2');
  assert.equal(calls[1].options.accessToken, 'scoped-test'); assert.equal(calls[1].options.loginCustomerId, '1231231231');
  assert.equal(calls[0].options.data.pageSize, undefined); assert.equal(calls[0].options.singleAttempt, true);
  assert.equal(calls[1].options.apiVersion, 'v24');
});
test('incomplete, repeated, malformed and over-deadline searches never return partial lists', async () => {
  const base = { customerId: '1234567890', accessToken: 'scoped-test', query: 'SELECT conversion_action.id FROM conversion_action' };
  await assert.rejects(googleAdsSearchRows({ ...base, request: async () => ({ results: [], nextPageToken: 'same' }) }), /could not be completed/);
  await assert.rejects(googleAdsSearchRows({ ...base, maxPages: 1, request: async () => ({ results: [], nextPageToken: 'more' }) }), /could not be completed/);
  for (const response of [null, [], { results: {} }, { error: {} }]) {
    await assert.rejects(googleAdsSearchRows({ ...base, request: async () => response }), /could not be completed/);
  }
  let calls = 0; await assert.rejects(googleAdsSearchRows({ ...base, now: () => calls++ * 50000, request: () => assert.fail('deadline') }), /could not be completed/);
  let elapsed = 0; await assert.rejects(googleAdsSearchRows({ ...base, now: () => elapsed,
    request: async () => { elapsed = 50000; return { results: [{ id: 1 }] }; } }), /could not be completed/);
  assert.deepEqual(await googleAdsSearchRows({ ...base, request: async () => ({}) }), []);
});
test('ambiguous canonical names never select the first conversion by accident', () => {
  assert.equal(buildClinicaclickManagedMapping([{ id: '1', name: 'Lead - ClinicaClick' }, { id: '2', name: 'lead - clinicaclick' }]).lead, null);
  assert.equal(buildClinicaclickManagedMapping([{ id: '1', name: 'My lead action' }]).lead, null);
  assert.equal(buildClinicaclickManagedMapping([{ id: '1', name: 'Lead - ClinicaClick' }]).lead, '1');
});
test('existing conversion preparation only creates missing secondary actions after rechecking permission', async () => {
  const calls = []; const lead = { id: '1', name: 'Lead - ClinicaClick', type: 'UPLOAD_CLICKS', primary_for_goal: false, counting_type: 'MANY_PER_CLICK' };
  const result = await ensureConversionActionsInternal({ customerId: '1234567890', accessToken: 'old-test', currency: 'EUR', events: ['lead', 'schedule'], createMissing: true,
    listActions: async options => { assert.equal(options.includeAllTypes, true); return { actions: [lead], clinicaclick_mapping: { lead: '1' } }; },
    beforeCreate: async () => { calls.push('authorized'); return { accessToken: 'fresh-test', loginCustomerId: '9999999999' }; },
    request: async (method, path, options) => {
      assert.deepEqual(calls, ['authorized']); calls.push('created');
      assert.equal(options.accessToken, 'fresh-test'); assert.equal(options.data.operations.length, 1);
      assert.equal(options.apiVersion, 'v24');
      const action = options.data.operations[0].create;
      assert.equal(action.name, 'Schedule - ClinicaClick'); assert.equal(action.primaryForGoal, false);
      assert.equal(action.countingType, 'MANY_PER_CLICK'); assert.equal(action.category, 'BOOK_APPOINTMENT');
      assert.equal(options.data.operations[0].update, undefined);
      return { results: [{ resourceName: 'customers/1234567890/conversionActions/2' }] };
    } });
  assert.equal(result.mapping.lead, '1'); assert.equal(result.mapping.schedule, '2'); assert.equal(result.created.length, 1);
});
test('revoked permission, ambiguous actions or an existing different type prevent creation', async () => {
  const base = { customerId: '1234567890', accessToken: 'test', events: ['lead'], createMissing: true,
    request: async () => assert.fail('must not create'), listActions: async () => ({ actions: [], clinicaclick_mapping: {} }) };
  await assert.rejects(ensureConversionActionsInternal({ ...base, beforeCreate: async () => { throw new Error('scope_forbidden'); } }), /scope_forbidden/);
  for (const actions of [[{ id: '1', name: 'Lead - ClinicaClick', type: 'WEBPAGE' }],
    [{ id: '1', name: 'Lead - ClinicaClick', type: 'UPLOAD_CLICKS' }, { id: '2', name: 'Lead - ClinicaClick', type: 'UPLOAD_CLICKS' }]]) {
    await assert.rejects(ensureConversionActionsInternal({ ...base, listActions: async () => ({ actions, clinicaclick_mapping: {} }) }), /Revisa las acciones/);
  }
});
test('an ad account mutation requires permission on every active mapping, not only the current clinic', async () => {
  const calls = []; const models = { ClinicGoogleAdsAccount: { findAll: async () => [{ id: 1, clinicaId: 2 }, { id: 3, clinicaId: 4 }] } };
  await assert.rejects(assertGoogleConversionMutationAccess({ models, userId: 7, customerId: '1234567890', runtimeAccountId: 1,
    assertAssetAccess: async options => { calls.push(options); if (options.assetId === 3) throw new Error('asset_in_use'); } }), /asset_in_use/);
  assert.equal(calls.length, 2); assert.equal(calls[0].userId, 7); assert.equal(calls[1].ownerClinicId, 4);
  await assert.rejects(assertGoogleConversionMutationAccess({ models, userId: 7, customerId: '1234567890', runtimeAccountId: 99,
    assertAssetAccess: async () => assert.fail('mapping removed') }), /mapping changed/);
});

test('the validation endpoint checks the provider action and never trusts a client readiness flag', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'), 'utf8');
  const start = source.indexOf('exports.validateGoogleDataManagerConversion =');
  const end = source.indexOf('exports.ensureGoogleAdsConversionActions =', start);
  assert.ok(start >= 0 && end > start);
  const action = { id: '1', name: 'Lead - ClinicaClick', type: 'UPLOAD_CLICKS', status: 'ENABLED',
    category: 'SUBMIT_LEAD_FORM', resource_name: 'customers/1234567890/conversionActions/1',
    primary_for_goal: false, counting_type: 'MANY_PER_CLICK' };
  for (const patch of [null, { type: 'WEBPAGE' }, { category: 'CONTACT' },
    { resource_name: 'customers/9999999999/conversionActions/1' }, { primary_for_goal: true },
    { status: 'HIDDEN' }, { counting_type: 'ONE_PER_CLICK' }, { queryError: true }]) {
    const calls = []; const context = { exports: {}, asyncHandler: fn => fn, getUserId: () => 7,
      normalizeCustomerId: value => value, VALID_EVENTS: ['lead'], EVENT_CATALOG: { lead: { category: 'SUBMIT_LEAD_FORM' } },
      GOOGLE_ADS_SCOPE: 'ads', GOOGLE_DATA_MANAGER_SCOPE: 'data-manager',
      resolveScopeFromInput: async () => ({ clinic_ids: [2], clinic_id: 2 }),
      requireMarketingClinicScope: async () => true,
      resolveScopedGoogleAdsRuntime: async () => ({ accessToken: 'scoped-test' }),
      listConversionActionsInternal: async options => {
        assert.equal(options.includeAllTypes, true);
        if (patch?.queryError) throw new Error('provider unavailable');
        return { clinicaclick_mapping: { lead: '1' }, actions: [{ ...action, ...patch }] };
      }, uploadGoogleDataManagerConversion: async options => { calls.push(options); } };
    vm.runInNewContext(source.slice(start, end), context);
    let status = 200; let body;
    const res = { status: value => { status = value; return res; }, json: value => { body = value; return res; } };
    await context.exports.validateGoogleDataManagerConversion({ body: { customer_id: '1234567890', clinic_id: 2,
      conversion_action_id: '1', event: 'lead', ready: true, validate_only: false } }, res);
    assert.equal(body.validate_only, true);
    if (patch) {
      assert.equal(body.validated, false); assert.equal(calls.length, 0); assert.equal(status, patch.queryError ? 502 : 409);
    } else {
      assert.equal(body.validated, true); assert.equal(calls.length, 1); assert.equal(calls[0].validateOnly, true);
      assert.equal(calls[0].gclid, 'GCLID_1'); assert.equal(calls[0].email, undefined); assert.equal(calls[0].phone, undefined);
    }
  }
});
