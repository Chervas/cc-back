'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
const { createGoogleAdsOnboardingBroker } = require('../../services/googleAdsOnboardingBroker.service');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ADS = 'https://www.googleapis.com/auth/adwords';
const DM = 'https://www.googleapis.com/auth/datamanager';

async function fixture() {
  const f = scopeFixture(); const calls = [];
  Object.assign(f.state.connection, { scopes: ADS + ' ' + DM });
  f.state.clinics.forEach(row => { row.estado_clinica = true; });
  const state = { allowed: true, conversions: true, at: 0,
    validation: { validated: true, warningCount: 0 },
    actions: [{ id: '456', resourceName: 'customers/1234567890/conversionActions/456', name: 'Lead - ClinicaClick',
      category: 'SUBMIT_LEAD_FORM', type: 'UPLOAD_CLICKS', status: 'ENABLED', countingType: 'MANY_PER_CLICK',
      primaryForGoal: false, includeInConversionsMetric: false }] };
  const broker = createGoogleAdsBroker({ ...f.options, now: () => state.at, conversionsEnabled: () => state.conversions,
    client: { execute: async command => {
      calls.push(structuredClone(command));
      let data;
      if (command.operation === 'google.ads.conversion_actions.read.v1') {
        data = { results: state.actions.map(conversionAction => ({ customer: { id: f.mapping.customerId }, conversionAction })), nextPageToken: null };
      } else {
        assert.equal(command.operation, 'google.ads.conversion.validate.v1'); data = state.validation;
      }
      await state.afterCall?.(command);
      return { requestId: command.requestId, data };
    } } });
  const runtime = { deliveryMode: 'broker', broker, account: f.mapping, brokerContext: await broker.prepare(f.mapping),
    customerId: f.mapping.customerId, loginCustomerId: f.mapping.loginCustomerId,
    connection: structuredClone(f.state.connection) };
  Object.defineProperty(runtime, 'accessToken', { get: () => assert.fail('managed flow must never read a token') });
  const models = { GoogleConnection: { findByPk: async (id, options) => {
    assert.deepEqual(options.attributes, ['id', 'googleUserId', 'scopes']);
    assert.equal(id, 2); return structuredClone(f.state.connection);
  } }, Clinica: { findByPk: async id => structuredClone(f.state.clinics.find(row => row.id_clinica === id)) } };
  const options = { runtime, models, clinicIds: [71], beforeExecute: async () => state.allowed, now: () => state.at };
  return { ...f, state, calls, runtime, options, adapter: createGoogleAdsOnboardingBroker(options) };
}
const validate = adapter => adapter.validate({ conversionActionId: '456', event: 'lead' });

test('onboarding uses the actual scoped broker reader and validate-only client with no token or event input', async () => {
  const f = await fixture(); const listed = await f.adapter.list({ includeAllTypes: true });
  assert.equal(listed.clinicaclick_mapping.lead, '456');
  assert.equal(listed.actions[0].send_to, null);
  assert.deepEqual(await validate(f.adapter), { validated: true, validate_only: true });
  assert.deepEqual(f.calls[1].payload, { conversionActionId: '456', eventName: 'lead', eventSource: 'WEB' });
  assert.equal(f.calls[1].tenantRef, 'clinic:59'); assert.equal(f.calls[1].assetRef, 'ads:1234567890');
  assert.equal(f.adapter.ingest, undefined); assert.equal(f.adapter.create, undefined);
  assert.equal(f.calls.length, 2);
});

test('validation requires an owned catalog and does not trust mutations to its returned copy', async () => {
  const f = await fixture(); await assert.rejects(validate(f.adapter), { code: 'canonical_conversion_action_required' });
  const listed = await f.adapter.list({ includeAllTypes: true });
  listed.actions[0].id = '999'; listed.clinicaclick_mapping.lead = '999';
  await assert.rejects(f.adapter.validate({ conversionActionId: '999', event: 'lead' }), { code: 'canonical_conversion_action_required' });
  assert.equal(f.calls.length, 1); await validate(f.adapter);
});

