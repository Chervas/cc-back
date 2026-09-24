'use strict';

const net = require('node:net');
const path = require('node:path');
const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
const { S3Client } = require('@aws-sdk/client-s3');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { BrokerStore } = require('./store');
const { Broker } = require('./broker');
const { createServer } = require('./server');
const { createS3AuditSink, drainAudit } = require('./audit');
const { fail } = require('./errors');
const { validatePolicy } = require('./policy');
const { privateFile, ACCOUNT, SOURCE } = require('./google-main');
const { createPublicMediaOperations } = require('./public-media-operation');
const L = require('./public-media-limits');
const tlsReload = require('./tls-reload');

const REGION = 'eu-west-3';
const BUCKET = 'clinicaclick-public-media-eu-west-3';
const BASE_URL = 'https://media.clinicaclick.com';
const MEDIA_WRITER_ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-public-media-prod-writer-role`;
const AUDIT_WRITER_ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-audit-prod-writer-role`;
const AUDIT_BUCKET = 'clinicaclick-integrations-prod-foun-auditlogbucket-3fmfqc6v8ktu';
const AUDIT_KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/9be75437-51b7-4462-80e1-36ac6c6f6e8a`;

const secretlessStore = Object.freeze({
  async withSecret() { fail('secret_unavailable'); },
  invalidate() {},
});

function validateConfig(config) {
  const keys = ['cohort', 'enabled', 'environment', 'listenAddress', 'policy', 'port', 'stateFile', 'tlsCertFile', 'tlsKeyFile'];
  if (config?.tlsRenewal) { keys.push('tlsRenewal'); tlsReload.validateSettings(config.tlsRenewal); }
  if (!config || Object.keys(config).sort().join(',') !== keys.sort().join(',')
    || config.cohort !== 'public-media-email-images-v1' || config.enabled !== true
    || !['dev', 'staging', 'prod'].includes(config.environment)
    || !net.isIP(config.listenAddress) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.stateFile !== 'string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  validatePolicy(config.policy);
  const ref = `public-media:${config.environment}`;
  if (config.policy.audience !== `clinicaclick:public-media:${config.environment}:v1`
    || config.policy.connections.length !== 1 || config.policy.connections[0].connectionRef !== ref
    || config.policy.connections[0].provider !== L.PROVIDER || config.policy.connections[0].initialState !== 'active'
    || config.policy.connections[0].secretArn || config.policy.principals.length !== 1
    || config.policy.principals[0].id !== ref || !config.policy.grants.length) fail('invalid_request');
  for (const grant of config.policy.grants) {
    const match = /^(clinic|group|catalog):([1-9][0-9]*)$/.exec(grant.tenantRef);
    if (!match || grant.principalId !== ref || grant.connectionRef !== ref
      || grant.assetRef !== `public-media:${grant.tenantRef}`
      || grant.operations.length !== 1 || grant.operations[0] !== L.OPERATIONS.PUT_EMAIL_IMAGE) fail('invalid_request');
  }
  return config;
}

async function connectAws() {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.env.AWS_CONFIG_FILE !== '/dev/null'
    || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null' || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
    || process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== 'http://169.254.169.254') fail('invalid_request');
  const handler = () => new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 8000, throwOnRequestTimeout: true });
  const options = (credentials, service) => ({ region: REGION, credentials, endpoint: `https://${service}.${REGION}.amazonaws.com`,
    maxAttempts: 1, requestHandler: handler() });
  const sourceCredentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 1, ec2MetadataV1Disabled: true });
  const source = new STSClient(options(sourceCredentials, 'sts')); const clients = [source];
  try {
    const sourceIdentity = await source.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
    if (sourceIdentity.Account !== ACCOUNT || sourceIdentity.Arn !== SOURCE) fail('scope_denied');
    const assume = (role, session) => fromTemporaryCredentials({ masterCredentials: sourceCredentials,
      params: { RoleArn: role, RoleSessionName: session, DurationSeconds: 900 }, clientConfig: options(sourceCredentials, 'sts') });
    const mediaCredentials = assume(MEDIA_WRITER_ROLE, 'clinicaclick-public-media-writer');
    const auditCredentials = assume(AUDIT_WRITER_ROLE, 'clinicaclick-public-media-audit');
    for (const [credentials, arn] of [[mediaCredentials, MEDIA_WRITER_ROLE], [auditCredentials, AUDIT_WRITER_ROLE]]) {
      const sts = new STSClient(options(credentials, 'sts')); clients.push(sts);
      const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(10000) });
      const roleName = arn.split('/').pop();
      if (identity.Account !== ACCOUNT || !identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/${roleName}/`)) fail('scope_denied');
    }
    const media = new S3Client({ ...options(mediaCredentials, 's3'), followRegionRedirects: false });
    const audit = new S3Client({ ...options(auditCredentials, 's3'), followRegionRedirects: false });
    clients.push(media, audit);
    return { media, sink: createS3AuditSink({ client: audit, bucket: AUDIT_BUCKET, keyArn: AUDIT_KEY,
      expectedBucketOwner: ACCOUNT, timeoutMs: 8000 }), close: () => clients.forEach(client => client.destroy()) };
  } catch (error) { clients.forEach(client => client.destroy()); throw error; }
}

async function main(filename, { awsFactory = connectAws } = {}) {
  const config = validateConfig(JSON.parse(privateFile(filename)));
  const tls = { cert: privateFile(config.tlsCertFile, 65536), key: privateFile(config.tlsKeyFile, 65536) };
  const store = new BrokerStore(config.stateFile); let aws, server, broker, timer, draining;
  try {
    aws = await awsFactory();
    broker = new Broker({ store, policy: config.policy, secrets: secretlessStore,
      operations: createPublicMediaOperations({ client: aws.media, bucket: BUCKET, baseUrl: BASE_URL, expectedBucketOwner: ACCOUNT }),
      transportProfile: 'public-media', timeoutMs: L.MAX_PROVIDER_TIMEOUT_MS + 5000 });
    server = createServer(broker, tls, { transportProfile: 'public-media' }); server.maxConnections = 4;
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
  } catch (error) { clearInterval(timer); server?.close(); await draining; aws?.close(); store.close(); throw error; }
}

if (require.main === module) main(process.argv[2]).then(runtime => {
  const stop = () => runtime.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(() => { process.stderr.write('PUBLIC_MEDIA_BROKER_START_FAILED\n'); process.exitCode = 1; });

module.exports = { ACCOUNT, BASE_URL, BUCKET, MEDIA_WRITER_ROLE, connectAws, main, validateConfig };
