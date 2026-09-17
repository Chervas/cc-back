'use strict';
const tlsReload = require('./tls-reload');
const path = require('node:path'); const net = require('node:net'); const { createPublicKey } = require('node:crypto');
const { fail } = require('./errors'); const { validatePolicy } = require('./policy'); const C = require('./whatsapp-contract');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const { BrokerStore } = require('./store'); const { Broker } = require('./broker'); const { createServer } = require('./server');
const { drainAudit } = require('./audit'); const { createWhatsappSecrets } = require('./whatsapp-secrets');
const { createWhatsappHttp } = require('./whatsapp-http'); const { createWhatsappOperations } = require('./whatsapp-operations');
const { createWhatsappCredentialInspector } = require('./whatsapp-credential-inspector');
function validateConfig(config) {
  if (config?.tlsRenewal) tlsReload.validateSettings(config.tlsRenewal);
  const keys = 'cohort,enabled,listenAddress,policy,port,stateFile,tlsCertFile,tlsKeyFile'.split(',');
  if (Object.hasOwn(config || {}, 'tlsRenewal')) keys.push('tlsRenewal');
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',')
    || config.enabled !== true || config.cohort !== C.COHORT || !net.isIP(config.listenAddress)
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  const policy = validatePolicy(config.policy);
  if (!policy.connections.length || policy.connections.length > 64 || policy.principals.length !== 2) fail('invalid_request');
  const principals = new Map(policy.principals.map(p => [p.id, p]));
  if (!principals.has('staging:whatsapp') || !principals.has('control:whatsapp')
    || policy.principals.some(p => p.maxPerMinute > 60)) fail('invalid_request');
  const principalKeys = policy.principals.map(p => createPublicKey(p.publicKey).export({ type: 'spki', format: 'der' }).toString('base64'));
  if (new Set(principalKeys).size !== principalKeys.length) fail('invalid_request');
  const phones = new Set(); const sendArns = new Set(); const readerArns = new Set(); const appArns = new Set();
  for (const binding of policy.connections) {
    if (Object.keys(binding).sort().join(',') !== 'clientSecretArn,connectionRef,expiresAt,initialState,provider,secretArn,templateReaderSecretArn,whatsapp'
      || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0) fail('invalid_request');
    const meta = C.bindingFor(binding);
    if (meta.subjectId === meta.readerSubjectId || phones.has(meta.phoneId)) fail('invalid_request');
    phones.add(meta.phoneId);
    const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`;
    for (const arn of [binding.secretArn, binding.templateReaderSecretArn, binding.clientSecretArn]) {
      if (typeof arn !== 'string' || !arn.startsWith(prefix) || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(prefix.length))) fail('invalid_request');
    }
    if (sendArns.has(binding.secretArn) || readerArns.has(binding.templateReaderSecretArn)) fail('invalid_request');
    sendArns.add(binding.secretArn); readerArns.add(binding.templateReaderSecretArn); appArns.add(binding.clientSecretArn);
  }
  if ([...sendArns].some(arn => readerArns.has(arn) || appArns.has(arn)) || [...readerArns].some(arn => appArns.has(arn))) fail('invalid_request');
  const sendScopes = new Set(); const controlScopes = new Set();
  for (const grant of policy.grants) {
    const binding = policy.connections.find(c => c.connectionRef === grant.connectionRef);
    const meta = C.bindingFor(binding);
    if (!/^clinic:[1-9][0-9]{0,9}$/.test(grant.tenantRef) || Number(grant.tenantRef.slice(7)) > 2147483647
      || grant.assetRef !== 'wa-phone:' + meta.phoneId) fail('invalid_request');
    const scope = JSON.stringify([grant.tenantRef, grant.connectionRef, grant.assetRef]);
    if (grant.principalId === 'staging:whatsapp') {
      if (grant.operations.some(op => !C.OPERATIONS.includes(op)) || sendScopes.has(scope)) fail('invalid_request');
      if (grant.operations.includes(C.TEMPLATE) && !meta.templates.length) fail('invalid_request');
      sendScopes.add(scope);
    } else {
      if (grant.operations.length !== 1 || grant.operations[0] !== C.REVOKE || controlScopes.has(scope)) fail('invalid_request');
      controlScopes.add(scope);
    }
  }
  if (!sendScopes.size || sendScopes.size !== controlScopes.size || [...sendScopes].some(scope => !controlScopes.has(scope))) fail('invalid_request');
  return config;
}
async function main(filename, { awsFactory = connectAws, http = createWhatsappHttp() } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const cert = privateFile(config.tlsCertFile, 65536); const key = privateFile(config.tlsKeyFile, 65536);
  const store = new BrokerStore(config.stateFile); let aws; let secrets; let broker; let server; let timer; let draining;
  try {
    aws = await awsFactory();
    secrets = createWhatsappSecrets({ client: aws.secrets, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY,
      inspectCredential: createWhatsappCredentialInspector({ http }) });
    broker = new Broker({ store, policy: config.policy, secrets, operations: createWhatsappOperations({ http, secrets }), timeoutMs: 25000 });
    let inFlight = 0;
    server = createServer({ async execute(...args) {
      if (inFlight >= 8) fail('rate_limited'); inFlight++;
      try { return await broker.execute(...args); } finally { inFlight--; }
    } }, { cert, key });
    server.maxConnections = 64; server.timeout = 35000;
    tlsReload.install(server, config, { cert, key });
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
}).catch(() => { process.stderr.write('WHATSAPP_BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
