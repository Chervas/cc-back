'use strict';
const S = require('./scope');
const { createCredentialsProcessProvider } = require('./credentials');
function createClients(credentials, dependencies = {}) {
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { SQSClient, GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const settings = endpoint => ({ region: S.REGION, endpoint, credentials, maxAttempts: 1,
    useFipsEndpoint: false, useDualstackEndpoint: false,
    requestHandler: dependencies.requestHandlerFactory
      ? dependencies.requestHandlerFactory()
      : new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 7000 }) });
  const sts = new STSClient(settings('https://sts.eu-west-3.amazonaws.com'));
  const sqs = new SQSClient(settings('https://sqs.eu-west-3.amazonaws.com'));
  return {
    identity: options => sts.send(new GetCallerIdentityCommand({}), options),
    queue: options => sqs.send(new GetQueueAttributesCommand({ QueueUrl: S.QUEUE_URL,
      AttributeNames: ['QueueArn', 'MessageRetentionPeriod', 'VisibilityTimeout', 'SqsManagedSseEnabled'] }), options),
    receive: (input, options) => sqs.send(new ReceiveMessageCommand(input), options),
    ack: (input, options) => sqs.send(new DeleteMessageCommand(input), options),
    destroy: () => { sts.destroy(); sqs.destroy(); },
  };
}
async function run(value, dependencies = {}) {
  const input = S.parseInput(value); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const abort = () => controller.abort(); dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) controller.abort();
  let clients;
  try {
    const options = { abortSignal: controller.signal };
    const credentials = dependencies.credentials || createCredentialsProcessProvider({ signal: controller.signal });
    clients = (dependencies.createClients || createClients)(credentials);
    const identity = S.verifyIdentity(await clients.identity(options));
    S.verifyQueue(await clients.queue(options));
    if (controller.signal.aborted) S.fail('alerts_timeout');
    if (input.operation === 'receive') {
      const result = await clients.receive({ QueueUrl: S.QUEUE_URL, MaxNumberOfMessages: input.max,
        VisibilityTimeout: 120, WaitTimeSeconds: 5 }, options);
      if (controller.signal.aborted) S.fail('alerts_timeout');
      return { ok: true, operation: 'receive', messages: S.projectMessages(result, input.max), identity, queueArn: S.QUEUE_ARN };
    }
    const result = await clients.ack({ QueueUrl: S.QUEUE_URL, ReceiptHandle: input.receiptHandle }, options);
    if (controller.signal.aborted) S.fail('alerts_timeout');
    if (result?.$metadata?.httpStatusCode !== 200) S.fail('alerts_ack_unknown');
    return { ok: true, operation: 'ack', deleted: true };
  } finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener('abort', abort);
    clients?.destroy();
  }
}
async function cli() {
  if (process.argv.length !== 2 || !/^v24\./.test(process.version)) S.fail('alerts_input_invalid');
  if (['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some(key => process.env[key] !== undefined)) S.fail('alerts_input_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); process.stdin.destroy(Error('alerts_timeout')); }, 20000);
  const terminate = () => controller.abort();
  process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) S.fail('alerts_input_invalid'); }
    const result = await run(JSON.parse(input), { signal: controller.signal });
    process.stdout.write(JSON.stringify(result));
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
  }
}
if (require.main === module) cli().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: S.safeError(error) })); process.exitCode = 1;
});
module.exports = { run, createClients, cli };
