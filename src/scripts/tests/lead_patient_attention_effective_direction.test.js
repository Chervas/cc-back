'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createLeadPatientAttentionService, KEY } = require('../../services/leadPatientAttention.service');

function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    const value = where[key];
    if (key === Op.or) return value.some(item => matches(row, item));
    if (key === Op.and) return value.every(item => matches(row, item));
    const actual = key.split('.').reduce((object, part) => object?.[part], row);
    if (value && typeof value === 'object' && !(value instanceof Date)) return Reflect.ownKeys(value).every(op => {
      if (op === Op.in) return value[op].includes(actual);
      if (op === Op.notIn) return !value[op].includes(actual);
      if (op === Op.gte) return +new Date(actual) >= +new Date(value[op]);
      if (op === Op.like) return String(actual || '').startsWith(value[op].slice(0, -1));
      throw Error('Unexpected test operator');
    });
    return actual === value;
  });
}

function fixture() {
  const leads = [8432, 8438].map((id, index) => ({ id, clinica_id: 72, nombre: index ? 'Synthetic Dzhamala' : 'Synthetic Ana',
    created_at: '2026-11-17T22:19:36Z', status_lead: 'citado', archived_at: null, asignado_a: null,
    patient_context: { relationship: 'new_contact', patient_id: null, request_kind: 'commercial' } }));
  const conversations = leads.map((lead, index) => ({ id: 17365 + index, clinic_id: 72, channel: 'whatsapp',
    patient_id: 68567 + index, lead_id: lead.id }));
  const messages = conversations.map((row, index) => ({ id: 202828 + index, conversation_id: row.id,
    message_type: 'event', automation_delivery_key: `temporary-patient-direction:start:${row.id}`,
    sent_at: '2026-11-18T09:01:49Z', metadata: { source: 'temporary_patient_direction',
      kind: 'temporary_patient_direction_started', clinic_id: 72, patient_id: row.patient_id,
      lead_intake_id: null, director_user_id: 44, started_at: '2026-11-18T09:01:48Z', start_reason: 'appointment_created' } }));
  const appointments = conversations.map((row, index) => ({ id_cita: 79785 + index, clinica_id: 72,
    paciente_id: row.patient_id, lead_intake_id: row.lead_id, source_system: null, es_provisional: false,
    inicio: '2026-11-23T10:15:00Z', estado: index ? 'info_confirmada' : 'info_enviada',
    arrived_at: null, care_started_at: null, care_completed_at: null, care_legacy_attendance: false }));
  const audits = [], contacts = [], assignments = [], reads = [], writes = [];
  const model = (name, rows, pk = 'id') => ({
    async findByPk(id) { return rows.find(row => Number(row[pk]) === Number(id)) || null; },
    async findAll(query = {}) {
      reads.push({ name, query });
      const found = rows.filter(row => matches(row, query.where));
      if (query.order) found.sort((a, b) => {
        for (const [field, direction] of query.order) {
          if (a[field] < b[field]) return direction === 'DESC' ? 1 : -1;
          if (a[field] > b[field]) return direction === 'DESC' ? -1 : 1;
        }
        return 0;
      });
      return found;
    },
    async findOne(query) { return (await this.findAll(query))[0] || null; },
    async create() { writes.push(name); assert.fail('Read projection must not create records'); },
    async update() { writes.push(name); assert.fail('Read projection must not update records'); },
  });
  const db = { Conversation: model('conversation', conversations), Message: model('message', messages),
    CitaPaciente: model('appointment', appointments, 'id_cita'), LeadAttributionAudit: model('audit', audits),
    LeadContactAttempt: model('contact', contacts), PatientDirectionAssignment: model('assignment', assignments),
    PatientDirectionSetting: model('setting', []),
    Usuario: model('user', [{ id_usuario: 44, nombre: 'Synthetic director', email_usuario: 'maria.gonzalez@modmarketing.net' }], 'id_usuario') };
  const service = createLeadPatientAttentionService(db, { contexts: { get: async lead => lead.patient_context },
    authorize: async () => true, isAdmin: () => false });
  const view = async input => service.enrich(input || leads, { actorId: 44 });
  return { leads, conversations, messages, appointments, audits, contacts, assignments, reads, writes, db, view };
}

