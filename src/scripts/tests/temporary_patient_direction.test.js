'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createTemporaryPatientDirectionService } = require('../../services/temporaryPatientDirection.service');

function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    const value = where[key];
    if (key === Op.or) return value.some(item => matches(row, item));
    if (key === Op.and) return value.every(item => matches(row, item));
    const actual = typeof key === 'string' ? key.split('.').reduce((value, part) => value?.[part], row) : row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Reflect.ownKeys(value).every(op => {
        const operand = value[op];
        if (op === Op.in) return operand.includes(actual);
        if (op === Op.notIn) return !operand.includes(actual);
        if (op === Op.ne) return actual !== operand;
        if (op === Op.gte) return +new Date(actual) >= +new Date(operand);
        if (op === Op.like) return String(actual || '').startsWith(operand.slice(0, -1));
        if (op === Op.and) return operand.every(item => matches({ value: actual }, { value: item }));
        throw Error(`Unsupported operator ${String(op)}`);
      });
    }
    return actual === value;
  });
}

function fixture({ clinicId = 72, patientId = null, leadId = 10, assigned = null, origin = 'lead', status = 'pendiente',
  relationship = 'new_contact', contextPatientId = patientId } = {}) {
  const since = new Date('2026-10-06T09:00:00Z'), beginning = new Date('2026-10-07T09:00:00Z');
  const conversations = [{ id: 1, clinic_id: clinicId, channel: 'whatsapp', patient_id: patientId, lead_id: leadId }];
  const leads = leadId ? [{ id: leadId, clinica_id: clinicId, asignado_a: assigned,
    status_lead: 'nuevo', archived_at: null, created_at: since }] : [];
  const messages = [], appointments = [], events = [], attempts = [], notifications = [], warnings = [], audits = [], contextCalls = [], contextBatches = [];
  const context = { relationship, patient_id: contextPatientId, clinic_id: clinicId, clinic_name: 'Synthetic clinic',
    same_clinic: true, captured_at: since.toISOString(), reason: 'synthetic_snapshot', request_kind: 'commercial' };
  if (origin === 'patient') events.push({ id: 1, patient_id: patientId, clinic_id: clinicId,
    actor_user_id: 44, event_type: 'patient.created', occurred_at: since });
  if (origin === 'message') messages.push({ id: 1, conversation_id: 1, sender_id: 44, direction: 'outbound',
    message_type: 'text', automation_delivery_key: null, content: 'Synthetic QA only', sent_at: since });
  if (patientId) appointments.push({ id_cita: 20, clinica_id: clinicId, paciente_id: patientId, lead_intake_id: leadId,
    created_by: origin === 'appointment' ? 44 : 99, created_at: since, inicio: beginning, fin: beginning,
    source_system: null, es_provisional: false, estado: status, arrived_at: null, care_schedule_start: null, care_legacy_attendance: false });
  const model = (rows, idKey = 'id') => ({
    async findByPk(id) { return rows.find(row => row[idKey] === Number(id)) || null; },
    async findAll({ where, order } = {}) {
      const result = rows.filter(row => matches(row, where));
      if (order) result.sort((a, b) => {
        for (const [key, direction] of order) {
          const left = a[key] instanceof Date ? +a[key] : a[key], right = b[key] instanceof Date ? +b[key] : b[key];
          if (left < right) return direction === 'ASC' ? -1 : 1;
          if (left > right) return direction === 'ASC' ? 1 : -1;
        }
        return 0;
      });
      return result;
    },
    async findOne(options) { return (await this.findAll(options))[0] || null; },
    async update(patch, { where }) { const selected = rows.filter(row => matches(row, where)); selected.forEach(row => Object.assign(row, patch)); return [selected.length]; },
    async create(values) { const row = { id: Math.max(0, ...rows.map(item => item.id)) + 1, ...values }; rows.push(row); return row; },
  });
  let queue = Promise.resolve();
  const db = { Conversation: model(conversations), Message: model(messages), LeadIntake: model(leads),
    LeadContactAttempt: model(attempts), LeadAttributionAudit: model(audits),
    CitaPaciente: model(appointments, 'id_cita'), PatientOperationalEvent: model(events),
    Usuario: model([{ id_usuario: 44, nombre: 'Graci', email_usuario: 'maria.gonzalez@modmarketing.net' }], 'id_usuario'),
    sequelize: { transaction(work) {
      const result = queue.then(() => work({ LOCK: { UPDATE: 'UPDATE' } }));
      queue = result.catch(() => {}); return result;
    } },
  };
  const patientContextService = {
    get: async (lead, options) => { contextCalls.push({ lead, options }); return context; },
    enrich: async (leads, options) => {
      contextBatches.push({ leads, options });
      return leads.map(lead => ({ ...lead, patient_context: context }));
    },
  };
  const service = createTemporaryPatientDirectionService(db, { now: () => new Date('2026-10-07T08:00:00Z'), patientContextService,
    notify: event => notifications.push(event), warn: code => warnings.push(code) });
  const decide = (decision, overrides = {}) => audits.push({ id: audits.length + 1, lead_intake_id: leadId,
    attribution_steps: { type: 'lead_patient_attention_v1', lead_patient_attention_v1: { version: 1, decision, request_kind: 'commercial', director_user_id: 44,
      decided_at: '2026-10-07T08:00:00Z', actor_user_id: 44, ...overrides } } });
  return { db, service, conversations, leads, messages, appointments, events, attempts, notifications, warnings,
    audits, context, contextCalls, contextBatches, patientContextService, decide };
}

