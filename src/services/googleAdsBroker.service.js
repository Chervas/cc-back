'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createGoogleAdsBrokerScope, createGoogleAdsScopeRepository, identity } = require('./googleAdsBrokerScope.service');
const { createGoogleAdsBrokerReader, safe } = require('./googleAdsBrokerReader.service');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const fail = code => { throw Object.assign(Error(code), { code }); };
function createGoogleAdsBroker(options) {
  const scope = createGoogleAdsBrokerScope(options);
  const reader = createGoogleAdsBrokerReader({ client: options.client, assertContext: scope.assertContext, ...(options.now ? { now: options.now } : {}) });
  const assert = async (account, context, options) => {
    const captured = await scope.assertContext(context, options); const requested = identity(account);
    if (Object.keys(requested).some(key => requested[key] !== captured[key])) fail('broker_binding_invalid');
    return captured;
  };
  return { prepare: scope.prepare, assert,
    async read(account, context, family, payload, budget) {
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
let cachedClient;
const client = { execute(command, budget) {
  cachedClient ||= createIntegrationsBrokerClient({ origin: process.env.GOOGLE_ADS_BROKER_ORIGIN,
    audience: process.env.GOOGLE_ADS_BROKER_AUDIENCE, keyId: process.env.GOOGLE_ADS_BROKER_KEY_ID,
    privateKey: privateFile(process.env.GOOGLE_ADS_BROKER_KEY_FILE), ca: privateFile(process.env.GOOGLE_ADS_BROKER_CA_FILE), timeoutMs: 30000 });
  return cachedClient.execute(command, budget);
} };
const service = createGoogleAdsBroker({ client, ...createGoogleAdsScopeRepository(() => require('../../models')) });
module.exports = { ...service, createGoogleAdsBroker, safe };
