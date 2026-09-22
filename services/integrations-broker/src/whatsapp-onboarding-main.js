'use strict';
const tlsReload = require('./tls-reload');
const path = require('node:path'); const net = require('node:net'); const { createPublicKey } = require('node:crypto');
const { fail } = require('./errors'); const { validatePolicy } = require('./policy'); const C = require('./whatsapp-onboarding-contract');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const { BrokerStore } = require('./store'); const { Broker } = require('./broker'); const { createServer } = require('./server');
const { drainAudit } = require('./audit'); const { createWhatsappHttp } = require('./whatsapp-http');
const { createWhatsappOnboardingSecrets } = require('./whatsapp-onboarding-secrets'); const { createWhatsappOnboarding } = require('./whatsapp-onboarding');
const P = require('./whatsapp-provisioning-contract'); const { createWhatsappProvisioning } = require('./whatsapp-onboarding-provisioning');
function validateConfig(config) {
  if (config?.tlsRenewal) tlsReload.validateSettings(config.tlsRenewal);
  const configKeys = [...(Object.hasOwn(config || {}, 'tlsRenewal') ? ['tlsRenewal'] : []),'cohort','enabled','listenAddress','policy','port','stateFile','tlsCertFile','tlsKeyFile', ...(Object.hasOwn(config || {}, 'provisioning') ? ['provisioning'] : [])];
  if (Object.hasOwn(config || {}, 'activationEnabled')) { configKeys.push('activationEnabled'); if (typeof config.activationEnabled !== 'boolean') fail('invalid_request'); }
  if (Object.hasOwn(config || {}, 'activationScopesFile')) {configKeys.push('activationScopesFile');if(typeof config.activationScopesFile!=='string'||!path.isAbsolute(config.activationScopesFile))fail('invalid_request');}
  if(config?.activationEnabled&&!config.activationScopesFile)fail('invalid_request');
  if (!config || Object.keys(config).sort().join(',') !== configKeys.sort().join(',')
    || config.enabled !== true || config.cohort !== C.COHORT || !net.isIP(config.listenAddress)
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  const policy = validatePolicy(config.policy);
  if (!policy.connections.length && !config.provisioning || policy.connections.length > 64 || policy.principals.length !== 2 || policy.principals.some(p => p.maxPerMinute > 60)) fail('invalid_request');
  if (config.provisioning) P.validateSettings(config.provisioning);
  const names = new Set(policy.principals.map(p => p.id));
  if (!names.has('gateway:whatsapp-onboarding') || !names.has('control:whatsapp-onboarding')) fail('invalid_request');
  const keys = policy.principals.map(p => createPublicKey(p.publicKey).export({ type: 'spki', format: 'der' }).toString('base64'));
  if (new Set(keys).size !== 2) fail('invalid_request');
  const slots = new Set(); const apps = new Set(); const scopes = new Set();
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`;
  for (const binding of policy.connections) {
    if (Object.keys(binding).sort().join(',') !== 'clientSecretArn,connectionRef,expiresAt,initialState,provider,secretArn,whatsappOnboarding'
      || binding.expiresAt !== null && (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0)) fail('invalid_request');
    const b = C.bindingFor(binding);
    if (slots.has(binding.secretArn) || scopes.has(b.scopeKey)) fail('invalid_request');
    slots.add(binding.secretArn); apps.add(binding.clientSecretArn); scopes.add(b.scopeKey);
    for (const arn of [binding.secretArn, binding.clientSecretArn]) if (!arn.startsWith(prefix) || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(prefix.length))) fail('invalid_request');
    const grants = policy.grants.filter(g => g.connectionRef === binding.connectionRef);
    if (grants.length !== 2 || new Set(grants.map(g => g.principalId)).size !== 2) fail('invalid_request');
    for (const grant of grants) {
      const principal = policy.principals.find(p => p.id === grant.principalId);
      try { for (const operation of grant.operations) C.authorize({ request: { ...grant, operation }, binding, principal }); }
      catch { fail('invalid_request'); }
      const expected = principal.id === 'gateway:whatsapp-onboarding' ? Object.values(C.OPERATIONS) : [C.OPERATIONS.status, C.OPERATIONS.abort, C.REVOKE];
      if (JSON.stringify([...grant.operations].sort()) !== JSON.stringify(expected.sort())) fail('invalid_request');
    }
  }
  if ([...slots].some(arn => apps.has(arn))) fail('invalid_request');
  return config;
}
async function main(filename, { awsFactory = connectAws, http = createWhatsappHttp(), activationHttp = require('./whatsapp-activation-http').createActivationHttp(), exchangeFactory } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const cert = privateFile(config.tlsCertFile, 65536); const key = privateFile(config.tlsKeyFile, 65536);
  const store = new BrokerStore(config.stateFile); let aws; let engine; let server; let timer; let draining;
  try {
    aws = await awsFactory();
    const secrets = createWhatsappOnboardingSecrets({ client: aws.secrets, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY });
    const provisioner = config.provisioning ? createWhatsappProvisioning({ store, policy: config.policy, settings: config.provisioning, client: aws.secrets }) : null;
    engine = createWhatsappOnboarding({ store, policy: config.policy, secrets, http, resolveBinding: provisioner?.resolveBinding, ...(exchangeFactory ? { exchangeFactory } : {}) });
    const A = require('./whatsapp-activation-contract');
    const activation = config.activationEnabled ? require('./whatsapp-activation').createWhatsappActivation({
      store, filename:config.stateFile, policy:config.policy, resolveBinding:provisioner?.resolveBinding,
      client:aws.secrets, accountId:ACCOUNT, kmsKeyArn:SECRET_KEY, http:activationHttp,
      publishCapture:appId=>{const reader=require('./whatsapp-activation-reader').createActivationReader(config.stateFile);
        try{require('./whatsapp-capture-catalog').publish(config.activationScopesFile,appId,reader.scopes(appId));}finally{reader.close();}},
    }) : null;
    const resolver = { resolve(request, principal, policy) {
      if (!activation || !A.OPERATIONS.includes(request.operation)) return provisioner?.resolve(request,principal,policy) || policy;
      const binding=policy.connections.find(b=>b.connectionRef===request.connectionRef)||provisioner?.resolveBinding(request.connectionRef);
      if (!binding || principal.id!=='gateway:whatsapp-onboarding') fail('scope_denied');
      C.authorize({request,principal,binding});
      return {...policy,connections:policy.connections.some(b=>b.connectionRef===binding.connectionRef)?policy.connections:[...policy.connections,binding],
        grants:[...policy.grants,{principalId:principal.id,connectionRef:binding.connectionRef,tenantRef:request.tenantRef,assetRef:request.assetRef,operations:[request.operation]}]};
    } };
    const broker = new Broker({ store, policy: config.policy, secrets, operations: {...engine.operations,...activation?.operations}, policyResolver: resolver }); let inFlight = 0;
    server = createServer({ async execute(...args) { if (inFlight >= 12) fail('rate_limited'); inFlight++;
      try {
        let prepare = false;
        try { prepare = !!provisioner && JSON.parse(args[0].toString('utf8')).operation === P.PREPARE; } catch {}
        return await (prepare ? provisioner.prepare(...args) : broker.execute(...args));
      } finally { inFlight--; } } }, { cert, key });
    server.maxConnections = 64; server.timeout = 35000;
    tlsReload.install(server, config, { cert, key });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.listenAddress, resolve); });
    const tick = () => { if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; }); };
    tick(); timer = setInterval(tick, 1000); timer.unref(); let closing;
    const close = () => closing ||= (async () => { clearInterval(timer); engine.close();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }); await draining;
      aws.close(); key.fill(0); store.close(); })();
    return { server, store, broker, close };
  } catch (error) { clearInterval(timer); engine?.close(); server?.close(); aws?.close(); key.fill(0); store.close(); throw error; }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; }); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('WHATSAPP_ONBOARDING_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
