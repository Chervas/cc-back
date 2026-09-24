'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createEmailHttp, limitedHandler, REJECTIONS } = require('../src/email-http');
const C = require('../src/email-contract');
const L = require('../src/email-limits');
const { payload, credentials, accepted } = require('./email-fixture.cjs');

test('actual SES SDK serializes and signs only the closed native SendEmail request with one attempt', async () => {
  const p = payload(), requests = [];
  const send = createEmailHttp({ handlerFactory: () => ({ async handle(request) {
    requests.push(request);
    assert.equal(request.hostname, 'email.eu-west-3.amazonaws.com');
    assert.equal(request.path, '/v2/email/outbound-emails');
    assert.match(request.headers.authorization, /AWS4-HMAC-SHA256 Credential=AKIAFICTITIOUS1234567/);
    assert.deepEqual(JSON.parse(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8')), C.commandInput(p));
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json' },
      body: Readable.from([JSON.stringify({ MessageId: accepted().providerMessageId })]) } };
  }, destroy() {} }) });
  assert.deepEqual(await send({ payload: p, token: Buffer.from(JSON.stringify(credentials)) }), accepted());
  assert.equal(requests.length, 1);
});

test('real SES SDK does not retry a provider 429 or 503', async () => {
  for (const [status, name, expected] of [[429, 'TooManyRequestsException', 'throttle'], [503, 'ServiceUnavailableException', 'unknown']]) {
    let calls = 0;
    const send = createEmailHttp({ handlerFactory: () => ({ async handle() {
      calls++;
      return { response: { statusCode: status, headers: { 'content-type': 'application/json', 'x-amzn-errortype': name },
        body: Readable.from([JSON.stringify({ message: 'FICTITIOUS sensitive provider detail', __type: name })]) } };
    }, destroy() {} }) });
    const work = send({ payload: payload(), token: Buffer.from(JSON.stringify(credentials)) });
    if (expected === 'throttle') assert.deepEqual(await work, { accepted: false, retryable: true, code: 'email_ses_throttled' });
    else await assert.rejects(work, { code: 'provider_failed' });
    assert.equal(calls, 1);
  }
});

test('only named, matching 4xx rejections become safe typed results; ambiguous errors remain unknown', async () => {
  for (const [name, code] of Object.entries(REJECTIONS)) {
    const status = name === 'TooManyRequestsException' ? 429 : name === 'NotFoundException' ? 404 : 400;
    let calls = 0;
    const send = createEmailHttp({ clientFactory: config => {
      assert.equal(config.maxAttempts, 1); assert.deepEqual(config.credentials, credentials);
      return { async send() { calls++; throw Object.assign(Error('PRIVATE_RECIPIENT_AND_BODY'), { name, $metadata: { httpStatusCode: status } }); }, destroy() {} };
    } });
    assert.deepEqual(await send({ payload: payload(), token: Buffer.from(JSON.stringify(credentials)) }), {
      accepted: false, code, retryable: name === 'TooManyRequestsException',
    }); assert.equal(calls, 1);
  }
  for (const error of [Object.assign(Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(Error('untrusted'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 500 } }),
    Object.assign(Error('untyped 429'), { $metadata: { httpStatusCode: 429 } }), Error('private body')]) {
    const send = createEmailHttp({ clientFactory: () => ({ async send() { throw error; }, destroy() {} }) });
    await assert.rejects(send({ payload: payload(), token: Buffer.from(JSON.stringify(credentials)) }), { code: 'provider_failed' });
  }
});

test('missing IDs, credential reflection, aborts and malformed credentials cannot be accepted', async () => {
  for (const MessageId of [null, '', credentials.accessKeyId, Buffer.from(credentials.secretAccessKey).toString('base64')]) {
    const send = createEmailHttp({ clientFactory: () => ({ async send() { return { MessageId }; }, destroy() {} }) });
    await assert.rejects(send({ payload: payload(), token: Buffer.from(JSON.stringify(credentials)) }), { code: 'provider_failed' });
  }
  const send = createEmailHttp({ clientFactory: () => assert.fail('aborted/invalid request reached SES') });
  await assert.rejects(send({ payload: payload(), token: Buffer.from(JSON.stringify(credentials)), signal: AbortSignal.abort() }), { code: 'provider_timeout' });
  await assert.rejects(send({ payload: payload(), token: Buffer.from('{}') }), { code: 'secret_unavailable' });
});

