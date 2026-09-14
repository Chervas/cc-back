'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const { sourceRole, identityFor } = require('./batch');
const { ROLES, SOCKET_ROOT, validateLease } = require('./scoped-credentials');
const { privateFile } = require('./reader-main');
function createServer(kind, lease) {
  if (!ROLES[kind]) throw Error('audit_configuration_invalid');
  const server = http.createServer({ maxHeaderSize: 2048 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET' || req.url !== '/v1/credentials' || req.headers['transfer-encoding']
      || (req.headers['content-length'] && req.headers['content-length'] !== '0')) { res.writeHead(403); res.end('{}'); return; }
    try { const value = await lease(kind); res.writeHead(200); res.end(JSON.stringify(value)); }
    catch { res.writeHead(503); res.end('{}'); }
  });
  server.requestTimeout = 3000; server.headersTimeout = 2000; server.timeout = 10000; server.keepAliveTimeout = 1000;
  return server;
}
function createLeaseProvider(sourceRoleArn) {
  sourceRole(sourceRoleArn);
  const { fromInstanceMetadata } = require('@aws-sdk/credential-providers');
  const { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } = require('@aws-sdk/client-sts');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const client = new STSClient({ region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', maxAttempts: 1,
    credentials: fromInstanceMetadata({ timeout: 1000, maxRetries: 1, ec2MetadataV1Disabled: true }),
    requestHandler: new NodeHttpHandler({ connectionTimeout: 1500, requestTimeout: 3000, throwOnRequestTimeout: true }) });
  const cache = new Map(); const pending = new Map();
  const lease = async kind => {
    if (!ROLES[kind]) throw Error('audit_identity_invalid');
    if (cache.get(kind)?.credentials.expiration.getTime() > Date.now() + 120000) return cache.get(kind);
    if (pending.has(kind)) return pending.get(kind);
    const work = (async () => {
      const abortSignal = AbortSignal.timeout(8000);
      const sourceIdentity = await client.send(new GetCallerIdentityCommand({}), { abortSignal }); identityFor(sourceIdentity, sourceRoleArn);
      const result = await client.send(new AssumeRoleCommand({ RoleArn: ROLES[kind], DurationSeconds: 900,
        RoleSessionName: `clinicaclick-audit-${kind}` }), { abortSignal });
      const c = result.Credentials;
      const value = validateLease({ version: 1, roleArn: ROLES[kind], sourceIdentity: { Account: sourceIdentity.Account, Arn: sourceIdentity.Arn },
        credentials: { accessKeyId: c?.AccessKeyId, secretAccessKey: c?.SecretAccessKey,
          sessionToken: c?.SessionToken, expiration: c?.Expiration?.toISOString() } }, kind, sourceRoleArn);
      cache.set(kind, value); return value;
    })();
    pending.set(kind, work); try { return await work; } finally { pending.delete(kind); }
  };
  return { lease, close: () => { cache.clear(); client.destroy(); } };
}
async function main(filename) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.getuid() === 0) throw Error('audit_configuration_invalid');
  const config = JSON.parse(privateFile(filename)); sourceRole(config.sourceRoleArn);
  if (!Number.isInteger(config.writerGid) || config.writerGid < 1 || !Number.isInteger(config.readerGid)
    || config.readerGid < 1 || config.readerGid === config.writerGid) throw Error('audit_configuration_invalid');
  const stat = fs.statSync(SOCKET_ROOT);
  if (fs.realpathSync(SOCKET_ROOT) !== SOCKET_ROOT || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o711) throw Error('audit_configuration_invalid');
  Object.assign(process.env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254' });
  const provider = createLeaseProvider(config.sourceRoleArn); const servers = [];
  try {
    for (const kind of ['writer', 'reader']) {
      const socketPath = path.join(SOCKET_ROOT, `${kind}.sock`);
      if (fs.existsSync(socketPath)) { const st = fs.lstatSync(socketPath);
        if (!st.isSocket() || st.uid !== process.getuid()) throw Error('audit_configuration_invalid'); fs.unlinkSync(socketPath); }
      const server = createServer(kind, provider.lease); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      fs.chownSync(socketPath, process.getuid(), config[`${kind}Gid`]); fs.chmodSync(socketPath, 0o660);
    }
  } catch (error) { for (const server of servers) server.close(); provider.close(); throw error; }
  const close = () => { for (const server of servers) server.close(); provider.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close); return { servers, provider };
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('AUDIT_CREDENTIAL_BROKER_START_FAILED\n'); process.exitCode = 1; });
module.exports = { createServer, createLeaseProvider, main };