for (const [name, patch] of [
  ['foreign owner', { resourceName: 'customers/9999999999/conversionActions/456' }],
  ['wrong type', { type: 'WEBPAGE' }], ['wrong category', { category: 'CONTACT' }],
  ['hidden action', { status: 'HIDDEN' }], ['wrong counting', { countingType: 'ONE_PER_CLICK' }],
  ['primary action', { primaryForGoal: true }], ['unknown primary flag', { primaryForGoal: undefined }],
]) test('canonical validation refuses ' + name + ' before Data Manager', async () => {
  const f = await fixture(); Object.assign(f.state.actions[0], patch);
  await f.adapter.list({ includeAllTypes: true }); await assert.rejects(validate(f.adapter)); assert.equal(f.calls.length, 1);
});

test('duplicate canonical names cannot authorize a validation', async () => {
  const f = await fixture(); f.state.actions.push({ ...f.state.actions[0], id: '457', resourceName: 'customers/1234567890/conversionActions/457' });
  await f.adapter.list({ includeAllTypes: true }); await assert.rejects(validate(f.adapter), { code: 'canonical_conversion_action_required' });
  assert.equal(f.calls.length, 1);
});

for (const change of ['acl', 'grant', 'clinic', 'scopes', 'subject', 'cohort']) {
  for (const when of ['before', 'during']) test(change + ' revoked ' + when + ' validation cannot return success', async () => {
    const f = await fixture(); await f.adapter.list({ includeAllTypes: true });
    const revoke = () => {
      if (change === 'acl') f.state.allowed = false;
      if (change === 'grant') f.options.runtime.account.isActive = false;
      if (change === 'clinic') f.options.models.Clinica.findByPk = async id => ({ id_clinica: id, grupoClinicaId: 5, estado_clinica: false });
      if (change === 'scopes') f.options.models.GoogleConnection.findByPk = async () => ({ id: 2, googleUserId: 'fictitious-subject', scopes: ADS });
      if (change === 'subject') f.options.models.GoogleConnection.findByPk = async () => ({ id: 2, googleUserId: 'changed-subject', scopes: ADS + ' ' + DM });
      if (change === 'cohort') f.state.conversions = false;
    };
    if (when === 'before') revoke(); else f.state.afterCall = revoke;
    await assert.rejects(validate(f.adapter)); assert.equal(f.calls.length, when === 'before' ? 1 : 2);
  });
}

test('warnings and malformed confirmations cannot pass validation; no retry follows a remote error', async () => {
  for (const response of [{ validated: false, warningCount: 1 }, { validated: true, warningCount: 1 },
    { validated: true, warningCount: 0, privateProviderDetail: 'DO_NOT_EXPOSE' }]) {
    const f = await fixture(); await f.adapter.list(); f.state.validation = response;
    await assert.rejects(validate(f.adapter), error => !error.message.includes('DO_NOT_EXPOSE'));
    assert.equal(f.calls.length, 2);
  }
  const f = await fixture(); await f.adapter.list();
  f.state.afterCall = () => { throw Object.assign(Error('PRIVATE_PROVIDER_DETAIL'), { code: 'provider_timeout' }); };
  await assert.rejects(validate(f.adapter), { code: 'provider_timeout', message: 'provider_timeout' }); assert.equal(f.calls.length, 2);
});

test('expired deadline, foreign clinic and serialized context cannot reach the provider', async () => {
  const f = await fixture(); f.state.at = 55000;
  await assert.rejects(f.adapter.list(), { code: 'broker_timeout' });
  f.state.at = 0;
  await assert.rejects(createGoogleAdsOnboardingBroker({ ...f.options, clinicIds: [99] }).list(), { code: 'broker_binding_invalid' });
  await assert.rejects(createGoogleAdsOnboardingBroker({ ...f.options,
    runtime: { ...f.runtime, brokerContext: {} } }).list(), { code: 'broker_binding_invalid' });
  assert.equal(f.calls.length, 0);
});

