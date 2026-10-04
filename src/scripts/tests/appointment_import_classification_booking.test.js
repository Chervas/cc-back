'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { resolveImportedTreatment } = require('../../services/appointmentImportResolution.service');
const { classifyImportedAppointment } = require('../../services/appointmentBookingCommand.service');
const { importReviewVersion } = require('../../lib/appointment-import-review');
const { occupancyForSolution } = require('../../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../../lib/booking-profile');

const start = '2030-01-07T09:00:00.000Z', middle = '2030-01-07T09:15:00.000Z', end = '2030-01-07T09:30:00.000Z';
const capabilities = { simple: true, multi: true, equipment: true };
const attention = { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 };

function original() {
  const profile = normalizeBookingProfile({ version: 3, phases: [
    { key: 'machine', duration_minutes: 15, installation_ids: [9], professionals: { mode: 'any', ids: [5] },
      equipment_requirements: [{ equipment_ids: [12] }], staff_attention: [attention] },
    { key: 'manual', duration_minutes: 15, installation_ids: [10], professionals: { mode: 'all', ids: [5, 6] } },
  ] });
  const phases = [
    { key: 'machine', start_at: start, end_at: middle, installation_id: 9, doctor_ids: [5], staff_time_scope: 'phase',
      equipment: [{ id: 12, name: 'Equipo real conservado', turnaround_minutes: 5 }], staff_attention: [attention],
      staff_intervals: [{ kind: 'start', start_at: start, end_at: '2030-01-07T09:05:00.000Z' },
        { kind: 'end', start_at: '2030-01-07T09:10:00.000Z', end_at: middle }] },
    { key: 'manual', start_at: middle, end_at: end, installation_id: 10, doctor_ids: [5, 6], staff_time_scope: 'appointment' },
  ];
  return { id_cita: 51, clinica_id: 72, paciente_id: 8, doctor_id: 5, instalacion_id: 9, tratamiento_id: null,
    tipo_cita: 'continuacion', inicio: start, fin: end, estado: 'recordatorio_confirmado',
    updated_at: '2026-10-04T10:00:00.000Z', source_system: 'cliniccloud', source_reference: 'appointment:fixture-51',
    nota: 'Original: máquina y después consulta', titulo: 'Servicio de origen', import_metadata: {
      cliniccloud_delta: { pending_assignment: ['treatment_id'], source: { service_key: 'Original' } },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_reconciliation: { automation_policy: 'hold' }, booking: { version: 1, profile, phases,
        priority_acknowledged: true, warnings: [{ code: 'SOURCE_OVERLAP' }] } } };
}

