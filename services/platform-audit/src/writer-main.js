'use strict';
const { inputFor, writeBatch, WRITER_ROLE, safeError } = require('./batch');
const { createWriter } = require('./s3');
async function run(input) {
  inputFor(input);
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.env.AWS_CONFIG_FILE !== '/dev/null'
    || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null' || process.env.AWS_EC2_METADATA_V1_DISABLED !== 'true'
    || process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT !== 'http://169.254.169.254') {
    throw Object.assign(Error('audit_configuration_invalid'), { code: 'audit_configuration_invalid' });
  }
  const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { S3Client } = require('@aws-sdk/client-s3');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const signal = AbortSignal.timeout(60000);
  const handler = () => new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true });
  // No default chain, environment credentials, SSO, shared files or permanent keys.
  const masterCredentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 1, ec2MetadataV1Disabled: true });
  const source = new STSClient({ region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com',
    credentials: masterCredentials, maxAttempts: 1, requestHandler: handler() });
  try {
    return await writeBatch(input, {
      sourceIdentity: () => source.send(new GetCallerIdentityCommand({}), { abortSignal: signal }),
      assumeWriter: async () => {
        const credentials = fromTemporaryCredentials({ masterCredentials, params: {
          RoleArn: WRITER_ROLE, RoleSessionName: 'clinicaclick-audit-writer', DurationSeconds: 900 },
        clientConfig: { region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', maxAttempts: 1, requestHandler: handler() } });
        const sts = new STSClient({ region: 'eu-west-3', endpoint: 'https://sts.eu-west-3.amazonaws.com', credentials, maxAttempts: 1, requestHandler: handler() });
        const s3 = new S3Client({ region: 'eu-west-3', endpoint: 'https://s3.eu-west-3.amazonaws.com', credentials,
          maxAttempts: 1, requestHandler: handler(), followRegionRedirects: false });
        return { identity: () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }), writer: createWriter(s3, { signal }),
          close: () => { sts.destroy(); s3.destroy(); } };
      },
    });
  } finally { source.destroy(); }
}
if (require.main === module) {
  (async () => {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 250000) throw Error('input_too_large'); }
    process.stdout.write(JSON.stringify({ ok: true, batch: await run(JSON.parse(input)) }));
  })().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: safeError(error) })); process.exitCode = 1; });
}
module.exports = { run };
