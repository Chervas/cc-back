'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');
const { SESv2Client, SendEmailCommand, GetEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { BrokerError, fail } = require('./errors');
const { credentials: validateCredentials } = require('./bedrock-contract');
const { commandInput, validate } = require('./email-contract');
const { REGION, MAX_RESPONSE_BYTES } = require('./email-limits');
const REJECTIONS = Object.freeze({
  AccountSuspendedException: 'email_ses_account_suspended', BadRequestException: 'email_ses_bad_request',
  LimitExceededException: 'email_ses_limit_exceeded', MailFromDomainNotVerifiedException: 'email_ses_mail_from_unverified',
  MessageRejected: 'email_ses_message_rejected', NotFoundException: 'email_ses_resource_not_found',
  SendingPausedException: 'email_ses_sending_paused', TooManyRequestsException: 'email_ses_throttled',
});
function limitedHandler(inner) {
  return { metadata: inner.metadata,
    async handle(request, options) {
      const outbound = request.method === 'POST' && request.path === '/v2/email/outbound-emails';
      const identityCreate = request.method === 'POST' && request.path === '/v2/email/identities';
      const identityRead = request.method === 'GET' && /^\/v2\/email\/identities\/[A-Za-z0-9.%_-]+$/.test(request.path);
      if (request.protocol !== 'https:' || request.hostname !== `email.${REGION}.amazonaws.com`
        || request.port && request.port !== 443 || !outbound && !identityCreate && !identityRead
        || Object.keys(request.query || {}).length) fail('invalid_request');
      const result = await inner.handle(request, options), body = result.response.body, chunks = [];
      let size = 0;
      const abort = () => body.destroy(new BrokerError('provider_timeout'));
      options?.abortSignal?.addEventListener('abort', abort, { once: true });
      try {
        if (options?.abortSignal?.aborted) abort();
        for await (const chunk of body) {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { body.destroy(); fail('provider_failed'); }
          chunks.push(Buffer.from(chunk));
        }
        result.response.body = Readable.from([Buffer.concat(chunks)]);
        return result;
      } finally { options?.abortSignal?.removeEventListener('abort', abort); }
    },
    updateHttpClientConfig: (...args) => inner.updateHttpClientConfig?.(...args),
    httpHandlerConfigs: () => inner.httpHandlerConfigs?.() || {}, destroy: () => inner.destroy?.(),
  };
}
function project(value) {
  if (value?.accepted === true && value.provider === 'ses' && typeof value.providerMessageId === 'string'
    && /^[A-Za-z0-9_-]{1,200}$/.test(value.providerMessageId)) {
    return { accepted: true, provider: 'ses', providerMessageId: value.providerMessageId };
  }
  if (value?.accepted === false && Object.values(REJECTIONS).includes(value.code)
    && value.retryable === (value.code === 'email_ses_throttled')) {
    return { accepted: false, code: value.code, retryable: value.retryable };
  }
  fail('provider_failed');
}
function createEmailHttp({ clientFactory = config => new SESv2Client(config),
  handlerFactory = () => new NodeHttpHandler({ httpsAgent: new https.Agent({ keepAlive: false, maxSockets: 1 }), connectionTimeout: 5000 }) } = {}) {
  return async ({ payload, token, signal }) => {
    validate(payload);
    let credentials;
    try { credentials = validateCredentials(JSON.parse(token.toString('utf8'))); } catch { fail('secret_unavailable'); }
    const values = Object.values(credentials), controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) fail('provider_timeout');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, payload.timeoutMs); timer.unref?.();
    let client, handler;
    try {
      handler = limitedHandler(handlerFactory());
      client = clientFactory({ region: REGION, credentials, endpoint: `https://email.${REGION}.amazonaws.com`,
        useFipsEndpoint: false, useDualstackEndpoint: false, retryMode: 'standard', maxAttempts: 1, requestHandler: handler });
      if (payload.stream === 'marketing') {
        const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: payload.identityName }), { abortSignal: controller.signal });
        if (identity?.VerifiedForSendingStatus !== true || identity?.DkimAttributes?.Status !== 'SUCCESS') {
          return project({ accepted: false, code: 'email_ses_mail_from_unverified', retryable: false });
        }
      }
      const response = await client.send(new SendEmailCommand(commandInput(payload)), { abortSignal: controller.signal });
      if (controller.signal.aborted) fail('provider_timeout');
      const data = project({ accepted: true, provider: 'ses', providerMessageId: response.MessageId });
      const json = JSON.stringify(data);
      for (const value of values) if ([value, encodeURIComponent(value), Buffer.from(value).toString('base64')].some(part => json.includes(part))) fail('provider_failed');
      return data;
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') fail('provider_timeout');
      if (error instanceof BrokerError) throw error;
      const status = Number(error.$metadata?.httpStatusCode);
      // A transport error, 5xx, malformed reply or unknown exception cannot
      // establish that SES did not accept the message. Never retry those.
      if (Object.hasOwn(REJECTIONS, error.name) && status >= 400 && status < 500
        && (error.name === 'TooManyRequestsException' ? status === 429 : status === 400 || status === 404)) {
        return project({ accepted: false, code: REJECTIONS[error.name], retryable: error.name === 'TooManyRequestsException' });
      }
      fail('provider_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); client?.destroy?.(); handler?.destroy?.(); }
  };
}
module.exports = { createEmailHttp, limitedHandler, project, REJECTIONS };