function fixture({ treatmentProfile = null, treatmentPatch = {}, failEvent = false, extraSupport = false } = {}) {
  const appointment = original();
  const occupancy = occupancyForSolution({ start_at: start, end_at: end, phases: appointment.import_metadata.booking.phases });
  if (extraSupport) {
    appointment.import_metadata.additional_staff = { version: 1, ids: [6], names: ['Apoyo'], start_at: start, end_at: end };
    for (let index = occupancy.length - 1; index >= 0; index--) if (occupancy[index].doctor_id === 6) occupancy.splice(index, 1);
    occupancy.push({ phase_key: 'additional_staff', resource_kind: 'doctor', resource_key: 'doctor:6', doctor_id: 6,
      installation_id: null, start_at: start, end_at: end });
  }
  const state = { row: appointment, occupancy: occupancy.map((row, index) => ({ ...row, id: 700 + index, appointment_id: 51 })),
    locks: [], events: [], commits: 0, rollbacks: 0, occupancyWrites: 0, treatmentLocks: 0, persisted: 0 };
  const treatment = { id_tratamiento: 3, origen: 'clinica', clinica_id: 72, activo: true,
    duracion_min: 90, clinical_config: treatmentProfile ? { booking_profile: treatmentProfile } : {}, ...treatmentPatch };
  const db = {
    Sequelize: { Op: { in: Symbol('in'), or: Symbol('or') } },
    sequelize: { transaction: async (options, callback) => {
      const tx = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, row: structuredClone(state.row),
        occupancy: structuredClone(state.occupancy), events: [] };
      try {
        const result = await callback(tx); state.row = tx.row; state.occupancy = tx.occupancy;
        state.events.push(...tx.events); state.commits++; return result;
      } catch (error) { state.rollbacks++; throw error; }
    } },
    CitaPaciente: { findByPk: async (id, { transaction: tx, lock }) => {
      assert.equal(id, 51); assert.equal(lock, 'UPDATE');
      return { ...structuredClone(tx.row), toJSON: () => structuredClone(tx.row), update: async (values, options) => {
        assert.equal(options.transaction, tx); state.persisted++; tx.row = { ...tx.row, ...structuredClone(values) };
        return { ...tx.row }; } };
    } },
    Clinica: { findByPk: async (id, options) => {
      assert.equal(options.lock, 'SHARE'); assert.equal(Number(id), 72); return { id_clinica: 72, grupoClinicaId: 2 }; } },
    Tratamiento: { findByPk: async (id, options) => {
      assert.equal(id, 3); assert(options.transaction); if (options.lock === 'SHARE') state.treatmentLocks++; return treatment; } },
    InstallationPhysicalAlias: { findAll: async () => [] },
    AppointmentBookingOccupancy: { findAll: async ({ where, transaction: tx, lock }) => {
      assert.equal(where.appointment_id, 51); assert.equal(lock, 'SHARE'); return tx.occupancy;
    }, destroy: async () => { state.occupancyWrites++; throw Error('Classification must not remove occupancy'); },
    bulkCreate: async () => { state.occupancyWrites++; throw Error('Classification must not recreate occupancy'); } },
    AppointmentBookingResource: { upsert: async (row, options) => { assert(options.transaction); state.locks.push(row.resource_key); },
      findByPk: async (_key, options) => { assert.equal(options.lock, 'UPDATE'); return {}; } },
    PatientOperationalEvent: { create: async (event, { transaction: tx }) => {
      if (failEvent) throw Error('Audit unavailable'); tx.events.push(event); } },
  };
  for (const name of ['AppointmentClinicalReport', 'PatientNutritionMeasurement', 'PatientNutritionReport',
    'PatientConsentDocument', 'PatientVoucherMovement', 'PatientProgramSession']) db[name] = { findOne: async () => null };
  const request = () => ({ mode: 'treatment', treatment_id: 3, reason: 'Correspondencia exacta contrastada',
    expected_version: importReviewVersion(state.row) });
  const run = (input = request(), overrides = {}) => resolveImportedTreatment({ db, appointmentId: 51,
    clinicId: 72, actorId: 7, input, capabilities, ...overrides });
  return { db, state, request, run, treatment };
}

test('classification keeps original multi-room, machine, partial attention, team and canonical occupancy IDs', async () => {
  for (const extraSupport of [false, true]) {
    const f = fixture({ extraSupport }), before = structuredClone(f.state);
    await f.run({ ...f.request(), force: true, priority_acknowledged: true,
      inicio: '2099-01-01', estado: 'completada', booking: { profile: {} }, preserveImportReservation: true });
    assert.equal(f.state.row.tratamiento_id, 3);
    for (const key of Object.keys(before.row).filter(key => !['tratamiento_id', 'updated_by', 'import_metadata'].includes(key))) {
      assert.deepEqual(f.state.row[key], before.row[key]);
    }
    for (const key of Object.keys(before.row.import_metadata)) assert.deepEqual(f.state.row.import_metadata[key], before.row.import_metadata[key]);
    assert.deepEqual(f.state.occupancy, before.occupancy); assert.equal(f.state.occupancyWrites, 0);
    assert.equal(f.state.events.length, 1); assert.equal(f.state.events[0].event_type, 'appointment.import_resolved');
    assert.equal(f.state.treatmentLocks, 1);
    assert.deepEqual(f.state.locks, [...new Set([...before.occupancy.map(row => row.resource_key), 'patient:8'])].sort());
    const retry = await f.run(before.row.import_metadata.import_treatment_resolution ? {} : {
      mode: 'treatment', treatment_id: 3, reason: 'Correspondencia exacta contrastada', expected_version: importReviewVersion(before.row) });
    assert.equal(retry.replayed, true); assert.equal(f.state.events.length, 1);
  }
});