for (const clinicId of [66, 72, 77]) {
  test(`clinic ${clinicId}: lead responsibility exists before the first outbound and survives conversion`, async () => {
    const f = fixture({ clinicId });
    await f.service.observeConversation(f.conversations[0]);
    assert.equal(f.leads[0].asignado_a, 44);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message_type, 'event');
    assert.equal(f.messages[0].sender_id, null, 'an automatic assignment is not a human reply');
    f.conversations[0].patient_id = 100;
    const [view] = await f.service.enrich(f.conversations);
    assert.equal(view.patient_direction.director_name, 'Graci');
    assert.equal(view.patient_direction.mode, 'temporary_clinic_phone');
  });
}

test('only the three agreed clinics and WhatsApp receive attention marks', async () => {
  for (const clinicId of [35, 56, 65, 67, 71, 73, 76, 78]) {
    const f = fixture({ clinicId }); await f.service.observeConversation(f.conversations[0]);
    assert.equal(f.messages.length, 0); assert.equal(f.leads[0].asignado_a, null);
  }
  for (const channel of ['internal', 'instagram']) {
    const f = fixture(); f.conversations[0].channel = channel;
    await f.service.observeConversation(f.conversations[0]); assert.equal(f.messages.length, 0);
  }
});

test('reading an unrelated patient does not claim the conversation', async () => {
  const f = fixture({ patientId: 100, leadId: null, origin: 'unrelated' });
  await f.service.observeConversation(f.conversations[0]); assert.equal(f.messages.length, 0);
});

test('a first manual reply claims only Graci conversations, not a read or another staff member reply', async () => {
  const f = fixture({ patientId: 100, leadId: null, origin: 'unrelated' });
  await f.service.observeConversation(f.conversations[0], { actorUserId: 99 });
  assert.equal(f.messages.length, 0);
  await f.service.observeConversation(f.conversations[0], { actorUserId: 44 });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].metadata.start_reason, 'human_contact');
});

test('attendance of another patient with the same lead never hands off this conversation', async () => {
  const f = fixture({ patientId: 100 });
  await f.service.observeConversation(f.conversations[0]);
  f.appointments.unshift({ ...f.appointments[0], id_cita: 19, paciente_id: 101, estado: 'completada' });
  await f.service.observeAppointment(f.appointments[1]);
  assert.equal(f.messages.length, 1);
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction.status, 'active');
});

test('attendance in another clinic or an imported appointment cannot cause a handoff', async () => {
  const f = fixture({ patientId: 100 });
  await f.service.observeConversation(f.conversations[0]);
  f.appointments.unshift({ ...f.appointments[0], id_cita: 18, clinica_id: 66, estado: 'completada' },
    { ...f.appointments[0], id_cita: 19, source_system: 'cliniccloud', estado: 'completada' });
  await f.service.observeAppointment(f.appointments[2]);
  assert.equal(f.messages.length, 1);
});

