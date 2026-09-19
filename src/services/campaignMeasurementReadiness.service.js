'use strict';

const { buildVerificationConfigHash, canonicalizeIntakeDomain, canonicalizeIntakeDomains,
  cookieNoticeProviderMatches, verifyPersistedVerificationAttestation } = require('../lib/intake-verification-attestation');
const parseInteger = raw => raw === undefined || raw === null || raw === '' ? null
  : Number.isInteger(Number.parseInt(raw, 10)) ? Number.parseInt(raw, 10) : null;
const listToUniqueArray = values => [...new Set((values || []).filter(Boolean).map(String))];

function normalizeConsentDomain(value) {
  return canonicalizeIntakeDomain(value);
}

function normalizeConsentDomains(values) {
  let source = values;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (_error) { source = [source]; }
  }
  return canonicalizeIntakeDomains(Array.isArray(source) ? source : []);
}

function readIntakeRecordConfig(record) {
  const raw = record?.config ?? record?.get?.('config') ?? null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function assessConsentMeasurementReadiness(marketingState) {
  const scope = marketingState?.scope || {};
  const record = scope.assignment_scope === 'group'
    ? marketingState?.records?.groupRecord
    : (marketingState?.records?.clinicRecord || marketingState?.records?.groupRecord);
  const config = record?.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? record.config
    : {};
  const features = config.features && typeof config.features === 'object' && !Array.isArray(config.features)
    ? config.features
    : {};
  const texts = config.texts && typeof config.texts === 'object' && !Array.isArray(config.texts)
    ? config.texts
    : {};
  const verification = config.snippet_verification
    && typeof config.snippet_verification === 'object'
    && !Array.isArray(config.snippet_verification)
    ? config.snippet_verification
    : {};
  const domains = normalizeConsentDomains(record?.domains);
  const provider = String(features.consent_provider || '').trim().toLowerCase();
  const externalCmpProvider = String(features.external_cmp_provider || '').trim().toLowerCase();
  const recordScopeType = String(record?.assignment_scope || '').trim().toLowerCase() === 'group'
    || (!record?.clinic_id && record?.group_id)
    ? 'group'
    : 'clinic';
  const recordScopeId = recordScopeType === 'group'
    ? parseInteger(record?.group_id)
    : parseInteger(record?.clinic_id);
  const configHash = buildVerificationConfigHash({
    scopeType: recordScopeType,
    scopeId: recordScopeId,
    domains: record?.domains,
    config,
    hmacKey: record?.hmac_key,
  });
  const issues = [];
  const renewalIssues = [];
  const add = (reason, extra = {}) => issues.push({ reason, ...extra });

  if (features.consent_mode_enabled !== true) add('consent_mode_disabled');
  if (!['clinicaclick', 'external_cmp'].includes(provider)) add('consent_provider_missing');
  if (provider === 'external_cmp' && !externalCmpProvider) add('external_cmp_provider_missing');
  if (!domains.length) add('consent_domains_missing');
  const missingLegal = [
    ['legal', texts.legal_url || texts.terms_url],
    ['cookies', texts.cookies_url],
    ['privacy', texts.privacy_url]
  ].filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
  if (missingLegal.length) add('consent_legal_urls_missing', { missing: missingLegal });
  const rawAttestations = verification.attestations_by_domain
    && typeof verification.attestations_by_domain === 'object'
    && !Array.isArray(verification.attestations_by_domain)
    ? verification.attestations_by_domain
    : {};
  const attestations = new Map();
  const validAttestationExpirations = [];
  for (const [rawDomain, token] of Object.entries(rawAttestations)) {
    const domain = normalizeConsentDomain(rawDomain);
    if (domain && !attestations.has(domain) && typeof token === 'string') {
      attestations.set(domain, token);
    }
  }

  for (const domain of domains) {
    const token = attestations.get(domain);
    if (!token) {
      add('consent_attestation_missing', { domain });
      continue;
    }
    const attestation = verifyPersistedVerificationAttestation(token, {
      scopeType: recordScopeType,
      scopeId: recordScopeId,
      domain,
      configHash,
    });
    if (!attestation.valid) {
      if (attestation.reason === 'attestation_operational_expired' && attestation.claims) {
        const renewalIssue = {
          reason: 'consent_attestation_renewal_required',
          domain,
          details: attestation.reason
        };
        issues.push(renewalIssue);
        renewalIssues.push(renewalIssue);
      } else {
        add('consent_attestation_invalid', { domain, details: attestation.reason });
        continue;
      }
    }
    if (Number.isSafeInteger(Number(attestation.operationalExpiresAt))) {
      validAttestationExpirations.push(Number(attestation.operationalExpiresAt));
    }
    const signals = attestation.claims?.signals || {};
    if (signals.installed !== true) add('consent_domain_unverified', { domain });
    if (signals.runtime_compatible !== true) add('consent_runtime_incompatible', { domain });
    if (signals.consent_mode_detected !== true) add('consent_signal_unverified', { domain });
    if (signals.google_consent_mode_detected !== true) add('google_consent_mode_unverified', { domain });
    if (provider === 'external_cmp' && (
      signals.cookie_notice_detected !== true
        || !cookieNoticeProviderMatches(signals.cookie_notice_provider, externalCmpProvider)
    )) {
      add('external_cmp_unverified', {
        domain,
        expected_provider: externalCmpProvider || null,
        detected_provider: signals.cookie_notice_provider || null,
        details: signals.cookie_notice_detected === true
          ? 'external_cmp_provider_mismatch'
          : 'external_cmp_not_detected',
      });
    }
    const pages = signals.legal_pages && typeof signals.legal_pages === 'object' ? signals.legal_pages : {};
    const invalidPages = ['legal', 'cookies', 'privacy'].filter((key) => (
      pages[key]?.configured !== true || pages[key]?.reachable !== true
    ));
    if (invalidPages.length) add('consent_legal_urls_unverified', { domain, missing: invalidPages });
  }

  const reasons = listToUniqueArray(issues.map((issue) => issue.reason));
  const minimumExpiration = validAttestationExpirations
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((minimum, value) => minimum === null || value < minimum ? value : minimum, null);
  const renewalIssueSet = new Set(renewalIssues);
  const blockingIssues = issues.filter((issue) => !renewalIssueSet.has(issue));
  return {
    ready: issues.length === 0,
    validated: issues.length === 0,
    reason: reasons[0] || null,
    reasons,
    issues,
    provider: ['clinicaclick', 'external_cmp'].includes(provider) ? provider : null,
    domains,
    expires_at: minimumExpiration ? new Date(minimumExpiration * 1000).toISOString() : null,
    verification_current: renewalIssues.length === 0 && issues.length === 0,
    renewal_required: renewalIssues.length > 0,
    renewal_issues: renewalIssues,
    // A stale observation never grants consent. It only means that the signed,
    // scope-bound configuration is still internally coherent while a new
    // public verification is required. The uploader must continue requiring
    // the visitor's live Consent Mode signal for every conversion.
    runtime_configuration_ready: blockingIssues.length === 0,
  };
}

function resolveWebMeasurementMarketingState(scope, marketingState) {
  const requestedScope = scope || marketingState?.scope || {};
  const records = marketingState?.records || {};
  const clinicRecord = records.clinicRecord || null;
  const groupRecord = records.groupRecord || null;

  if (requestedScope.assignment_scope === 'group') {
    return {
      source: 'group',
      assignment_scope: 'group',
      clinic_id: null,
      group_id: parseInteger(requestedScope.group_id || groupRecord?.group_id),
      record: groupRecord,
      marketingState: {
        ...marketingState,
        scope: {
          ...(marketingState?.scope || {}),
          assignment_scope: 'group',
          clinic_id: null,
          group_id: parseInteger(requestedScope.group_id || groupRecord?.group_id)
        },
        records: { clinicRecord: null, groupRecord }
      }
    };
  }

  const clinicId = parseInteger(requestedScope.clinic_id);
  const groupConfig = readIntakeRecordConfig(groupRecord);
  const groupLocationIds = new Set((Array.isArray(groupConfig.locations) ? groupConfig.locations : [])
    .map((location) => parseInteger(location?.id || location?.clinic_id))
    .filter(Boolean));
  const usesGroupWebMeasurement = Boolean(groupRecord && clinicId && groupLocationIds.has(clinicId));
  const record = usesGroupWebMeasurement ? groupRecord : (clinicRecord || groupRecord);
  const assignmentScope = usesGroupWebMeasurement || (!clinicRecord && groupRecord) ? 'group' : 'clinic';
  const groupId = parseInteger(requestedScope.group_id || groupRecord?.group_id);

  return {
    source: usesGroupWebMeasurement
      ? 'group_web_location'
      : (assignmentScope === 'group' ? 'group_fallback' : 'clinic'),
    assignment_scope: assignmentScope,
    clinic_id: clinicId,
    group_id: groupId,
    record,
    marketingState: {
      ...marketingState,
      scope: {
        ...(marketingState?.scope || {}),
        assignment_scope: assignmentScope,
        clinic_id: assignmentScope === 'clinic' ? clinicId : null,
        group_id: groupId
      },
      records: assignmentScope === 'group'
        ? { clinicRecord: null, groupRecord: record }
        : { clinicRecord: record, groupRecord: null }
    }
  };
}

module.exports = { assessConsentMeasurementReadiness, resolveWebMeasurementMarketingState };
