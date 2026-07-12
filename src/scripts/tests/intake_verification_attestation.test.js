'use strict';

const assert = require('node:assert/strict');
const {
  buildVerificationConfigHash,
  canonicalizeIntakeDomain,
  canonicalizeIntakeDomains,
  cookieNoticeProviderMatches,
  issueVerificationAttestation,
  verifyVerificationAttestation,
} = require('../../lib/intake-verification-attestation');

process.env.INTAKE_VERIFICATION_ATTESTATION_SECRET = 'intake-attestation-test-secret';

function run() {
  assert.equal(canonicalizeIntakeDomain('https://WWW.PropDental.es./ruta'), 'propdental.es');
  assert.deepEqual(
    canonicalizeIntakeDomains(['www.propdental.es', 'propdental.es', 'citas.propdental.es']),
    ['citas.propdental.es', 'propdental.es'],
  );
  assert.equal(cookieNoticeProviderMatches('Complianz', 'complianz'), true);
  assert.equal(cookieNoticeProviderMatches('Cookiebot, Complianz', 'COMPLIANZ'), true);
  assert.equal(cookieNoticeProviderMatches('Complianz GDPR', 'complianz'), false,
    'Provider matching must be exact after case normalization');
  assert.equal(cookieNoticeProviderMatches('Cookiebot, OneTrust', 'complianz'), false);

  const config = {
    features: {
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
      external_cmp_provider: 'complianz',
    },
    texts: {
      legal_url: '/aviso-legal/',
      cookies_url: '/politica-de-cookies/',
      privacy_url: '/privacidad/',
    },
  };
  const hash = buildVerificationConfigHash({
    scopeType: 'group',
    scopeId: 5,
    domains: ['propdental.es', 'www.propdental.es'],
    config,
    hmacKey: 'snippet-key-a',
  });
  const nowMs = Date.UTC(2026, 6, 12, 12, 0, 0);
  const issued = issueVerificationAttestation({
    scopeType: 'group',
    scopeId: 5,
    domain: 'www.propdental.es',
    configHash: hash,
    nowMs,
    ttlSeconds: 900,
    signals: {
      installed: true,
      runtime_compatible: true,
      consent_mode_detected: true,
      google_consent_mode_detected: true,
      legal_urls_detected: true,
      legal_pages: {
        legal: { configured: true, reachable: true },
        cookies: { configured: true, reachable: true },
        privacy: { configured: true, reachable: true },
      },
    },
  });
  assert.ok(issued.token);
  assert.equal(issued.expiresAt, '2026-07-12T12:15:00.000Z');

  const expected = {
    scopeType: 'group',
    scopeId: 5,
    domain: 'propdental.es',
    configHash: hash,
    nowMs: nowMs + 1_000,
  };
  assert.equal(verifyVerificationAttestation(issued.token, expected).valid, true);
  assert.equal(verifyVerificationAttestation(`${issued.token}x`, expected).reason, 'attestation_signature_invalid');
  assert.equal(verifyVerificationAttestation(issued.token, { ...expected, scopeId: 6 }).reason, 'attestation_scope_mismatch');
  assert.equal(verifyVerificationAttestation(issued.token, {
    ...expected,
    domain: 'citas.propdental.es',
  }).reason, 'attestation_domain_mismatch');
  assert.equal(verifyVerificationAttestation(issued.token, {
    ...expected,
    configHash: 'f'.repeat(64),
  }).reason, 'attestation_config_mismatch');
  assert.equal(verifyVerificationAttestation(issued.token, {
    ...expected,
    nowMs: nowMs + (901 * 1_000),
  }).reason, 'attestation_expired');

  const rotatedHash = buildVerificationConfigHash({
    scopeType: 'group',
    scopeId: 5,
    domains: ['propdental.es'],
    config,
    hmacKey: 'snippet-key-b',
  });
  assert.notEqual(rotatedHash, hash, 'Rotating the snippet HMAC must invalidate prior attestations');

  console.log('intake_verification_attestation.test.js OK');
}

run();
