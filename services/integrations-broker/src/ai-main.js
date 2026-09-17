'use strict';

const path = require('node:path');
const net = require('node:net');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const { validatePolicy } = require('./policy');
const { fail } = require('./errors');
const { BrokerStore } = require('./store');
const { Broker } = require('./broker');
const { createServer } = require('./server');
const { createAwsSecretStore } = require('./secrets');
const { createAiHttp } = require('./ai-http');
const { createAiOperations } = require('./ai-operations');
const { OPERATIONS, MAX_TIMEOUT_MS, MAX_CONCURRENT_REQUESTS } = require('./ai-limits');
const { USE_CASES } = require('./ai-contract');
const { drainAudit } = require('./audit');
const tlsReload = require('./tls-reload');

function validateConfig(config) {
  const keys = ['cohort', 'enabled', 'environment', 'listenAddress', 'policy', 'port', 'stateFile', 'tlsCertFile', 'tlsKeyFile'];
  if (config?.tlsRenewal) { keys.push('tlsRenewal'); tlsReload.validateSettings(config.tlsRenewal); }
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',')
    || config.cohort !== 'ai-providers-v1' || config.enabled !== true || !['dev', 'staging', 'prod'].includes(config.environment)
    || !net.isIP(config.listenAddress) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  validatePolicy(config.policy);
  const prefix = config.environment === 'dev' ? '/clinicaclick/integrations/dev/' : '/clinicaclick/integrations/prod/';
  if (!config.policy.connections.length || !config.policy.grants.length) fail('invalid_request');
  for (const binding of config.policy.connections) {
    const provider = binding.provider.replace(/^ai_/, '');
    if (!Object.hasOwn(OPERATIONS, provider) || !binding.ai?.models?.length
      || !binding.secretArn?.startsWith(`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${prefix}ai/`)
      || Object.keys(binding).some(key => !['connectionRef', 'provider', 'initialState', 'expiresAt', 'secretArn', 'ai'].includes(key))) fail('invalid_request');
  }
  for (const grant of config.policy.grants) {
    const provider = config.policy.connections.find(c => c.connectionRef === grant.connectionRef).provider.slice(3);
    if (grant.tenantRef !== `platform:${config.environment}` || !USE_CASES[provider].some(use => grant.assetRef === `ai:${use}`)
      || grant.operations.length !== 1 || grant.operations[0] !== OPERATIONS[provider]) fail('invalid_request');
  }
  return config;
}
async function main(filename, { awsFactory = connectAws, http = createAiHttp() } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const tls = { cert: privateFile(config.tlsCertFile, 65536), key: privateFile(config.tlsKeyFile, 65536) };
  const store = new BrokerStore(config.stateFile);
  let aws, server, broker, timer, draining;
  try {
    aws = await awsFactory();
    const secrets = createAwsSecretStore({ client: aws.secrets, accountId: ACCOUNT, kmsKeyArn: SECRET_KEY,
      prefix: config.environment === 'dev' ? '/clinicaclick/integrations/dev/' : '/clinicaclick/integrations/prod/' });
    broker = new Broker({ store, policy: config.policy, secrets, operations: createAiOperations({ http }),
      transportProfile: 'ai', timeoutMs: MAX_TIMEOUT_MS - 5000 });
    let inFlight = 0;
    server = createServer({ async execute(...args) {
      if (inFlight >= MAX_CONCURRENT_REQUESTS) fail('rate_limited');
      inFlight++;
      try { return await broker.execute(...args); } finally { inFlight--; }
    } }, tls, { transportProfile: 'ai' });
    server.maxConnections = 8;
    tlsReload.install(server, config, tls);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.listenAddress, resolve); });
    const tick = () => { if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; }); };
    tick(); timer = setInterval(tick, 1000); timer.unref();
    let closing;
    const close = () => closing ||= (async () => {
      clearInterval(timer);
      for (const controllers of broker.active.values()) for (const controller of controllers) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
      await draining; aws.close(); store.close();
    })();
    return { server, store, broker, close };
  } catch (error) {
    clearInterval(timer); server?.close(); await draining; aws?.close(); store.close(); throw error;
  }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('AI_BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
