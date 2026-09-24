'use strict';
const https = require('node:https');
const { SESv2Client, CreateEmailIdentityCommand, GetEmailIdentityCommand } = require('@aws-sdk/client-sesv2');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { credentials: validateCredentials } = require('./bedrock-contract');
const { fail } = require('./errors');
const { REGION } = require('./email-limits');
const { limitedHandler } = require('./email-http');
const contract = require('./email-identity-contract');

function normalize(identityName, response = {}) {
  return contract.project({
    identityName,
    verificationStatus: response.VerificationStatus || 'pending',
    verifiedForSending: response.VerifiedForSendingStatus === true,
    dkimStatus: response.DkimAttributes?.Status || 'pending',
    dkimTokens: response.DkimAttributes?.Tokens || [],
    mailFromDomain: response.MailFromAttributes?.MailFromDomain || null,
    mailFromStatus: response.MailFromAttributes?.MailFromDomainStatus || 'not_started',
  });
}

function createEmailIdentityHttp({ clientFactory = config => new SESv2Client(config) } = {}) {
  return async ({ action, payload, token, signal }) => {
    contract.validate(payload);
    let credentials;
    try { credentials = validateCredentials(JSON.parse(token.toString('utf8'))); } catch { fail('secret_unavailable'); }
    const handler = limitedHandler(new NodeHttpHandler({ httpsAgent: new https.Agent({ keepAlive: false, maxSockets: 1 }), connectionTimeout: 5000 }));
    const client = clientFactory({ region: REGION, credentials, endpoint: `https://email.${REGION}.amazonaws.com`, maxAttempts: 1, requestHandler: handler });
    try {
      if (action === 'ensure') {
        try {
          await client.send(new CreateEmailIdentityCommand({ EmailIdentity: payload.identityName }), { abortSignal: signal });
        } catch (error) {
          if (!['AlreadyExistsException', 'ConflictException'].includes(error?.name)) throw error;
        }
      }
      const response = await client.send(new GetEmailIdentityCommand({ EmailIdentity: payload.identityName }), { abortSignal: signal });
      return normalize(payload.identityName, response);
    } catch (error) {
      if (error?.name === 'AbortError') fail('provider_timeout');
      if (error?.name === 'NotFoundException') {
        return normalize(payload.identityName, {});
      }
      fail('provider_failed');
    } finally {
      client.destroy?.();
      handler.destroy?.();
    }
  };
}

module.exports = { createEmailIdentityHttp, normalize };
