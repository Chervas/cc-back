'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { occupancyForSolution } = require('../../lib/booking-profile-solver');
const c = require('../../lib/appointment-clinical-components');
const service = require('../../services/appointmentClinicalComponents.service');
const clone = value => structuredClone(value);
function appointment(id, role) {
  const child = role === 'component', doctor = child ? 53 : 50, room = child ? 79 : 75;
  const start = child ? '2030-01-07T10:00:00.000Z' : '2030-01-07T10:15:00.000Z';
  const end = child ? '2030-01-07T10:15:00.000Z' : '2030-01-07T10:45:00.000Z';
  const receipt = { version: 'cliniccloud-source-booking/1', source_account: 'cliniccloud-5880',
    source_appointment_id: String(id + 1000), source_contact_id: '800',
    preserved_start_at: start, preserved_end_at: end, automation_policy: 'hold',
    policy: 'preserve_source_interval_report_conflicts' };
  receipt.receipt_sha256 = hash(receipt);
  return { id_cita: id, paciente_id: 8, clinica_id: 66, doctor_id: doctor, instalacion_id: room,
    tratamiento_id: child ? null : 688, voucher_id: null, lead_intake_id: null, campana_id: null,
    titulo: 'Source label', nota: 'Source clinical note', motivo: null, tipo_cita: 'continuacion', estado: 'pendiente',
    inicio: start, fin: end, created_at: '2026-10-04T10:00:00.000Z', updated_at: '2026-10-05T00:30:00.000Z',
    created_by: 7, updated_by: 7, es_provisional: false, hold_expires_at: null, arrived_at: null, care_started_at: null,
    care_schedule_start: null, source_system: 'cliniccloud', source_reference: 'delta:fixture:' + id,
    import_metadata: { source_account: 'cliniccloud-5880', source_appointment_id: String(id + 1000), source_contact_id: '800',
      cliniccloud_source_booking: receipt, cliniccloud_reconciliation: { automation_policy: 'hold' },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_delta: { pending_assignment: child ? ['treatment_id'] : [],
        source: { service_key: 'PRP 1 SESION', details: 'PRP', price: child ? '120.00' : '120.00' } },
      booking: { version: 1, profile: { version: 2, phases: [{ key: 'appointment', duration_minutes: child ? 15 : 30,
        installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } }] },
      phases: [{ key: 'appointment', installation_id: room, doctor_ids: [doctor], start_at: start, end_at: end, staff_time_scope: 'phase' }] } } };
}
const primaryTreatment = () => ({ id_tratamiento: 688, clinica_id: 66, nombre_tratamiento: 'PRP', activo: true,
  precio_base: '120.00', clinical_config: { catalog_status: 'active', source_reference: 'service:2798745' } });
