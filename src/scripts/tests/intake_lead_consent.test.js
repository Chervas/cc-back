'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveLeadConsentMetadata } = require('../../lib/intake-lead-consent');

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function run() {
  const capturedAt = '2026-07-12T10:44:00.000Z';
  const grantedContact = deriveLeadConsentMetadata({
    version: 'consent_mode_v2',
    contact: true,
    phone: true,
    marketing: false,
    ad_user_data: 'denied',
    captured_at: capturedAt,
    source: 'https://www.propdental.es/contacto/',
  });
  assert.equal(grantedContact.basis, 'consent', 'A direct contact grant is a valid consent basis');
  assert.equal(iso(grantedContact.capturedAt), capturedAt);
  assert.equal(grantedContact.source, 'https://www.propdental.es/contacto/');
  assert.equal(grantedContact.version, 'consent_mode_v2');

  const advertisingGrant = deriveLeadConsentMetadata({
    contact: false,
    phone: false,
    email: false,
    whatsapp: false,
    ad_user_data: 'granted',
    captured_at: capturedAt,
    source: 'https://www.propdental.es/',
    version: 'consent_mode_v2',
  });
  assert.equal(advertisingGrant.basis, 'consent', 'An explicit advertising grant is a valid consent basis');

  const denied = deriveLeadConsentMetadata({
    contact: false,
    phone: false,
    email: false,
    whatsapp: false,
    marketing: false,
    ad_user_data: 'denied',
    captured_at: capturedAt,
    source: 'https://www.propdental.es/',
    version: 'consent_mode_v2',
  });
  assert.equal(denied.basis, null, 'Denied consent must never be persisted as a consent basis');
  assert.equal(iso(denied.capturedAt), capturedAt, 'Denied choices still retain auditable metadata');
  assert.equal(denied.version, 'consent_mode_v2');

  const contradictoryAds = deriveLeadConsentMetadata({
    marketing: true,
    ad_user_data: 'denied',
    captured_at: capturedAt,
    source: 'https://www.propdental.es/',
    version: 'consent_mode_v2',
  });
  assert.equal(contradictoryAds.basis, null, 'An advertising denial must win over a simultaneous advertising grant');

  const analyticsOnly = deriveLeadConsentMetadata({
    analytics: true,
    analytics_storage: 'granted',
    captured_at: capturedAt,
    source: 'https://www.propdental.es/',
    version: 'consent_mode_v2',
  });
  assert.deepEqual(analyticsOnly, {
    basis: null,
    capturedAt: null,
    source: null,
    version: null,
  }, 'Analytics permission is not contact or advertising consent');

  assert.deepEqual(deriveLeadConsentMetadata('granted'), {
    basis: null,
    capturedAt: null,
    source: null,
    version: null,
  }, 'Legacy scalar values must not be promoted into structured consent');
  assert.deepEqual(deriveLeadConsentMetadata({ contact: 'pending', captured_at: capturedAt }), {
    basis: null,
    capturedAt: null,
    source: null,
    version: null,
  }, 'Unknown choices must not be treated as validated consent evidence');

  const controllerSource = fs.readFileSync(
    path.join(__dirname, '../../controllers/intake.controller.js'),
    'utf8',
  );
  assert.match(controllerSource, /const derivedConsentMetadata = deriveLeadConsentMetadata\(consentValue\);/);
  assert.match(controllerSource, /consent_basis:\s*consent_basis\s*\|\|\s*derivedConsentMetadata\.basis\s*\|\|\s*null/);
  assert.match(controllerSource, /consent_captured_at:\s*consent_captured_at\s*\?\s*parseDate\(consent_captured_at\)\s*:\s*derivedConsentMetadata\.capturedAt/);
  assert.match(controllerSource, /consent_source:\s*consent_source\s*\|\|\s*derivedConsentMetadata\.source\s*\|\|\s*pageUrlValue/);
  assert.match(controllerSource, /consent_version:\s*consent_version\s*\|\|\s*derivedConsentMetadata\.version\s*\|\|\s*null/);

  console.log('intake_lead_consent.test.js OK');
}

run();
