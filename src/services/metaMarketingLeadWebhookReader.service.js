'use strict';

// Public ingress has its own principal/key and two operations. It cannot read
// contacts, Ads, subscriptions or controls and never enables the API reader.
const path = require('node:path');
const L = require('../../services/integrations-broker/src/meta-marketing-leads-contract');
const { isGatewayRuntime, resolveEnqueueRuntimeNamespace } = require('../lib/gatewayJobOwnership');
const { createConfiguredMetaMarketingClient } = require('./metaMarketingBrokerReader.service');
const { createMetaMarketingLeadReader } = require('./metaMarketingLeadReader.service');
const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository } = require('./metaMarketingBrokerScope.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)
  && Number(value) <= 2147483647;

function receiverConfiguration(env = process.env) {
  if (env.META_MARKETING_LEADGEN_RECEIVER_ENABLED !== 'true') fail('meta_leads_disabled');
  if (!isGatewayRuntime(env)) fail('broker_configuration_invalid');
  let namespace;
  try {
    namespace = resolveEnqueueRuntimeNamespace(env.JOB_RUNTIME_NAMESPACE || env.RUNTIME_NAMESPACE || 'gateway',
      env.META_LEAD_JOB_RUNTIME_NAMESPACE || env.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE, env);
  } catch { fail('broker_configuration_invalid'); }
  // The existing Gateway job-owner gate also rejects DEV/local execution.
  if (!['dev', 'staging'].includes(namespace) || typeof env.META_APP_ID !== 'string'
    || !/^[1-9][0-9]{0,29}$/.test(env.META_APP_ID)) fail('broker_configuration_invalid');
  const current = { origin: env.META_MARKETING_LEADS_BROKER_ORIGIN,
    audience: env.META_MARKETING_LEADS_BROKER_AUDIENCE, keyId: env.META_MARKETING_LEADS_BROKER_KEY_ID,
    keyFile: env.META_MARKETING_LEADS_BROKER_KEY_FILE, caFile: env.META_MARKETING_LEADS_BROKER_CA_FILE,
    appId: env.META_APP_ID, namespace,
    verifyPage: env.META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID ?? null,
    verifyAccount: env.META_MARKETING_LEADGEN_VERIFY_AD_ACCOUNT_ASSET_ID ?? null };
  let origin;
  try { origin = new URL(current.origin); } catch { fail('broker_configuration_invalid'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(current.audience || '')
    || current.keyId !== L.ingressPrincipal(namespace)
    || ![current.keyFile, current.caFile].every(filename => typeof filename === 'string' && path.isAbsolute(filename)
      && path.resolve(filename) === filename)) fail('broker_configuration_invalid');
  return current;
}

function pinnedConfiguration(env) {
  let captured;
  return () => {
    const current = receiverConfiguration(env);
    if (captured && JSON.stringify(current) !== JSON.stringify(captured)) fail('broker_configuration_invalid');
    captured = current;
    return current;
  };
}

function createConfiguredMetaLeadWebhookClient({ env = process.env, createClient } = {}) {
  const configured = pinnedConfiguration(env);
  // The existing file/TLS/signature adapter reads only the dedicated prefix.
  // Its private file checks and configuration-change fence remain intact.
  let client;
  return { execute(command, budget) {
    const current = configured();
    if (!L.RECEPTION_OPERATIONS.includes(command?.operation)) fail('operation_denied');
    if (!client) client = createConfiguredMetaMarketingClient({ env: {
      META_MARKETING_BROKER_ORIGIN: current.origin,
      META_MARKETING_BROKER_AUDIENCE: current.audience,
      META_MARKETING_BROKER_KEY_ID: current.keyId,
      META_MARKETING_BROKER_KEY_FILE: current.keyFile,
      META_MARKETING_BROKER_CA_FILE: current.caFile,
    }, transportProfile: 'meta-marketing', ...(createClient ? { createClient } : {}) });
    return client.execute(command, budget);
  } };
}

function createMetaLeadWebhookReader({ scope, client, env = process.env, loadRoute, now } = {}) {
  if (typeof scope?.prepare !== 'function' || typeof scope?.assertContext !== 'function'
    || typeof client?.execute !== 'function') fail('broker_configuration_invalid');
  const configured = pinnedConfiguration(env);
  const metadata = { prepare: async id => { configured(); return scope.prepare(id); },
    assertContext: async context => {
      const before = configured(), state = await scope.assertContext(context);
      configured();
      if (state.appId !== before.appId) fail('scope_denied');
      return state;
    } };
  const reader = createMetaMarketingLeadReader({ scope: metadata, client, enabled: () => {
    if (env.META_MARKETING_LEADGEN_RECEIVER_ENABLED !== 'true') return false;
    configured(); return true;
  }, ...(loadRoute ? { loadRoute } : {}), ...(now ? { now } : {}) });
  const preparePair = (pageId, accountId, options) => reader.preparePair(pageId, accountId, options);
  return {
    preparePair,
    assertPair: (pair, options) => reader.assertPair(pair, options),
    async verificationPair() {
      configured();
      const page = env.META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID;
      const account = env.META_MARKETING_LEADGEN_VERIFY_AD_ACCOUNT_ASSET_ID;
      if (!positive(page) || !positive(account) || page === account) fail('broker_configuration_invalid');
      const pair = await preparePair(Number(page), Number(account));
      await reader.assertPair(pair);
      return pair;
    },
    async read(pair, family, payload, options) {
      configured();
      if (!['challenge', 'receiptAccept'].includes(family)) fail('operation_denied');
      return reader.read(pair, family, payload, options);
    },
  };
}

const instances = new WeakMap();
function forWebhookModels(models, { env = process.env } = {}) {
  if (!models || typeof models !== 'object' || !env || typeof env !== 'object') fail('broker_configuration_invalid');
  if (!instances.has(models)) instances.set(models, new WeakMap());
  const byEnvironment = instances.get(models);
  if (!byEnvironment.has(env)) {
    const scope = createMetaMarketingBrokerScope({ ...createMetaMarketingScopeRepository(() => models),
      enabled: () => {
        if (env.META_MARKETING_LEADGEN_RECEIVER_ENABLED !== 'true') return false;
        receiverConfiguration(env); return true;
      } });
    byEnvironment.set(env, createMetaLeadWebhookReader({ scope, client: createConfiguredMetaLeadWebhookClient({ env }), env,
      loadRoute: (page, account, transaction) => require('./metaLeadRoutes.service').loadRoute({ models, page, account, transaction }) }));
  }
  return byEnvironment.get(env);
}
module.exports = { receiverConfiguration, createConfiguredMetaLeadWebhookClient, createMetaLeadWebhookReader, forWebhookModels };