function fixture({ failEvent = false, failParentUpdate = false, corruptUpdate = false, dependency = null,
  deniedFeature = null, missingAnchor = false, badOccupancy = false } = {}) {
  let state = new Map([[101, appointment(101, 'component')], [102, appointment(102, 'parent')]]);
  const events = [], calls = [], permissionCalls = [], writes = [];
  const inSymbol = Symbol('in');
  const storedOccupancy = id => occupancyForSolution({ start_at: state.get(id).inicio, end_at: state.get(id).fin,
    phases: state.get(id).import_metadata.booking.phases }, new Map([[79, 'installation:80'], [75, 'installation:75']]));
  const occupancy = new Map([101, 102].map(id => [id, storedOccupancy(id)]));
  if (badOccupancy) occupancy.get(101)[0].end_at = '2030-01-07T10:16:00.000Z';
  const model = (id, tx) => {
    const row = tx ? tx.rows.get(Number(id)) : state.get(Number(id));
    if (!row) return null;
    const instance = { ...clone(row), toJSON: () => clone(row), setDataValue(key, value) { this[key] = value; },
      async update(values, options) {
        assert.equal(options.transaction, tx); assert.equal(options.hooks, false);
        assert.deepEqual(options.fields, ['updated_by', 'import_metadata', 'updated_at']);
        if (id === 102 && failParentUpdate) throw Error('parent_write_failed');
        writes.push({ id, keys: Object.keys(values) });
        Object.assign(row, clone(values), { updated_at: '2026-10-05T00:35:00.000Z' });
        if (corruptUpdate) row.nota = 'unexpected_change';
        Object.assign(instance, clone(row)); return instance;
      } };
    return instance;
  };
  const db = { Sequelize: { Op: { in: inSymbol } }, sequelize: { async transaction(options, callback) {
    const tx = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, rows: clone(state), events: [] };
    const result = await callback(tx); state = tx.rows; events.push(...tx.events); return result;
  } }, CitaPaciente: { async findByPk(id, options) { calls.push({ table: 'appointments', id: Number(id), ...options }); return model(Number(id), options?.transaction); },
    async findAll(query) { calls.push({ table: 'appointment_bulk', query });
      return query.where.id_cita[inSymbol].filter(id => state.has(id)).map(id => model(id)); } },
    Tratamiento: { async findByPk(id, options) { calls.push({ table: 'treatment', id, ...options }); return Number(id) === 688 ? primaryTreatment() : null; },
      async findAll(query) { calls.push({ table: 'treatment_bulk', query }); return [primaryTreatment()]; } },
    Clinica: { async findByPk(id, options) { calls.push({ table: 'clinic', id, ...options }); return id === 66 ? { id: 66 } : null; } },
    AppointmentBookingOccupancy: { async findAll({ where, ...options }) { calls.push({ table: 'occupancy', id: where.appointment_id, ...options }); return clone(occupancy.get(where.appointment_id)); } },
    AppointmentBookingResource: { async findByPk(key, options) { calls.push({ table: 'anchor', key, ...options });
      return missingAnchor ? null : { resource_key: key, resource_kind: key.split(':')[0] }; } },
    PatientOperationalEvent: { async create(value, { transaction }) { if (failEvent) throw Error('audit_failed');
      const event = { ...clone(value), id: '9007199254740993' }; transaction.events.push(event); return event; },
      async findByPk(id, { transaction } = {}) { return [...events, ...(transaction?.events || [])].find(event => String(event.id) === String(id)) || null; },
      async findAll(query) { calls.push({ table: 'event_bulk', query }); return events.filter(event => query.where.id[inSymbol].includes(String(event.id))); } } };
  for (const [name, field] of service.DEPENDENCIES) db[name] = { async findOne({ where, transaction, lock }) {
    assert(transaction); assert.equal(lock, 'SHARE'); assert.equal(Object.keys(where)[0], field);
    calls.push({ table: name, id: where[field] }); return name === dependency ? { id: 1 } : null;
  } };
  const request = () => ({ parent_appointment_id: 102, expected_version: c.reviewVersion(state.get(101)),
    expected_parent_version: c.reviewVersion(state.get(102)), reason: 'Revisión explícita de ambas reservas fuente PRP', confirm_source_roles: true,
    source_acknowledgements: { component: c.sourceAcknowledgement(state.get(101)), parent: c.sourceAcknowledgement(state.get(102)) } });
  const canAccessFeature = async value => { permissionCalls.push(value); return value.featureKey !== deniedFeature; };
  const resolveKeys = async ({ transaction, installationIds }) => { assert(transaction); assert(installationIds.length === 1);
    return { keys: new Map([[79, 'installation:80'], [75, 'installation:75']]) }; };
  return { db, events, calls, permissionCalls, writes, occupancy, request, get rows() { return state; },
    change(id, callback) { callback(state.get(id)); },
    context() { return c.componentContext({ component: state.get(101), parent: state.get(102), treatment: primaryTreatment(), auditEvent: events[0] }); },
    run(input = request(), overrides = {}) { return service.linkExistingComponent({ db, appointmentId: 101, clinicId: 66, actorId: 7,
      input, canAccessFeature, resolveKeys, ...overrides }); } };
}

