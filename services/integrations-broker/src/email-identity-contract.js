'use strict';
const Ajv = require('ajv');
const { fail } = require('./errors');

const domain = { type: 'string', minLength: 3, maxLength: 255, pattern: '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$' };
const schema = new Ajv({ strict: true }).compile({
  type: 'object',
  additionalProperties: false,
  properties: {
    identityName: domain,
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 20000 },
  },
  required: ['identityName', 'timeoutMs'],
});

function validate(payload) {
  if (!schema(payload) || payload.identityName !== payload.identityName.toLowerCase()) fail('invalid_request');
  return payload;
}

function authorize({ request, binding }) {
  if (binding.provider !== 'aws_ses' || !binding.email
    || request.assetRef !== 'email:identity-management'
    || !binding.email.templates.includes('marketing.campaign')) fail('scope_denied');
}

function project(value) {
  const status = String(value?.verificationStatus || '').toLowerCase();
  const dkimStatus = String(value?.dkimStatus || '').toLowerCase();
  if (!['pending', 'success', 'failed', 'temporary_failure', 'not_started'].includes(status)
    || !['pending', 'success', 'failed', 'temporary_failure', 'not_started'].includes(dkimStatus)) fail('provider_failed');
  const tokens = Array.isArray(value?.dkimTokens)
    ? value.dkimTokens.filter(token => typeof token === 'string' && /^[A-Za-z0-9+/=_-]{1,255}$/.test(token)).slice(0, 3)
    : [];
  return {
    identityName: value.identityName,
    verificationStatus: status,
    verifiedForSending: value.verifiedForSending === true,
    dkimStatus,
    dkimTokens: tokens,
    mailFromDomain: typeof value.mailFromDomain === 'string' ? value.mailFromDomain : null,
    mailFromStatus: typeof value.mailFromStatus === 'string' ? value.mailFromStatus.toLowerCase() : 'not_started',
  };
}

module.exports = { validate, authorize, project };
