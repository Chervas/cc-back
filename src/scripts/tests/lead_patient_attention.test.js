'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createLeadPatientAttentionService, KEY } = require('../../services/leadPatientAttention.service');

function matches(row, where) {
  return Reflect.ownKeys(where || {}).every(key => {
    const expected = where[key];
    if (key === Op.or) return expected.some(w => matches(row, w));
    const value = typeof key === 'string' ? key.split('.').reduce((obj, field) => obj?.[field], row) : row[key];
    if (expected && typeof expected === 'object') return expected[Op.in]?.includes(value);
    return value === expected;
  });
}
function fixture({ relationship = 'existing_patient', status = 'nuevo', assigned = 44, allowed = true, formal = false } = {}) {
  const audits = [], messages = [], notifications = [], activations = [];
  const lead = { id: 10, clinica_id: 72, status_lead: status, asignado_a: assigned,
    source: 'web', gclid: 'synthetic-click', archived_at: null };
  const model = (rows, pk = 'id') => ({
    async findByPk(id) { return rows.find(row => Number(row[pk]) === Number(id)) || null; },
    async findAll({ where, order } = {}) {
      let results = rows.filter(row => matches(row, where));
      if (order?.[0]?.[1] === 'DESC') results = [...results].sort((a, b) => b.id - a.id);
      return results;
    },
    async findOne(query) { return (await this.findAll(query))[0] || null; },
    async create(values) { const row = { id: rows.length + 1, ...values }; rows.push(row); return row; },
  });
  lead.update = async patch => Object.assign(lead, patch);
  const db = { LeadIntake: model([lead]), LeadAttributionAudit: model(audits), Message: model(messages),
    Conversation: model([{ id: 5, clinic_id: 72, lead_id: 10, channel: 'whatsapp' }]),
    Usuario: model([{ id_usuario: 44, nombre: 'Directora QA', email_usuario: 'maria.gonzalez@modmarketing.net' }], 'id_usuario'),
    sequelize: { transaction: async work => work({ LOCK: { UPDATE: 'UPDATE' } }) } };
  if (formal) db.PatientDirectionSetting = model([{ clinic_id: 72, is_enabled: true, director_user_id: 44 }]);
  const context = { relationship, patient_id: relationship === 'existing_patient' ? 100 : null,
    request_kind: 'commercial', captured_at: '2026-10-29T19:35:00Z' };
  const service = createLeadPatientAttentionService(db, {
    contexts: { get: async () => context, capture: async () => context },
    now: () => new Date('2026-10-30T10:00:00Z'),
    authorize: async (actor, clinic) => allowed && [1, 44, 55].includes(actor) && clinic === 72,
    isAdmin: actor => actor === 1,
    notify: event => notifications.push(event),
    activateFormal: async input => activations.push(input),
  });
  return { db, service, lead, context, audits, messages, notifications, activations };
}

test('existing patient waits for a choice; owner and admin copy are distinct', async () => {
  const f = fixture();
  const [owner] = await f.service.enrich([f.lead], { actorId: 44 });
  assert.equal(owner.patient_attention.state, 'pending_review');
  assert.equal(owner.patient_attention.can_decide, true);
  assert.equal(owner.patient_attention.is_director, true);
  const [admin] = await f.service.enrich([f.lead], { actorId: 1 });
  assert.equal(admin.patient_attention.can_decide, true);
  assert.equal(admin.patient_attention.is_director, false);
  assert.equal(f.audits.length, 0, 'GET never persists classification or choices');
});

test('clinical staff may view the notice but cannot act as director', async () => {
  const f = fixture();
  const [view] = await f.service.enrich([f.lead], { actorId: 55 });
  assert.equal(view.patient_attention.can_decide, false);
  await assert.rejects(f.service.decide({ leadId: 10, actorId: 55, decision: 'director' }), { status: 403 });
  assert.equal(f.audits.length, 0);
});

test('new-contact assignment keeps the director mark after technical patient creation without patient review', async () => {
  for (const relationship of ['new_contact', 'unknown']) {
    const f = fixture({ relationship });
    f.lead.es_paciente = true;
    const [view] = await f.service.enrich([f.lead], { actorId: 44 });
    assert.equal(view.patient_attention.state, 'director');
    assert.equal(view.patient_attention.can_decide, false);
    assert.equal(view.patient_context.relationship, relationship);
  }
});

test('clinic transfer is durable and idempotent, no source or lifecycle overwrite', async () => {
  const f = fixture();
  const input = { leadId: 10, actorId: 44, decision: 'clinic', requestKind: 'commercial' };
  await f.service.decide(input); await f.service.decide(input);
  assert.equal(f.lead.asignado_a, null);
  assert.equal(f.lead.status_lead, 'nuevo');
  assert.equal(f.lead.gclid, 'synthetic-click');
  assert.equal(f.audits.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message_type, 'event');
  assert.equal(f.messages[0].sender_id, null, 'internal decision is not a human WhatsApp reply');
  assert.equal(f.notifications.length, 1);
  assert.equal((await f.service.enrich([f.lead], { actorId: 44 }))[0].patient_attention.state, 'clinic');
  await assert.rejects(f.service.decide({ ...input, decision: 'director' }), { status: 409 });
});