test('strict contract requires both CAS, acknowledgements, clinical reason and explicit role confirmation', () => {
  const f = fixture(), input = f.request(); assert.deepEqual(c.normalizeLink(input), input);
  for (const patch of [{ parent_appointment_id: '102' }, { expected_version: null }, { expected_parent_version: null },
    { reason: 'short' }, { confirm_source_roles: false }, { force: true }, { role: 'other' }, { price: 0 },
    { program_session: {} }, { source_acknowledgements: { component: input.source_acknowledgements.component } }]) {
    assert.throws(() => c.normalizeLink({ ...input, ...patch }), { code: 'appointment_clinical_component_invalid', status: 400 });
  }
  assert.throws(() => c.normalizeLink({ ...input, source_acknowledgements: { ...input.source_acknowledgements,
    component: { ...input.source_acknowledgements.component, source_appointment_id: 1101 } } }), { code: 'appointment_clinical_component_invalid' });
});
test('permissions and invalid actor/tenant checks precede DB reads and writes', async () => {
  for (const deniedFeature of ['appointments.manage', 'patients.sensitive.view']) {
    const f = fixture({ deniedFeature }); await assert.rejects(f.run(), { code: 'appointment_clinical_component_forbidden', status: 403 });
    assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.events.length, 0);
  }
  for (const overrides of [{ actorId: 0 }, { clinicId: '66' }, { appointmentId: 102 }]) {
    const f = fixture(); await assert.rejects(f.run(f.request(), overrides), { code: 'appointment_clinical_component_invalid' }); assert.equal(f.calls.length, 0);
  }
});
test('successful relation preserves whole appointments, booking, source positive prices and occupancy; one audit only', async () => {
  const f = fixture(), before = clone(f.rows), occupancy = clone(f.occupancy); const result = await f.run();
  assert.equal(result.replayed, false); assert.equal(result.relation.status, 'linked'); assert.equal(result.relation.ready_for_care, false);
  assert.equal(result.relation.requires_primary_clinical_consent, true); assert.equal(result.relation.consent_scope_appointment_id, 102);
  assert.equal(c.isValidatedClinicalComponentContext(result.relation, f.rows.get(101)), true);
  for (const id of [101, 102]) assert.equal(service.unchangedAppointment(before.get(id), f.rows.get(id)), true);
  assert.equal(f.rows.get(101).tratamiento_id, null); assert.equal(f.rows.get(101).import_metadata.cliniccloud_delta.source.price, '120.00');
  assert.deepEqual(f.occupancy, occupancy); assert.equal(f.events.length, 1); assert.equal(f.events[0].event_type, c.EVENT_TYPE);
  assert.equal(f.events[0].metadata.no_booking_or_economic_effect, true);
  assert.deepEqual(f.writes.map(item => item.keys), [['updated_by', 'import_metadata'], ['updated_by', 'import_metadata']]);
  const ids = f.calls.filter(call => call.table === 'appointments').map(call => call.id); assert.deepEqual(ids, [101, 102]);
  const anchors = f.calls.filter(call => call.table === 'anchor'); assert.deepEqual(anchors.map(item => item.key),
    ['doctor:50', 'doctor:53', 'installation:75', 'installation:80', 'patient:8']);
  assert(anchors.every(item => item.lock === 'UPDATE')); assert(f.calls.filter(call => call.table === 'occupancy').every(item => item.lock === 'SHARE'));
});
test('idempotent retry validates reciprocal audit without writing or consuming reservation again, including arrival', async () => {
  const f = fixture(), input = f.request(); await f.run(input); const written = f.writes.length;
  f.change(101, row => { row.arrived_at = '2030-01-07T10:00:00.000Z'; row.care_started_at = '2030-01-07T10:02:00.000Z'; });
  assert.equal((await f.run(input)).replayed, true); assert.equal(f.events.length, 1); assert.equal(f.writes.length, written);
  await assert.rejects(f.run({ ...input, reason: 'Otra revisión explícita de las mismas reservas' }), { code: 'appointment_clinical_component_already_linked' });
});
test('both appointment CAS and clinic scoping fail closed', async () => {
  for (const id of [101, 102]) {
    const f = fixture(), input = f.request(); f.change(id, row => { row.nota = 'Concurrent review'; });
    await assert.rejects(f.run(input), { code: 'appointment_clinical_component_changed' }); assert.equal(f.events.length, 0);
  }
  const f = fixture(); await assert.rejects(f.run(f.request(), { clinicId: 72 }), { code: 'appointment_clinical_component_not_found' });
});
test('link eligibility rejects progressed, closed, economic, lead, program, additional staff and classified components', async () => {
  const mutations = [r => { r.estado = 'completada'; }, r => { r.estado = 'cancelada'; }, r => { r.estado = 'no_asistio'; },
    r => { r.estado = 'reprogramada'; }, r => { r.arrived_at = '2030-01-07T10:00:00Z'; }, r => { r.care_started_at = '2030-01-07T10:00:00Z'; },
    r => { r.care_schedule_start = '2030-01-07T10:00:00Z'; }, r => { r.voucher_id = 1; }, r => { r.lead_intake_id = 1; },
    r => { r.es_provisional = true; }, r => { r.hold_expires_at = '2030-01-07'; }, r => { r.import_metadata.program_session = {}; },
    r => { r.import_metadata.additional_staff = {}; }, r => { r.tratamiento_id = 688; }, r => { r.import_metadata.import_treatment_resolution = {}; }];
  for (const mutate of mutations) {
    const f = fixture(); f.change(101, mutate); await assert.rejects(f.run(), { code: 'appointment_clinical_component_roles_unproven' }); assert.equal(f.events.length, 0);
  }
});
test('scope/roles source identity and exact reservations are mandatory, with no generic full-PRP substitution', () => {
  const child = appointment(101, 'component'), parent = appointment(102, 'parent');
  for (const mutate of [r => { r.paciente_id = 9; }, r => { r.clinica_id = 72; }, r => { r.doctor_id = 50; },
    r => { r.instalacion_id = 75; }, r => { r.import_metadata.booking.phases[0].equipment = [{ id: 5 }]; },
    r => { r.import_metadata.booking.phases[0].staff_intervals = []; }, r => { r.import_metadata.booking.phases[0].staff_time_scope = 'appointment'; },
    r => { r.import_metadata.booking.profile.phases.push(clone(r.import_metadata.booking.profile.phases[0])); }]) {
    const value = clone(child); mutate(value); assert.throws(() => c.assertPairRoles(value, parent, primaryTreatment()), { code: 'appointment_clinical_component_roles_unproven' });
  }
  for (const patch of [{ activo: false }, { clinica_id: 72 }, { id_tratamiento: 2000 }, { clinical_config: { source_reference: 'generic' } }])
    assert.throws(() => c.assertPairRoles(child, parent, { ...primaryTreatment(), ...patch }), { code: 'appointment_clinical_component_parent_role_unproven' });
  const compound = clone(parent); compound.tratamiento_id = null;
  assert.throws(() => c.assertPairRoles(child, compound, primaryTreatment()), { code: 'appointment_clinical_component_roles_unproven' });
});
test('missing or modified source receipt/HOLD/ack is not replaced by a user assertion', async () => {
  for (const mutate of [r => { r.source_system = 'native'; }, r => { delete r.import_metadata.cliniccloud_source_booking; },
    r => { r.import_metadata.cliniccloud_source_booking.receipt_sha256 = 'a'.repeat(64); },
    r => { r.import_metadata.cliniccloud_reconciliation.automation_policy = 'allow'; }, r => { r.fin = '2030-01-07T10:16:00Z'; }]) {
    const value = appointment(101, 'component'); mutate(value); assert.throws(() => c.sourceAcknowledgement(value), { code: 'appointment_clinical_component_source_unproven' });
  }
  const f = fixture(), input = f.request(); input.source_acknowledgements.component.source_booking_receipt_sha256 = 'a'.repeat(64);
  await assert.rejects(f.run(input), { code: 'appointment_clinical_component_source_changed' }); assert.equal(f.events.length, 0);
});
test('contact/day/order/source ID mismatches cannot be paired; source overlap is retained rather than corrected', () => {
  const child = appointment(101, 'component'), parent = appointment(102, 'parent');
  for (const mutate of [r => { r.import_metadata.source_contact_id = '900'; r.import_metadata.cliniccloud_source_booking.source_contact_id = '900'; },
    r => { r.import_metadata.source_appointment_id = '1101'; r.import_metadata.cliniccloud_source_booking.source_appointment_id = '1101'; },
    r => { r.inicio = '2030-01-08T10:15:00.000Z'; r.fin = '2030-01-08T10:45:00.000Z'; },
    r => { r.inicio = '2030-01-07T09:45:00.000Z'; r.fin = '2030-01-07T10:15:00.000Z'; },
    r => { r.inicio = '2030-01-07T11:15:00.000Z'; r.fin = '2030-01-07T11:45:00.000Z'; }]) {
    const value = clone(parent); mutate(value);
    value.import_metadata.booking.phases[0].start_at = value.inicio; value.import_metadata.booking.phases[0].end_at = value.fin;
    const receipt = value.import_metadata.cliniccloud_source_booking; receipt.preserved_start_at = value.inicio; receipt.preserved_end_at = value.fin;
    delete receipt.receipt_sha256; receipt.receipt_sha256 = hash(receipt);
    assert.throws(() => c.assertPairRoles(child, value, primaryTreatment()), { code: 'appointment_clinical_component_source_pair_mismatch' });
  }
  const overlapping = clone(child); overlapping.fin = '2030-01-07T10:30:00.000Z';
  overlapping.import_metadata.booking.profile.phases[0].duration_minutes = 30;
  overlapping.import_metadata.booking.phases[0].end_at = overlapping.fin;
  const receipt = overlapping.import_metadata.cliniccloud_source_booking; receipt.preserved_end_at = overlapping.fin;
  delete receipt.receipt_sha256; receipt.receipt_sha256 = hash(receipt);
  assert.doesNotThrow(() => c.assertPairRoles(overlapping, parent, primaryTreatment()));
});
test('existing clinical, nutritional, consent, financial or purchased history blocks reinterpretation', async () => {
  for (const [dependency] of service.DEPENDENCIES) {
    const f = fixture({ dependency }); await assert.rejects(f.run(), { code: 'appointment_clinical_component_history_exists' }); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); delete f.db.PatientConsentDocument;
  await assert.rejects(f.run(), { code: 'appointment_clinical_component_history_guard_unavailable' }); assert.equal(f.events.length, 0);
});
test('occupancy and existing resource anchors are verified without creating or changing them', async () => {
  for (const [options, suffix] of [[{ badOccupancy: true }, 'occupancy_unproven'], [{ missingAnchor: true }, 'resource_unproven']]) {
    const f = fixture(options); await assert.rejects(f.run(), { code: 'appointment_clinical_component_' + suffix }); assert.equal(f.events.length, 0); assert.equal(f.writes.length, 0);
  }
});
test('event/second-row failures or unintended field changes roll back both appointments and audit', async () => {
  for (const options of [{ failEvent: true }, { failParentUpdate: true }, { corruptUpdate: true }]) {
    const f = fixture(options), before = clone(f.rows); await assert.rejects(f.run()); assert.deepEqual(f.rows, before); assert.equal(f.events.length, 0);
  }
});
test('a caller-provided noncanonical transaction is rejected before row reads', async () => {
  const f = fixture(); await assert.rejects(f.run(f.request(), { transaction: { options: { isolationLevel: 'REPEATABLE READ' } } }), { code: 'appointment_clinical_component_transaction_invalid' });
  assert.equal(f.calls.length, 0);
});
test('partial, missing, malformed or different reciprocal relation never suppresses review', async () => {
  const f = fixture(); await f.run(); const receipt = clone(f.rows.get(101).import_metadata[c.PARENT_KEY]);
  for (const children of [undefined, [], [{}], [receipt, receipt], [{ ...receipt, parent_appointment_id: 999 }]]) {
    const parent = clone(f.rows.get(102)); parent.import_metadata[c.CHILDREN_KEY] = children;
    assert.equal(c.componentContext({ component: f.rows.get(101), parent, treatment: primaryTreatment(), auditEvent: f.events[0] }).status, 'needs_review');
  }
  assert.equal(c.componentContext({ component: f.rows.get(101), parent: f.rows.get(102), treatment: primaryTreatment(), auditEvent: null }).status, 'needs_review');
  const row = clone(f.rows.get(101)); row.import_metadata[c.PARENT_KEY].reason = 'Changed sealed reason';
  assert.equal(c.componentContext({ component: row, parent: f.rows.get(102), treatment: primaryTreatment(), auditEvent: f.events[0] }).status, 'needs_review');
});
test('audit ID/type/patient/clinic/actor/source and base receipt must all match', async () => {
  const f = fixture(); await f.run();
  for (const mutate of [e => { e.id = '1'; }, e => { e.event_type = 'appointment.import_resolved'; }, e => { e.patient_id = 9; },
    e => { e.clinic_id = 72; }, e => { e.actor_user_id = 8; }, e => { e.source = 'fixture'; },
    e => { e.metadata.base_receipt_sha256 = 'a'.repeat(64); }, e => { e.metadata.component_appointment_id = 999; }]) {
    const event = clone(f.events[0]); mutate(event);
    assert.equal(c.componentContext({ component: f.rows.get(101), parent: f.rows.get(102), treatment: primaryTreatment(), auditEvent: event }).status, 'needs_review');
  }
});
test('arrival, care-start and completion do not destroy a valid planned relationship or grant care approval', async () => {
  const f = fixture(); await f.run();
  for (const id of [101, 102]) f.change(id, row => { row.arrived_at = '2030-01-07T10:00:00Z'; row.care_started_at = '2030-01-07T10:01:00Z';
    row.care_schedule_start = '2030-01-07T10:02:00Z'; row.estado = 'completada'; row.updated_at = '2030-01-07T11:00:00Z'; });
  const context = f.context(); assert.equal(context.status, 'linked'); assert.equal(context.ready_for_care, false); assert.equal(context.administration_inferred, false);
  assert.equal(c.isValidatedClinicalComponentContext(context, f.rows.get(101)), true);
  for (const estado of ['cancelada', 'no_asistio', 'reprogramada']) {
    const row = clone(f.rows.get(101)); row.estado = estado;
    assert.equal(c.componentContext({ component: row, parent: f.rows.get(102), treatment: primaryTreatment(), auditEvent: f.events[0] }).status, 'needs_review');
  }
});
test('changed source, clock, note, staff, room, treatment, phases or source price invalidates a relationship', async () => {
  const f = fixture(); await f.run();
  const mutations = [r => { r.inicio = '2030-01-07T10:01:00Z'; }, r => { r.nota = 'Changed'; }, r => { r.doctor_id = 50; },
    r => { r.instalacion_id = 75; }, r => { r.tratamiento_id = 688; }, r => { r.source_reference = 'other'; },
    r => { r.import_metadata.booking.phases[0].doctor_ids = [50]; }, r => { r.import_metadata.cliniccloud_delta.source.price = '0.00'; }];
  for (const mutate of mutations) {
    const row = clone(f.rows.get(101)); mutate(row);
    assert.equal(c.componentContext({ component: row, parent: f.rows.get(102), treatment: primaryTreatment(), auditEvent: f.events[0] }).status, 'needs_review');
  }
  const parent = clone(f.rows.get(102)); parent.nota = 'Changed';
  assert.equal(c.componentContext({ component: f.rows.get(101), parent, treatment: primaryTreatment(), auditEvent: f.events[0] }).status, 'needs_review');
});
test('JSON/DTO forgery, cloning, wrong row and removed marker cannot be treated as validated server proof', async () => {
  const f = fixture(); await f.run(); const context = f.context();
  assert.equal(c.isValidatedClinicalComponentContext(context), true);
  assert.equal(c.isValidatedClinicalComponentContext(clone(context)), false);
  assert.equal(c.isValidatedClinicalComponentContext({ status: 'linked', role: c.ROLE }), false);
  assert.equal(c.isValidatedClinicalComponentContext(context, f.rows.get(102)), false);
  const row = clone(f.rows.get(101)); delete row.import_metadata[c.PARENT_KEY];
  assert.equal(c.isValidatedClinicalComponentContext(context, row), false); assert(Object.isFrozen(context));
});
test('partial marker cannot be overwritten and even an empty parent relation is fail-closed', async () => {
  for (const [id, key, value] of [[101, c.PARENT_KEY, {}], [101, c.CHILDREN_KEY, []], [102, c.PARENT_KEY, {}], [102, c.CHILDREN_KEY, []]]) {
    const f = fixture(); f.change(id, row => { row.import_metadata[key] = value; });
    await assert.rejects(f.run(), { code: 'appointment_clinical_component_' + (id === 101 && key === c.PARENT_KEY ? 'already_linked' : 'relation_exists') });
    assert.equal(f.events.length, 0);
  }
});
test('bulk DTO enrichment is bounded, read-only, scoped and has three reads rather than N+1', async () => {
  const f = fixture(); await f.run(); f.calls.length = 0; const rows = [clone(f.rows.get(101)), clone(f.rows.get(102))];
  const events = f.events.length, writes = f.writes.length;
  assert.equal(await service.loadClinicalComponentContexts({ db: f.db, appointments: rows }), rows);
  assert.equal(rows[0].clinical_component_context.status, 'linked'); assert.equal(rows[1].clinical_component_context, null);
  assert.equal(c.isValidatedClinicalComponentContext(rows[0].clinical_component_context, rows[0]), true);
  assert.equal(f.calls.length, 3); assert.equal(f.events.length, events); assert.equal(f.writes.length, writes);
  assert.deepEqual(f.calls[0].query.where.clinica_id[f.db.Sequelize.Op.in], [66]);
  assert.deepEqual(f.calls[0].query.where.paciente_id[f.db.Sequelize.Op.in], [8]);
  await assert.rejects(service.loadClinicalComponentContexts({ db: f.db, appointments: Array(1001).fill(rows[0]) }), { code: 'appointment_clinical_component_read_scope_exceeded' });
});
test('care parent lookup re-reads reciprocal records with shared locks and never interprets context as consent', async () => {
  const f = fixture(); assert.equal(await service.getValidatedClinicalComponentParent({ db: f.db, appointment: f.rows.get(101) }), null);
  await f.run(); await assert.rejects(service.getValidatedClinicalComponentParent({ db: f.db, appointment: f.rows.get(101) }), { code: 'appointment_clinical_component_transaction_required' });
  f.calls.length = 0;
  const result = await f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => service.getValidatedClinicalComponentParent({ db: f.db, appointment: f.rows.get(101), transaction }));
  assert.equal(result.parent.id_cita, 102); assert.equal(result.context.status, 'linked'); assert.equal(result.context.ready_for_care, false);
  assert(f.calls.every(call => call.lock === 'SHARE')); assert.equal(f.events.length, 1);
  f.change(102, row => { delete row.import_metadata[c.CHILDREN_KEY]; });
  await assert.rejects(f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => service.getValidatedClinicalComponentParent({ db: f.db,
    appointment: f.rows.get(101), transaction })), { code: 'appointment_clinical_component_relation_unproven' });
});