test('actual endpoint code and scope helper use the broker while ignoring client readiness and event-body fields', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'), 'utf8');
  const helper = source.slice(source.indexOf('async function onboardingBrokerForScope('), source.indexOf('async function ensureConversionActionsInternal('));
  const endpoints = source.slice(source.indexOf('exports.listGoogleAdsConversionActions ='), source.indexOf('exports.ensureGoogleAdsConversionActions ='));
  for (const outcome of ['success', 'acl_removed', 'scope_changed', 'unauthenticated']) {
    const f = await fixture(); let permitted = true; let ids = [71];
    const scope = () => ({ assignment_scope: 'clinic', clinic_id: 71, group_id: 5, clinic_ids: [...ids] });
    const context = { exports: {}, process: { env: {} }, asyncHandler: fn => fn, getUserId: () => outcome === 'unauthenticated' ? null : 7,
      ...require('../../services/googleAdsConversionPreparation.service'), createGoogleAdsOnboardingBroker,
      db: f.options.models, normalizeCustomerId: value => value, GOOGLE_ADS_SCOPE: ADS, GOOGLE_DATA_MANAGER_SCOPE: DM,
      resolveScopeFromInput: async input => {
        // Clinic scope may have a parent group, which must not broaden its ACL.
        assert.equal(input.groupIdRaw == null, true); return scope();
      }, requireMarketingClinicScope: async () => true, hasMarketingClinicScopeAccess: async () => permitted,
      resolveScopedGoogleAdsRuntime: async () => f.runtime,
      listConversionActionsInternal: () => assert.fail('managed endpoint cannot list with a token'),
      uploadGoogleDataManagerConversion: () => assert.fail('managed endpoint cannot use legacy upload') };
    vm.runInNewContext(helper + '\n' + endpoints, context);
    f.state.afterCall = () => {
      if (outcome === 'acl_removed') permitted = false;
      if (outcome === 'scope_changed') ids = [59, 71];
    };
    let status = 200, body;
    const res = { status: value => { status = value; return res; }, json: value => { body = value; return res; } };
    await context.exports.validateGoogleDataManagerConversion({ body: { clinic_id: 71, customer_id: f.mapping.customerId,
      conversion_action_id: '456', event: 'lead', ready: true, validate_only: false, gclid: 'FORGED_REAL_CLICK', email: 'private@example.invalid' } }, res);
    assert.equal(status, outcome === 'success' ? 200 : outcome === 'unauthenticated' ? 401 : 403);
    assert.equal(body.success, outcome === 'success');
    assert.equal(f.calls.length, outcome === 'success' ? 2 : outcome === 'unauthenticated' ? 0 : 1);
    if (outcome === 'success') {
      assert.equal(body.validated, true); assert.equal(body.validate_only, true);
      assert.deepEqual(Object.keys(f.calls[1].payload).sort(), ['conversionActionId', 'eventName', 'eventSource']);
      await context.exports.listGoogleAdsConversionActions({ query: { clinic_id: 71, customer_id: f.mapping.customerId } }, res);
      assert.equal(body.actions[0].id, '456'); assert.equal(f.calls.length, 3);
      assert.equal(body.action_management.mode, 'broker'); assert.equal(body.action_management.enabled, false);
      context.process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED = 'true';
      context.process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED = 'true';
      await context.exports.listGoogleAdsConversionActions({ query: { clinic_id: 71, customer_id: f.mapping.customerId } }, res);
      assert.equal(body.action_management.enabled, true);
      context.process.env.RUNTIME_ROLE = 'gateway';
      await context.exports.listGoogleAdsConversionActions({ query: { clinic_id: 71, customer_id: f.mapping.customerId } }, res);
      assert.equal(body.action_management.mode, 'broker'); assert.equal(body.action_management.enabled, false);
    }
  }
});
