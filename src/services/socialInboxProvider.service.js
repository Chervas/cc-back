'use strict';
const { randomUUID, createHash } = require('node:crypto');
const S = require('../../services/integrations-broker/src/meta-marketing-social');
const { createConfiguredMetaMarketingClient } = require('./metaMarketingBrokerReader.service');
const { receiverConfiguration } = require('./metaMarketingLeadWebhookReader.service');

function provider(env = process.env) {
  const client = createConfiguredMetaMarketingClient({ env, transportProfile: 'meta-marketing' });
  async function call(operation, route, payload, requestId = randomUUID()) {
    if (env.META_SOCIAL_INBOX_ENABLED !== 'true') return { available: false, reason: 'social_disabled' };
    const response = await client.execute(
      {
        operation,
        requestId,
        tenantRef: route.tenantRef,
        assetRef: 'meta-facebook_page:' + route.pageId,
        connectionRef: route.connectionRef,
        payload: {
          clinicId: route.clinicId,
          channel: route.channel,
          accountId: route.accountId,
          ...payload,
        },
      },
      { timeoutMs: 28000 },
    );
    if (response?.requestId !== requestId || typeof response.data?.available !== 'boolean')
      throw Error('broker_response_invalid');
    return response.data;
  }
  return {
    receive: (r, e) =>
      call(S.receive, r, {
        kind: e.type,
        senderId: e.senderId,
        postId: e.postId || null,
        commentId: e.commentId || null,
      }),
    reconcile: (r, kind, recipient, text, attemptId) =>
      call(S.outcome, r, { kind, recipient, text, attemptId }),
    availability: (r, kind) => call(S.status, r, { kind }),
    send: (r, kind, recipient, text, attemptId) =>
      call(S.send, r, { kind, recipient, text, attemptId }, attemptId),
  };
}
async function verify(raw, signature, env = process.env) {
  const c = receiverConfiguration(env);
  const client = createConfiguredMetaMarketingClient({
    env: {
      META_MARKETING_BROKER_ORIGIN: c.origin,
      META_MARKETING_BROKER_AUDIENCE: c.audience,
      META_MARKETING_BROKER_KEY_ID: c.keyId,
      META_MARKETING_BROKER_KEY_FILE: c.keyFile,
      META_MARKETING_BROKER_CA_FILE: c.caFile,
    },
    transportProfile: 'meta-marketing',
  });
  const requestId = randomUUID();
  const response = await client.execute(
    {
      operation: S.verify,
      requestId,
      tenantRef: env.META_SOCIAL_VERIFY_TENANT_REF,
      connectionRef: env.META_SOCIAL_VERIFY_CONNECTION_REF,
      assetRef: 'meta-facebook_page:' + env.META_SOCIAL_VERIFY_PAGE_ID,
      payload: { rawBase64: raw.toString('base64'), signature },
    },
    { timeoutMs: 20000 },
  );
  if (
    response?.requestId !== requestId ||
    response.data?.appId !== c.appId ||
    response.data?.digest !== createHash('sha256').update(raw).digest('hex')
  )
    throw Error('social_verification_unavailable');
  return c.appId;
}
module.exports = { provider, verify };