test('director can take the new opportunity, then explicitly hand it to clinic', async () => {
  const f = fixture();
  await f.service.decide({ leadId: 10, actorId: 44, decision: 'director' });
  assert.equal(f.lead.asignado_a, 44);
  assert.equal((await f.service.enrich([f.lead], { actorId: 44 }))[0].patient_attention.state, 'director');
  await f.service.decide({ leadId: 10, actorId: 44, decision: 'clinic', requestKind: 'patient_care' });
  assert.equal(f.audits.at(-1).attribution_steps[KEY].request_kind, 'patient_care');
  assert.equal(f.lead.status_lead, 'nuevo', 'request purpose is separate from funnel status');
});

test('a possible shared-phone identity is not automatically linked to a patient', async () => {
  const f = fixture({ relationship: 'possible_patient' });
  await f.service.decide({ leadId: 10, actorId: 44, decision: 'director' });
  assert.equal(f.context.patient_id, null);
  assert.equal(f.audits[0].attribution_steps[KEY].decision, 'director');
});

test('formal activation uses only a confirmed patient, never the old chat identity for an ambiguous request', async () => {
  for (const relationship of ['existing_patient', 'possible_patient']) {
    const f = fixture({ relationship, formal: true });
    (await f.db.Conversation.findByPk(5)).patient_id = 999;
    await f.service.decide({ leadId: 10, actorId: 44, decision: 'director' });
    assert.equal(f.activations.length, 1);
    assert.equal(f.activations[0].patientId, relationship === 'existing_patient' ? 100 : null);
    assert.equal(f.activations[0].leadId, 10);
  }
});

test('decision locks settings before conversation and lead, matching concurrent formal activation', async () => {
  const f = fixture({ formal: true }), order = [];
  for (const [model, method, name] of [[f.db.PatientDirectionSetting, 'findOne', 'settings'],
    [f.db.Conversation, 'findAll', 'conversation'], [f.db.LeadIntake, 'findByPk', 'lead']]) {
    const original = model[method].bind(model);
    model[method] = async (...args) => { const query = method === 'findByPk' ? args[1] : args[0];
      if (query?.lock) order.push(name); return original(...args); };
  }
  await f.service.decide({ leadId: 10, actorId: 44, decision: 'director' });
  assert.deepEqual(order.slice(0, 3), ['settings', 'conversation', 'lead']);
});

for (const state of ['acudio_cita', 'convertido', 'descartado']) test(`${state}: cannot reopen closed request`, async () => {
  const f = fixture({ status: state });
  assert.equal((await f.service.enrich([f.lead], { actorId: 44 }))[0].patient_attention.state, 'completed');
  await assert.rejects(f.service.decide({ leadId: 10, actorId: 44, decision: 'director' }), { status: 409 });
});

test('other owner, insufficient ACL and new technical patient are not captured', async () => {
  for (const options of [{ assigned: 9 }, { allowed: false }, { relationship: 'new_contact' }]) {
    const f = fixture(options);
    await assert.rejects(f.service.decide({ leadId: 10, actorId: 44, decision: 'director' }));
    assert.equal(f.audits.length, 0);
  }
});

test('unknown operation, request purpose or identity cannot be injected', async () => {
  const f = fixture();
  for (const overrides of [{ decision: 'admin' }, { requestKind: 'qualified_lead' }, { actorId: -1 }, { leadId: '10 OR 1' }]) {
    await assert.rejects(f.service.decide({ leadId: 10, actorId: 44, decision: 'director', ...overrides }), { status: 400 });
  }
  assert.equal(f.audits.length, 0);
});

test('attended handoff closes only the same request and clinic even before lead status catches up', async () => {
  const f = fixture({ status: 'citado' });
  await f.service.decide({ leadId: 10, actorId: 44, decision: 'director' });
  const metadata = { source: 'temporary_patient_direction', kind: 'temporary_patient_direction_handoff',
    clinic_id: 72, lead_intake_id: 9 };
  f.messages.push({ id: 20, message_type: 'event', metadata });
  assert.equal((await f.service.enrich([f.lead], { actorId: 44 }))[0].patient_attention.state, 'director');
  metadata.lead_intake_id = 10; metadata.clinic_id = 66;
  assert.equal((await f.service.enrich([f.lead], { actorId: 44 }))[0].patient_attention.state, 'director');
  metadata.clinic_id = 72;
  const view = (await f.service.enrich([f.lead], { actorId: 44 }))[0];
  assert.equal(view.patient_attention.state, 'completed'); assert.equal(view.patient_attention.can_decide, false);
  await assert.rejects(f.service.decide({ leadId: 10, actorId: 44, decision: 'clinic' }), { status: 409 });
});
