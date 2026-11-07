'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMetaMarketingLeadReader, cooldownWait } = require('../../services/metaMarketingLeadReader.service');
const { metaLeadCooldownError } = require('../../lib/integrationsBrokerClient');
const { createBrokerCooldownWait, retryBudgetProof, inspectRetryBudgetProof } = require('../../lib/metaLeadBrokerCooldown');
const L = require('../../../services/integrations-broker/src/meta-marketing-leads-contract');
const { routes, loadRoute } = require('../../services/metaLeadRoutes.service');
const fail = code => Object.assign(Error(code), { code });
const event = { lead_id: '100', page_id: '200', form_id: '300', ad_id: '400' };
const receiptRef = '11111111-1111-4111-8111-111111111111';
const usage = { usagePct: 1, nextAllowedAt: 0, pauseUntil: 0 };
function fixture() {
  const state = { enabled: true, commands: [], blocked: false, route: null, routeVersion: 1, checks: 0, txChecks: 0 };
  const states = id => ({ mappingId: id, kind: id === 10 ? 'facebook_page' : 'ad_account', id: id === 10 ? '200' : '500',
    assetRef: id === 10 ? 'meta-facebook_page:200' : 'meta-ad_account:500', connectionId: 1, connectionRef: 'meta:fixture',
    appId: '900', subjectId: '800', enrollmentHash: 'immutable', scopeKey: 'group:28', tenantRef: 'clinic:5', clinicIds: [5, 6] });
  const contexts = new WeakMap();
  const scope = { prepare: async id => { const context = {}; contexts.set(context, id); return context; }, assertContext: async context => {
    state.checks++; if (state.blocked) throw fail('asset_revoked');
    return { ...states(contexts.get(context)), ...(state.change || {}) };
  } };
  state.data = { event, lead: { id: '100', form_id: '300', ad_id: '400', campaign_id: '600', created_time: '2026-11-05T10:00:00Z',
    is_organic: false, field_data: [{ name: 'full_name', values: ['QA Person'] }, { name: 'email', values: ['qa@example.invalid'] }] },
  identity: { account_id: '500', campaign_id: '600', ad_id: '400', adset_id: '700' }, recipientClinicId: null, usage };
  const reader = createMetaMarketingLeadReader({ scope, enabled: () => state.enabled,
    loadRoute: async () => ({ recipientClinicId: state.route, digest: String(state.routeVersion) }),
    transactionStates: async (pageId, accountId, transaction) => {
      assert.equal(transaction.fixture, true); state.txChecks++;
      return { page: pageId === null ? null : states(pageId), account: states(accountId) };
    }, client: { execute: async command => {
      state.commands.push(command); await state.onCommand?.();
      if (state.error) throw state.error;
      return { requestId: command.requestId, data: state.data };
    } } });
  return { reader, state };
}
test('Lead reader denies default-disabled and caller-selected credentials, URLs or accounts', async () => {
  const f = fixture(); f.state.enabled = false;
  await assert.rejects(f.reader.preparePair(10, 11), { code: 'meta_leads_disabled' });
  assert.equal(f.state.commands.length, 0); f.state.enabled = true;
  const pair = await f.reader.preparePair(10, 11);
  for (const extra of [{ adAccountAssetRef: 'meta-ad_account:500' }, { token: 'PRIVATE' }, { url: 'https://evil.invalid' }, { leadId: '100' }]) {
    await assert.rejects(f.reader.read(pair, 'receiptRead', { receiptRef, ...extra }), { code: 'invalid_request' });
  }
  assert.equal(f.state.commands.length, 0);
});
test('paired authority is fixed and credential-free; receipt IDs are the only contact lookup input', async () => {
  const f = fixture(), pair = await f.reader.preparePair(10, 11);
  assert.deepEqual(await f.reader.read(pair, 'receiptRead', { receiptRef }), f.state.data);
  assert.deepEqual(f.state.commands[0].payload, { receiptRef, adAccountAssetRef: 'meta-ad_account:500' });
  assert.equal(f.state.commands[0].assetRef, 'meta-facebook_page:200');
  assert(!JSON.stringify(f.state.commands).includes('accessToken'));
});
test('well-shaped response for another page is rejected in every page operation', async () => {
  for (const family of ['form', 'pageStatus', 'pageEnable', 'receiptAccept']) {
    const f = fixture(), pair = await f.reader.preparePair(10, 11);
    const fields = ['leadgen'];
    f.state.data = family === 'form' ? { form: { id: '300', name: 'QA Form', page_id: '201', status: 'ACTIVE' }, usage }
      : family === 'receiptAccept' ? { persisted: true, receipts: [{ receiptRef, event: { ...event, page_id: '201' } }] }
        : { page: { id: '201', has_lead_access: true }, subscription: { subscribed: true, fields,
          revision: L.subscription('900', '201', '500', fields) }, usage };
    const payload = family === 'form' ? { formId: '300' } : family === 'pageEnable' ? { expectedSubscriptionRevision: 'a'.repeat(64) }
      : family === 'receiptAccept' ? { rawBase64: Buffer.from('{}').toString('base64'), signature: 'sha256=' + 'a'.repeat(64) } : {};
    await assert.rejects(f.reader.read(pair, family, payload), { code: 'broker_response_invalid' });
  }
});
test('response extras, unrequested form answers and forged recipient routes cannot escape the reader', async () => {
  for (const mutate of [data => { data.accessToken = 'PRIVATE'; }, data => { data.lead.field_data.push({ name: 'diagnosis', values: ['PRIVATE'] }); },
    data => { data.recipientClinicId = 5; }]) {
    const f = fixture(), pair = await f.reader.preparePair(10, 11); mutate(f.state.data);
    await assert.rejects(f.reader.read(pair, 'receiptRead', { receiptRef }), { code: 'broker_response_invalid' });
  }
});
test('revocation and route edits during provider I/O prevent returning contacts', async () => {
  for (const mutate of [state => { state.blocked = true; }, state => { state.routeVersion++; }]) {
    const f = fixture(), pair = await f.reader.preparePair(10, 11); f.state.onCommand = () => mutate(f.state);
    await assert.rejects(f.reader.read(pair, 'receiptRead', { receiptRef }), error => ['asset_revoked', 'meta_broker_scope_changed'].includes(error.code));
    assert.equal(f.state.commands.length, 1);
  }
});
test('in-transaction revalidation uses the supplied transaction without a separate scope transaction', async () => {
  const f = fixture(), transaction = { fixture: true };
  const pair = await f.reader.preparePair(10, 11, { transaction });
  assert.equal(f.state.checks, 0); assert.equal(f.state.txChecks, 1);
  await f.reader.assertPair(pair, { transaction });
  assert.equal(f.state.checks, 0); assert.equal(f.state.txChecks, 2);
  f.state.routeVersion++;
  await assert.rejects(f.reader.assertPair(pair, { transaction }), { code: 'meta_broker_scope_changed' });
});
test('typed broker cooldown becomes a provenance-bearing wait; raw errors and forged result JSON do not', async () => {
  const f = fixture(), pair = await f.reader.preparePair(10, 11);
  f.state.error = Object.assign(fail('rate_limited'), { retryAfterMs: 7200000, config: { token: 'PRIVATE' } });
  let caught; try { await f.reader.read(pair, 'receiptRead', { receiptRef }); } catch (error) { caught = error; }
  const now = Date.now(), wait = cooldownWait(caught, 'campaign_meta_lead_receive', now);
  assert.equal(+wait.nextAllowedAt, now + 7200000); assert(!JSON.stringify(caught).includes('PRIVATE'));
  const job = { id: 3, type: 'campaign_meta_lead_receive', attempts: 8, max_attempts: 8 };
  const execution = { status: 'waiting', nextRunAt: wait.nextAllowedAt, result: wait };
  const proof = retryBudgetProof(job, execution, now);
  assert.equal(inspectRetryBudgetProof(proof, 3, 8, wait.nextAllowedAt, now).maxAttempts, 8);
  assert.equal(retryBudgetProof(job, { ...execution, result: JSON.parse(JSON.stringify(wait)) }, now), null);
  assert.equal(cooldownWait(f.state.error, job.type), null);
  assert.throws(() => inspectRetryBudgetProof(proof, 3, 9, wait.nextAllowedAt, now), /invalid/);
  assert.throws(() => retryBudgetProof({ ...job, max_attempts: 1000000 }, execution, now), /invalid/);
});
test('cooldown parsing accepts only a bounded integer from exact rate-limit body and consistent header', () => {
  const body = { error: { code: 'rate_limited', retryAfterMs: 42001 } };
  assert.equal(metaLeadCooldownError(body, 429, { 'retry-after': '43' }).retryAfterMs, 42001);
  for (const value of [-1, 0, '42001', 86400001, Infinity, null]) assert.throws(() => metaLeadCooldownError({ error: { code: 'rate_limited', retryAfterMs: value } }, 429), /broker_response_invalid/);
  assert.throws(() => metaLeadCooldownError(body, 429, { 'retry-after': '42' }), /broker_response_invalid/);
  assert.throws(() => metaLeadCooldownError({ ...body, accessToken: 'PRIVATE' }, 429), /broker_response_invalid/);
  assert.equal(metaLeadCooldownError({ error: { code: 'provider_failed', retryAfterMs: 10 } }, 502), null);
});
test('route registry is closed, unique per page and validates active clinic membership', async () => {
  const page = { scopeKey: 'group:29', assetRef: 'meta-facebook_page:200', clinicIds: [66, 72] };
  const account = { scopeKey: page.scopeKey, assetRef: 'meta-ad_account:500', clinicIds: page.clinicIds };
  const route = { pageAssetRef: page.assetRef, adAccountAssetRef: account.assetRef, recipientClinicId: 66 };
  assert.throws(() => routes([route, route]), /route_invalid/);
  assert.throws(() => routes([{ ...route, token: 'PRIVATE' }]), /route_invalid/);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }, calls = [];
  const models = { CampaignWorkspaceSetting: { findOne: async options => { calls.push(options); return { id: 'setting', version: 2, preferences: { meta_lead_routes: [route] } }; } },
    Clinica: { findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 29, estado_clinica: 1 }) } };
  assert.equal((await loadRoute({ models, page, account, transaction })).recipientClinicId, 66);
  assert.equal(calls[0].transaction, transaction); assert.equal(calls[0].lock, 'UPDATE');
  models.Clinica.findByPk = async () => ({ grupoClinicaId: 99, estado_clinica: 1 });
  await assert.rejects(loadRoute({ models, page, account }), /route_invalid/);
});
