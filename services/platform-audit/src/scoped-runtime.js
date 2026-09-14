'use strict';
const { inputFor, writeBatch, identityFor } = require('./batch');
const { createWriter } = require('./s3');
const { readBatch } = require('./reader');
const { runtimeClient, ROLES } = require('./scoped-credentials');
async function target(config, kind) {
  const lease = await runtimeClient(config, kind)();
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { S3Client } = require('@aws-sdk/client-s3'); const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const signal = AbortSignal.timeout(kind === 'writer' ? 60000 : 15000);
  const settings = () => ({ region: 'eu-west-3', credentials: lease.credentials, maxAttempts: 1,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 1500, requestTimeout: 3000, throwOnRequestTimeout: true }) });
  const sts = new STSClient({ ...settings(), endpoint: 'https://sts.eu-west-3.amazonaws.com' });
  const s3 = new S3Client({ ...settings(), endpoint: 'https://s3.eu-west-3.amazonaws.com', followRegionRedirects: false });
  return { lease, signal, client: s3, writer: createWriter(s3, { signal }),
    identity: async () => { const value = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }); identityFor(value, ROLES[kind]); return value; },
    close: () => { sts.destroy(); s3.destroy(); } };
}
async function write(input, config) {
  inputFor(input); if (input.sourceRoleArn !== config.brokerSourceRoleArn) throw Error('audit_identity_invalid');
  const api = await target(config, 'writer');
  try { return await writeBatch(input, { sourceIdentity: async () => api.lease.sourceIdentity, assumeWriter: async () => ({ ...api, close() {} }) }); }
  finally { api.close(); }
}
async function read(input, config) {
  require('./reader-protocol').inputFor(input);
  const api = await target(config, 'reader');
  try { await api.identity(); return await readBatch(input, api.client, api.signal); }
  finally { api.close(); }
}
module.exports = { write, read };
