'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const eligibility = require('../../lib/whatsappAppointmentEligibility');
const source = fs.readFileSync(require.resolve('../../services/emailDelivery.service'), 'utf8');
const marker = '}, { beforeDispatch: async () => {';
const from = source.indexOf(marker) + marker.length;
const to = source.indexOf('      const dispatchState = await marketingDispatchDeliveryState(current);', from);
assert.ok(from > marker.length && to > from);

async function providerAttempt(current, { listHeld = false, commercialRefused = false, rendered = {} } = {}) {
  let attempts = 0, listChecks = 0;
  // Exercise the real final pre-provider block using a stored EmailMessage,
  // never an actual mail provider, database, application or environment.
  const run = vm.runInNewContext(`(async () => { ${source.slice(from, to)} })`, {
    message: { id: 1 }, recipient: 'qa@example.invalid', rendered, db: { EmailMessage: { findByPk: async id => { assert.equal(id, 1); return current; } } },
    require: name => {
      if (name === '../lib/automation-runtime-stop') return { assertEmailCanDispatch: async () => {} };
      if (name === '../lib/whatsappAppointmentEligibility') return eligibility;
      if (name === './marketingEmailDispatch.service') return { assertEmailReviewCanDispatch: async row => {
        assert.equal(row, current); listChecks++;
        if (listHeld) eligibility.assertClinicNonOperationalAllowed(66, { metadata: { communication_purpose: 'review_request' } });
        if (commercialRefused) throw Object.assign(Error('privacy_commercial_communications_restricted'), {
          code: 'AUTOMATION_COMMUNICATIONS_RESTRICTED', details: { reason_code: 'lopd_commercial_refused' }, retryable: false,
        });
      } };
      throw Error('unexpected_dependency');
    },
  });
  try { await run(); attempts++; return { attempts, listChecks }; }
  catch (error) { return { attempts, listChecks, code: error.code }; }
}

test('fresh stored BS email scope blocks consent and review before any provider call, including mislabelled native/manual messages', async () => {
  for (const clinica_id of [66, 72]) for (const communication of [
    { template_key: 'patient.consent_request', metadata: { clinic_id: 99 } },
    { template_key: 'marketing.campaign', metadata: { communication_purpose: 'review_request' } },
  ]) {
    const result = await providerAttempt({ status: 'sending', clinica_id, ...communication });
    assert.equal(result.attempts, 0); assert.equal(result.code, 'whatsapp_appointment_nonoperational_clinic_held');
  }
});

test('a signed LOPD commercial refusal stops an already queued marketing email at the final provider boundary', async () => {
  const result = await providerAttempt({ status: 'sending', clinica_id: 66, stream: 'marketing',
    template_key: 'marketing.campaign', metadata: {} }, { commercialRefused: true });
  assert.equal(result.attempts, 0); assert.equal(result.listChecks, 1);
  assert.equal(result.code, 'AUTOMATION_COMMUNICATIONS_RESTRICTED');
});

test('already pending review email also requires the independently stored list/recipient binding', async () => {
  const result = await providerAttempt({ status: 'sending', clinica_id: null,
    template_key: 'marketing.campaign', metadata: {} }, { listHeld: true });
  assert.equal(result.attempts, 0); assert.equal(result.listChecks, 1);
  assert.equal(result.code, 'whatsapp_appointment_nonoperational_clinic_held');
});

test('ordinary BS login, appointment and marketing emails and other clinics keep their existing delivery path', async () => {
  for (const template_key of ['auth.email_verification', 'appointment.reminder', 'marketing.campaign']) {
    const result = await providerAttempt({ status: 'sending', clinica_id: 66, template_key, metadata: {} });
    assert.equal(result.attempts, 1); assert.equal(result.listChecks, 1);
  }
  const other = await providerAttempt({ status: 'sending', clinica_id: 99, template_key: 'patient.consent_request' });
  assert.equal(other.attempts, 1);
});

