'use strict';

// Real SQL/search/HTTP handlers/command on the launcher's own private mysqld.
// HTTP ACL is the reused helper's declared synthetic boundary, not real auth.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 BOOKING_PATIENT_CONTEXT_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const clone = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();
const advertisedSlots = payload => {
  if (Array.isArray(payload.rows)) {
    assert(payload.rows.length > 0, 'grid must contain a calculated column');
    return payload.rows.flatMap(row => { assert.equal(row.ok, true); return advertisedSlots(row); });
  }
  if (Array.isArray(payload.slots)) return payload.slots;
  for (const key of ['slots_by_instalacion', 'slots_by_doctor']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const values = Object.values(payload[key]);
      assert(values.every(Array.isArray));
      return values.flat();
    }
  }
  assert.fail('expected a real advertised-slot collection, not diagnostics or an unknown payload');
};
test('ordinary patient context: real SQL alternatives, canonical-ID HTTP inference, scoped mismatches and exact reschedule overlap receipt',
  { skip: process.env.BOOKING_PATIENT_CONTEXT_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      try {
        const profile = f.profile(1, [f.phase('independent', { duration_minutes: 30, installation_ids: [102], professionals: { mode: 'any', ids: [2], preferred_id: 2 } })]);
        await db.Tratamiento.create({ id_tratamiento: 41, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Tratamiento ajeno ficticio', origen: 'clinica', activo: true,
          clinical_config: { catalog_status: 'active', booking_profile: profile } });
        const conflict = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 41, doctor_id: 2, instalacion_id: 102,
          inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z' }) });
        const candidate = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 4, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' }) });
        const clinic = await db.Clinica.findByPk(100), instant = '2030-01-07T09:00:00.000Z';
        const search = patientId => searchTreatmentSlots({ db, clinic, treatmentId: 4, date: '2030-01-07', limit: 200,
          patientId, capabilities: f.capabilities, now: new Date('2030-01-01') });
        assert((await search(null)).slots.some(row => row.start_at === instant));
        assert(!(await search(1)).slots.some(row => row.start_at === instant));
        assert((await search(2)).slots.some(row => row.start_at === instant));
        assert((await search(1)).slots.some(row => row.start_at === '2030-01-07T09:30:00.000Z'));
        report.checks.push('Direct search SQL passes patient1 to patientBusy: doctor1/sala101 are genuinely free while patient1 is occupied in doctor2/sala102; no-patient or patient2 generic search stays free');
        const existing = { tratamiento_id: '4', doctor_id: '1', instalacion_id: '101', duration_minutes: undefined, duracion_min: '30',
          ignore_cita_id: String(candidate.id_cita), inicio_local: '2030-01-07T10:00', from_local: '10:00', to_local: '10:30',
          dates: ['2030-01-07'], column_ids: ['1'], mode: 'doctor' };
        const response = await f.transport('check', existing);
        assert.equal(response.statusCode, 409); assert.equal(response.body.reason, 'patient_busy'); assert.equal(response.body.can_force, false);
        assert.doesNotMatch(JSON.stringify(response.body), /appointment_id|doctor_id|patient_id|paciente_id|Clínica ficticia|Profesional ficticio|09:00|09:30/);
        for (const handler of ['treatmentSlots', 'slots', 'grid', 'summary']) {
          const result = await f.transport(handler, existing); assert.equal(result.statusCode, 200);
          // Empty narrow window has no start that can fit the target30 without
          // intersecting the other patient appointment. Assert the advertised
          // slots/day result specifically; diagnostics can contain busy times.
          if (handler === 'summary') assert.equal(result.body.by_day['2030-01-07'], false);
          else if (handler === 'treatmentSlots') assert(!advertisedSlots(result.body).some(row => row.start_at === instant));
          else assert.deepEqual(advertisedSlots(result.body), []);
          const free = await f.transport(handler, { ...existing, from_local: '10:30', to_local: '11:00' });
          assert.equal(free.statusCode, 200);
          if (handler === 'summary') assert.equal(free.body.by_day['2030-01-07'], true);
          else assert(advertisedSlots(free.body).some(row => row.start_at === '2030-01-07T09:30:00.000Z'));
        }
        assert.equal((await f.transport('check', { ...existing, inicio_local: '2030-01-07T11:00' })).statusCode, 200); // Own reservation alone is excluded.
        report.checks.push('Real loopback HTTP check/slots/grid/summary/treatmentSlots infer patient from canonical existing ID and exclude only that ID; busy409 generic no PII, free own slot remains available');

        // Exact SQL scope rejects another clinic or another treatment before
        // using its patient or excluding a foreign appointment from occupancy.
        assert.equal((await f.transport('check', { ...existing, clinica_id: '200' })).statusCode, 404);
        assert.equal((await f.transport('check', { ...existing, tratamiento_id: '41' })).statusCode, 404);
        assert.equal((await f.transport('check', { ...existing, ignore_cita_id: '999999' })).statusCode, 404);
        report.checks.push('Existing appointment clinic/treatment/unknown ID mismatches fail closed via current HTTP handlers; explicit public-patient ACL/membership boundary covered separately by unit handler tests');

        // A hard advisory preview is not a generic force grant. The existing
        // explicit ordinary reprogram dialog still obtains its exact signed
        // acknowledgement from the canonical writer under patient locks.
        const before = clone(await f.read(candidate.id_cita)), counts = await f.counts();
        const move = { existingAppointmentId: candidate.id_cita, appointmentValues: { inicio: instant, fin: '2030-01-07T09:30:00.000Z',
          estado: 'reprogramada', reschedule_reason: 'patient_request', updated_by: 1 }, reschedulePatientOverlap: { actorId: 1 } };
        let receipt;
        await assert.rejects(f.reserve(move), error => {
          assert.equal(error.code, 'booking_patient_overlap'); assert.equal(error.details.can_confirm_patient_overlap, true);
          assert.equal(error.details.can_force, false); receipt = error.details.patient_overlap_acknowledgement;
          assert.match(receipt, /^[a-f0-9]{64}$/); return true;
        });
        assert.deepEqual(clone(await f.read(candidate.id_cita)), before); assert.deepEqual(await f.counts(), counts);
        const confirmed = await f.reserve({ ...move, reschedulePatientOverlap: { actorId: 1, acknowledgement: receipt } });
        const after = await f.read(candidate.id_cita); assert.equal(iso(after.inicio), instant); assert.equal(after.import_metadata.patient_overlap_confirmation.acknowledgement, receipt);
        assert.equal(after.import_metadata.patient_overlap_confirmation.confirmed_by, 1); assert.equal(confirmed.id_cita, candidate.id_cita);
        assert.equal(await db.CitaPaciente.count(), 2); assert.equal((await f.read(conflict.id_cita)).doctor_id, 2);
        report.checks.push('New patient-busy preview does not remove explicit ordinary reprogram confirmation: command requires exact receipt, first attempt writes nothing, confirmed move preserves canonical ID and stores receipt without force');
      } finally { await f.close(); }
    });
  });
