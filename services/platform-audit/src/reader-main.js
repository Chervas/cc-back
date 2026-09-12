'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { isolatedRead, READER_ROLE, roles } = require('./reader');
function privateFile(filename, max = 65536) {
  if (!path.isAbsolute(filename) || fs.realpathSync(filename) !== filename || !fs.statSync(filename).isFile()
    || fs.statSync(filename).size > max || (fs.statSync(filename).mode & 0o077)) throw Error('audit_reader_configuration_invalid');
  return fs.readFileSync(filename);
}
async function awsRead(input, settings) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.env.AWS_CONFIG_FILE !== '/dev/null'
    || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null' || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
    || process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== 'http://169.254.169.254') throw Error('audit_reader_configuration_invalid');
  const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { S3Client } = require('@aws-sdk/client-s3'); const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const signal = AbortSignal.timeout(15000);
  const handler = () => new NodeHttpHandler({ connectionTimeout: 1500, requestTimeout: 3000, throwOnRequestTimeout: true });
  const sourceCredentials = fromInstanceMetadata({ timeout: 1000, maxRetries: 1, ec2MetadataV1Disabled: true });
  const source = new STSClient({ region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', credentials: sourceCredentials,
    maxAttempts: 1, requestHandler: handler() });
  try { return await isolatedRead(input, settings, {
    sourceIdentity: () => source.send(new GetCallerIdentityCommand({}), { abortSignal: signal }),
    assumeReader: async () => {
      const credentials = fromTemporaryCredentials({ masterCredentials: sourceCredentials, params: { RoleArn: READER_ROLE,
        RoleSessionName: 'clinicaclick-audit-reader', DurationSeconds: 900 }, clientConfig: {
        region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', maxAttempts: 1, requestHandler: handler() } });
      const sts = new STSClient({ region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', credentials, maxAttempts: 1, requestHandler: handler() });
      const client = new S3Client({ region: 'eu-west-3', endpoint: 'https://s3.eu-west-3.amazonaws.com', credentials,
        maxAttempts: 1, followRegionRedirects: false, requestHandler: handler() });
      return { identity: () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }), client, signal,
        close: () => { sts.destroy(); client.destroy(); } };
    },
  }); } finally { source.destroy(); }
}
function main(filename) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('audit_reader_node24_required');
  const config = JSON.parse(privateFile(filename)); roles(config.readerSourceRoleArn, config.writerSourceRoleArn);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('audit_reader_configuration_invalid');
  Object.assign(process.env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254' });
  const { ReaderStore } = require('./reader-store'); const { createServer } = require('./reader-server');
  const store = new ReaderStore(config.stateFile);
  const server = createServer({ store, principals: config.principals, read: input => awsRead(input, config) }, {
    key: privateFile(config.tlsKeyFile), cert: privateFile(config.tlsCertFile) });
  server.listen(config.port, config.listenAddress || '127.0.0.1');
  const close = () => server.close(() => { store.close(); process.exitCode = 0; });
  process.once('SIGTERM', close); process.once('SIGINT', close); return { server, store };
}
if (require.main === module) { try { main(process.argv[2]); } catch { process.stderr.write('AUDIT_READER_START_FAILED\n'); process.exitCode = 1; } }
module.exports = { main, privateFile, awsRead };
