'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preparationRevision, validatePreparation, applyCampaignPreparation, mergeVerifiedDomains } = require('../../lib/intake-campaign-preparation');

const body = { mutation_kind: 'campaign_preparation', expected_revision: null, domain: 'https://clinic.example/landing',
  form_intercept_enabled: true, consent_provider: 'clinicaclick', legal_urls: {
    legal: 'https://clinic.example/legal', privacy: 'https://clinic.example/privacy', cookies: 'https://clinic.example/cookies',
  } };
const record = { assignment_scope: 'clinic', clinic_id: 1, hmac_key: 'secret-not-exported', domains: ['other.example'],
  config: { features: { chat_enabled: true, tel_modal_enabled: true, form_intercept_enabled: false, google_ads_user_data_runtime_enabled: true },
    texts: { greeting: 'Hola' }, google_ads: { enabled: true, gate: 'current' }, meta_ads: { enabled: true },
    locations: [{ id: 1 }], flows: [{ id: 'existing' }], appearance: { theme: 'existing' },
  } };

test('first preparation enables only requested web measurement, not ads signals or widgets', () => {
  const next = applyCampaignPreparation(null, body);
  assert.deepEqual(next.domains, ['clinic.example']);
  assert.equal(next.config.features.form_intercept_enabled, true);
  assert.equal(next.config.features.chat_enabled, false); assert.equal(next.config.features.tel_modal_enabled, false);
  assert.equal(next.config.features.google_ads_user_data_enabled, false);
  assert.equal(next.config.google_ads, undefined); assert.equal(next.config.meta_ads, undefined);
});
test('existing ads policy, widgets, texts, locations and flows survive preparation', () => {
  const snapshot = JSON.stringify(record);
  const next = applyCampaignPreparation(record, { ...body, expected_revision: preparationRevision(record) });
  assert.equal(next.config.features.chat_enabled, true); assert.equal(next.config.features.tel_modal_enabled, true);
  assert.equal(next.config.features.google_ads_user_data_runtime_enabled, true);
  for (const key of ['google_ads', 'meta_ads', 'locations', 'flows', 'appearance']) assert.deepEqual(next.config[key], record.config[key]);
  assert.equal(next.config.texts.greeting, 'Hola'); assert.deepEqual(next.domains, ['clinic.example', 'other.example']);
  assert.equal(JSON.stringify(record), snapshot);
});
test('an ads-only record does not opt into widgets when its first web is prepared', () => {
  const current = { ...record, config: { google_ads: { enabled: true } } };
  const next = applyCampaignPreparation(current, { ...body, expected_revision: preparationRevision(current) });
  assert.equal(next.config.features.chat_enabled, false); assert.equal(next.config.features.tel_modal_enabled, false);
  assert.equal(next.config.google_ads.enabled, true);
});
test('a stale preparation cannot overwrite edited privacy, domain, form or secret configuration', () => {
  const expected_revision = preparationRevision(record);
  for (const changed of [
    { ...record, hmac_key: 'rotated' }, { ...record, domains: [] },
    { ...record, config: { ...record.config, texts: { privacy_url: 'https://clinic.example/new' } } },
    { ...record, config: { ...record.config, features: { ...record.config.features, form_intercept_enabled: true } } },
  ]) awaitConflict(changed, { ...body, expected_revision });
});
function awaitConflict(current, request) {
  assert.throws(() => applyCampaignPreparation(current, request), error => error.status === 409 && error.code === 'intake_preparation_conflict');
}
test('reconciliation updates do not cause false conflicts or get overwritten', () => {
  const expected_revision = preparationRevision(record);
  const changed = { ...record, config: { ...record.config, google_ads: { enabled: true, gate: 'renewed' } } };
  assert.equal(applyCampaignPreparation(changed, { ...body, expected_revision }).config.google_ads.gate, 'renewed');
});
test('preparation rejects provider mutations and forged verification fields', () => {
  for (const patch of [{ google_ads: { enabled: true } }, { hmac_key: 'replacement' }, { snippet_verification: { verified: true } }, { features: { chat_enabled: true } }]) {
    assert.throws(() => validatePreparation({ ...body, ...patch }), /intake_preparation_invalid/);
  }
});
test('external consent requires the named CMP and never grants visitor consent', () => {
  assert.throws(() => validatePreparation({ ...body, consent_provider: 'external_cmp' }), /intake_external_cmp_required/);
  const next = applyCampaignPreparation(null, { ...body, consent_provider: 'external_cmp', external_cmp_provider: 'complianz' });
  assert.equal(next.config.features.consent_provider, 'external_cmp');
  assert.equal(JSON.stringify(next).includes('granted'), false);
});
test('legal links must be HTTP(S) URLs without credentials', () => {
  for (const privacy of ['javascript:alert(1)', '/privacy', 'https://user:secret@clinic.example/privacy']) {
    assert.throws(() => validatePreparation({ ...body, legal_urls: { ...body.legal_urls, privacy } }), /intake_legal_url_invalid/);
  }
});
test('preparation revision does not expose HMAC secrets and is scope-bound', () => {
  assert.match(preparationRevision(record), /^[a-f0-9]{64}$/);
  assert.notEqual(preparationRevision(record), preparationRevision({ ...record, clinic_id: 2 }));
  assert.equal(preparationRevision(null), null);
});
test('renewing one domain keeps only server-revalidated proofs of the other domains', () => {
  const calls = [];
  const result = mergeVerifiedDomains({ attestations_by_domain: { old: 'valid-persisted', expired: 'expired' } },
    { attestations_by_domain: { current: 'fresh' }, verified: true }, (input, strict) => {
      calls.push(strict);
      return { attestations_by_domain: Object.fromEntries(Object.entries(input.attestations_by_domain).filter(([, token]) => token !== 'expired')) };
    });
  assert.deepEqual(calls, [true, false, false]);
  assert.deepEqual(result.attestations_by_domain, { old: 'valid-persisted', current: 'fresh' });
  assert.equal(result.verified, undefined);
});
test('incoming proof is checked strictly before accepting or merging any existing state', () => {
  let count = 0;
  assert.throws(() => mergeVerifiedDomains({}, { verified: true }, (_value, strict) => {
    count++; assert.equal(strict, true); throw new Error('attestation_missing');
  }), /attestation_missing/);
  assert.equal(count, 1);
});
