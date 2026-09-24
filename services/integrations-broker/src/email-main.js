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
const { createEmailHttp } = require('./email-http');
const { createEmailOperations } = require('./email-operation');
const L = require('./email-limits');
const { drainAudit } = require('./audit');
const tlsReload = require('./tls-reload');

function validateConfig(config) {
  const keys = ['cohort', 'enabled', 'environment', 'listenAddress', 'policy', 'port', 'stateFile', 'tlsCertFile', 'tlsKeyFile'];
  if (config?.tlsRenewal) { keys.push('tlsRenewal'); tlsReload.validateSettings(config.tlsRenewal); }
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',')
    || !['email-ses-transactional-v1', 'email-ses-v2'].includes(config.cohort) || config.enabled !== true || !['dev', 'staging', 'prod'].includes(config.environment)
    || !net.isIP(config.listenAddress) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  validatePolicy(config.policy);
  const ref = `email:${config.environment}`;
  const prefix = config.environment === 'dev' ? '/clinicaclick/integrations/dev/' : '/clinicaclick/integrations/prod/';
  if (config.policy.audience !== `clinicaclick:email:${config.environment}:v1`
    || config.policy.connections.length !== 1 || config.policy.principals.length !== 1 || !config.policy.grants.length
    || config.policy.principals[0].id !== ref) fail('invalid_request');
  const binding = config.policy.connections[0];
  if (binding.connectionRef !== ref || binding.provider !== L.PROVIDER
    || !binding.secretArn?.startsWith(`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${prefix}email/ses/`)
    || Object.keys(binding).some(key => !['connectionRef', 'provider', 'initialState', 'expiresAt', 'secretArn', 'email'].includes(key))
    || binding.email.recipientAllowlist.some(address => address !== address.toLowerCase())
    || binding.email.registeredAccountTemplates.some(template => !binding.email.templates.includes(template))
    || config.environment === 'dev' && config.cohort === 'email-ses-transactional-v1'
      && binding.email.templates.some(template => !L.AUTH_TEMPLATES.includes(template))) fail('invalid_request');
  for (const grant of config.policy.grants) {
    const identityGrant = grant.assetRef === 'email:identity-management';
    if (grant.principalId !== ref || grant.connectionRef !== ref || grant.tenantRef !== `platform:${config.environment}`
      || !(binding.email.templates.some(template => grant.assetRef === `email:${template}`)
        || grant.assetRef === 'email:identity-management')
      || !grant.operations.length || grant.operations.some(operation => !L.isEmailOperation(operation))
      || identityGrant && grant.operations.some(operation => operation === L.OPERATION)
      || !identityGrant && grant.operations.some(operation => operation !== L.OPERATION)) fail('invalid_request');
  }
  return config;
}
async function main(filename, { awsFactory = connectAws, http = createEmailHttp() } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const tls = { cert: privateFile(config.tlsCertFile, 65536), key: privateFile(config.tlsKeyFile, 65536) };
  const store = new BrokerStore(config.stateFile);
  let aws, server, broker, timer, draining;
  try {
    aws = await awsFactory();
    const secrets = createAwsSecretStore({ client: aws.secrets, accountId: ACCOUNT, kmsKeyArn: SECRET_KEY,
      prefix: config.environment === 'dev' ? '/clinicaclick/integrations/dev/' : '/clinicaclick/integrations/prod/' });
    broker = new Broker({ store, policy: config.policy, secrets, operations: createEmailOperations({ store, http }),
      transportProfile: 'email', timeoutMs: L.MAX_PROVIDER_TIMEOUT_MS + 5000 });
    server = createServer(broker, tls, { transportProfile: 'email' });
    server.maxConnections = 4;
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
}).catch(() => { process.stderr.write('EMAIL_BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