test('Ana8432 and Dz8438 retain effective patient-origin direction in list and detail without assignment or attendance', async () => {
  const f = fixture();
  const list = await f.view();
  assert.deepEqual(list.map(lead => [lead.id, lead.patient_attention.state, lead.patient_attention.director_user_id]),
    [[8432, 'director', 44], [8438, 'director', 44]]);
  for (const lead of f.leads) {
    const [detail] = await f.view([lead]);
    assert.deepEqual(detail.patient_attention, list.find(row => row.id === lead.id).patient_attention);
    assert.equal(lead.asignado_a, null, 'projection does not repair operational ownership');
  }
  assert.equal(f.appointments[1].estado, 'info_confirmada', 'future confirmation is not attendance');
  assert.deepEqual(f.writes, []);
  assert(f.reads.filter(row => row.name === 'conversation').every(row => row.query.raw && !row.query.lock));
});

for (const status of ['descartado', 'acudio_cita', 'convertido']) test(`${status} never reopens an old temporal mark`, async () => {
  const f = fixture(); f.leads[0].status_lead = status;
  assert.equal((await f.view())[0].patient_attention.state, 'completed');
});

test('archived requests remain closed', async () => {
  const f = fixture(); f.leads[0].archived_at = '2026-11-18T10:00:00Z';
  assert.equal((await f.view())[0].patient_attention.state, 'completed');
});

test('a later manual clinic decision takes precedence over the temporal event', async () => {
  const f = fixture();
  f.audits.push({ id: 30, lead_intake_id: 8432, attribution_steps: { type: KEY, [KEY]: {
    version: 1, decision: 'clinic', request_kind: 'patient_care', director_user_id: 44,
    decided_at: '2026-11-18T10:00:00Z' } } });
  assert.equal((await f.view())[0].patient_attention.state, 'clinic');
});

test('a later handoff without lead_id still closes this exact patient/conversation request', async () => {
  const f = fixture();
  f.messages.push({ ...f.messages[0], id: 202850, sent_at: '2026-11-18T10:00:00Z',
    automation_delivery_key: 'temporary-patient-direction:handoff:17365',
    metadata: { ...f.messages[0].metadata, kind: 'temporary_patient_direction_handoff' } });
  assert.equal((await f.view())[0].patient_attention.state, 'completed');
});

for (const status of ['ha_acudido', 'en_atencion', 'completada']) test(`actual ${status} evidence wins even when handoff has not been emitted`, async () => {
  const f = fixture(); f.appointments[0].estado = status;
  assert.equal((await f.view())[0].patient_attention.state, 'completed');
  assert.equal(f.messages.length, 2, 'a read does not emit the missing handoff');
});

test('arrival timestamp closes direction without confusing the future confirmation state', async () => {
  const f = fixture(); f.appointments[0].arrived_at = '2026-11-23T10:00:00Z';
  f.appointments[0].care_schedule_start = f.appointments[0].inicio;
  assert.equal((await f.view())[0].patient_attention.state, 'completed');
});

test('arrival belonging to an old reservation time does not hand off the rescheduled request', async () => {
  const f = fixture(); f.appointments[0].arrived_at = '2026-11-18T10:00:00Z';
  f.appointments[0].care_schedule_start = '2026-11-18T10:15:00Z';
  assert.equal((await f.view())[0].patient_attention.state, 'director');
});

test('newer service revocation is respected instead of resurrecting a legacy start', async () => {
  const f = fixture(); f.assignments.push({ conversation_id: 17365, clinic_id: 72, patient_id: 68567,
    lead_intake_id: 8432, status: 'ended_service_disabled', end_reason: 'service_disabled', ended_at: '2026-11-18T10:00:00Z' });
  assert.equal((await f.view())[0].patient_attention.state, 'clinic');
});

test('attendance or a handoff from another patient, clinic or older request cannot close this direction', async () => {
  for (const mismatch of ['patient', 'clinic', 'request']) {
    const f = fixture();
    const event = { ...f.messages[0], id: 202850, metadata: { ...f.messages[0].metadata,
      kind: 'temporary_patient_direction_handoff' } };
    if (mismatch === 'patient') event.metadata.patient_id = 999;
    if (mismatch === 'clinic') event.metadata.clinic_id = 66;
    if (mismatch === 'request') event.metadata.lead_intake_id = 8438;
    f.messages.push(event);
    f.appointments.push({ ...f.appointments[0], id_cita: 999, paciente_id: 999, estado: 'completada' });
    assert.equal((await f.view())[0].patient_attention.state, 'director');
  }
});

