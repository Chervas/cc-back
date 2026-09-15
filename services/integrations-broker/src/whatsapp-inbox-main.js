'use strict';
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const { privateFile, connectAws } = require('./google-main');
const { BrokerStore } = require('./store'); const { drainAudit } = require('./audit');
const { createWhatsappInbox } = require('./whatsapp-inbox');
const { createInboxKeyProvider } = require('./whatsapp-inbox-key');
const { createInboxServer, validatePrincipals } = require('./whatsapp-inbox-server');
const { validateApplication, createInboxApplicationSecret } = require('./whatsapp-inbox-secret');
const COHORT = 'whatsapp-inbox-passive-v1';
function validateConfig(c) {
  if (!c || Object.keys(c).sort().join(',') !== 'application,auditContext,bindings,cohort,consumerEnabled,enabled,keyManifestFile,limits,listenAddress,port,principals,stateFile,tlsCaFile,tlsCertFile,tlsKeyFile'
    || c.cohort !== COHORT || c.enabled !== true || typeof c.consumerEnabled !== 'boolean' || !net.isIP(c.listenAddress)
    || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) fail('invalid_request');
  const paths = ['stateFile', 'keyManifestFile', 'tlsCertFile', 'tlsKeyFile', 'tlsCaFile'].map(k => c[k]);
  if (paths.some(v => typeof v !== 'string' || !path.isAbsolute(v) || path.normalize(v) !== v)
    || new Set(paths).size !== paths.length) fail('invalid_request');
  validateApplication(c.application); validatePrincipals(c.principals);
  // This first runtime serves one explicit WABA and one clinic. A shared/group
  // binding needs its own reviewed scope contract before expanding the cohort.
  if (!Array.isArray(c.bindings) || c.bindings.length !== 1
    || Object.keys(c.bindings[0]).sort().join(',') !== 'phoneIds,wabaId'
    || !/^[1-9][0-9]{0,29}$/.test(c.bindings[0].wabaId)
    || !Array.isArray(c.bindings[0].phoneIds) || c.bindings[0].phoneIds.length !== 1
    || !/^[1-9][0-9]{0,29}$/.test(c.bindings[0].phoneIds[0])) fail('invalid_request');
  if (!c.auditContext || Object.keys(c.auditContext).sort().join(',') !== 'connectionRef,operation,policyVersion,resourceRef,tenantRef'
    || !/^clinic:[1-9][0-9]{0,9}$/.test(c.auditContext.tenantRef)
    || c.auditContext.resourceRef !== 'wa-inbox:' + c.application.appId
    || c.auditContext.operation !== 'whatsapp.webhook.capture') fail('invalid_request');
  if (!c.limits || Object.keys(c.limits).sort().join(',') !== 'maxAuditBacklog,maxBytes,maxRows'
    || Object.values(c.limits).some(v => !Number.isSafeInteger(v) || v < 1)
    || c.limits.maxRows > 100000 || c.limits.maxBytes > 1024 * 1024 * 1024 || c.limits.maxAuditBacklog > 10000) fail('invalid_request');
  return structuredClone(c);
}
async function connectInboxAws() {
  // connectAws verifies the exact EC2 identity and the audit writer identity;
  // the KMS client also uses IMDSv2, with no ambient credential chain or retries.
  const aws = await connectAws(); let kms;
  try {
    const { fromInstanceMetadata } = require('@aws-sdk/credential-providers');
    const { KMSClient } = require('@aws-sdk/client-kms'); const { NodeHttpHandler } = require('@smithy/node-http-handler');
    kms = new KMSClient({ region: 'eu-west-3', endpoint: 'https://kms.eu-west-3.amazonaws.com', maxAttempts: 1,
      credentials: fromInstanceMetadata({ timeout: 1500, maxRetries: 1, ec2MetadataV1Disabled: true }),
      requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true }) });
    return { ...aws, kms, close() { kms.destroy(); aws.close(); } };
  } catch (error) { kms?.destroy(); aws.close(); throw error; }
}
function pinIdentity(store, config, cipher) {
  const identity = JSON.stringify([COHORT, config.application.appId, cipher.keyId, config.bindings, config.auditContext.tenantRef,
    config.auditContext.connectionRef]);
  const digest = createHash('sha256').update(identity).digest('hex');
  store.transaction(() => {
    store.db.exec('CREATE TABLE IF NOT EXISTS whatsapp_inbox_identity (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL)');
    const prior = store.db.prepare('SELECT digest FROM whatsapp_inbox_identity WHERE id=1').get();
    if (prior && prior.digest !== digest) fail('scope_denied');
    const exists = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_inbox'").get();
    if (!prior && exists && store.db.prepare('SELECT 1 FROM whatsapp_inbox LIMIT 1').get()) fail('scope_denied');
    if (!prior) store.db.prepare('INSERT INTO whatsapp_inbox_identity VALUES (1,?)').run(digest);
  });
}
async function main(filename, { awsFactory = connectInboxAws } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const cert = privateFile(config.tlsCertFile, 65536); const key = privateFile(config.tlsKeyFile, 65536);
  const ca = privateFile(config.tlsCaFile, 65536); const manifest = JSON.parse(privateFile(config.keyManifestFile, 16384));
  let aws; let cipher; let store; let secret; let server; let timer; let draining;
  try {
    aws = await awsFactory(); cipher = await createInboxKeyProvider(aws.kms).open(manifest, config.application.appId);
    // No key bootstrap or implicit migration on startup. Preserve files on a
    // missing key, incompatible scope, corrupt ciphertext or unavailable AWS.
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(config.stateFile)) !== path.dirname(config.stateFile)) fail('invalid_request');
    store = new BrokerStore(config.stateFile); pinIdentity(store, config, cipher);
    const inbox = createWhatsappInbox({ store, cipher, appId: config.application.appId, bindings: config.bindings,
      auditContext: config.auditContext, ...config.limits });
    secret = createInboxApplicationSecret(aws.secrets, config.application);
    server = createInboxServer({ inbox, withApplicationSecret: work => secret.withSecret(work), principals: config.principals,
      cert, key, ca, consumerEnabled: config.consumerEnabled });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.listenAddress, resolve); });
    const tick = () => { if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; }); };
    tick(); timer = setInterval(tick, 1000); timer.unref(); let closing;
    const close = () => closing ||= (async () => {
      clearInterval(timer); secret.close();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
      await draining; cipher.close(); store.close(); aws.close(); key.fill(0);
    })();
    return { server, store, inbox, close };
  } catch (error) {
    clearInterval(timer); server?.close(); secret?.close(); cipher?.close(); store?.close(); aws?.close(); key.fill(0); throw error;
  }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('WHATSAPP_INBOX_START_FAILED\n'); process.exitCode = 1; });
module.exports = { COHORT, validateConfig, connectInboxAws, pinIdentity, main };
