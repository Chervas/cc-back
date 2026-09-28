'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createGoogleAdsBrokerScope, createGoogleAdsScopeRepository, identity } = require('./googleAdsBrokerScope.service');
const { createGoogleAdsBrokerReader, safe } = require('./googleAdsBrokerReader.service');
const { createGoogleDataManagerBrokerClient } = require('./googleDataManagerBrokerClient.service');
const { createGoogleAdsActionManagementBrokerClient } = require('./googleAdsActionManagementBrokerClient.service');
const { createGoogleDataManagerDestinationsBrokerClient } = require('./googleDataManagerDestinationsBrokerClient.service');
const { createGoogleAdsOptimizationBrokerClient } = require('./googleAdsOptimizationBrokerClient.service');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const fail = code => { throw Object.assign(Error(code), { code }); };
function createGoogleAdsBroker(options) {
  const scope = createGoogleAdsBrokerScope({ ...options, discoveryOnly: false });
  const discoveryScope = createGoogleAdsBrokerScope({ ...options, discoveryOnly: true });
  const reader = createGoogleAdsBrokerReader({ client: options.client, assertContext: scope.assertContext, ...(options.now ? { now: options.now } : {}) });
  const conversions = createGoogleDataManagerBrokerClient({ client: options.client, assertContext: scope.assertContext,
    ...(options.now ? { now: options.now } : {}), ...(options.conversionsEnabled ? { enabled: options.conversionsEnabled } : {}),
    ...(options.receiptReconciliationEnabled ? { reconciliationEnabled: options.receiptReconciliationEnabled } : {}) });
  const actionManagement = createGoogleAdsActionManagementBrokerClient({ client: options.client, assertContext: scope.assertContext,
    ...(options.now ? { now: options.now } : {}), ...(options.actionManagementEnabled ? { enabled: options.actionManagementEnabled } : {}) });
  const destinations = createGoogleDataManagerDestinationsBrokerClient({ client: options.client, assertContext: scope.assertContext,
    ...(options.now ? { now: options.now } : {}), ...(options.destinationsEnabled ? { enabled: options.destinationsEnabled } : {}) });
  const optimization = options.optimizationClient ? createGoogleAdsOptimizationBrokerClient({ client: options.optimizationClient,
    assertContext: scope.assertContext, ...(options.now ? { now: options.now } : {}),
    ...(options.optimizationEnabled ? { enabled: options.optimizationEnabled } : {}) }) : null;
  const discoveryReader = createGoogleAdsBrokerReader({ client: options.client, assertContext: discoveryScope.assertContext, ...(options.now ? { now: options.now } : {}) });
  const check = scope => async (account, context, options) => {
    const captured = await scope.assertContext(context, options); const requested = identity(account);
    if (Object.keys(requested).some(key => requested[key] !== captured[key])) fail('broker_binding_invalid');
    return captured;
  };
  const assert = check(scope); const assertDiscovery = check(discoveryScope);
  return { prepare: scope.prepare, assert, prepareDiscovery: discoveryScope.prepare, assertDiscovery,
    async optimizationAuthority(account, context, options) {
      if (!optimization) fail('broker_cohort_disabled');
      await assert(account, context, options); return optimization.authority(context, options);
    },
    async optimization(account, context, family, input, options) {
      if (!optimization) fail('broker_cohort_disabled');
      await assert(account, context);
      const result = await optimization.execute(context, family, input, options);
      await assert(account, context); return result;
    },
    async destinations(account, context, family, input, options) {
      await assert(account, context);
      const result = await destinations.execute(context, family, input, options);
      await assert(account, context); return result;
    },
    async actionManagement(account, context, family, input, options) {
      await assert(account, context);
      const result = await actionManagement.execute(context, family, input, options);
      await assert(account, context); return result;
    },
    async conversion(account, context, family, input, options) {
      await assert(account, context);
      const result = await conversions.execute(context, family, input, options);
      await assert(account, context); return result;
    },
    async readDiscovery(account, context, budget) {
      await assertDiscovery(account, context);
      const rows = await discoveryReader.read(context, 'discovery', {}, budget);
      await assertDiscovery(account, context); return rows;
    },
    async read(account, context, family, payload, budget) {
      if (family === 'conversion_settings') {
        if (budget?.beforeExecute !== undefined && typeof budget.beforeExecute !== 'function') fail('invalid_request');
        return reader.read(context, family, payload, { ...budget, beforeExecute: async fresh => {
          const requested = identity(account);
          if (Object.keys(requested).some(key => requested[key] !== fresh[key])) fail('broker_binding_invalid');
          await budget?.beforeExecute?.(fresh);
        } });
      }
      await assert(account, context);
      const rows = await reader.read(context, family, payload, budget);
      await assert(account, context); return rows;
    },
  };
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail('broker_configuration_invalid');
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail('broker_configuration_invalid');
    return fs.readFileSync(filename);
  } catch { fail('broker_configuration_invalid'); }
}
function createConfiguredGoogleAdsClient({ env = process.env, readPrivateFile = privateFile, createClient = createIntegrationsBrokerClient } = {}) {
  let cachedClient, cachedConfiguration;
  return { execute(command, budget) {
    const current = { origin: env.GOOGLE_ADS_BROKER_ORIGIN,
      audience: env.GOOGLE_ADS_BROKER_AUDIENCE, keyId: env.GOOGLE_ADS_BROKER_KEY_ID,
      keyFile: env.GOOGLE_ADS_BROKER_KEY_FILE, caFile: env.GOOGLE_ADS_BROKER_CA_FILE };
    if (cachedConfiguration && JSON.stringify(current) !== JSON.stringify(cachedConfiguration)) fail('broker_configuration_invalid');
    cachedClient ||= createClient({ origin: current.origin, audience: current.audience, keyId: current.keyId,
      privateKey: readPrivateFile(current.keyFile), ca: readPrivateFile(current.caFile), timeoutMs: 30000 });
    cachedConfiguration ||= current;
    return cachedClient.execute(command, budget);
  } };
}
const client = createConfiguredGoogleAdsClient();
function createConfiguredGoogleAdsOptimizationClient({ env = process.env, readPrivateFile = privateFile, createClient = createIntegrationsBrokerClient } = {}) {
  let transport, identity, saved;
  const load = () => {
    if (env.GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED !== 'true') fail('broker_cohort_disabled');
    const current = Object.fromEntries(['ORIGIN', 'AUDIENCE', 'KEY_ID', 'KEY_FILE', 'CA_FILE'].map(key => [key, env['GOOGLE_ADS_OPTIMIZATION_BROKER_' + key]]));
    Object.assign(current, { readerKeyId: env.GOOGLE_ADS_BROKER_KEY_ID, readerKeyFile: env.GOOGLE_ADS_BROKER_KEY_FILE });
    if (saved && JSON.stringify(current) !== JSON.stringify(saved)) fail('broker_configuration_invalid');
    if (!transport) {
      try {
        if (!current.readerKeyId || !current.readerKeyFile || current.readerKeyId === current.KEY_ID
          || current.readerKeyFile === current.KEY_FILE) fail('broker_configuration_invalid');
        const crypto = require('node:crypto'); const privateKey = readPrivateFile(current.KEY_FILE), ca = readPrivateFile(current.CA_FILE);
        const publicKey = value => crypto.createPublicKey(value).export({ type: 'spki', format: 'der' }).toString('base64');
        const publicWriter = publicKey(privateKey);
        if (publicWriter === publicKey(readPrivateFile(current.readerKeyFile))) fail('broker_configuration_invalid');
        transport = createClient({ origin: current.ORIGIN, audience: current.AUDIENCE, keyId: current.KEY_ID, privateKey, ca, timeoutMs: 30000 });
        identity = require('../../services/integrations-broker/src/google-optimization-write-contract').hash({
          origin: current.ORIGIN, audience: current.AUDIENCE, key: current.KEY_ID, publicKey: publicWriter,
          ca: crypto.createHash('sha256').update(ca).digest('hex') });
        saved = current;
      } catch { fail('broker_configuration_invalid'); }
    }
    return transport;
  };
  return { identity() { load(); return identity; }, execute(command, budget) { return load().execute(command, budget); } };
}
const optimizationClient = createConfiguredGoogleAdsOptimizationClient();
const service = createGoogleAdsBroker({ client, optimizationClient, ...createGoogleAdsScopeRepository(() => require('../../models')) });
const modelServices = new WeakMap();
function forModels(models) {
  if (!models || typeof models !== 'object') fail('broker_configuration_invalid');
  if (!modelServices.has(models)) modelServices.set(models, createGoogleAdsBroker({ client, optimizationClient, ...createGoogleAdsScopeRepository(() => models) }));
  return modelServices.get(models);
}
module.exports = { ...service, createGoogleAdsBroker, createConfiguredGoogleAdsClient, createConfiguredGoogleAdsOptimizationClient, forModels, safe };