test('temporary attention never overrides the independent full Director assignment', async () => {
  const f = fixture(); await f.service.observeConversation(f.conversations[0]);
  const fullAssignment = { id: 500, director_user_id: 99, status: 'active' };
  const [view] = await f.service.enrich([{ ...f.conversations[0], patient_direction: fullAssignment }]);
  assert.strictEqual(view.patient_direction, fullAssignment);
});

test('does not take another staff member lead or a discarded/attended lead', async () => {
  for (const status of ['descartado', 'acudio_cita', 'convertido', 'archived', 'other_human', 'assigned_elsewhere']) {
    const f = fixture();
    if (status === 'archived') f.leads[0].archived_at = new Date();
    else if (status === 'assigned_elsewhere') f.leads[0].asignado_a = 99;
    else if (status === 'other_human') f.attempts.push({ id: 1, lead_intake_id: 10, usuario_id: 99 });
    else f.leads[0].status_lead = status;
    await f.service.observeConversation(f.conversations[0]); assert.equal(f.messages.length, 0, status);
  }
});

test('wrong director identity cannot activate the workaround', async () => {
  const f = fixture(); f.db.Usuario.findByPk = async () => ({ id_usuario: 44, email_usuario: 'different@example.invalid' });
  await f.service.observeConversation(f.conversations[0]); assert.equal(f.messages.length, 0);
});

test('concurrent observations create one mark and one internal handoff', async () => {
  const f = fixture({ patientId: 100 });
  await Promise.all(Array.from({ length: 20 }, () => f.service.observeConversation(f.conversations[0])));
  assert.equal(f.messages.length, 1);
  f.appointments[0].arrived_at = new Date('2026-10-07T09:00:00Z');
  f.appointments[0].care_schedule_start = f.appointments[0].inicio;
  await Promise.all(Array.from({ length: 20 }, () => f.service.observeAppointment(f.appointments[0])));
  assert.equal(f.messages.length, 2); assert.equal(f.notifications.length, 2);
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
});

test('a failed attention projection never aborts reception or a clinical transaction', async () => {
  const f = fixture(), callbacks = [];
  f.db.Message.findAll = async () => { throw Object.assign(Error('Synthetic unavailable table'), { original: { code: 'ER_NO_SUCH_TABLE' } }); };
  const row = f.conversations[0];
  assert.strictEqual(await f.service.observeConversation(row), row);
  assert.equal(f.warnings[0], 'ER_NO_SUCH_TABLE');
  await f.service.observeConversation(row, { transaction: { afterCommit: callback => callbacks.push(callback) } });
  assert.equal(callbacks.length, 1);
  assert.equal(await callbacks[0](), null);
  assert.equal(f.messages.length, 0);
});

test('attention is not materialized until the owning transaction commits', async () => {
  const f = fixture(), callbacks = [];
  await f.service.observeConversation(f.conversations[0], { transaction: { afterCommit: callback => callbacks.push(callback) } });
  assert.equal(f.messages.length, 0);
  await callbacks[0](); assert.equal(f.messages.length, 1);
});

for (const relationship of ['existing_patient', 'possible_patient']) {
  test(`${relationship}: a legacy request is pending on read, without claiming it or asserting active care`, async () => {
    const f = fixture({ patientId: 100, relationship });
    const [view] = await f.service.enrich(f.conversations);
    assert.equal(view.patient_direction.status, 'pending_review');
    assert.equal(view.patient_direction.lead_id, 10);
    assert.deepEqual(view.patient_direction.patient_context, f.context);
    assert.equal(view.patient_direction.started_at, null);
    assert.equal(view.patient_direction.start_reason, 'lead_patient_review');
    assert.equal(f.contextBatches.length, 1, 'legacy context is enriched in a batch even without a snapshot or marker');
    assert.equal(f.contextBatches[0].options.transaction, null);
    assert.equal((await f.service.ensure(1, 44)).status, 'pending_review', 'a manual reply is not a review decision');
    assert(f.contextCalls[0].options.transaction, 'get participates in the observation transaction');
    assert.equal(f.messages.length, 0);
    assert.equal(f.leads[0].asignado_a, null);
    assert.equal(f.audits.length, 0, 'the review writer owns decisions');
  });
}

