'use strict';
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net'); const tls = require('node:tls');
const { createPublicKey } = require('node:crypto'); const { fail } = require('./errors'); const { validatePolicy } = require('./policy');
const M = require('./whatsapp-template-management');
const C = require('./whatsapp-authorized-contract'); const E = require('./whatsapp-onboarding-contract');
const { privateFile, connectAws, ACCOUNT, SECRET_KEY } = require('./google-main');
const { validateConfig: validateEnrollmentConfig } = require('./whatsapp-onboarding-main');
const { BrokerStore } = require('./store'); const { Broker } = require('./broker'); const { createServer } = require('./server');
const { drainAudit } = require('./audit');
const { validateAuthorization, createWhatsappAuthorizedRegistry } = require('./whatsapp-authorized-registry');
const { createWhatsappAuthorizedSecrets } = require('./whatsapp-authorized-secrets');
const { createWhatsappAuthorizedHttp } = require('./whatsapp-authorized-http');
const { createWhatsappAuthorizedOperations } = require('./whatsapp-authorized-operations');
const CONFIG_KEYS = ['cohort','enabled','listenAddress','port','stateFile','tlsCertFile','tlsKeyFile','policy',
  'enrollmentConfigFile','enrollmentStateFile','authorizations'];
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
function validateConfig(config) {
  if (!C.keys(config, CONFIG_KEYS) || config.enabled !== true || config.cohort !== C.COHORT || !net.isIP(config.listenAddress)
    || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || !['stateFile','tlsCertFile','tlsKeyFile','enrollmentConfigFile','enrollmentStateFile'].every(k => absolute(config[k]))
    || new Set([config.stateFile,config.enrollmentStateFile,config.enrollmentConfigFile,config.tlsKeyFile,config.tlsCertFile]).size !== 5
    || !Array.isArray(config.authorizations) || !config.authorizations.length || config.authorizations.length > 64) fail('invalid_request');
  const policy = validatePolicy(config.policy);
  if (policy.principals.length !== 2 || policy.principals.some(p => p.maxPerMinute > 60)
    || !['staging:whatsapp','control:whatsapp'].every(id => policy.principals.some(p => p.id === id))
    || policy.connections.length !== config.authorizations.length) fail('invalid_request');
  const keys = policy.principals.map(p => createPublicKey(p.publicKey).export({ type: 'spki', format: 'der' }).toString('base64'));
  if (new Set(keys).size !== 2) fail('invalid_request');
  const authorizations = config.authorizations.map(value => {
    if (!Object.hasOwn(value || {}, 'enabled') || typeof value.enabled !== 'boolean') fail('invalid_request');
    return validateAuthorization(value);
  });
  for (const key of ['connectionRef','authorizationId','phoneId'])
    if (new Set(authorizations.map(a => a[key])).size !== authorizations.length) fail('invalid_request');
  const slots = new Map(); const apps = new Set(); const enrollmentRefs = new Map(); const scopes = new Map();
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`;
  for (const a of authorizations) {
    const binding = policy.connections.find(b => b.connectionRef === a.connectionRef);
    if (!C.keys(binding, ['connectionRef','provider','initialState','expiresAt']) || binding.provider !== C.PROVIDER
      || binding.expiresAt !== a.expiresAt) fail('invalid_request');
    const enrollment = a.enrollmentBinding; const b = E.bindingFor(enrollment);
    if (!C.keys(enrollment, ['clientSecretArn','connectionRef','expiresAt','initialState','provider','secretArn','whatsappOnboarding'])
      || enrollment.expiresAt !== null && (!Number.isSafeInteger(enrollment.expiresAt) || enrollment.expiresAt <= 0
        || a.expiresAt === null || enrollment.expiresAt < a.expiresAt)
      || !['active','blocked','revoked','expired'].includes(enrollment.initialState)
      || slots.has(enrollment.secretArn) && slots.get(enrollment.secretArn) !== enrollment.connectionRef
      || scopes.has(b.scopeKey) && scopes.get(b.scopeKey) !== enrollment.connectionRef
      || enrollmentRefs.has(enrollment.connectionRef) && enrollmentRefs.get(enrollment.connectionRef) !== JSON.stringify(enrollment)) fail('invalid_request');
    for (const arn of [enrollment.secretArn,enrollment.clientSecretArn])
      if (!arn.startsWith(prefix) || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(prefix.length))) fail('invalid_request');
    // One enrollment binding may hold multiple immutable flow versions. It may
    // never be aliased to a different scope/slot or changed between numbers.
    slots.set(enrollment.secretArn, enrollment.connectionRef); apps.add(enrollment.clientSecretArn);
    enrollmentRefs.set(enrollment.connectionRef, JSON.stringify(enrollment)); scopes.set(b.scopeKey, enrollment.connectionRef);
    const grants = policy.grants.filter(g => g.connectionRef === binding.connectionRef);
    if (grants.length !== b.clinicIds.length * 2) fail('invalid_request');
    const seen = new Set();
    for (const grant of grants) {
      const expected = grant.principalId === 'staging:whatsapp' ? C.SEND : C.REVOKE;
      const key = JSON.stringify([grant.principalId,grant.tenantRef]);
      if (!b.clinicIds.some(id => grant.tenantRef === 'clinic:' + id) || grant.assetRef !== 'wa-phone:' + a.phoneId
        || !grant.operations.includes(expected) || grant.operations.some(op => ![expected,...(expected === C.SEND ? M.OPERATIONS : [])].includes(op)) || new Set(grant.operations).size !== grant.operations.length || seen.has(key)) fail('invalid_request');
      seen.add(key);
    }
  }
  if ([...slots.keys()].some(arn => apps.has(arn))) fail('invalid_request');
  return config;
}
function enrollmentLoader(config) {
  return ref => {
    let body;
    try {
      body = privateFile(config.enrollmentConfigFile);
      const current = validateEnrollmentConfig(JSON.parse(body.toString('utf8')));
      if (current.stateFile !== config.enrollmentStateFile) fail('invalid_request');
      return current.policy.connections.find(binding => binding.connectionRef === ref);
    } finally { body?.fill(0); }
  };
}
function validateFiles(config) {
  // The operational ledger may not alias the onboarding ledger, even via a
  // symlink or hard link. Only the operational BrokerStore can create tables.
  if (fs.realpathSync(config.enrollmentStateFile) !== config.enrollmentStateFile
    || fs.realpathSync(path.dirname(config.stateFile)) !== path.dirname(config.stateFile)) fail('invalid_request');
  const enrollment = fs.statSync(config.enrollmentStateFile); const directory = fs.statSync(path.dirname(config.stateFile));
  if (!enrollment.isFile() || enrollment.mode & 0o077 || !directory.isDirectory() || directory.mode & 0o077) fail('invalid_request');
  if (fs.existsSync(config.stateFile)) {
    if (fs.realpathSync(config.stateFile) !== config.stateFile) fail('invalid_request');
    const state = fs.statSync(config.stateFile);
    if (!state.isFile() || state.mode & 0o077 || state.dev === enrollment.dev && state.ino === enrollment.ino) fail('invalid_request');
  }
}
async function main(filename, { awsFactory = connectAws, http = createWhatsappAuthorizedHttp() } = {}) {
  let raw; let key; let cert; let store; let registry; let aws; let secrets; let broker; let server; let timer; let draining; let closing;
  let accepting = true;
  const pending = new Set();
  const shutdown = () => closing ||= (async () => {
    accepting = false; clearInterval(timer); secrets?.close();
    for (const controllers of broker?.active.values() || []) for (const controller of controllers) controller.abort();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
    await Promise.allSettled([...pending]); await draining;
    if (store && aws) await drainAudit(store, aws.sink, { limit: 20 }).catch(() => null);
    try { registry?.close(); } finally { try { aws?.close(); } finally { key?.fill(0); cert?.fill(0); store?.close(); } }
  })();
  try {
    raw = privateFile(filename); const config = validateConfig(JSON.parse(raw.toString('utf8'))); raw.fill(0); raw = null;
    const loadEnrollmentBinding = enrollmentLoader(config);
    for (const a of config.authorizations) {
      const current = loadEnrollmentBinding(a.enrollmentBinding.connectionRef);
      if (!current || E.fingerprint(current) !== E.fingerprint(a.enrollmentBinding)) fail('invalid_request');
    }
    validateFiles(config);
    cert = privateFile(config.tlsCertFile, 65536); key = privateFile(config.tlsKeyFile, 65536);
    try { tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' }); } catch { fail('invalid_request'); }
    registry = createWhatsappAuthorizedRegistry({ filename: config.enrollmentStateFile, authorizations: config.authorizations, loadEnrollmentBinding });
    store = new BrokerStore(config.stateFile);
    aws = await awsFactory();
    secrets = createWhatsappAuthorizedSecrets({ client: aws.secrets, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY, registry, http });
    broker = new Broker({ store, policy: config.policy, secrets, operations: createWhatsappAuthorizedOperations({ http, secrets, registry }), timeoutMs: 25000 });
    server = createServer({ execute(...args) {
      if (!accepting || pending.size >= 8) fail('rate_limited');
      const work = broker.execute(...args); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    } }, { cert, key });
    server.maxConnections = 64; server.timeout = 35000;
    await new Promise((resolve, reject) => {
      const failed = error => reject(error); server.once('error', failed);
      server.listen(config.port, config.listenAddress, () => { server.removeListener('error', failed); resolve(); });
    });
    const tick = () => { if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; }); };
    tick(); timer = setInterval(tick, 1000); timer.unref();
    return { server, store, broker, registry, close: shutdown };
  } catch (error) { raw?.fill(0); await shutdown(); throw error; }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; }); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('WHATSAPP_AUTHORIZED_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig };
