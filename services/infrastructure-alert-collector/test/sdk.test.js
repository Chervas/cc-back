'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createClients } = require('../src/main'); const S = require('../src/scope');
test('actual SDK serializers sign only fixed STS/SQS endpoints, one attempt, and destroy owned handlers', async () => {
  const requests = []; let destroyed = 0;
  const credentials = async () => ({ accessKeyId: 'ASIA' + 'A'.repeat(16), secretAccessKey: 'x'.repeat(40), sessionToken: 'fictional-token', expiration: new Date(Date.now() + 900000) });
  const clients = createClients(credentials, { requestHandlerFactory: () => ({
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request) {
      requests.push(request);
      const sts = request.hostname === 'sts.eu-west-3.amazonaws.com';
      const body = sts ? '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::137819318729:assumed-role/clinicaclick-platform-alerts-role/fixture</Arn><UserId>FIXTURE</UserId><Account>137819318729</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></GetCallerIdentityResponse>'
        : request.headers['x-amz-target']?.endsWith('GetQueueAttributes') ? JSON.stringify({ Attributes: { QueueArn: S.QUEUE_ARN } }) : '{}';
      return { response: { statusCode: 200, headers: { 'content-type': sts ? 'text/xml' : 'application/x-amz-json-1.0', 'x-amzn-requestid': 'fixture' }, body: Buffer.from(body) } };
    },
    destroy() { destroyed++; },
  }) });
  try {
    const identity = await clients.identity({}); assert.equal(identity.Account, S.ACCOUNT);
    await clients.queue({});
    await clients.receive({ QueueUrl: S.QUEUE_URL, MaxNumberOfMessages: 10, VisibilityTimeout: 120, WaitTimeSeconds: 5 }, {});
    await clients.ack({ QueueUrl: S.QUEUE_URL, ReceiptHandle: 'FIXTURE' }, {});
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert(['sts.eu-west-3.amazonaws.com', 'sqs.eu-west-3.amazonaws.com'].includes(request.hostname));
      assert.equal(request.protocol, 'https:');
      assert(request.headers.authorization.includes('/eu-west-3/'));
    }
    assert.deepEqual(requests.slice(1).map(x => x.headers['x-amz-target']), ['AmazonSQS.GetQueueAttributes', 'AmazonSQS.ReceiveMessage', 'AmazonSQS.DeleteMessage']);
    for (const request of requests.slice(1)) assert.equal(JSON.parse(new TextDecoder().decode(request.body)).QueueUrl, S.QUEUE_URL);
  } finally { clients.destroy(); }
  assert.equal(destroyed, 2);
});
test('actual SDK does not retry an uncertain service response', async () => {
  let requests = 0;
  const clients = createClients(async () => ({ accessKeyId: 'ASIA' + 'A'.repeat(16), secretAccessKey: 'x'.repeat(40), sessionToken: 'fictional-token' }), {
    requestHandlerFactory: () => ({ metadata: { handlerProtocol: 'http/1.1' }, destroy() {}, async handle() {
      requests++;
      return { response: { statusCode: 503, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Buffer.from('{"__type":"ServiceUnavailable","message":"fixture"}') } };
    } }),
  });
  try { await assert.rejects(clients.ack({ QueueUrl: S.QUEUE_URL, ReceiptHandle: 'FIXTURE' }, {})); }
  finally { clients.destroy(); }
  assert.equal(requests, 1);
});
