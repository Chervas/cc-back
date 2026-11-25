'use strict';

require('./fixtures/scheduled_jobs.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const db = require('../../../models');
const buttons = require('../../lib/whatsapp-bulk-opt-out');

let identityRestriction;
const identityModule = require.resolve('../../services/whatsappContactIdentity.service');
require.cache[identityModule] = { id: identityModule, filename: identityModule, loaded: true, exports: {
  windowMemberIds: async conversation => [conversation.id],
  restrict: async value => { identityRestriction = value; return { applied: true }; },
} };
const optOut = require('../../services/marketingOptOut.service');

test('verified review selection and transport ignore only an advertising import without a later withdrawal', async t => {
  const queries = [];
  const capture = async ({ where }) => {
    queries.push(db.sequelize.getQueryInterface().queryGenerator.selectQuery('MarketingContactOptOuts', { where })
      .replaceAll('`MarketingContactOptOuts`.', ''));
    return null;
  };
  t.mock.method(db.MarketingContactOptOut, 'findAll', async options => { await capture(options); return []; });
  t.mock.method(db.MarketingContactOptOut, 'findOne', capture);
  t.mock.method(require('../../services/patientIncidents.service'), 'assertCommercialAllowed', async () => {});
  t.mock.method(require('../../lib/bs-privacy-commercial-preferences'), 'commercialRefusals',
    async () => ({ patientIds: new Set(), phoneDigits: new Set() }));
  await optOut.getActiveOptOutSetsForScope({ clinicIds: [44] }, null, { reviewRequest: true });
  const contact = { clinicId: 44, patientId: 6, phone: '+34600000001', scope: 'marketing' };
  await optOut.assertStoredCommunicationAllowed({ ...contact, reviewRequest: true, includeChannel: true });
  await optOut.assertStoredCommunicationAllowed(contact);
  for (const query of queries.slice(0, 2)) {
    assert.match(query, /`scope` = 'care'/);
    assert.match(query, /NOT \(`source` = 'cliniccloud_publicidad_legacy' AND `inbound_message_id` IS NULL AND `trigger_message_id` IS NULL\)/);
  }
  assert.match(queries[1], /`scope` = 'whatsapp_channel'/);
  assert.match(queries[2], /`scope` = 'marketing'/);
  assert.doesNotMatch(queries[2], /cliniccloud_publicidad_legacy/);
});

test('a new template gets the mandatory language-specific button without replacing approved links', () => {
  const body = { type: 'BODY', text: 'Hola' };
  const original = [body, { type: 'BUTTONS', buttons: [
    { type: 'QUICK_REPLY', text: 'Sí' }, { type: 'URL', text: 'Web', url: 'https://example.test' },
  ] }];
  const required = buttons.requireOptOutButton(original, 'ca');
  assert.deepEqual(required[1].buttons.map(button => button.text), ['Sí', 'Donar-me de baixa', 'Web']);
  assert.equal(original[1].buttons.length, 2);
  assert.equal(buttons.requireOptOutButton(required, 'ca'), required);
  assert.throws(() => buttons.requireOptOutButton([{ type: 'BUTTONS', buttons: Array(10).fill({ type: 'QUICK_REPLY', text: 'Hola' }) }], 'es'), {
    code: 'template_bulk_opt_out_button_required',
  });
  const template = { language: 'ca', components: required };
  assert.deepEqual(buttons.sendComponent(template), { type: 'button', sub_type: 'quick_reply', index: '1',
    parameters: [{ type: 'payload', payload: buttons.OPT_OUT_PAYLOAD }] });
  assert.equal(buttons.sendComponent(template, { test: true }).parameters[0].payload, buttons.TEST_PAYLOAD);
  assert.equal(buttons.sendComponent({ language: 'ca', components: original }), null);
});

function fixture(category = 'UTILITY') {
  const input = { id: 101, direction: 'inbound', content: 'Pedir baja', sent_at: new Date('2026-11-20T10:00:00Z'),
    metadata: { context: { id: 'wamid.provider-outbound' }, provider_type: 'button', phone_number_id: '333', waba_id: '444',
      button: { payload: buttons.OPT_OUT_PAYLOAD } } };
  const conversation = { id: 51, clinic_id: 61, contact_id: '34600000001', channel: 'whatsapp', patient_id: 71 };
  const origin = { id: 81, metadata: { wamid: 'wamid.provider-outbound',
    source: 'marketing_bulk_sends', kind: 'mass_campaign_send', dispatch_context: 'campaign',
    // A stale commercial flag must not override the provider category.
    template_category: category, template_commercial: category !== 'MARKETING',
    phoneNumberId: '333', wabaId: '444', recipient: conversation.contact_id, list_id: 91, item_id: 92,
    template_components: [buttons.sendComponent({ language: 'es', components: buttons.requireOptOutButton([], 'es') })] } };
  const records = new Map();
  const contactEvents = [];
  const notices = [];
  const itemChanges = [];
  const item = { id: 92, paciente_id: 71, status: 'ready', selected: true, opt_out_at: null,
    update: async patch => { itemChanges.push(patch); Object.assign(item, patch); },
    get() { return item; } };
  const transaction = { LOCK: { UPDATE: 'update' } };
  db.sequelize.transaction = async callback => callback(transaction);
  db.Message.findAll = async ({ where }) => {
    assert.deepEqual(where.conversation_id[Op.in], [51]);
    assert.equal(where.direction, 'outbound');
    return where[Op.and][0].logic === origin.metadata.wamid ? [origin] : [];
  };
  db.Message.findOne = async () => notices[0] || null;
  db.Message.create = async notice => {
    notices.push(notice);
    return { ...notice, update: async patch => Object.assign(notice, patch) };
  };
  db.MarketingContactOptOut.findOrCreate = async ({ where, defaults }) => {
    assert.equal(where.channel, 'whatsapp');
    assert.equal(where.clinica_id, 61);
    assert.equal(where.phone_digits, conversation.contact_id);
    if (!records.has(where.scope)) {
      const row = { id: 1, ...where, ...defaults, update: async patch => Object.assign(row, patch) };
      records.set(where.scope, row);
    }
    return [records.get(where.scope)];
  };
  db.Clinica.findByPk = async () => ({ grupoClinicaId: null });
  db.MarketingPatientListItem.findOne = async ({ where }) => {
    assert.deepEqual(where, { id: 92, list_id: 91, app_message_id: 81 });
    return item;
  };
  db.MarketingPatientListItem.findAll = async () => [item];
  db.MarketingPatientList.update = async () => {};
  db.MarketingPatientContactEvent.create = async event => contactEvents.push(event);
  const apply = overrides => optOut.applyBulkWhatsappOptOut({ clinicId: 61, conversation, inboundMessage: input, ...overrides });
  return { apply, input, conversation, origin, records, contactEvents, notices, itemChanges };
}

test('Utility stops WhatsApp at its own clinic and marks only the origin item', async () => {
  const f = fixture('UTILITY');
  const first = await f.apply();
  assert.equal(first.scope, 'whatsapp_channel');
  assert.equal(first.applied, true);
  assert.deepEqual(first.clinic_ids, [61]);
  assert.equal(f.records.size, 1);
  assert.equal(f.contactEvents.length, 1);
  assert.equal(f.notices[0].metadata.scope, 'whatsapp_channel');
  assert.deepEqual(Object.keys(f.itemChanges[0]), ['opt_out_at']);
  await f.apply();
  assert.equal(f.records.size, 1);
  assert.equal(f.contactEvents.length, 1);
  assert.equal(f.notices.length, 1);
});

test('Marketing stops WhatsApp promotions and does not write legacy generic consent', async () => {
  const f = fixture('MARKETING');
  const actual = await f.apply();
  assert.equal(actual.scope, 'marketing');
  assert.deepEqual([...f.records.keys()], ['marketing']);
  assert.deepEqual(Object.keys(f.itemChanges[0]), ['opt_out_at']);
});

test('a rejection requires exact provider context and sender, and tests never change consent', async () => {
  const f = fixture();
  assert.equal((await f.apply({ clinicId: 62 })).applied, false);
  for (const change of [{ waba_id: '555' }, { phone_number_id: '666' }, { context: { id: 'wrong' } }]) {
    const incoming = { ...f.input, metadata: { ...f.input.metadata, ...change } };
    assert.equal((await f.apply({ inboundMessage: incoming })).reason, 'bulk_opt_out_context_unverified');
  }
  const testInput = { ...f.input, metadata: { ...f.input.metadata, button: { payload: buttons.TEST_PAYLOAD } } };
  assert.equal((await f.apply({ inboundMessage: testInput })).reason, 'bulk_opt_out_test');
  f.origin.metadata.template_components = [];
  assert.equal((await f.apply()).reason, 'bulk_opt_out_context_unverified');
  assert.equal(f.records.size, 0);
  assert.equal(f.itemChanges.length, 0);
});

test('a clear written refusal to the exact message works and unrelated declines do not block the channel', async () => {
  const f = fixture();
  f.input.metadata.provider_type = 'text';
  delete f.input.metadata.button;
  f.input.content = 'No me interesa';
  assert.equal(await f.apply(), null);
  f.input.content = 'No quiero recibir más comunicaciones';
  assert.equal((await f.apply()).scope, 'whatsapp_channel');
  f.input.metadata.context.id = 'wamid.unmatched';
  assert.equal((await f.apply()).reason, 'bulk_opt_out_context_unverified');
});

test('opaque identities use the existing channel or marketing scope without borrowing a phone', async () => {
  const f = fixture();
  f.conversation.contact_id = 'bsuid:444:ES.example';
  assert.equal((await f.apply()).scope, 'whatsapp_channel');
  assert.equal(identityRestriction.scope, 'all');
  assert.equal(f.records.size, 0);
});

function legacyButton(f) {
  f.input.content = 'No recibir avisos';
  f.input.metadata.button = { payload: 'No recibir avisos', text: 'No recibir avisos' };
  f.origin.metadata.template_components = [];
  f.origin.metadata.template_id = 933;
  f.origin.metadata.template_name = 'test_approved_utility';
  return { components: [{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'No recibir avisos' }] }] };
}