test('unknown legacy context preserves the current attention workflow without an undecidable review', async () => {
  const f = fixture({ relationship: 'unknown' });
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
  assert.equal(f.messages.length, 0, 'reading alone does not claim an unknown lead');
  assert.equal((await f.service.ensure(1)).status, 'active');
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction.status, 'active');
  assert.equal(f.messages.length, 1);
  assert.equal(f.leads[0].asignado_a, 44);
  f.decide('clinic');
  assert.equal(await f.service.ensure(1), null, 'the persisted owner decision still wins over unknown context');
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
});

test('an unavailable context follows the unknown legacy workflow, without manufacturing a review', async () => {
  const f = fixture();
  f.patientContextService.get = async () => { throw Object.assign(Error('offline'), { code: 'context_unavailable' }); };
  f.patientContextService.enrich = f.patientContextService.get;
  assert.equal((await f.service.ensure(1)).status, 'active');
  const [view] = await f.service.enrich(f.conversations);
  assert.equal(view.patient_direction.status, 'active');
  assert.equal(view.patient_direction.patient_context.relationship, 'unknown');
  assert.equal(f.messages.length, 1);
  assert.equal(f.leads[0].asignado_a, 44);
});

for (const terminal of ['descartado', 'archived']) {
  test(`${terminal}: an active marker disappears without deleting its audit history`, async () => {
    const f = fixture({ patientId: 100, relationship: 'existing_patient' });
    f.decide('director');
    await f.service.ensure(1);
    assert.equal((await f.service.enrich(f.conversations))[0].patient_direction.status, 'active');
    if (terminal === 'archived') f.leads[0].archived_at = new Date();
    else f.leads[0].status_lead = terminal;
    assert.equal(await f.service.ensure(1, 44), null);
    assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
    assert.equal(f.messages.length, 1, 'the existing start remains audit evidence');
  });
}

test('enrich batches 100 requests, including repeated chats, without per-row SQL or context get calls', async () => {
  const f = fixture({ patientId: 100, relationship: 'existing_patient' });
  for (let id = 11; id < 110; id++) {
    f.leads.push({ ...f.leads[0], id });
    f.conversations.push({ ...f.conversations[0], id: id - 9, lead_id: id });
  }
  f.conversations.push({ ...f.conversations[0], id: 101 });
  f.decide('clinic');
  f.attempts.push({ id: 1, lead_intake_id: 11, usuario_id: 99 });
  const calls = {};
  for (const name of ['LeadIntake', 'Message', 'LeadAttributionAudit', 'LeadContactAttempt']) {
    const findAll = f.db[name].findAll;
    f.db[name].findAll = async options => { calls[name] = (calls[name] || 0) + 1; return findAll.call(f.db[name], options); };
    f.db[name].findByPk = f.db[name].findOne = async () => { throw Error(`per-row ${name} read forbidden`); };
  }
  f.patientContextService.get = async () => { throw Error('per-row context get forbidden'); };
  const rows = await f.service.enrich(f.conversations);
  assert.equal(rows.length, 101);
  assert.equal(rows[0].patient_direction, null, 'clinic decision');
  assert.equal(rows[1].patient_direction, null, 'another human has contact');
  assert.equal(rows.at(-1).patient_direction, null, 'duplicate chats share the lead decision');
  assert(rows.slice(2, -1).every(row => row.patient_direction.status === 'pending_review'));
  assert.deepEqual(calls, { Message: 1, LeadIntake: 1, LeadAttributionAudit: 1, LeadContactAttempt: 1 });
  assert.equal(f.contextBatches.length, 1);
  assert.equal(f.contextBatches[0].leads.length, 100);
  assert.equal(f.warnings.length, 0);
});

