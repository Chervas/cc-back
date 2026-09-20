'use strict';

// Separate signing identity and endpoint: conversation work cannot occupy the
// audio/OCR service's admission pool. No AWS/provider credential is read here.
const fs = require('node:fs');
const path = require('node:path');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const { OPERATION, REGION, MAX_TIMEOUT_MS } = require('../../services/integrations-broker/src/bedrock-limits');
const { PROVIDER_ERRORS } = require('../../services/integrations-broker/src/bedrock-errors');
const { createBedrockAdmission } = require('../lib/bedrockAdmission');
const ERROR_NAMES = Object.fromEntries(Object.entries(PROVIDER_ERRORS).map(([name, code]) => [code, name]));
const fail = code => { throw Object.assign(new Error(code), { code }); };
function privateFile(filename) {
  try {
    if (!filename || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error();
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) throw Error();
    return fs.readFileSync(filename);
  } catch { fail('broker_configuration_invalid'); }
}
function createBedrockBroker({ env = process.env, clientFactory = createIntegrationsBrokerClient, readFile = privateFile,
  admission = createBedrockAdmission() } = {}) {
  let client;
  const enabled = () => env.BEDROCK_BROKER_ENABLED === 'true';
  return {
    enabled,
    async execute(useCase, body, { timeoutMs = 20000, requestId, beforeDispatch } = {}) {
      if (!enabled()) fail('provider_disabled');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) fail('invalid_request');
      const environment = env.BEDROCK_BROKER_ENVIRONMENT;
      if (!['dev', 'staging', 'prod'].includes(environment) || !env.BEDROCK_BROKER_CONNECTION_REF
        || (env.BEDROCK_REGION || REGION) !== REGION
        || env.BEDROCK_BROKER_AUDIENCE !== `clinicaclick:bedrock:${environment}:v1`) fail('broker_configuration_invalid');
      client ||= clientFactory({ origin: env.BEDROCK_BROKER_ORIGIN, audience: env.BEDROCK_BROKER_AUDIENCE,
        keyId: env.BEDROCK_BROKER_KEY_ID, privateKey: readFile(env.BEDROCK_BROKER_KEY_FILE), ca: readFile(env.BEDROCK_BROKER_CA_FILE),
        transportProfile: 'ai', timeoutMs: MAX_TIMEOUT_MS + 10000 });
      try {
        // Snapshot the native body before waiting, so caller mutation cannot
        // change either context or the memory/admission reservation.
        let command, bytes;
        try {
          const json = JSON.stringify({ ...(requestId ? { requestId } : {}), operation: OPERATION,
            connectionRef: env.BEDROCK_BROKER_CONNECTION_REF, tenantRef: `platform:${environment}`,
            assetRef: `ai:${useCase}`, payload: { useCase, timeoutMs, body } });
          bytes = Buffer.byteLength(json) + 2048; // conservative signed-envelope allowance
          if (bytes > 1024 * 1024) fail('invalid_request');
          command = JSON.parse(json);
        } catch { fail('invalid_request'); }
        const result = await admission.run(async () => {
          if (!enabled()) fail('provider_disabled');
          if (env.BEDROCK_BROKER_ENVIRONMENT !== environment || env.BEDROCK_BROKER_CONNECTION_REF !== command.connectionRef) fail('broker_configuration_invalid');
          if (beforeDispatch) await beforeDispatch();
          if (!enabled()) fail('provider_disabled');
          if (env.BEDROCK_BROKER_ENVIRONMENT !== environment || env.BEDROCK_BROKER_CONNECTION_REF !== command.connectionRef) fail('broker_configuration_invalid');
          return client.execute(command, { timeoutMs: timeoutMs + 10000 });
        }, bytes);
        return result.data;
      } catch (error) {
        // Only actual Bedrock errors keep model fallback eligibility. Broker
        // capacity/auth/secret/audit errors must not trigger another inference.
        if (ERROR_NAMES[error.code]) error.name = ERROR_NAMES[error.code];
        throw error;
      }
    },
  };
}
module.exports = { ...createBedrockBroker(), createBedrockBroker };