test('no-treatment review also preserves the reservation instead of removing its partial-attention equipment', async () => {
  const f = fixture(), before = structuredClone(f.state);
  await f.run({ mode: 'no_treatment', visit_type: 'revision', reason: 'Visita de revisión sin acto añadido',
    expected_version: importReviewVersion(f.state.row) });
  assert.equal(f.state.row.tratamiento_id, null); assert.equal(f.state.row.tipo_cita, 'revision');
  assert.deepEqual(f.state.row.import_metadata.booking, before.row.import_metadata.booking);
  assert.deepEqual(f.state.occupancy, before.occupancy); assert.equal(f.state.occupancyWrites, 0);
});

test('compatible configured treatment classifies without changing phase keys or labels', async () => {
  const profile = structuredClone(original().import_metadata.booking.profile);
  profile.phases.forEach((phase, index) => { phase.key = `catalog_${index}`; phase.label = 'New catalogue label'; });
  const f = fixture({ treatmentProfile: profile }), before = structuredClone(f.state.occupancy);
  await f.run(); assert.deepEqual(f.state.occupancy, before);
  assert.equal(f.state.row.import_metadata.booking.phases[0].key, 'machine');
});

test('new clinical profile cannot silently change phase count, room, team, unit or explicit attention', async () => {
  const base = original().import_metadata.booking.profile;
  for (const change of [profile => { profile.phases.pop(); },
    profile => { profile.phases[0].installation_ids = [11]; },
    profile => { profile.phases[1].professionals.ids = [5, 7]; },
    profile => { profile.phases[0].equipment_requirements = [{ equipment_ids: [13] }]; },
    profile => { profile.phases[0].staff_attention = [{ mode: 'continuous', patient_preparation_minutes: 0 }]; }]) {
    const profile = structuredClone(base); change(profile);
    const f = fixture({ treatmentProfile: profile }), before = structuredClone(f.state);
    await assert.rejects(f.run(), { code: 'booking_import_profile_mismatch' });
    assert.deepEqual(f.state.row, before.row); assert.deepEqual(f.state.occupancy, before.occupancy);
    assert.equal(f.state.persisted, 0); assert.equal(f.state.events.length, 0);
  }
});

test('catalogue duration and inherited attention cannot rewrite the actual source interval or staff windows', async () => {
  const profile = structuredClone(original().import_metadata.booking.profile);
  profile.phases.forEach(phase => { phase.duration_minutes = 45; delete phase.staff_attention; });
  const f = fixture({ treatmentProfile: profile }), before = structuredClone(f.state);
  await f.run();
  assert.equal(f.state.row.inicio, start); assert.equal(f.state.row.fin, end);
  assert.deepEqual(f.state.row.import_metadata.booking, before.row.import_metadata.booking);
  assert.deepEqual(f.state.occupancy, before.occupancy); assert.equal(f.state.occupancyWrites, 0);
});

test('stored JSON key order does not invalidate the original normalized staff-attention policy', async () => {
  const f = fixture();
  const reordered = { mode: 'start_end', end_minutes: 5, start_minutes: 5, end_window_minutes: 10, start_window_minutes: 10 };
  f.state.row.import_metadata.booking.profile.phases[0].staff_attention = [reordered];
  f.state.row.import_metadata.booking.phases[0].staff_attention = [reordered];
  const before = structuredClone(f.state);
  await f.run(); assert.deepEqual(f.state.occupancy, before.occupancy);
  assert.deepEqual(f.state.row.import_metadata.booking, before.row.import_metadata.booking);
});

