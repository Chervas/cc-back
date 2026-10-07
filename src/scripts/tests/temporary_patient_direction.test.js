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
    const actual = row[key];
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

function fixture({ clinicId = 72, patientId = null, leadId = 10, assigned = null, origin = 'lead', status = 'pendiente' } = {}) {
  const since = new Date('2026-10-06T09:00:00Z'), beginning = new Date('2026-10-07T09:00:00Z');
  const conversations = [{ id: 1, clinic_id: clinicId, channel: 'whatsapp', patient_id: patientId, lead_id: leadId }];
  const leads = leadId ? [{ id: leadId, clinica_id: clinicId, asignado_a: assigned,
    status_lead: 'nuevo', archived_at: null, created_at: since }] : [];
  const messages = [], appointments = [], events = [], attempts = [], notifications = [], warnings = [];
  if (origin === 'patient') events.push({ id: 1, patient_id: patientId, clinic_id: clinicId,
    actor_user_id: 44, event_type: 'patient.created', occurred_at: since });
  if (origin === 'message') messages.push({ id: 1, conversation_id: 1, sender_id: 44, direction: 'outbound',
    message_type: 'text', automation_delivery_key: null, content: 'Synthetic QA only', sent_at: since });
  if (patientId) appointments.push({ id_cita: 20, clinica_id: clinicId, paciente_id: patientId, lead_intake_id: leadId,
    created_by: origin === 'appointment' ? 44 : 99, created_at: since, inicio: beginning, fin: beginning,
    source_system: null, es_provisional: false, estado: status, arrived_at: null, care_schedule_start: null });
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
    LeadContactAttempt: model(attempts), CitaPaciente: model(appointments, 'id_cita'), PatientOperationalEvent: model(events),
    Usuario: model([{ id_usuario: 44, nombre: 'Graci', email_usuario: 'maria.gonzalez@modmarketing.net' }], 'id_usuario'),
    sequelize: { transaction(work) {
      const result = queue.then(() => work({ LOCK: { UPDATE: 'UPDATE' } }));
      queue = result.catch(() => {}); return result;
    } },
  };
  const service = createTemporaryPatientDirectionService(db, { now: () => new Date('2026-10-07T08:00:00Z'),
    notify: event => notifications.push(event), warn: code => warnings.push(code) });
  return { db, service, conversations, leads, messages, appointments, events, attempts, notifications, warnings };
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