test('pinned HTTP handler denies alternate destinations and caps provider bodies before parsing', async () => {
  let calls = 0;
  const handler = limitedHandler({ async handle() { calls++; return { response: { body: Readable.from([Buffer.alloc(L.MAX_RESPONSE_BYTES + 1)]) } }; } });
  const request = { protocol: 'https:', hostname: 'email.eu-west-3.amazonaws.com', method: 'POST', path: '/v2/email/outbound-emails', query: {} };
  for (const patch of [{ hostname: 'attacker.invalid' }, { protocol: 'http:' }, { port: 8443 }, { method: 'GET' },
    { path: '/v2/email/contact-lists' }, { query: { injected: '1' } }]) {
    await assert.rejects(handler.handle({ ...request, ...patch }), { code: 'invalid_request' });
  }
  assert.equal(calls, 0);
  await assert.rejects(handler.handle(request), { code: 'provider_failed' }); assert.equal(calls, 1);

  const identityHandler = limitedHandler({ async handle() {
    return { response: { body: Readable.from([Buffer.from('{}')]) } };
  } });
  await assert.doesNotReject(identityHandler.handle({
    ...request,
    method: 'PUT',
    path: '/v2/email/identities/clinic.example/mail-from',
  }));
});

test('contract rejects arbitrary SES features, marketing, header injection and oversized UTF8 content', () => {
  for (const patch of [{ Raw: { Data: 'unsafe' } }, { attachments: [] }, { cc: ['other@example.test'] },
    { stream: 'marketing' }, { from: 'ok@example.test\r\nBcc: extra@example.test' }, { to: 'QA@example.test' },
    { attempt: 0 }, { attempt: 101 }, { timeoutMs: 60000 }, { text: '界'.repeat(100000) }, { endpoint: 'https://other.invalid' }]) {
    assert.throws(() => C.validate(payload(patch)), { code: 'invalid_request' });
  }
});

test('marketing email verifies the exact SES domain before sending and blocks an unverified identity', async () => {
  const marketing = payload({
    templateKey: 'marketing.campaign',
    stream: 'marketing',
    recipientPolicy: 'marketing-consent',
    from: 'Clinic QA <news@example.test>',
    configurationSet: 'qa-marketing',
    identityName: 'example.test',
  });
  const commands = [];
  const verified = createEmailHttp({ clientFactory: () => ({
    async send(command) {
      commands.push(command.constructor.name);
      if (command.constructor.name === 'GetEmailIdentityCommand') {
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS' },
          MailFromAttributes: { MailFromDomain: 'bounce.example.test', MailFromDomainStatus: 'SUCCESS' },
        };
      }
      return { MessageId: accepted().providerMessageId };
    },
    destroy() {},
  }) });
  assert.deepEqual(await verified({ payload: marketing, token: Buffer.from(JSON.stringify(credentials)) }), accepted());
  assert.deepEqual(commands, ['GetEmailIdentityCommand', 'SendEmailCommand']);

  let sent = false;
  const blocked = createEmailHttp({ clientFactory: () => ({
    async send(command) {
      if (command.constructor.name === 'GetEmailIdentityCommand') {
        return { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'PENDING' } };
      }
      sent = true;
      return { MessageId: accepted().providerMessageId };
    },
    destroy() {},
  }) });
  assert.deepEqual(await blocked({ payload: marketing, token: Buffer.from(JSON.stringify(credentials)) }), {
    accepted: false,
    code: 'email_ses_mail_from_unverified',
    retryable: false,
  });
  assert.equal(sent, false);

  const pendingMailFrom = createEmailHttp({ clientFactory: () => ({
    async send(command) {
      if (command.constructor.name === 'GetEmailIdentityCommand') {
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS' },
          MailFromAttributes: { MailFromDomain: 'bounce.example.test', MailFromDomainStatus: 'PENDING' },
        };
      }
      assert.fail('mail must not be sent before the custom MAIL FROM is verified');
    },
    destroy() {},
  }) });
  assert.deepEqual(await pendingMailFrom({ payload: marketing, token: Buffer.from(JSON.stringify(credentials)) }), {
    accepted: false,
    code: 'email_ses_mail_from_unverified',
    retryable: false,
  });
});