test('a stale cancelled outbox is never delivered', async () => {
  const result = await providerAttempt({ status: 'cancelled', clinica_id: 66, template_key: 'appointment.reminder' });
  assert.equal(result.attempts, 0); assert.equal(result.code, 'email_outbox_no_longer_sending');
});

test('generic custom email bodies cannot hide actual consent or review links', async () => {
  for (const clinica_id of [66, 72]) for (const link of [
    'https://qa.invalid/tablet/consentimientos/FAKE_TOKEN',
    'https://qa.invalid/api/consentimientos/documents/1/pdf',
    'https://g.page/r/FAKE/review',
    'https://search.google.com/local/writereview?placeid=FAKE',
  ]) for (const rendered of [{ html: `<a href="${link}">Abrir</a>` }, { text: `Abrir: ${link}` }]) {
    const result = await providerAttempt({ status: 'sending', clinica_id, template_key: 'custom_generic', metadata: {} }, { rendered });
    assert.equal(result.attempts, 0); assert.equal(result.code, 'whatsapp_appointment_nonoperational_clinic_held');
  }
  const normal = await providerAttempt({ status: 'sending', clinica_id: 66, template_key: 'custom_generic', metadata: {} }, {
    rendered: { html: '<a href="https://qa.invalid/clinic/map">Cómo llegar</a>' },
  });
  assert.equal(normal.attempts, 1);
});

test('real outbox delivery suppresses held queued emails once and preserves accepted terminal receipts', async t => {
  const db = require('./fixtures/email_models.fixture.cjs');
  const delivery = require('../../services/emailDelivery.service');
  const provider = require('../../services/emailProvider.service');
  const { encryptEmailValue } = require('../../lib/emailSensitiveEnvelope');
  const prior = process.env.EMAIL_DATA_ENCRYPTION_KEY;
  process.env.EMAIL_DATA_ENCRYPTION_KEY = 'FICTITIOUS_NONOPERATIONAL_GUARD_TEST_KEY';
  t.after(() => { if (prior === undefined) delete process.env.EMAIL_DATA_ENCRYPTION_KEY; else process.env.EMAIL_DATA_ENCRYPTION_KEY = prior; });
  let current, attempts = 0;
  t.mock.method(db.EmailMessage, 'findByPk', async () => current);
  t.mock.method(db.EmailMessage, 'update', async patch => {
    if (!['queued', 'sending'].includes(current.status)) return [0];
    Object.assign(current, patch); return [1];
  });
  t.mock.method(db.EmailSuppression, 'findOne', async () => null);
  t.mock.method(provider, 'sendEmail', async (_payload, options) => {
    await options.beforeDispatch(); attempts++;
    throw Error('A held email must not reach a provider');
  });
  for (const clinica_id of [66, 72]) for (const communication_purpose of ['consent', 'review_request']) {
    const hash = delivery.hashEmail('qa@example.test'), publicId = 'em_fictitious_guard';
    current = { id: 1, public_id: publicId, clinica_id, status: 'queued', stream: 'transactional',
      template_key: 'ops.email_test', template_context: {}, metadata: { communication_purpose },
      recipient_hash: hash, recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('qa@example.test', `message:${publicId}:${hash}`),
      async update(patch) { Object.assign(this, patch); return this; } };
    const result = await delivery.runEmailSendJob({ email_message_id: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.result.reason, 'whatsapp_appointment_nonoperational_clinic_held');
    assert.equal(current.status, 'suppressed'); assert.equal(attempts, 0);
    const again = await delivery.runEmailSendJob({ email_message_id: 1 });
    assert.equal(again.result.already_terminal, true); assert.equal(attempts, 0);
    current.status = 'delivered'; current.provider_message_id = 'FICTITIOUS_ACCEPTED_RECEIPT';
    const accepted = await delivery.runEmailSendJob({ email_message_id: 1 });
    assert.equal(accepted.result.already_terminal, true);
    assert.equal(accepted.result.provider_message_id, 'FICTITIOUS_ACCEPTED_RECEIPT');
    assert.equal(current.status, 'delivered'); assert.equal(attempts, 0);
  }
});