test('inactive, draft, obsolete, foreign or unsupported profile treatments cannot use classification', async () => {
  for (const treatmentPatch of [{ activo: false }, { activo: 0 }, { clinica_id: 73 },
    { clinical_config: { catalog_status: 'draft' } }, { clinical_config: { catalog_status: 'obsolete' } }]) {
    const f = fixture({ treatmentPatch }), before = structuredClone(f.state.row);
    await assert.rejects(f.run()); assert.deepEqual(f.state.row, before); assert.equal(f.state.persisted, 0);
  }
  const f = fixture(); await assert.rejects(f.run(f.request(), { capabilities: { simple: true, multi: false } }),
    { code: 'booking_profile_runtime_unavailable' }); assert.equal(f.state.persisted, 0);
});

test('classification cannot conceal missing machine occupancy, invalid staff intervals or mismatched source boundaries', async () => {
  for (const change of [f => { f.state.occupancy = f.state.occupancy.filter(row => row.resource_kind !== 'equipment'); },
    f => { f.state.row.import_metadata.booking.phases[0].equipment[0].turnaround_minutes = 10; },
    f => { f.state.row.import_metadata.booking.phases[0].staff_intervals[0].end_at = middle; },
    f => { f.state.row.import_metadata.booking.phases[0].start_at = middle; },
    f => { f.state.row.import_metadata.booking.phases[1].doctor_ids = [5]; },
    f => { delete f.state.row.import_metadata.booking; }, f => { f.state.occupancy = []; }]) {
    const f = fixture(); change(f); const before = structuredClone(f.state);
    await assert.rejects(f.run(), { code: 'booking_import_reservation_invalid' });
    assert.deepEqual(f.state.row, before.row); assert.deepEqual(f.state.occupancy, before.occupancy);
    assert.equal(f.state.persisted, 0); assert.equal(f.state.occupancyWrites, 0);
  }
});

test('stale source CAS and existing documentary history still block classification', async () => {
  const f = fixture(), input = f.request(); f.state.row.nota = 'Concurrent edit';
  await assert.rejects(f.run(input), { code: 'booking_import_changed' }); assert.equal(f.state.persisted, 0);
  f.db.PatientConsentDocument.findOne = async () => ({ id: 1 });
  await assert.rejects(f.run(), { code: 'booking_import_history_exists' }); assert.equal(f.state.persisted, 0);
});

test('event failure rolls back the classification without touching canonical occupancy', async () => {
  const f = fixture({ failEvent: true }), before = structuredClone(f.state);
  await assert.rejects(f.run(), /Audit unavailable/);
  assert.deepEqual(f.state.row, before.row); assert.deepEqual(f.state.occupancy, before.occupancy);
  assert.equal(f.state.events.length, 0); assert.equal(f.state.occupancyWrites, 0); assert.equal(f.state.commits, 0);
});

test('classification command requires a transaction, strict choice, CAS and cannot piggyback force or a reschedule', async () => {
  const f = fixture();
  for (const patch of [{ force: true }, { appointmentValues: { updated_by: 7, tratamiento_id: 3, inicio: middle } },
    { expectedVersion: 'bad' }, { appointmentValues: { updated_by: 7, tratamiento_id: 3, tipo_cita: 'revision' } }]) {
    await assert.rejects(f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction =>
      classifyImportedAppointment({ db: f.db, existingAppointmentId: 51, transaction, capabilities,
        appointmentValues: { updated_by: 7, tratamiento_id: 3 }, expectedVersion: importReviewVersion(f.state.row),
        persist: () => { throw Error('Unexpected persistence'); }, ...patch })), { code: 'booking_import_invalid' });
  }
  await assert.rejects(classifyImportedAppointment({ db: f.db, existingAppointmentId: 51, capabilities,
    appointmentValues: { updated_by: 7, tratamiento_id: 3 }, expectedVersion: importReviewVersion(f.state.row) }),
  { code: 'booking_import_invalid' });
});

test('HTTP does not forward any classification-only preservation option to ordinary booking', () => {
  const controller = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
  assert.doesNotMatch(controller, /classifyImportedAppointment|preserveImportReservation|trustedImportClassification/);
});
