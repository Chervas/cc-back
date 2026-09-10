'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const { buildVerificationConfigHash, canonicalizeIntakeDomains, canonicalizeIntakeDomain } = require('./intake-verification-attestation');

const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['mutation_kind', 'expected_revision', 'domain', 'form_intercept_enabled', 'consent_provider', 'legal_urls'],
  properties: {
    mutation_kind: { const: 'campaign_preparation' },
    group_id: { type: 'integer', minimum: 1 },
    expected_revision: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] },
    domain: { type: 'string', minLength: 3, maxLength: 2048 },
    form_intercept_enabled: { type: 'boolean' },
    consent_provider: { enum: ['clinicaclick', 'external_cmp'] },
    external_cmp_provider: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,40}$' },
    legal_urls: { type: 'object', additionalProperties: false, required: ['legal', 'privacy', 'cookies'], properties: {
      legal: { type: 'string', minLength: 1, maxLength: 2048 },
      privacy: { type: 'string', minLength: 1, maxLength: 2048 },
      cookies: { type: 'string', minLength: 1, maxLength: 2048 },
    } },
  },
});

function error(code, status = 400) { return Object.assign(new Error(code), { code, status }); }

function preparationRevision(record) {
  if (!record) return null;
  const verification = buildVerificationConfigHash({ scopeType: record.assignment_scope,
    scopeId: record.assignment_scope === 'group' ? record.group_id : record.clinic_id,
    domains: record.domains, config: record.config, hmacKey: record.hmac_key });
  return crypto.createHash('sha256').update(JSON.stringify([verification, record.config?.features?.form_intercept_enabled ?? null])).digest('hex');
}

function validatePreparation(body) {
  if (!validate(body)) throw error('intake_preparation_invalid');
  if (body.consent_provider === 'external_cmp' && !body.external_cmp_provider) throw error('intake_external_cmp_required');
  for (const value of Object.values(body.legal_urls)) {
    // Root-relative legal pages are shared across domains by the existing web editor.
    if (/^\/(?![\/\\])[^\\\x00-\x20]*$/.test(value.trim())) continue;
    let url;
    try { url = new URL(value); } catch { throw error('intake_legal_url_invalid'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw error('intake_legal_url_invalid');
  }
  const domain = canonicalizeIntakeDomain(body.domain);
  if (!domain || !domain.includes('.')) throw error('intake_domain_invalid');
  return domain;
}

function applyCampaignPreparation(record, body) {
  const domain = validatePreparation(body);
  if (body.expected_revision !== preparationRevision(record)) throw error('intake_preparation_conflict', 409);
  const previous = record?.config || {};
  const features = {
    chat_enabled: false, tel_modal_enabled: false, viewcontent_enabled: true, webevents_enabled: true,
    ...(!record ? { google_ads_user_data_enabled: false, google_ads_user_data_disclosure_confirmed: false, google_ads_user_data_runtime_enabled: false } : {}),
    ...previous.features,
  };
  return {
    domains: canonicalizeIntakeDomains([...(record?.domains || []), domain]),
    config: { ...previous,
      features: { ...features, form_intercept_enabled: body.form_intercept_enabled, consent_mode_enabled: true,
        consent_provider: body.consent_provider,
        external_cmp_provider: body.external_cmp_provider || previous.features?.external_cmp_provider || 'complianz' },
      texts: { ...previous.texts, legal_url: body.legal_urls.legal.trim(), privacy_url: body.legal_urls.privacy.trim(), cookies_url: body.legal_urls.cookies.trim() },
    },
  };
}

function mergeVerifiedDomains(existingVerification, incomingVerification, rebuild) {
  const incoming = rebuild(incomingVerification, true);
  const existing = rebuild(existingVerification, false);
  return rebuild({ attestations_by_domain: {
    ...existing.attestations_by_domain, ...incoming.attestations_by_domain,
  } }, false);
}

module.exports = { preparationRevision, validatePreparation, applyCampaignPreparation, mergeVerifiedDomains };
