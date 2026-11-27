'use strict';
const { randomUUID } = require('node:crypto');
const S = require('../../services/integrations-broker/src/meta-marketing-social');
const { createConfiguredMetaMarketingClient } = require('./metaMarketingBrokerReader.service');

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
    subscribePage: (r, versionId) => call(S.subscribe, r, { kind: 'dm', enrollmentId: r.enrollmentId, versionId }),
    history: (r, kind, start, end, cursor, participantId) =>
      call(S.history, r, { kind, start, end, cursor, ...(participantId ? { participantId } : {}) }),
    receive: (r, e) =>
      call(S.receive, r, {
        kind: e.type,
        ...(e.source === 'history' ? { history: true } : {}),
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
module.exports = { provider, verify: require('./socialInboxWebhookVerifier.service').verify };