test('enrich reuses supplied patient_context and batches only the missing lead contexts', async () => {
  const f = fixture({ relationship: 'unknown' });
  f.conversations[0].patient_context = { ...f.context, relationship: 'existing_patient', patient_id: 100 };
  f.conversations.push({ ...f.conversations[0], id: 2, patient_context: undefined });
  assert((await f.service.enrich(f.conversations)).every(row => row.patient_direction.status === 'pending_review'));
  assert.equal(f.contextBatches.length, 0, 'the caller already provided this lead context');
  assert.equal(f.contextCalls.length, 0);
  f.leads.push({ ...f.leads[0], id: 11 });
  f.conversations.push({ ...f.conversations[1], id: 3, lead_id: 11 });
  const rows = await f.service.enrich(f.conversations);
  assert.equal(rows[0].patient_direction.status, 'pending_review');
  assert.equal(rows[2].patient_direction, null);
  assert.deepEqual(f.contextBatches[0].leads.map(lead => lead.id), [11]);
  assert.equal(f.contextCalls.length, 0);
});

test('latest per-lead decision overrides legacy marks; unrelated later audits do not erase it', async () => {
  const f = fixture({ patientId: 100 });
  await f.service.ensure(1);
  f.context.relationship = 'existing_patient';
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction.status, 'pending_review');
  f.decide('director', { request_kind: 'patient_care' });
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction.status, 'active');
  f.decide('clinic', { request_kind: 'patient_care' });
  f.audits.push({ id: 3, lead_intake_id: 10, attribution_steps: { action: 'registrar_contacto' } });
  assert.equal(await f.service.ensure(1, 44), null);
  assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
  assert.equal(f.messages.length, 1);
});

test('director decision is projected immediately and starts one request-scoped event', async () => {
  const f = fixture({ patientId: 100, relationship: 'existing_patient' });
  f.decide('director', { request_kind: 'patient_care' });
  const [view] = await f.service.enrich(f.conversations);
  assert.equal(view.patient_direction.status, 'active');
  assert.equal(view.patient_direction.request_kind, 'patient_care');
  assert.equal(f.messages.length, 0, 'enrichment stays read-only');
  await Promise.all(Array.from({ length: 5 }, () => f.service.ensure(1)));
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].automation_delivery_key, 'temporary-patient-direction:start:lead:72:10');
  assert.equal(f.messages[0].metadata.lead_intake_id, 10);
  assert.equal(f.leads[0].asignado_a, 44);
});

for (const relationship of ['existing_patient', 'possible_patient']) {
  test(`${relationship}: only this request, patient and clinic can complete the handoff`, async () => {
    const f = fixture({ patientId: 100, relationship });
    f.decide('director');
    const own = f.appointments[0];
    f.appointments.unshift(...[
      { lead_intake_id: 9 }, { paciente_id: 101 }, { clinica_id: 66 },
      { source_system: 'cliniccloud' }, { es_provisional: true }, { care_legacy_attendance: true },
      { inicio: new Date('2020-01-01') },
    ].map((patch, i) => ({ ...own, id_cita: i + 1, estado: 'completada', ...patch })));
    await f.service.ensure(1);
    assert.equal(f.messages.length, 1, 'historical or unrelated attended appointments never close this request');
    own.estado = 'completada';
    await f.service.observeAppointment(own);
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].metadata.lead_intake_id, 10);
    assert.equal(f.messages[1].metadata.appointment_id, own.id_cita);
    f.decide('director');
    assert.equal(await f.service.ensure(1, 44), null, 'even a repeated decision cannot reopen this lead');
    assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
  });
}

test('reviewed requests with unresolved or conflicting patient identity cannot hand off', async () => {
  for (const conflict of [false, true]) {
    const f = fixture({ patientId: conflict ? 100 : null, contextPatientId: conflict ? 101 : null,
      relationship: 'possible_patient' });
    f.decide('director');
    if (conflict) f.appointments[0].estado = 'completada';
    else f.appointments.push({ id_cita: 20, paciente_id: 100, clinica_id: 72, lead_intake_id: 10,
      source_system: null, es_provisional: false, inicio: new Date('2026-10-07T09:00:00Z'), estado: 'completada' });
    await f.service.ensure(1);
    assert.equal(f.messages.length, 1);
  }
});

test('a new lead on the same canonical conversation is reviewed independently of the old handoff', async () => {
  const f = fixture({ patientId: 100, relationship: 'existing_patient' });
  f.decide('director'); f.appointments[0].estado = 'completada';
  await f.service.ensure(1);
  assert.equal(f.messages.length, 2);
  f.leads.push({ ...f.leads[0], id: 11, asignado_a: null });
  f.conversations[0].lead_id = 11;
  assert.equal((await f.service.ensure(1)).status, 'pending_review');
  const [view] = await f.service.enrich(f.conversations);
  assert.equal(view.patient_direction.lead_id, 11);
  assert.equal(view.patient_direction.status, 'pending_review');
  assert.equal(f.messages.length, 2);
});

