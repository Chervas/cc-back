'use strict';
const path = require('node:path'), net = require('node:net');
const { createPublicKey } = require('node:crypto');
const { fail } = require('./errors'), { validatePolicy } = require('./policy');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const { BrokerStore } = require('./store'), { Broker } = require('./broker'), { createServer } = require('./server');
const { drainAudit } = require('./audit'), tlsReload = require('./tls-reload');
const C = require('./meta-marketing-contract');
const { createMetaMarketingSecrets } = require('./meta-marketing-secrets');
const { createMetaMarketingHttp } = require('./meta-marketing-http');
const { createMetaMarketingOperations } = require('./meta-marketing-operations');
function secretPrefix(environment) { return `/clinicaclick/integrations/prod/meta-marketing/${environment}/`; }
function validateConfig(config) {
  if (config?.tlsRenewal) tlsReload.validateSettings(config.tlsRenewal);
  const keys = 'cohort,enabled,environment,listenAddress,policy,port,stateFile,tlsCertFile,tlsKeyFile'.split(',');
  if (Object.hasOwn(config || {}, 'tlsRenewal')) keys.push('tlsRenewal');
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',') || config.enabled !== true
    || config.cohort !== C.COHORT || !['dev', 'staging'].includes(config.environment) || !net.isIP(config.listenAddress)
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  const policy = validatePolicy(config.policy), reader = `${config.environment}:meta-marketing`, control = `control:${config.environment}:meta-marketing`;
  if (!policy.connections.length || policy.connections.length > 64 || policy.principals.length !== 2
    || ![reader, control].every(id => policy.principals.some(p => p.id === id))
    || policy.principals.some(p => p.maxPerMinute > 60)) fail('invalid_request');
  const publicKeys = policy.principals.map(p => createPublicKey(p.publicKey).export({ type: 'spki', format: 'der' }).toString('base64'));
  if (new Set(publicKeys).size !== publicKeys.length) fail('invalid_request');
  const tokenArns = new Set(), appArns = new Set(), subjects = new Set(), assets = new Set();
  for (const binding of policy.connections) {
    if (Object.keys(binding).sort().join(',') !== 'clientSecretArn,connectionRef,expiresAt,initialState,metaMarketing,provider,secretArn'
      || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0) fail('invalid_request');
    const meta = C.bindingFor(binding), subject = `${meta.appId}:${meta.subjectId}`;
    if (subjects.has(subject) || tokenArns.has(binding.secretArn)) fail('invalid_request');
    subjects.add(subject); tokenArns.add(binding.secretArn); appArns.add(binding.clientSecretArn);
    const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${secretPrefix(config.environment)}`;
    for (const arn of [binding.secretArn, binding.clientSecretArn]) {
      if (typeof arn !== 'string' || !arn.startsWith(prefix) || arn.length > 2048
        || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(prefix.length))) fail('invalid_request');
    }
    for (const asset of meta.assets) { if (assets.has(asset.assetRef)) fail('invalid_request'); assets.add(asset.assetRef); }
  }
  if ([...tokenArns].some(arn => appArns.has(arn))) fail('invalid_request');
  const readScopes = new Set(), controlScopes = new Set(), grantedConnections = new Set();
  for (const grant of policy.grants) {
    if (!/^clinic:[1-9][0-9]{0,9}$/.test(grant.tenantRef) || Number(grant.tenantRef.slice(7)) > 2147483647) fail('invalid_request');
    const binding = policy.connections.find(c => c.connectionRef === grant.connectionRef);
    C.resource(binding, grant.assetRef);
    const scope = JSON.stringify([grant.tenantRef, grant.connectionRef, grant.assetRef]);
    if (grant.principalId === reader) {
      if (grant.operations.some(op => !C.OPERATIONS.includes(op)) || readScopes.has(scope)) fail('invalid_request');
      readScopes.add(scope); grantedConnections.add(grant.connectionRef);
    } else {
      if (grant.operations.length !== 1 || grant.operations[0] !== C.REVOKE || controlScopes.has(scope)) fail('invalid_request');
      controlScopes.add(scope);
    }
  }
  if (!readScopes.size || readScopes.size !== controlScopes.size || [...readScopes].some(scope => !controlScopes.has(scope))
    || grantedConnections.size !== policy.connections.length) fail('invalid_request');
  return config;
}
async function main(filename, { awsFactory = connectAws, http = createMetaMarketingHttp() } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const cert = privateFile(config.tlsCertFile, 65536), key = privateFile(config.tlsKeyFile, 65536);
  const store = new BrokerStore(config.stateFile); let aws, secrets, broker, server, timer, draining;
  try {
    aws = await awsFactory();
    secrets = createMetaMarketingSecrets({ client: aws.secrets, http, accountId: ACCOUNT,
      prefix: secretPrefix(config.environment), kmsKeyArn: SECRET_KEY });
    broker = new Broker({ store, policy: config.policy, secrets, operations: createMetaMarketingOperations({ http, secrets }), timeoutMs: 25000 });
    const controlKey = config.policy.principals.find(p => p.id === `control:${config.environment}:meta-marketing`).keyId;
    let readsInFlight = 0, controlsInFlight = 0;
    server = createServer({ async execute(...args) {
      // The header only selects a bounded lane; Broker still authenticates the
      // signature and restricts the control principal to revocation. Slow reads
      // cannot occupy its one reserved slot.
      const control = args[1]?.['x-broker-key-id'] === controlKey;
      if (control ? controlsInFlight >= 1 : readsInFlight >= 4) fail('rate_limited');
      if (control) controlsInFlight++; else readsInFlight++;
      try { return await broker.execute(...args); }
      finally { if (control) controlsInFlight--; else readsInFlight--; }
    } }, { cert, key });
    server.maxConnections = 32; server.timeout = 35000; tlsReload.install(server, config, { cert, key });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.listenAddress, resolve); });
    const tick = () => { if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; }); };
    tick(); timer = setInterval(tick, 1000); timer.unref();
    let closing;
    const close = () => closing ||= (async () => {
      clearInterval(timer); secrets.close();
      for (const controllers of broker.active.values()) for (const controller of controllers) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
      await draining; aws.close(); key.fill(0); store.close();
    })();
    return { server, store, broker, close };
  } catch (error) { clearInterval(timer); server?.close(); secrets?.close(); aws?.close(); key.fill(0); store.close(); throw error; }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('META_MARKETING_BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig, secretPrefix };
