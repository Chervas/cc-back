'use strict';

// Exercise the actual service bodies with isolated in-memory models only.
// No app model index, workers, outbox writes or provider is imported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const eligibility = require('../../lib/whatsappAppointmentEligibility');

function harness() {
  const lists = new Map(), items = new Map(), messages = new Map(), chatMessages = new Map(), appointments = new Map(), conversations = new Map();
  const calls = { provider: 0, write: 0 };
  const forbidden = () => { calls.provider++; throw Error('FORBIDDEN_PROVIDER_OR_SERVICE'); };
  const model = rows => ({
    findByPk: async id => rows.get(Number(id)) || null,
    findOne: async ({ where }) => [...rows.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
    create: async () => { calls.write++; throw Error('FORBIDDEN_MODEL_WRITE'); },
    findAll: async () => [],
  });
  const db = { MarketingPatientList: model(lists), MarketingPatientListItem: model(items), EmailMessage: model(messages),
    CitaPaciente: model(appointments), Conversation: model(conversations), Message: model(chatMessages),
    MarketingPatientContactEvent: model(new Map()) };
  const serviceStub = new Proxy({}, { get: (_, key) => key === 'normalizePhoneNumber' ? value => value : forbidden });
  let bulk, email;
  function load(filename) {
    const full = path.resolve(__dirname, '../../services', filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(full, 'utf8'), { module, exports: module.exports, Buffer, Date, Map, Set, Promise,
      process: { env: {} }, console: { log() {}, warn() {}, error() {} }, setTimeout: forbidden,
      require: name => {
        if (name === '../../models') return db;
        if (name === 'crypto' || name === 'sequelize') return require(name);
        if (name === '../lib/whatsappAppointmentEligibility') return eligibility;
        if (name === '../lib/phone') return require('../../lib/phone');
        if (name === '../lib/review-care-snapshot') return require('../../lib/review-care-snapshot');
        if (name === '../lib/review-attribution-hold') return require('../../lib/review-attribution-hold');
        if (name === '../lib/marketing-import-care-date') return require('../../lib/marketing-import-care-date');
        if (name === '../lib/bs-privacy-commercial-preferences') return { assertCommercialAllowed: async () => true };
        if (name === './patientIncidents.service') return { assertCommercialAllowed: async () => {} };
        if (name === './marketingBulkSends.service') return bulk;
        if (name === './marketingEmailDispatch.service') return email || serviceStub;
        if (name.startsWith('../lib/')) return {};
        if (name.startsWith('./')) return serviceStub;
        throw Error('UNEXPECTED_IMPORT:' + name);
      },
    }, { filename: full });
    return module.exports;
  }
  bulk = load('marketingBulkSends.service.js'); email = load('marketingEmailDispatch.service.js');
  const seed = (clinicId, criteria = { review_request: true }, patch = {}) => {
    const list = { id: lists.size + 1, clinica_id: clinicId, scope_type: 'clinic', criteria, ...patch };
    const item = { id: items.size + 1, list_id: list.id, clinica_id: clinicId, phone: 'SYNTHETIC', ...patch.item };
    delete list.item; lists.set(list.id, list); items.set(item.id, item); return { list, item };
  };
  return { bulk, email, seed, lists, items, messages, chatMessages, appointments, conversations, calls };
}
const held = error => error.code === 'whatsapp_appointment_nonoperational_clinic_held' && error.retryable === false;
const unknown = error => error.code === 'review_communication_scope_unverified';
const attributionHeld = error => error.code === 'review_attribution_held' && error.retryable === false && error.status === 409;

test('a stored request-cycle attribution hold defeats stale caller data without changing its historical clinic or snapshot', async () => {
  const h = harness(), scope = h.seed(70, { review_request: true }, {
    item: { paciente_id: 59235, custom_fields: { review_attribution_hold: { reason: 'clinic_attribution_corrected', correctionRef: 'owned-case' } } },
  });
  const before = JSON.stringify(scope.item);
  await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed({ ...scope, item: { ...scope.item, custom_fields: {} } }), attributionHeld);
  assert.equal(JSON.stringify(scope.item), before);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('attribution holds stop reminder, Google rating follow-up, feedback acknowledgement and dispatch before materialization', async () => {
  const h = harness(), scope = h.seed(70, { review_request: true }, {
    item: { custom_fields: { review_attribution_hold: { reason: 'source_venue_unverified', correctionRef: 'owned-case' } } },
  });
  await assert.rejects(h.bulk.sendReviewRequestReminder({ listId: scope.list.id, itemId: scope.item.id }), attributionHeld);
  await assert.rejects(h.bulk.__testing.sendReviewRatingFollowUp({ ...scope, rating: 5, clinicId: 70 }), attributionHeld);
  await assert.rejects(h.bulk.__testing.sendReviewPrivateFeedbackAcknowledgement({ ...scope,
    triggerMessage: { metadata: { kind: 'review_private_feedback_request' } } }), attributionHeld);
  await assert.rejects(h.bulk.__testing.sendDispatchItem({ ...scope, template: { name: 'custom_generic' }, clinicConfig: { clinicId: 70 } }), attributionHeld);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('an attribution hold is fail-closed but does not apply to another recipient or ordinary non-review marketing', async () => {
  const { assertReviewAttributionClear } = require('../../lib/review-attribution-hold');
  for (const value of [false, '', [], { active: false }]) assert.throws(() => assertReviewAttributionClear({ custom_fields: { review_attribution_hold: value } }), attributionHeld);
  assert.doesNotThrow(() => assertReviewAttributionClear({ custom_fields: {} }));
  const h = harness(), ordinary = h.seed(70, { template_usage: 'marketing' }, { item: { custom_fields: { review_attribution_hold: { reason: 'owned' } } } });
  assert.equal((await h.bulk.assertReviewRequestCommunicationAllowed(ordinary)).review, false);
  assert.equal((await h.bulk.assertReviewRequestCommunicationAllowed(h.seed(1))).clinicId, 1);
});

test('a selected-recipient sample cannot bypass a correction hold on its stored original recipient', async () => {
  const h = harness(), fingerprint = 'a'.repeat(64);
  const scope = h.seed(70, { review_request: true, review_care_version: 1 }, {
    item: { status: 'test_sample', paciente_id: null, selected: 0, dispatch_status: 'test_only', custom_fields: {
      test_sample: true, review_test_data_mode: 'selected_recipient', review_test_source_item_id: 2,
      review_test_render_fingerprint: fingerprint,
    } },
  });
  h.items.set(2, { id: 2, list_id: scope.list.id, clinica_id: 70, paciente_id: 59235,
    custom_fields: { review_attribution_hold: { reason: 'clinic_attribution_corrected', correctionRef: 'owned-case' } } });
  h.chatMessages.set(100, { id: 100, conversation_id: 9, direction: 'outbound', metadata: {
    source: 'marketing_bulk_sends', kind: 'mass_campaign_test', list_id: scope.list.id, item_id: scope.item.id,
    recipient: 'SYNTHETIC', review_test_source_item_id: 2, review_test_render_fingerprint: fingerprint,
  } });
  await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed({ ...scope,
    conversation: { id: 9 }, triggerMessage: { id: 100 } }), attributionHeld);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('review purpose recognizes stored boolean/string/usage/dispatch variants without changing ordinary marketing', async () => {
  const h = harness();
  for (const criteria of [{ review_request: true }, { review_request: 'true' }, { review_request: 1 }, { review_request: '1' },
    { template_usage: 'solicitud_resena' }, { template_usage: 'reviews' }, { dispatch: { context: 'review_request' } }]) {
    assert.equal(h.bulk.__testing.isReviewRequestList({ criteria }), true);
    const scope = h.seed(66, criteria);
    await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed(scope), held);
  }
  const normal = h.seed(66, { template_usage: 'marketing', review_request: false });
  const result = await h.bulk.assertReviewRequestCommunicationAllowed(normal);
  assert.equal(result.review, false);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('the advertising-only distinction uses the approved template and the stored review recipient', async () => {
  const h = harness();
  const scope = h.seed(44, { review_request: true, whatsapp_template_id: 30 }, {
    item: { paciente_id: 8, selected: true, status: 'ready', phone: '+34600000001' },
  });
  const dispatch = overrides => h.bulk.assertReviewRequestCommunicationAllowed({
    ...scope, channel: 'whatsapp', whatsappTemplateId: 30, whatsappRecipient: '34600000001', ...overrides,
  });
  assert.equal((await dispatch()).verifiedWhatsappReview, true);
  assert.equal((await dispatch({ whatsappRecipient: '34600000002' })).verifiedWhatsappReview, false);
  assert.equal((await dispatch({ whatsappTemplateId: 31 })).verifiedWhatsappReview, false);
  scope.item.exclusion_reason = 'review_refusal';
  assert.equal((await dispatch()).verifiedWhatsappReview, false);
  scope.item.exclusion_reason = null;
  scope.list.criteria.review_gift_enabled = true;
  assert.equal((await dispatch()).verifiedWhatsappReview, false);
  assert.equal(h.calls.provider, 0);
  assert.equal(h.calls.write, 0);
});

test('WhatsApp uses the review preference only for a bound approved review template', async () => {
  const h = harness();
  const scope = h.seed(44, { review_request: true, whatsapp_template_id: 30 }, {
    item: { paciente_id: 8, selected: true, status: 'ready', phone: '+34600000001' },
  });
  const conversation = { id: 3, clinic_id: 44, patient_id: 8 };
  h.conversations.set(3, conversation);
  const template = { id: 30, status: 'APPROVED', category: 'MARKETING', catalog_template_id: 32 };
  const checks = [];
  const dependencies = {
    './marketingOptOut.service': {
      isMarketingOutboundMessage: () => true,
      assertStoredCommunicationAllowed: async input => checks.push(input),
    },
    './whatsappContactIdentity.service': { assertPhoneEndpointCurrent: async () => {} },
    '../lib/bs-privacy-commercial-preferences': { assertCommercialAllowed: async () => {} },
    '../lib/whatsapp-template-workflow': require('../../lib/whatsapp-template-workflow'),
    './marketingBulkSends.service': h.bulk,
  };
  const source = fs.readFileSync(require.resolve('../../services/whatsapp.service'), 'utf8');
  const start = source.indexOf('    async assertPrivacyCommercialAllowed(');
  const end = source.indexOf('    async dispatchMessage(', start);
  const sender = vm.runInNewContext('({' + source.slice(start, end) + '})', {
    db: { WhatsappTemplate: { findOne: async () => template }, Conversation: { findByPk: async () => conversation } },
    require: name => {
      assert(Object.hasOwn(dependencies, name));
      return dependencies[name];
    },
  });
  const payload = { type: 'template', to: '34600000001', template: { name: 'fictitious', language: { code: 'es' } } };
  const message = { conversation_id: 3, metadata: {
    source: 'marketing_bulk_sends', kind: 'mass_campaign_send', dispatch_context: 'review_request',
    list_id: scope.list.id, item_id: scope.item.id,
  } };
  const config = { clinicId: 44, wabaId: '123' };
  await sender.assertPrivacyCommercialAllowed(payload, config, message);
  await sender.assertPrivacyCommercialAllowed({ ...payload, to: '34600000002' }, config, message);
  template.catalog_template_id = null;
  await sender.assertPrivacyCommercialAllowed(payload, config, message);
  h.chatMessages.set(90, { conversation_id: 3, direction: 'outbound', status: 'sent', metadata: {
    ...message.metadata, recipient: payload.to, template_usage: 'solicitud_resena', wamid: 'wamid.fictitious',
  } });
  const reply = { ...message, metadata: { ...message.metadata, kind: 'review_google_link_followup', trigger_message_id: 90 } };
  await sender.assertPrivacyCommercialAllowed({ type: 'text', to: payload.to }, config, reply);
  h.chatMessages.get(90).metadata.item_id += 1;
  await sender.assertPrivacyCommercialAllowed({ type: 'text', to: payload.to }, config, reply);
  assert.equal(checks[0].reviewRequest, true);
  assert.equal(checks[0].includeChannel, true);
  assert.equal(checks[1].reviewRequest, undefined);
  assert.equal(checks[2].reviewRequest, undefined);
  assert.equal(checks[3].reviewRequest, true);
  assert.equal(checks[4].reviewRequest, undefined);
});

test('real stored clinic/recipient defeat caller clinic spoofing and group first-clinic fallback', async () => {
  const h = harness();
  for (const clinicId of [66, 72]) {
    const scope = h.seed(clinicId);
    await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed({
      list: { ...scope.list, clinica_id: 44, criteria: {} }, item: { ...scope.item, clinica_id: 44 },
    }), held);
  }
  const group = h.seed(66, { review_request: true }, { scope_type: 'group', clinica_id: null, clinic_ids: [44, 66, 72],
    item: { clinica_id: 72 } });
  await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed(group), held);
  group.item.clinica_id = null;
  await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed(group), unknown);
  group.item.clinica_id = 44;
  assert.equal((await h.bulk.assertReviewRequestCommunicationAllowed(group)).clinicId, 44, 'other-clinic recipient is not blocked just because BS is in group');
  h.conversations.set(9, { id: 9, clinic_id: 66 });
  await assert.rejects(h.bulk.assertReviewRequestCommunicationAllowed({ ...group, conversation: { id: 9, clinic_id: 44 } }), held);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('actual review template is held even when stored list criteria are mislabeled as marketing', async () => {
  const h = harness(), scope = h.seed(66, { template_usage: 'marketing' });
  await assert.rejects(h.bulk.__testing.sendDispatchItem({ ...scope,
    template: { name: 'clinicaclick_solicitar_resena' }, clinicConfig: { clinicId: 44 } }), held);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('automatic review start consults real appointment clinic before template/list/patient materialization', async () => {
  const h = harness();
  h.appointments.set(10, { id_cita: 10, clinica_id: 66 });
  await assert.rejects(h.bulk.createAndStartReviewRequestForAppointment({ appointmentId: 10, clinicId: 44 }), held);
  h.appointments.set(10, { id_cita: 10, clinica_id: 72 });
  await assert.rejects(h.bulk.createAndStartReviewRequestForAppointment({ appointmentId: 10, clinicId: 72 }), held);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('reminder, rating, private feedback ACK and direct dispatch cannot send BS review communication', async () => {
  const h = harness();
  for (const clinicId of [66, 72]) {
    const scope = h.seed(clinicId);
    await assert.rejects(h.bulk.sendReviewRequestReminder({ listId: scope.list.id, itemId: scope.item.id }), held);
    await assert.rejects(h.bulk.__testing.sendReviewRatingFollowUp({ ...scope, rating: 5, clinicId: 44 }), held);
    await assert.rejects(h.bulk.__testing.sendReviewPrivateFeedbackAcknowledgement({ ...scope,
      triggerMessage: { metadata: { kind: 'review_private_feedback_request' } } }), held);
    await assert.rejects(h.bulk.__testing.sendDispatchItem({ ...scope, template: { name: 'custom_generic' },
      clinicConfig: { clinicId: 44 } }), held);
  }
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('already queued review email re-reads stored list and recipient before actual transport', async () => {
  const h = harness();
  for (const clinicId of [66, 72]) {
    const scope = h.seed(clinicId, { template_usage: 'solicitud_resena' });
    const id = h.messages.size + 1;
    h.messages.set(id, { id, clinica_id: clinicId, related_type: 'marketing_bulk_send',
      related_id: `${scope.list.id}:${scope.item.id}`, metadata: { list_id: scope.list.id, item_id: scope.item.id } });
    await assert.rejects(h.email.assertEmailReviewCanDispatch({ id, clinica_id: 44, metadata: {} }), held);
    h.messages.get(id).metadata = {}; // Old queued record need not carry purpose or IDs.
    await assert.rejects(h.email.assertEmailReviewCanDispatch({ id }), held);
  }
  const group = h.seed(72, { review_request: true }, { scope_type: 'group', clinica_id: null, clinic_ids: [44, 66, 72] });
  const id = h.messages.size + 1;
  h.messages.set(id, { id, clinica_id: 44, related_type: 'marketing_bulk_send', related_id: `${group.list.id}:${group.item.id}`,
    metadata: { list_id: group.list.id, item_id: group.item.id } });
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id }), held);
  const ordinary = h.seed(44, { template_usage: 'marketing' });
  h.messages.get(id).metadata = { list_id: ordinary.list.id, item_id: ordinary.item.id }; // Cannot replace canonical relation.
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id }), held);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('ordinary marketing and transactional email remain outside the BS review hold', async () => {
  const h = harness();
  const scope = h.seed(66, { template_usage: 'marketing', review_request: false });
  h.messages.set(1, { id: 1, clinica_id: 66, related_type: 'marketing_bulk_send', related_id: `${scope.list.id}:${scope.item.id}`,
    metadata: { list_id: scope.list.id, item_id: scope.item.id } });
  assert.equal(await h.email.assertEmailReviewCanDispatch({ id: 1 }), true);
  h.messages.set(2, { id: 2, clinica_id: 66, related_type: 'password_reset', related_id: '123', metadata: {} });
  assert.equal(await h.email.assertEmailReviewCanDispatch({ id: 2 }), true);
  const review = h.seed(66);
  h.messages.get(2).metadata = { list_id: review.list.id };
  assert.equal(await h.email.assertEmailReviewCanDispatch({ id: 2 }), true, 'an unrelated transactional list_id is not a review campaign');
  h.messages.get(2).template_key = 'clinical.review_request';
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id: 2 }), held, 'actual review key is gated on every email stream');
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});

test('old campaign tests and metadata-only marketing never gain permission from deleted lists or recipients', async () => {
  const h = harness();
  const nonretryableScope = error => unknown(error) && error.retryable === false;
  h.messages.set(1, { id: 1, clinica_id: 66, template_key: 'marketing.campaign', stream: 'marketing',
    related_type: 'marketing_bulk_send_test', related_id: '999:1700000000000', metadata: {} });
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id: 1 }), nonretryableScope);
  h.messages.set(2, { id: 2, clinica_id: 72, template_key: 'marketing.campaign', stream: 'marketing',
    related_type: null, related_id: null, metadata: { list_id: 999, item_id: 888 } });
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id: 2 }), nonretryableScope);
  const ordinary = h.seed(44, { template_usage: 'marketing' });
  h.messages.set(3, { id: 3, clinica_id: 44, template_key: 'marketing.campaign', stream: 'marketing',
    related_type: 'marketing_bulk_send_test', related_id: `${ordinary.list.id}:1700000000000`,
    metadata: { list_id: ordinary.list.id, item_id: ordinary.item.id } });
  assert.equal(await h.email.assertEmailReviewCanDispatch({ id: 3 }), true, 'valid ordinary campaign test remains valid');
  h.items.delete(ordinary.item.id);
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id: 3 }), nonretryableScope);
  h.messages.get(3).related_type = 'marketing_bulk_send';
  h.messages.get(3).related_id = `${ordinary.list.id}:${ordinary.item.id}`;
  h.messages.get(3).metadata = {};
  await assert.rejects(h.email.assertEmailReviewCanDispatch({ id: 3 }), nonretryableScope);
  assert.equal(h.calls.provider, 0); assert.equal(h.calls.write, 0);
});
