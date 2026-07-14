'use strict';

const crypto = require('crypto');

const ATTESTATION_TYPE = 'cc-intake-verification';
const ATTESTATION_VERSION = 1;
const DEFAULT_ATTESTATION_TTL_SECONDS = 15 * 60;
const MAX_ATTESTATION_TTL_SECONDS = 20 * 60;
const DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const MAX_PERSISTED_VERIFICATION_TTL_SECONDS = 7 * 24 * 60 * 60;

function canonicalizeIntakeDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');
  } catch (_error) {
    return '';
  }
}

function canonicalizeIntakeDomains(values) {
  let source = values;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_error) {
      source = [source];
    }
  }
  return Array.from(new Set((Array.isArray(source) ? source : [])
    .map(canonicalizeIntakeDomain)
    .filter(Boolean)))
    .sort();
}

function cookieNoticeProviderMatches(detectedProviders, expectedProvider) {
  const expected = String(expectedProvider || '').trim().toLowerCase();
  if (!expected) return false;
  const source = Array.isArray(detectedProviders)
    ? detectedProviders
    : String(detectedProviders || '').split(',');
  return source.some((provider) => String(provider || '').trim().toLowerCase() === expected);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeScopeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'group' || normalized === 'clinic' ? normalized : null;
}

function normalizeScopeId(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildVerificationConfigHash({ scopeType, scopeId, domains, config, hmacKey } = {}) {
  const normalizedScopeType = normalizeScopeType(scopeType);
  const normalizedScopeId = normalizeScopeId(scopeId);
  const safeConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const features = safeConfig.features && typeof safeConfig.features === 'object' && !Array.isArray(safeConfig.features)
    ? safeConfig.features
    : {};
  const texts = safeConfig.texts && typeof safeConfig.texts === 'object' && !Array.isArray(safeConfig.texts)
    ? safeConfig.texts
    : {};
  const relevant = {
    scope: { type: normalizedScopeType, id: normalizedScopeId },
    domains: canonicalizeIntakeDomains(domains),
    consent: {
      enabled: features.consent_mode_enabled === true,
      provider: String(features.consent_provider || '').trim().toLowerCase() || null,
      external_cmp_provider: String(features.external_cmp_provider || '').trim().toLowerCase() || null,
    },
    legal_urls: {
      legal: String(texts.legal_url || texts.terms_url || '').trim() || null,
      cookies: String(texts.cookies_url || '').trim() || null,
      privacy: String(texts.privacy_url || '').trim() || null,
    },
    // The clear HMAC key never leaves this process. Its digest makes a key
    // rotation invalidate a verification made against the previous snippet.
    snippet_hmac_sha256: hmacKey ? sha256(hmacKey) : null,
  };
  return sha256(stableJson(relevant));
}

function resolveAttestationSecret() {
  const value = String(
    process.env.INTAKE_VERIFICATION_ATTESTATION_SECRET
      || process.env.JWT_SECRET
      || ''
  ).trim();
  return value || null;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function signPayload(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function safeSignals(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legalPagesSource = source.legal_pages && typeof source.legal_pages === 'object'
    && !Array.isArray(source.legal_pages)
    ? source.legal_pages
    : {};
  const legalPages = {};
  for (const key of ['legal', 'cookies', 'privacy']) {
    const page = legalPagesSource[key] && typeof legalPagesSource[key] === 'object'
      ? legalPagesSource[key]
      : {};
    legalPages[key] = {
      configured: page.configured === true,
      reachable: page.reachable === true,
      url: String(page.url || '').slice(0, 2048) || null,
      checked_url: String(page.checked_url || '').slice(0, 2048) || null,
      reason: String(page.reason || '').slice(0, 64) || null,
    };
  }
  return {
    installed: source.installed === true,
    runtime_compatible: source.runtime_compatible === true,
    runtime_version: String(source.runtime_version || '').slice(0, 32) || null,
    consent_mode_detected: source.consent_mode_detected === true,
    cookie_notice_detected: source.cookie_notice_detected === true,
    cookie_notice_provider: String(source.cookie_notice_provider || '').slice(0, 128) || null,
    google_consent_mode_detected: source.google_consent_mode_detected === true,
    legacy_chat_detected: source.legacy_chat_detected === true,
    legacy_chat_provider: String(source.legacy_chat_provider || '').slice(0, 64) || null,
    legal_urls_detected: source.legal_urls_detected === true,
    legal_pages: legalPages,
    checked_url: String(source.checked_url || '').slice(0, 2048) || null,
  };
}

function issueVerificationAttestation({
  scopeType,
  scopeId,
  domain,
  configHash,
  signals,
  nowMs = Date.now(),
  ttlSeconds = DEFAULT_ATTESTATION_TTL_SECONDS,
} = {}) {
  const secret = resolveAttestationSecret();
  const normalizedScopeType = normalizeScopeType(scopeType);
  const normalizedScopeId = normalizeScopeId(scopeId);
  const normalizedDomain = canonicalizeIntakeDomain(domain);
  const normalizedConfigHash = String(configHash || '').trim().toLowerCase();
  const normalizedTtl = Math.min(
    Math.max(1, Number.parseInt(String(ttlSeconds), 10) || DEFAULT_ATTESTATION_TTL_SECONDS),
    MAX_ATTESTATION_TTL_SECONDS,
  );
  if (!secret) return { token: null, expiresAt: null, reason: 'attestation_secret_missing' };
  if (!normalizedScopeType || !normalizedScopeId || !normalizedDomain || !/^[a-f0-9]{64}$/.test(normalizedConfigHash)) {
    return { token: null, expiresAt: null, reason: 'attestation_input_invalid' };
  }

  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + normalizedTtl;
  const claims = {
    typ: ATTESTATION_TYPE,
    v: ATTESTATION_VERSION,
    scope: { type: normalizedScopeType, id: normalizedScopeId },
    domain: normalizedDomain,
    config_hash: normalizedConfigHash,
    signals: safeSignals(signals),
    iat: issuedAt,
    exp: expiresAt,
  };
  const encoded = encodeBase64Url(stableJson(claims));
  return {
    token: `${encoded}.${signPayload(encoded, secret)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    reason: null,
    claims,
  };
}

function resolvePersistedVerificationTtlSeconds(value) {
  const configured = value ?? process.env.INTAKE_PERSISTED_VERIFICATION_TTL_SECONDS;
  return Math.min(
    Math.max(
      1,
      Number.parseInt(String(configured ?? ''), 10) || DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS,
    ),
    MAX_PERSISTED_VERIFICATION_TTL_SECONDS,
  );
}

function verifyVerificationAttestationClaims(token, {
  scopeType,
  scopeId,
  domain,
  configHash,
  nowMs = Date.now(),
  allowExpired = false,
} = {}) {
  const secret = resolveAttestationSecret();
  if (!secret) return { valid: false, reason: 'attestation_secret_missing', claims: null };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: 'attestation_malformed', claims: null };
  }
  const expectedSignature = signPayload(parts[0], secret);
  const actualBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: 'attestation_signature_invalid', claims: null };
  }

  let claims;
  try {
    claims = JSON.parse(decodeBase64Url(parts[0]));
  } catch (_error) {
    return { valid: false, reason: 'attestation_payload_invalid', claims: null };
  }
  if (claims?.typ !== ATTESTATION_TYPE || claims?.v !== ATTESTATION_VERSION) {
    return { valid: false, reason: 'attestation_version_invalid', claims: null };
  }
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    return { valid: false, reason: 'attestation_time_invalid', claims: null };
  }
  if (expiresAt - issuedAt > MAX_ATTESTATION_TTL_SECONDS) {
    return { valid: false, reason: 'attestation_ttl_invalid', claims: null };
  }
  if (issuedAt > nowSeconds + 30) {
    return { valid: false, reason: 'attestation_not_yet_valid', claims: null };
  }
  if (!allowExpired && expiresAt <= nowSeconds) {
    return { valid: false, reason: 'attestation_expired', claims };
  }

  const expectedScopeType = normalizeScopeType(scopeType);
  const expectedScopeId = normalizeScopeId(scopeId);
  const expectedDomain = canonicalizeIntakeDomain(domain);
  const expectedConfigHash = String(configHash || '').trim().toLowerCase();
  if (claims?.scope?.type !== expectedScopeType || claims?.scope?.id !== expectedScopeId) {
    return { valid: false, reason: 'attestation_scope_mismatch', claims };
  }
  if (claims.domain !== expectedDomain) {
    return { valid: false, reason: 'attestation_domain_mismatch', claims };
  }
  if (claims.config_hash !== expectedConfigHash) {
    return { valid: false, reason: 'attestation_config_mismatch', claims };
  }

  return { valid: true, reason: null, claims: { ...claims, signals: safeSignals(claims.signals) } };
}

function verifyVerificationAttestation(token, expected = {}) {
  return verifyVerificationAttestationClaims(token, expected);
}

/**
 * Verifies evidence that was already accepted and persisted by the backend.
 *
 * The signed token remains intentionally short-lived so it cannot be replayed
 * as a new admin submission. Once accepted, the same signed claims can support
 * readiness for a separate operational window. Signature, scope, domain,
 * config hash and the original short token TTL are still checked every time.
 */
function verifyPersistedVerificationAttestation(token, {
  operationalTtlSeconds,
  ...expected
} = {}) {
  const result = verifyVerificationAttestationClaims(token, {
    ...expected,
    allowExpired: true,
  });
  if (!result.valid) return result;

  const nowSeconds = Math.floor((expected.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = resolvePersistedVerificationTtlSeconds(operationalTtlSeconds);
  const operationalExpiresAt = Number(result.claims.iat) + ttlSeconds;
  if (operationalExpiresAt <= nowSeconds) {
    return {
      valid: false,
      reason: 'attestation_operational_expired',
      claims: result.claims,
      operationalExpiresAt,
    };
  }

  return {
    ...result,
    operationalExpiresAt,
    operationalExpiresAtIso: new Date(operationalExpiresAt * 1000).toISOString(),
  };
}

module.exports = {
  ATTESTATION_TYPE,
  ATTESTATION_VERSION,
  DEFAULT_ATTESTATION_TTL_SECONDS,
  MAX_ATTESTATION_TTL_SECONDS,
  DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS,
  MAX_PERSISTED_VERIFICATION_TTL_SECONDS,
  buildVerificationConfigHash,
  canonicalizeIntakeDomain,
  canonicalizeIntakeDomains,
  cookieNoticeProviderMatches,
  issueVerificationAttestation,
  resolvePersistedVerificationTtlSeconds,
  verifyPersistedVerificationAttestation,
  verifyVerificationAttestation,
};
