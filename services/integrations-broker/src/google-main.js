'use strict';
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { createPublicKey } = require('node:crypto');
const { fail } = require('./errors'); const { validatePolicy } = require('./policy');
const { PROVIDER, OPERATIONS, REVOKE_OPERATION, asset } = require('./google-business-profile-contract');
const { BrokerStore } = require('./store'); const { Broker } = require('./broker');
const { createServer } = require('./server'); const { createGoogleHttp } = require('./google-http');
const { createGoogleSecretStore } = require('./google-secrets');
const { createGoogleBusinessProfileOperations } = require('./google-business-profile');
const scContract = require('./google-search-console-contract');
const { createSearchConsoleOperations } = require('./google-search-console');
const gaContract = require('./google-analytics-contract'); const { createAnalyticsOperations } = require('./google-analytics');
const { cursorCodec } = require('./provider-cursor'); const { drainAudit, createS3AuditSink } = require('./audit');
const oauthContract = require('./google-oauth-contract'); const { createGoogleOAuth } = require('./google-oauth');
const { createGoogleOAuthSecrets } = require('./google-oauth-secrets');
const adsContract = require('./google-ads-contract');
const { createGoogleAdsOperations } = require('./google-ads');
const { createGoogleAdsDeveloperSecret } = require('./google-ads-developer-secret');
const enrollmentContract = require('./google-ads-enrollment-contract');
const { createGoogleAdsEnrollment } = require('./google-ads-enrollment');
const ACCOUNT = '137819318729'; const REGION = 'eu-west-3';
const SOURCE = `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-integrations-prod-ec2-role/i-0cf40cfe823f160fa`;
const WRITER_ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-audit-prod-writer-role`;
const BUCKET = 'clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu';
const AUDIT_KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a`;
const SECRET_KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/15864f4f-2db5-485b-a49f-303c57eedc59`;
function privateFile(filename, limit = 1048576) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail('invalid_request');
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > limit) fail('invalid_request');
  return fs.readFileSync(filename);
}
function validatePropertyControlSeparation(policy, contract) {
  const readers = new Set(policy.grants.filter(g => g.operations.some(op => contract.OPERATIONS.includes(op))).map(g => g.principalId));
  const keyFor = id => {
    try { return createPublicKey(policy.principals.find(p => p.id === id).publicKey).export({ type: 'spki', format: 'der' }).toString('base64'); }
    catch { fail('invalid_request'); }
  };
  const readerKeys = new Set([...readers].map(keyFor));
  for (const grant of policy.grants.filter(g => g.operations.includes(contract.REVOKE_OPERATION))) {
    if (readers.has(grant.principalId) || readerKeys.has(keyFor(grant.principalId))) fail('invalid_request');
  }
}
function validateOAuthSeparation(policy, contract) {
  const operations = Object.values(oauthContract.operationsFor(contract.PROVIDER));
  const prior = new Set(policy.grants.filter(g => g.operations.some(op => contract.OPERATIONS.includes(op)
    || op === contract.REVOKE_OPERATION)).map(g => g.principalId));
  const keyFor = id => {
    try { return createPublicKey(policy.principals.find(p => p.id === id).publicKey).export({ type: 'spki', format: 'der' }).toString('base64'); }
    catch { fail('invalid_request'); }
  };
  const keys = new Set([...prior].map(keyFor));
  for (const connection of policy.connections) if (connection.oauth) oauthContract.bindingFor(connection);
  for (const grant of policy.grants.filter(g => g.operations.some(op => operations.includes(op)))) {
    if (prior.has(grant.principalId) || keys.has(keyFor(grant.principalId))) fail('invalid_request');
    oauthContract.bindingFor(policy.connections.find(c => c.connectionRef === grant.connectionRef));
  }
}
function validateConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'cohort,cursorKeyFile,enabled,listenAddress,policy,port,stateFile,tlsCertFile,tlsKeyFile'
    || config.enabled !== true || !['google-business-profile-read-v1', 'google-search-console-read-v1', 'google-analytics-read-v1', 'google-ads-read-v1'].includes(config.cohort)
    || !net.isIP(config.listenAddress) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  validatePolicy(config.policy);
  if (config.cohort === 'google-ads-read-v1') {
    if (!config.policy.connections.length || config.policy.connections.some(c => c.provider !== adsContract.PROVIDER || !c.secretArn || !c.clientSecretArn
      || !c.developerSecretArn || !require('./google-oauth-secrets').subject(c.googleSubject) || !(c.googleAdsAccounts?.length || c.googleAdsEnrollmentScopes?.length)
      || c.analyticsProperties || c.searchConsoleSites)) fail('invalid_request');
    for (const connection of config.policy.connections) {
      const ids = new Set();
      for (const row of connection.googleAdsAccounts || []) {
        adsContract.resource(connection, row.assetRef);
        if (ids.has(row.assetRef)) fail('invalid_request'); ids.add(row.assetRef);
      }
    }
    for (const grant of config.policy.grants) {
      if (!/^clinic:[1-9]\d{0,9}$/.test(grant.tenantRef)
        || grant.operations.some(op => !adsContract.OPERATIONS.includes(op) && op !== adsContract.REVOKE_OPERATION
          && !Object.values(oauthContract.operationsFor(adsContract.PROVIDER)).includes(op)
          && !Object.values(enrollmentContract.OPERATIONS).includes(op) && op !== enrollmentContract.REVOKE_OPERATION)) fail('invalid_request');
      const binding = config.policy.connections.find(c => c.connectionRef === grant.connectionRef);
      if (grant.assetRef.startsWith('ads-enroll:')) enrollmentContract.scopeFor(binding, grant.assetRef, grant.tenantRef);
      else {
        if (grant.operations.some(op => Object.values(enrollmentContract.OPERATIONS).includes(op) || op === enrollmentContract.REVOKE_OPERATION)) fail('invalid_request');
        adsContract.resource(binding, grant.assetRef);
      }
    }
    validatePropertyControlSeparation(config.policy, adsContract);
    validateOAuthSeparation(config.policy, adsContract);
    enrollmentContract.validatePolicy(config.policy);
    return config;
  }
  if (config.policy.connections.some(c => c.googleAdsAccounts || c.googleAdsEnrollmentScopes || c.developerSecretArn)) fail('invalid_request');
  if (config.cohort === 'google-search-console-read-v1') {
    if (!config.policy.connections.length || config.policy.connections.some(c => c.provider !== scContract.PROVIDER || !c.secretArn || !c.clientSecretArn
      || !require('./google-oauth-secrets').subject(c.googleSubject) || !c.searchConsoleSites?.length || c.analyticsProperties)) fail('invalid_request');
    for (const connection of config.policy.connections) {
      const ids = new Set();
      for (const row of connection.searchConsoleSites) {
        if (scContract.site(row.siteUrl).assetRef !== row.assetRef || ids.has(row.assetRef)) fail('invalid_request'); ids.add(row.assetRef);
      }
    }
    for (const grant of config.policy.grants) {
      if (!/^clinic:[1-9]\d{0,9}$/.test(grant.tenantRef) || grant.operations.some(op => !scContract.OPERATIONS.includes(op) && op !== scContract.REVOKE_OPERATION
        && !Object.values(oauthContract.operationsFor(scContract.PROVIDER)).includes(op))) fail('invalid_request');
      scContract.resource(config.policy.connections.find(c => c.connectionRef === grant.connectionRef), grant.assetRef);
    }
    validatePropertyControlSeparation(config.policy, scContract);
    validateOAuthSeparation(config.policy, scContract);
    return config;
  }
  if (config.cohort === 'google-analytics-read-v1') {
    if (!config.policy.connections.length || config.policy.connections.some(c => c.provider !== gaContract.PROVIDER || !c.secretArn || !c.clientSecretArn
      || !require('./google-oauth-secrets').subject(c.googleSubject) || !c.analyticsProperties?.length || c.searchConsoleSites)) fail('invalid_request');
    for (const connection of config.policy.connections) {
      const ids = new Set();
      for (const row of connection.analyticsProperties) {
        if (gaContract.property(row.propertyName).assetRef !== row.assetRef || ids.has(row.assetRef)) fail('invalid_request'); ids.add(row.assetRef);
      }
    }
    for (const grant of config.policy.grants) {
      if (!/^clinic:[1-9]\d{0,9}$/.test(grant.tenantRef) || grant.operations.some(op => !gaContract.OPERATIONS.includes(op) && op !== gaContract.REVOKE_OPERATION
        && !Object.values(oauthContract.operationsFor(gaContract.PROVIDER)).includes(op))) fail('invalid_request');
      gaContract.resource(config.policy.connections.find(c => c.connectionRef === grant.connectionRef), grant.assetRef);
    }
    validatePropertyControlSeparation(config.policy, gaContract);
    validateOAuthSeparation(config.policy, gaContract);
    return config;
  }
  if (!config.policy.connections.length || config.policy.connections.some(c => c.provider !== PROVIDER || !c.secretArn || !c.clientSecretArn)
    || config.policy.connections.some(c => c.searchConsoleSites || c.googleSubject || c.analyticsProperties)
    || config.policy.grants.some(g => !/^clinic:[1-9]\d{0,9}$/.test(g.tenantRef) || g.operations.some(op => !OPERATIONS.includes(op) && op !== REVOKE_OPERATION
      && !Object.values(oauthContract.OPERATIONS).includes(op)))) fail('invalid_request');
  const readers = new Set(config.policy.grants.filter(g => g.operations.some(op => OPERATIONS.includes(op))).map(g => g.principalId));
  if (config.policy.grants.some(g => g.operations.includes(REVOKE_OPERATION) && readers.has(g.principalId))) fail('invalid_request');
  const keyFor = id => {
    try { return createPublicKey(config.policy.principals.find(p => p.id === id).publicKey).export({ type: 'spki', format: 'der' }).toString('base64'); }
    catch { fail('invalid_request'); }
  };
  const readerKeys = new Set([...readers].map(keyFor));
  if (config.policy.grants.some(g => g.operations.includes(REVOKE_OPERATION) && readerKeys.has(keyFor(g.principalId)))) fail('invalid_request');
  const priorControls = new Set([...readers, ...config.policy.grants.filter(g => g.operations.includes(REVOKE_OPERATION)).map(g => g.principalId)]);
  const priorKeys = new Set([...priorControls].map(keyFor));
  for (const grant of config.policy.grants.filter(g => g.operations.some(op => Object.values(oauthContract.OPERATIONS).includes(op)))) {
    if (priorControls.has(grant.principalId) || priorKeys.has(keyFor(grant.principalId))) fail('invalid_request');
    oauthContract.bindingFor(config.policy.connections.find(c => c.connectionRef === grant.connectionRef));
  }
  for (const grant of config.policy.grants) asset(grant.assetRef);
  return config;
}
async function connectAws() {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.env.AWS_CONFIG_FILE !== '/dev/null'
    || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null' || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
    || process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== 'http://169.254.169.254') fail('invalid_request');
  const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager'); const { S3Client } = require('@aws-sdk/client-s3');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const handler = () => new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true });
  const config = (credentials, service) => ({ region: REGION, credentials, endpoint: `https://${service}.${REGION}.amazonaws.com`,
    maxAttempts: 1, requestHandler: handler() });
  const credentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 1, ec2MetadataV1Disabled: true });
  const source = new STSClient(config(credentials, 'sts')); const clients = [source];
  try {
    const identity = await source.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
    if (identity.Account !== ACCOUNT || identity.Arn !== SOURCE) fail('scope_denied');
    const writerCredentials = fromTemporaryCredentials({ masterCredentials: credentials,
      params: { RoleArn: WRITER_ROLE, RoleSessionName: 'clinicaclick-integrations-audit', DurationSeconds: 900 }, clientConfig: config(credentials, 'sts') });
    const writerSts = new STSClient(config(writerCredentials, 'sts')); clients.push(writerSts);
    const writerIdentity = await writerSts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
    if (writerIdentity.Account !== ACCOUNT || writerIdentity.Arn !== `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-audit-prod-writer-role/clinicaclick-integrations-audit`) fail('scope_denied');
    const secrets = new SecretsManagerClient(config(credentials, 'secretsmanager')); clients.push(secrets);
    const s3 = new S3Client({ ...config(writerCredentials, 's3'), followRegionRedirects: false }); clients.push(s3);
    return { secrets, sink: createS3AuditSink({ client: s3, bucket: BUCKET, keyArn: AUDIT_KEY, expectedBucketOwner: ACCOUNT, timeoutMs: 8000 }),
      close: () => clients.forEach(c => c.destroy()) };
  } catch (error) { clients.forEach(c => c.destroy()); throw error; }
}
async function main(filename, { awsFactory = connectAws, http = createGoogleHttp() } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const cert = privateFile(config.tlsCertFile, 65536); const key = privateFile(config.tlsKeyFile, 65536);
  const cursorKey = privateFile(config.cursorKeyFile, 32); const cursor = cursorCodec(cursorKey);
  const store = new BrokerStore(config.stateFile); let aws; let secrets; let oauth; let adsEngine; let adsEnrollment; let server; let timer; let draining;
  try {
    aws = await awsFactory();
    const searchConsole = config.cohort === 'google-search-console-read-v1';
    const analytics = config.cohort === 'google-analytics-read-v1';
    const ads = config.cohort === 'google-ads-read-v1';
    secrets = createGoogleSecretStore({ client: aws.secrets, http, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY,
      provider: searchConsole ? scContract.PROVIDER : analytics ? gaContract.PROVIDER : ads ? adsContract.PROVIDER : PROVIDER });
    if (ads) {
      const withDeveloperSecret = createGoogleAdsDeveloperSecret({ client: aws.secrets, accountId: ACCOUNT,
        prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY });
      adsEngine = createGoogleAdsOperations({ http, cursor, withDeveloperSecret });
      if (config.policy.connections.some(c => c.googleAdsEnrollmentScopes?.length)) {
        adsEnrollment = createGoogleAdsEnrollment({ store, http, cursor, withDeveloperSecret });
      }
      const invalidate = secrets.invalidate;
      secrets.invalidate = ref => { invalidate(ref); adsEngine.invalidate(ref); adsEnrollment?.invalidate(ref); };
    }
    let broker;
    if (config.policy.connections.some(c => c.oauth)) oauth = createGoogleOAuth({ store, policy: config.policy, http,
      secrets: createGoogleOAuthSecrets({ client: aws.secrets, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY }),
      onActivated: ref => { secrets.invalidate(ref); for (const controller of broker.active.get(ref) || []) controller.abort(); } });
    broker = new Broker({ store, policy: config.policy, secrets, adsEnrollment,
      operations: ads ? { ...adsEngine.operations, ...adsEnrollment?.operations, ...oauthContract.controlsFor(adsContract.PROVIDER, oauth) }
        : searchConsole ? createSearchConsoleOperations({ http, cursor, oauth }) : analytics ? createAnalyticsOperations({ http, cursor, oauth }) : createGoogleBusinessProfileOperations({ http, cursor, oauth }), timeoutMs: 25000 });
    let inFlight = 0;
    server = createServer({ async execute(...args) {
      if (inFlight >= 8) fail('rate_limited'); inFlight++;
      try { return await broker.execute(...args); } finally { inFlight--; }
    } }, { cert, key });
    server.maxConnections = 64; server.timeout = 35000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.listenAddress, resolve); });
    const tick = () => {
      if (!draining) draining = drainAudit(store, aws.sink, { limit: 20 }).catch(() => null).finally(() => { draining = null; });
    };
    tick(); timer = setInterval(tick, 1000); timer.unref();
    let closing;
    const close = () => closing ||= (async () => {
      clearInterval(timer); oauth?.close(); adsEngine?.close(); adsEnrollment?.close(); secrets.close();
      for (const controllers of broker.active.values()) for (const controller of controllers) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
      await draining; aws.close(); cursorKey.fill(0); store.close();
    })();
    return { server, store, broker, close };
  } catch (error) { clearInterval(timer); server?.close(); oauth?.close(); adsEngine?.close(); adsEnrollment?.close(); secrets?.close(); aws?.close(); cursorKey.fill(0); store.close(); throw error; }
}
if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { main, validateConfig, privateFile, connectAws, ACCOUNT, SOURCE, SECRET_KEY };