test('a legacy "No recibir avisos" click only opts out when the exact Utility template has that approved quick reply', async () => {
  const f = fixture('UTILITY');
  const approved = legacyButton(f);
  db.WhatsappTemplate.findOne = async ({ where }) => {
    assert.deepEqual(where, { id: 933, name: 'test_approved_utility', waba_id: '444', status: 'APPROVED' });
    return approved;
  };
  assert.equal((await f.apply()).scope, 'whatsapp_channel');
  f.input.metadata.button = { payload: 'No me interesa', text: 'No me interesa' };
  assert.equal(await f.apply(), null);
  f.input.metadata.button = { payload: 'No recibir mensajes', text: 'No recibir mensajes' };
  assert.equal((await f.apply()).reason, 'bulk_opt_out_context_unverified');
  assert.equal(f.records.size, 1);
  assert.equal(f.contactEvents.length, 1);
});

test('an operator can only apply a stored provider-certified refusal, once, to the exact unlinked conversation', async () => {
  const f = fixture('UTILITY');
  const approved = legacyButton(f);
  f.conversation.patient_id = null;
  let certified = false;
  db.sequelize.query = async (sql, { replacements }) => {
    assert.match(sql, /JOIN WhatsappInboxMessageKeys k ON k.message_id = m.id/);
    assert.match(sql, /i.clinic_id = :clinicId/);
    assert.deepEqual(replacements, { inboundMessageId: 101, conversationId: 51, clinicId: 61 });
    return [certified ? [{ id: 101 }] : []];
  };
  db.WhatsappTemplate.findOne = async () => approved;
  const selectNotice = db.Message.findOne;
  db.Message.findOne = async options => options.where.direction === 'inbound' ? f.input : selectNotice(options);
  const operation = () => optOut.applyVerifiedStoredBulkWhatsappOptOut({
    conversation: f.conversation, inboundMessageId: 101, actorUserId: 301,
  });
  assert.equal((await operation()).reason, 'bulk_opt_out_provider_receipt_required');
  assert.equal(f.records.size, 0);
  certified = true;
  assert.equal((await operation()).scope, 'whatsapp_channel');
  assert.equal((await operation()).scope, 'whatsapp_channel');
  assert.equal(f.notices[0].metadata.applied_by_user_id, 301);
  assert.equal(f.contactEvents[0].payload.applied_by_user_id, 301);
  assert.equal(f.contactEvents.length, 1);
  assert.equal(f.notices.length, 1);
  f.conversation.patient_id = 71;
  assert.equal((await operation()).reason, 'bulk_opt_out_requires_unlinked_phone');
});
