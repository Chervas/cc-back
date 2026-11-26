'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { operation: signatureOperation } = require('../../services/integrations-broker/src/meta-marketing-social-signature');
const { createConfiguredMetaMarketingClient } = require('./metaMarketingBrokerReader.service');
const { receiverConfiguration } = require('./metaMarketingLeadWebhookReader.service');

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
      operation: signatureOperation,
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
module.exports = { verify };