test('request marks follow the lead across canonical chats and retain handoff finality', async () => {
  const f = fixture({ patientId: 100, relationship: 'existing_patient' });
  f.decide('director'); f.appointments[0].estado = 'completada';
  await f.service.ensure(1);
  f.conversations.push({ ...f.conversations[0], id: 2 });
  assert.equal(await f.service.ensure(2), null);
  assert.equal((await f.service.enrich([f.conversations[1]]))[0].patient_direction, null);
  assert.equal(f.messages.length, 2);
});

test('legacy undated handoffs stay closed, while marks predating a new lead do not consume it', async () => {
  const f = fixture({ patientId: 100, relationship: 'existing_patient' });
  f.messages.push({ id: 1, conversation_id: 1, message_type: 'event', automation_delivery_key: 'temporary-patient-direction:handoff:1',
    metadata: { source: 'temporary_patient_direction', kind: 'temporary_patient_direction_handoff', clinic_id: 72, director_user_id: 44 } });
  assert.equal(await f.service.ensure(1), null);
  f.messages[0].sent_at = new Date('2020-01-01');
  assert.equal((await f.service.ensure(1)).status, 'pending_review');
});

for (const conflict of ['lead_owner', 'chat_owner', 'human_contact', 'decision_director', 'lead_clinic']) {
  test(`${conflict}: neither a decision nor a manual reply steals human responsibility`, async () => {
    const f = fixture({ patientId: 100, relationship: 'existing_patient' });
    f.decide('director');
    if (conflict === 'lead_owner') f.leads[0].asignado_a = 99;
    if (conflict === 'chat_owner') f.conversations[0].assignee_id = 99;
    if (conflict === 'human_contact') f.attempts.push({ lead_intake_id: 10, usuario_id: 99 });
    if (conflict === 'decision_director') f.audits[0].attribution_steps.lead_patient_attention_v1.director_user_id = 99;
    if (conflict === 'lead_clinic') f.leads[0].clinica_id = 66;
    const owner = f.leads[0].asignado_a;
    assert.equal(await f.service.ensure(1, 44), null);
    assert.equal((await f.service.enrich(f.conversations))[0].patient_direction, null);
    assert.equal(f.leads[0].asignado_a, owner);
    assert.equal(f.messages.length, 0);
  });
}

for (const clinicId of [66, 72, 77]) for (const origin of ['lead', 'patient', 'message', 'appointment']) {
  for (const state of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado',
    'cambio_solicitado', 'reprogramada', 'cancelada', 'no_asistio', 'completada', 'arrival', 'stale_arrival']) {
    test(`regression ${clinicId}/${origin}/${state}`, async () => {
      const f = fixture({ clinicId, patientId: 100, leadId: origin === 'lead' ? 10 : null, origin,
        status: ['arrival', 'stale_arrival'].includes(state) ? 'info_confirmada' : state });
      await f.service.observeConversation(f.conversations[0]);
      if (['arrival', 'stale_arrival'].includes(state)) {
        f.appointments[0].arrived_at = new Date('2026-10-07T09:00:00Z');
        f.appointments[0].care_schedule_start = state === 'arrival' ? f.appointments[0].inicio : new Date('2026-10-01T09:00:00Z');
      }
      await f.service.observeAppointment(f.appointments[0]);
      const handoffs = f.messages.filter(row => row.metadata?.kind === 'temporary_patient_direction_handoff');
      assert.equal(handoffs.length, ['completada', 'arrival'].includes(state) ? 1 : 0);
      assert.equal(f.appointments[0].estado, ['arrival', 'stale_arrival'].includes(state) ? 'info_confirmada' : state,
        'attention must not change clinical status');
      assert.equal(f.warnings.length, 0);
      const before = f.messages.length;
      await f.service.observeConversation(f.conversations[0], { actorUserId: 44 });
      assert.equal(f.messages.length, before, 'neither retries nor human/automatic followups reopen a completed handoff');
    });
  }
}
