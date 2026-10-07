'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const c = require('../../../lib/appointment-clinical-components');
const { hash } = require('../../../lib/cliniccloud-import/adapter');
const { createAppointmentVisitCommunicationService } = require('../../../services/appointmentVisitCommunications.service');
const clone = value => structuredClone(value);
const NOW = '2030-01-01T12:00:00.000Z';
function appointment(id = 101, overrides = {}) {
  return { id_cita: id, clinica_id: 66, paciente_id: 8, doctor_id: 50, instalacion_id: 75,
    tratamiento_id: 688, tipo_cita: 'continuacion', inicio: '2030-01-07T10:15:00.000Z', fin: '2030-01-07T10:45:00.000Z', estado: 'pendiente',
    es_provisional: false, source_system: null, source_reference: null, import_metadata: {},
    created_at: NOW, updated_at: NOW, titulo: 'Fixture only', nota: 'Must not enter communication snapshot', ...overrides };
}
function prpFixture({ componentAppointmentId = 101, parentAppointmentId = 102, auditEventId = '9007199254740993' } = {}) {
  const rows = [componentAppointmentId, parentAppointmentId].map((id, index) => {
    const child = index === 0, doctor = child ? 53 : 50, room = child ? 79 : 75;
    const start = child ? '2030-01-07T10:00:00.000Z' : '2030-01-07T10:15:00.000Z';
    const end = child ? '2030-01-07T10:15:00.000Z' : '2030-01-07T10:45:00.000Z';
    const receipt = { version: 'cliniccloud-source-booking/1', source_account: 'cliniccloud-5880',
      source_appointment_id: String(id + 1000), source_contact_id: '800', preserved_start_at: start,
      preserved_end_at: end, automation_policy: 'hold', policy: 'preserve_source_interval_report_conflicts' };
    receipt.receipt_sha256 = hash(receipt);
    return appointment(id, { doctor_id: doctor, instalacion_id: room, tratamiento_id: child ? null : 688, inicio: start, fin: end,
      source_system: 'cliniccloud', source_reference: 'fixture:' + id,
      import_metadata: { source_account: 'cliniccloud-5880', source_appointment_id: String(id + 1000), source_contact_id: '800',
        cliniccloud_source_booking: receipt, cliniccloud_reconciliation: { automation_policy: 'hold' },
        notification_suppression: { appointment_details: true, day_before: true, same_day: true },
        booking: { version: 1, profile: { version: 2, phases: [{ key: 'appointment', duration_minutes: child ? 15 : 30,
          installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } }] },
        phases: [{ key: 'appointment', installation_id: room, doctor_ids: [doctor], start_at: start, end_at: end, staff_time_scope: 'phase' }] } } });
  });
  const treatment = { id_tratamiento: 688, clinica_id: 66, activo: true, nombre_tratamiento: 'PRP',
    clinical_config: { catalog_status: 'active', source_reference: 'service:2798745' } };
  const roles = c.assertPairRoles(rows[0], rows[1], treatment);
  const receipt = { version: 1, role: c.ROLE, component_appointment_id: componentAppointmentId, parent_appointment_id: parentAppointmentId,
    patient_id: 8, clinic_id: 66, actor_id: 7, reason: 'Explicit fixture review of both preserved PRP reservations', reviewed_at: NOW,
    request_hash: hash({ fixture: 1 }), component_fingerprint: c.reservationFingerprint(rows[0]), parent_fingerprint: c.reservationFingerprint(rows[1]),
    source_acknowledgements: { component: roles.component, parent: roles.parent }, primary_treatment_evidence: roles.treatment,
    planned_only: true, administration_inferred: false, individual_price_assigned: false, purchase_or_program_inferred: false };
  const event = { id: auditEventId, clinic_id: 66, patient_id: 8, actor_user_id: 7, event_type: c.EVENT_TYPE, source: 'agenda',
    metadata: { role: c.ROLE, component_appointment_id: componentAppointmentId, parent_appointment_id: parentAppointmentId,
      request_hash: receipt.request_hash, base_receipt_sha256: hash(receipt) } };
  receipt.audit_event_id = event.id; receipt.receipt_sha256 = hash(receipt);
  rows[0].import_metadata[c.PARENT_KEY] = clone(receipt); rows[1].import_metadata[c.CHILDREN_KEY] = [clone(receipt)];
  assert(c.isValidatedClinicalComponentContext(c.componentContext({ component: rows[0], parent: rows[1], treatment, auditEvent: event })));
  return { rows, treatment, event };
}
function fixture({ rows = [appointment()], prp = false, policy = null, legacy = null, failCreate = null } = {}) {
  const relation = prp ? prpFixture() : null;
  const names = { CitaPaciente: 'id_cita', AppointmentVisit: 'id', AppointmentVisitMember: 'appointment_id',
    AppointmentVisitCommunication: 'id', FlowExecutionV2: 'id', Message: 'id', Conversation: 'id',
    Tratamiento: 'id_tratamiento', PatientOperationalEvent: 'id' };
  let state = Object.fromEntries(Object.keys(names).map(name => [name, new Map()]));
  for (const row of relation?.rows || rows) state.CitaPaciente.set(String(row.id_cita), clone(row));
  if (relation) {
    state.Tratamiento.set('688', clone(relation.treatment)); state.PatientOperationalEvent.set(relation.event.id, clone(relation.event));
  }
  const calls = [], writes = [];
  let clock = NOW, operational = policy, exact = legacy, previous = Promise.resolve();
  const db = { sequelize: { async transaction(options, callback) {
    const prior = previous; let release;
    previous = new Promise(resolve => { release = resolve; }); await prior;
    const tx = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, data: clone(state) };
    try { const result = await callback(tx); state = tx.data; return result; } finally { release(); }
  } } };
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  function wrap(name, row, tx) {
    if (!row) return null;
    return { ...clone(row), toJSON: () => clone(row), async update(values, opts) {
      assert.equal(opts.transaction, tx); assert.equal(opts.hooks, false);
      if (name === 'AppointmentVisitCommunication' && values.message_id != null
        && [...tx.data[name].values()].some(other => other.id !== row.id && other.message_id === values.message_id)) {
        throw Object.assign(Error('fixture_unique_constraint'), { name: 'SequelizeUniqueConstraintError' });
      }
      writes.push({ model: name, id: row[names[name]], keys: Object.keys(values) });
      Object.assign(row, clone(values)); Object.assign(this, clone(row)); return this;
    } };
  }
  for (const [name, key] of Object.entries(names)) db[name] = {
    async findByPk(id, opts = {}) {
      calls.push({ model: name, method: 'findByPk', id, lock: opts.lock, transaction: !!opts.transaction });
      return wrap(name, (opts.transaction?.data || state)[name].get(String(id)), opts.transaction);
    },
    async findAll(opts = {}) {
      calls.push({ model: name, method: 'findAll', lock: opts.lock, transaction: !!opts.transaction });
      const rows = [...(opts.transaction?.data || state)[name].values()].filter(row => matches(row, opts.where));
      if (opts.order) rows.sort((a, b) => typeof a[opts.order[0][0]] === 'number'
        ? a[opts.order[0][0]] - b[opts.order[0][0]] : String(a[opts.order[0][0]]).localeCompare(String(b[opts.order[0][0]])));
      return rows.map(row => wrap(name, row, opts.transaction));
    },
    async findOne(opts) { return (await this.findAll(opts))[0] || null; },
    async create(values, opts) {
      assert(opts.transaction); assert.equal(opts.hooks, false);
      if (name === failCreate) throw Error('fixture_create_failed');
      const table = opts.transaction.data[name], row = { created_at: clock, updated_at: clock, ...clone(values) };
      const uniqueError = () => { throw Object.assign(Error('fixture_unique_constraint'), { name: 'SequelizeUniqueConstraintError' }); };
      if (table.has(String(row[key]))) uniqueError();
      if (name === 'AppointmentVisitCommunication') {
        for (const current of table.values()) {
          if (['visit_id', 'purpose', 'communication_revision', 'window_sha256'].every(k => row[k] === current[k])) uniqueError();
          if (row.message_id != null && row.message_id === current.message_id) uniqueError();
        }
      }
      table.set(String(row[key]), row); writes.push({ model: name, id: row[key], keys: Object.keys(values) });
      return wrap(name, row, opts.transaction);
    },
  };
  const service = createAppointmentVisitCommunicationService({ db, now: () => new Date(clock), newId: randomUUID,
    readOperationalPolicy: () => operational, readLegacyPolicy: () => exact });
  return { db, service, calls, writes, get state() { return state; }, now(value) { clock = value; },
    policy(value) { operational = value; }, legacy(value) { exact = value; },
    change(name, id, values) { Object.assign(state[name].get(String(id)), clone(values)); },
    seed(name, row) { state[name].set(String(row[names[name]]), clone(row)); },
    singleton(id = 101) { return service.ensureSingletonVisit({ appointmentId: id, clinicId: 66, actorId: 7 }); },
    group() { return service.linkValidatedPrpVisit({ componentAppointmentId: 101, parentAppointmentId: 102, clinicId: 66, actorId: 7 }); },
  };
}
const window = (key = 'event') => ({ key, starts_at: NOW, ends_at: '2030-01-02T12:00:00.000Z' });
const policy = () => ({ version: 1, purpose: 'appointment_operations', approvedBy: 7, approvalRef: 'fixture-only',
  approvedAt: '2029-12-31T12:00:00.000Z', clinicIds: [66], automaticBacklogReplay: false, sameDayAllowed: false });