test('existing/possible patients retain pending review despite an old start event', async () => {
  for (const relationship of ['existing_patient', 'possible_patient']) {
    const f = fixture(); f.leads[0].patient_context.relationship = relationship;
    assert.equal((await f.view())[0].patient_attention.state, 'pending_review');
  }
});

for (const mismatch of ['clinic', 'conversation', 'patient', 'director', 'request', 'older_request']) test(`temporal ${mismatch} mismatch cannot claim this patient`, async () => {
  const f = fixture();
  if (mismatch === 'clinic') f.messages[0].metadata.clinic_id = 66;
  if (mismatch === 'conversation') f.messages[0].conversation_id = 999;
  if (mismatch === 'patient') f.messages[0].metadata.patient_id = 999;
  if (mismatch === 'director') f.messages[0].metadata.director_user_id = 99;
  if (mismatch === 'request') f.messages[0].metadata.lead_intake_id = 8438;
  if (mismatch === 'older_request') f.messages[0].metadata.started_at = '2026-11-16T10:00:00Z';
  assert.equal((await f.view())[0].patient_attention.state, 'unassigned');
});

test('a conversation from a different clinic and ambiguous conversations are not canonical ownership', async () => {
  const f = fixture(); f.conversations[0].clinic_id = 66;
  assert.equal((await f.view())[0].patient_attention.state, 'unassigned');
  const g = fixture(); g.conversations.push({ ...g.conversations[0], id: 999 });
  assert.equal((await g.view())[0].patient_attention.state, 'unassigned');
});

test('another human or explicit owner is never overridden by the temporal projection', async () => {
  const f = fixture(); f.contacts.push({ lead_intake_id: 8432, usuario_id: 99 });
  assert.equal((await f.view())[0].patient_attention.state, 'clinic');
  const g = fixture(); g.leads[0].asignado_a = 99;
  assert.equal((await g.view())[0].patient_attention.state, 'clinic');
});

test('query failure cannot promote an unassigned lead or mutate the underlying records', async () => {
  const f = fixture(); f.db.CitaPaciente.findAll = async () => { throw Error('query unavailable'); };
  assert.equal((await f.view())[0].patient_attention.state, 'unassigned');
  assert.deepEqual(f.writes, []);
});


test('a completed appointment explicitly linked to another lead of the same patient cannot end this direction', async () => {
  const f=fixture();f.appointments[0].lead_intake_id=999;f.appointments[0].estado='completada';
  const [lead]=await f.view();assert.equal(lead.patient_attention.state,'director');assert.deepEqual(f.writes,[]);
});
test('a legacy appointment without lead_id remains valid attendance evidence for the exact patient and clinic', async () => {
  const f=fixture();f.appointments[0].lead_intake_id=null;f.appointments[0].estado='completada';
  assert.equal((await f.view())[0].patient_attention.state,'completed');assert.deepEqual(f.writes,[]);
});
test('first appointment ordering is retained when another lead has an earlier attended appointment', async () => {
  const f=fixture();f.appointments.push({...f.appointments[0],id_cita:90000,lead_intake_id:999,estado:'completada',inicio:'2026-11-20T10:15:00Z'});
  assert.equal((await f.view())[0].patient_attention.state,'director');
});
test('several requests share one scoped appointment read instead of one query per request', async () => {
  const f=fixture();await f.view();const reads=f.reads.filter(row=>row.name==='appointment');
  assert.equal(reads.length,1);assert.equal(reads[0].query.limit,5001);assert.equal(reads[0].query.raw,true);
  assert.equal(reads[0].query.where[Op.or].length,2);assert(!reads[0].query.attributes.includes('nota'));
});
test('an incomplete appointment history cannot fabricate ownership or attendance', async () => {
  const f=fixture();f.db.CitaPaciente.findAll=async()=>Array.from({length:5001},()=>({...f.appointments[0]}));
  assert.equal((await f.view())[0].patient_attention.state,'unassigned');assert.deepEqual(f.writes,[]);
});
