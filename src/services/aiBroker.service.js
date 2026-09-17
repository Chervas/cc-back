'use strict';

// Application side: signing identity only. Provider keys stay in the AWS runtime.
const fs = require('node:fs');
const path = require('node:path');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const { OPERATIONS, MAX_TIMEOUT_MS } = require('../../services/integrations-broker/src/ai-limits');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function privateFile(filename) {
  try {
    if (!filename || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error();
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) throw Error();
    return fs.readFileSync(filename);
  } catch { fail('broker_configuration_invalid'); }
}
function createAiBroker({ env = process.env, clientFactory = createIntegrationsBrokerClient, readFile = privateFile } = {}) {
  let client;
  const enabled = provider => Object.hasOwn(OPERATIONS, provider) && env[`AI_BROKER_${provider.toUpperCase()}_ENABLED`] === 'true';
  return {
    enabled,
    async execute(provider, useCase, body, { timeoutMs = 90000, requestId } = {}) {
      if (!enabled(provider)) fail('provider_disabled');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) fail('invalid_request');
      const environment = env.AI_BROKER_ENVIRONMENT;
      const connectionRef = env[`AI_BROKER_${provider.toUpperCase()}_CONNECTION_REF`];
      if (!['dev', 'staging', 'prod'].includes(environment) || !connectionRef) fail('broker_configuration_invalid');
      // An enabled broker never falls back to the local provider key after a failure.
      client ||= clientFactory({ origin: env.AI_BROKER_ORIGIN, audience: env.AI_BROKER_AUDIENCE,
        keyId: env.AI_BROKER_KEY_ID, privateKey: readFile(env.AI_BROKER_KEY_FILE), ca: readFile(env.AI_BROKER_CA_FILE),
        transportProfile: 'ai', timeoutMs: MAX_TIMEOUT_MS });
      const result = await client.execute({ ...(requestId ? { requestId } : {}), operation: OPERATIONS[provider],
        connectionRef, tenantRef: `platform:${environment}`, assetRef: `ai:${useCase}`, payload: { useCase, timeoutMs, body } },
      { timeoutMs: Math.min(MAX_TIMEOUT_MS, timeoutMs + 10000) }).catch(error => {
        // Preserve the existing UI's fixed status classification, without provider bodies/headers.
        const status = { provider_unauthorized: 401, rate_limited: 429 }[error.code];
        if (status) error.response = { status };
        throw error;
      });
      return { data: result.data };
    },
  };
}
module.exports = { ...createAiBroker(), createAiBroker };