function combinedAppointment(id = 301) {
  const start = '2030-01-07T10:00:00.000Z', end = '2030-01-07T10:45:00.000Z';
  const profile = { version: 4, phases: [
    { key: 'setup', duration_minutes: 15, start_offset_minutes: 0, installation_ids: [75], professionals: { mode: 'any', ids: [50], preferred_id: 50 } },
    { key: 'care', duration_minutes: 30, start_offset_minutes: 15, installation_ids: [76, 77], professionals: { mode: 'any', ids: [51, 52], preferred_id: 51, fallback_when: 'unavailable' } },
  ] };
  const phases = profile.phases.map((required, index) => {
    const from = index ? '2030-01-07T10:15:00.000Z' : start, to = index ? end : '2030-01-07T10:15:00.000Z';
    return { key: required.key, start_at: from, end_at: to, start_offset_minutes: required.start_offset_minutes,
      installation_id: required.installation_ids[0], doctor_ids: [required.professionals.ids[0]], staff_time_scope: 'phase',
      staff_attention: [{ mode: 'continuous', patient_preparation_minutes: 0 }],
      staff_intervals: [{ kind: 'continuous', start_at: from, end_at: to }] };
  });
  return appointment(id, { inicio: start, fin: end, import_metadata: { booking: { version: 1, profile, phases,
    capacity_fully_verified: true, attention_requirements_pending: [] } } });
}
module.exports = { fixture, appointment, prpFixture, combinedAppointment, window, policy, NOW };
