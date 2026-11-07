'use strict';

// The application receives a closed projection, never provider credentials.
const { createHash, randomUUID } = require('node:crypto');
const L = require('../../services/integrations-broker/src/meta-marketing-leads-contract');
const { createConfiguredMetaMarketingClient, forModels: metadataForModels } = require('./metaMarketingBrokerReader.service');
const { createBrokerCooldownWait } = require('../lib/metaLeadBrokerCooldown');
const SAFE = new Set(['broker_cohort_disabled', 'meta_leads_disabled', 'meta_broker_binding_invalid', 'meta_broker_scope_changed',
  'meta_broker_not_active', 'broker_response_invalid', 'broker_configuration_invalid', 'broker_timeout', 'broker_unavailable',
  'connection_blocked', 'asset_revoked', 'scope_denied', 'operation_denied', 'invalid_request', 'invalid_signature',
  'secret_unavailable', 'secret_version_changed', 'credential_revoked', 'provider_failed', 'provider_timeout', 'provider_unauthorized', 'rate_limited', 'audit_unavailable',
  'meta_lead_receipt_review_required', 'meta_credential_renewal_required','meta_business_activation_uncertain']);
const fail = code => { throw Object.assign(Error(code), { code }); };
const cooldowns = new WeakMap();
function safeError(error) {
  const result = Object.assign(Error(SAFE.has(error?.code) ? error.code : 'broker_response_invalid'), {
    code: SAFE.has(error?.code) ? error.code : 'broker_response_invalid', retryable: false,
  });
  if (result.code === 'rate_limited' && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 1 && error.retryAfterMs <= 86400000) {
    result.retryAfterMs = error.retryAfterMs;
    cooldowns.set(result, error.retryAfterMs);
  }
  return result;
}
function cooldownWait(error, type, now = Date.now()) {
  const delay = error && cooldowns.get(error);
  return delay ? createBrokerCooldownWait(type, delay, now) : null;
}
function createMetaMarketingLeadReader({ scope, client, transactionStates = async () => fail('broker_configuration_invalid'),
  loadRoute = async () => ({ recipientClinicId: null, digest: 'none' }),
  enabled = () => process.env.META_MARKETING_LEADGEN_ENABLED === 'true', now = Date.now }) {
  if (typeof scope?.prepare !== 'function' || typeof scope.assertContext !== 'function'
    || typeof client?.execute !== 'function' || typeof transactionStates !== 'function') fail('broker_configuration_invalid');
  const pairs = new WeakMap();
  const accounts = new WeakMap();
  const digest = states => createHash('sha256').update(JSON.stringify(states)).digest('hex');
  function compatible(page, account) {
    if (page.kind !== 'facebook_page' || account.kind !== 'ad_account'
      || ['appId', 'subjectId', 'enrollmentHash', 'scopeKey', 'connectionRef', 'connectionId', 'tenantRef']
        .some(key => page[key] == null || page[key] !== account[key])
      || JSON.stringify(page.clinicIds) !== JSON.stringify(account.clinicIds)) fail('scope_denied');
  }
  async function assertPair(pair, { transaction = null } = {}) {
    if (!enabled()) fail('meta_leads_disabled');
    const captured = pairs.get(pair);
    if (!captured) fail('meta_broker_binding_invalid');
    if (!transaction && !captured.page) {
      captured.page = await scope.prepare(captured.pageMappingId);
      captured.account = await scope.prepare(captured.accountMappingId);
    }
    const { page, account } = transaction
      ? await transactionStates(captured.pageMappingId, captured.accountMappingId, transaction)
      : { page: await scope.assertContext(captured.page), account: await scope.assertContext(captured.account) };
    compatible(page, account);
    const route = await loadRoute(page, account, transaction);
    if (captured.fingerprint && captured.fingerprint !== digest([page, account, route])) fail('meta_broker_scope_changed');
    if (!enabled()) fail('meta_leads_disabled');
    return { page, account, route, fingerprint: digest([page, account, route]) };
  }
  async function preparePair(pageMappingId, accountMappingId, { transaction = null } = {}) {
    if (!enabled()) fail('meta_leads_disabled');
    const pair = Object.freeze({});
    pairs.set(pair, { pageMappingId: Number(pageMappingId), accountMappingId: Number(accountMappingId),
      page: transaction ? null : await scope.prepare(pageMappingId), account: transaction ? null : await scope.prepare(accountMappingId) });
    const current = await assertPair(pair, { transaction });
    pairs.get(pair).fingerprint = current.fingerprint;
    return pair;
  }
  async function prepareAccount(mappingId, { transaction = null } = {}) {
    if (!enabled()) fail('meta_leads_disabled');
    const context = Object.freeze({});
    const scopeContext = transaction ? null : await scope.prepare(mappingId);
    const state = transaction ? (await transactionStates(null, Number(mappingId), transaction)).account : await scope.assertContext(scopeContext);
    if (state.kind !== 'ad_account') fail('scope_denied');
    accounts.set(context, { mappingId: Number(mappingId), fingerprint: digest(state), scopeContext });
    return context;
  }
  async function assertAccount(context, { transaction = null } = {}) {
    if (!enabled()) fail('meta_leads_disabled');
    const expected = accounts.get(context);
    if (!expected) fail('meta_broker_binding_invalid');
    if (!transaction && !expected.scopeContext) expected.scopeContext = await scope.prepare(expected.mappingId);
    const state = transaction ? (await transactionStates(null, expected.mappingId, transaction)).account : await scope.assertContext(expected.scopeContext);
    if (state.kind !== 'ad_account' || digest(state) !== expected.fingerprint) fail('meta_broker_scope_changed');
    return state;
  }
  async function read(pair, family, payload = {}, { timeoutMs = 30000, requestId = randomUUID() } = {}) {
    let observed;
    try {
      const operation = L.OPERATIONS[family];
      if (!operation || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_request');
      const deadline = now() + timeoutMs;
      const before = await assertPair(pair); observed = before.page;
      const full = { ...payload, adAccountAssetRef: before.account.assetRef };
      // Callers may not supply authority, even when it happens to match.
      if (Object.hasOwn(payload, 'adAccountAssetRef')) fail('invalid_request');
      L.validate(operation, full);
      if (now() >= deadline) fail('broker_timeout');
      const response = await client.execute({ requestId, operation, connectionRef: before.page.connectionRef,
        assetRef: before.page.assetRef, tenantRef: before.page.tenantRef, payload: full }, { timeoutMs: deadline - now() });
      await assertPair(pair);
      if (now() >= deadline) fail('broker_timeout');
      if (response?.requestId !== requestId) fail('broker_response_invalid');
      try { L.validateResponse(operation, response.data, full); } catch { fail('broker_response_invalid'); }
      if (family === 'form' && response.data.form.page_id !== before.page.id
        || ['pageStatus', 'pageEnable'].includes(family) && response.data.page.id !== before.page.id
        || family === 'receiptAccept' && response.data.receipts.some(receipt => receipt.event.page_id !== before.page.id)) fail('broker_response_invalid');
      if (['pageStatus', 'pageEnable'].includes(family) && response.data.subscription.revision
        !== L.subscription(before.page.appId, before.page.id, before.account.id, response.data.subscription.fields)) fail('broker_response_invalid');
      if (family === 'receiptRead') {
        if (response.data.event.page_id !== before.page.id || response.data.identity
          && response.data.identity.account_id !== before.account.id
          || response.data.recipientClinicId !== before.route.recipientClinicId) fail('broker_response_invalid');
      }
      return structuredClone(response.data);
    } catch (error) {
      if (observed && typeof scope.recordCredentialFailure === 'function') try { await scope.recordCredentialFailure(observed, error); } catch {}
      throw safeError(error);
    }
  }
  return { preparePair, assertPair, prepareAccount, assertAccount, read };
}
const instances = new WeakMap();
function forModels(models) {
  if (!models || typeof models !== 'object') fail('broker_configuration_invalid');
  if (!instances.has(models)) instances.set(models, createMetaMarketingLeadReader({
    scope: metadataForModels(models), client: createConfiguredMetaMarketingClient({ transportProfile: 'meta-marketing' }),
    loadRoute: (page, account, transaction) => require('./metaLeadRoutes.service').loadRoute({ models, page, account, transaction }),
    transactionStates: async (pageId, accountId, transaction) => {
      const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository } = require('./metaMarketingBrokerScope.service');
      // Lock the common enrollment first, before either Page. Different pages
      // sharing one account cannot each hold a page row while waiting for the
      // other's enrollment validation. Discovery is metadata only; the locked
      // scope below rechecks its complete identity and immutable fingerprint.
      const owner = await models.MetaMarketingBrokerBinding.findAll({ where: { mapping_id: accountId },
        attributes: ['enrollment_id'], raw: true, transaction, logging: false, limit: 2 });
      if (owner.length !== 1 || !owner[0].enrollment_id) fail('meta_broker_binding_invalid');
      const enrolled = await models.MetaMarketingEnrollmentRequest.findByPk(owner[0].enrollment_id,
        { attributes: ['enrollment_id'], raw: true, transaction, lock: transaction.LOCK.UPDATE, logging: false });
      if (!enrolled) fail('meta_broker_binding_invalid');
      const scoped = createMetaMarketingBrokerScope(createMetaMarketingScopeRepository(() => models, { transaction }));
      const page = pageId === null ? null : await scoped.prepare(pageId), account = await scoped.prepare(accountId);
      return { page: page === null ? null : await scoped.assertContext(page), account: await scoped.assertContext(account) };
    },
  }));
  return instances.get(models);
}
module.exports = { createMetaMarketingLeadReader, forModels, cooldownWait };
