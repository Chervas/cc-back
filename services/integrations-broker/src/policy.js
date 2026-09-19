'use strict';

const Ajv = require('ajv');
const { createPublicKey } = require('node:crypto');
const { ref } = require('./contracts');
const { fail } = require('./errors');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const strings = { type: 'array', minItems: 1, uniqueItems: true, items: ref };
const validate = new Ajv({ strict: true }).compile(object({
  audience: ref, version: ref, maxBacklog: { type: 'integer', minimum: 2, maximum: 100000 },
  principals: { type: 'array', maxItems: 100, items: object({ id: ref, keyId: ref, enabled: { type: 'boolean' },
    publicKey: { type: 'string', maxLength: 1024 }, maxPerMinute: { type: 'integer', minimum: 1, maximum: 600 } }) },
  connections: { type: 'array', maxItems: 10000, items: object({ connectionRef: ref, provider: ref,
    initialState: { enum: ['active', 'blocked', 'revoked', 'expired'] },
    expiresAt: { type: ['integer', 'null'], minimum: 0 }, secretArn: { type: 'string', maxLength: 2048 },
    clientSecretArn: { type: 'string', maxLength: 2048 },
    developerSecretArn: { type: 'string', maxLength: 2048 },
    templateReaderSecretArn: { type: 'string', maxLength: 2048 },
    whatsapp: require('./whatsapp-contract').bindingSchema,
    whatsappOnboarding: require('./whatsapp-onboarding-contract').bindingSchema,
    metaMarketing: require('./meta-marketing-contract').bindingSchema,
    metaMarketingOAuth: require('./meta-marketing-oauth-contract').bindingSchema,
    ai: require('./ai-contract').bindingSchema,
    bedrock: require('./bedrock-contract').bindingSchema,
    email: require('./email-contract').bindingSchema,
    googleSubject: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
    searchConsoleSites: { type: 'array', minItems: 1, maxItems: 1000,
      items: object({ assetRef: ref, siteUrl: { type: 'string', maxLength: 512 } }) },
    analyticsProperties: { type: 'array', minItems: 1, maxItems: 1000,
      items: object({ assetRef: ref, propertyName: { type: 'string', pattern: '^properties/[1-9][0-9]{0,19}$' } }) },
    googleAdsAccounts: { type: 'array', minItems: 1, maxItems: 1000,
      items: object({ assetRef: ref, customerId: { type: 'string', pattern: '^[0-9]{10}$' },
        loginCustomerId: { type: ['string', 'null'], pattern: '^[0-9]{10}$' } }) },
    googleAdsEnrollmentScopes: { type: 'array', minItems: 1, maxItems: 100,
      items: require('./google-ads-enrollment-contract').scopeSchema },
    googleDataManager: require('./google-data-manager-contract').bindingSchema,
    googleDataManagerEnrollment: require('./google-destination-contract').bindingSchema,
    googleAdsActionManagement: require('./google-action-management-contract').bindingSchema,
    googleBusinessProfileWrites: require('./google-business-profile-write-contract').bindingSchema,
    oauth: require('./google-oauth-contract').bindingSchema }, ['connectionRef', 'provider', 'initialState']) },
  grants: { type: 'array', maxItems: 100000, items: object({ principalId: ref, tenantRef: ref, connectionRef: ref, assetRef: ref, operations: strings }) },
}));
function validatePolicy(policy) {
  if (!validate(policy)) fail('invalid_request');
  for (const [rows, key] of [[policy.principals, 'id'], [policy.principals, 'keyId'], [policy.connections, 'connectionRef']]) {
    if (new Set(rows.map(row => row[key])).size !== rows.length) fail('invalid_request');
  }
  try { for (const row of policy.principals) if (createPublicKey(row.publicKey).asymmetricKeyType !== 'ed25519') fail('invalid_request'); }
  catch { fail('invalid_request'); }
  for (const grant of policy.grants) {
    if (!policy.principals.some(row => row.id === grant.principalId) || !policy.connections.some(row => row.connectionRef === grant.connectionRef)) fail('invalid_request');
  }
  for (const binding of policy.connections) {
    if (Boolean(binding.metaMarketing) !== (binding.provider === 'meta_marketing')) fail('invalid_request');
    if (binding.metaMarketing) require('./meta-marketing-contract').bindingFor(binding);
    if (Boolean(binding.metaMarketingOAuth) !== (binding.provider === 'meta_marketing_onboarding')) fail('invalid_request');
    if (binding.metaMarketingOAuth) require('./meta-marketing-oauth-contract').bindingFor(binding);
    if (binding.googleAdsActionManagement) require('./google-action-management-contract').validateBinding(binding);
    if (binding.googleBusinessProfileWrites) require('./google-business-profile-write-contract').validateBinding(binding);
    if (binding.googleDataManager) require('./google-data-manager-contract').validateBinding(binding);
    if (binding.googleDataManagerEnrollment) require('./google-destination-contract').validateBinding(binding);
    if (Boolean(binding.bedrock) !== (binding.provider === 'aws_bedrock')) fail('invalid_request');
    if (Boolean(binding.email) !== (binding.provider === 'aws_ses')) fail('invalid_request');
    if (binding.ai && !['ai_openai', 'ai_gemini', 'ai_groq'].includes(binding.provider)
      || binding.provider.startsWith('ai_') && !binding.ai
      || binding.ai && binding.provider !== 'ai_openai' && (binding.ai.organization || binding.ai.project)) fail('invalid_request');
    if ((binding.whatsapp || binding.templateReaderSecretArn) && binding.provider !== 'meta_whatsapp') fail('invalid_request');
    if (binding.provider === 'meta_whatsapp') require('./whatsapp-contract').bindingFor(binding);
    if (binding.whatsappOnboarding && binding.provider !== 'meta_whatsapp_onboarding') fail('invalid_request');
    if (binding.provider === 'meta_whatsapp_onboarding') require('./whatsapp-onboarding-contract').bindingFor(binding);
  }
  return policy;
}
module.exports = { validatePolicy };
