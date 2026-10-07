'use strict';
// Real solver/search/command and real model factories on freshly owned MySQL.
// No API session, runtime enrollment, messages, live schema or patients.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const { bookingPlanHash } = require('../../lib/booking-plan-receipt');
test('complete plan receipt: SQL machine/policy CAS, rollback and effective frozen v4/legacy snapshot equality',
  { skip: process.env.BOOKING_PLAN_RECEIPT_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db });
      const profile = f.profile(4, [f.phase('first', { duration_minutes: 30 }), f.phase('second', { duration_minutes: 30,
        start_offset_minutes: 15, installation_ids: [102], professionals: { mode: 'any', ids: [2], preferred_id: 2 },
        equipment_requirements: [{ equipment_ids: [401, 402] }] })]);
      await db.Tratamiento.create({ id_tratamiento: 42, clinica_id: 100, grupo_clinica_id: 50,
        nombre: 'Visita combinada sólo prueba', origen: 'clinica', activo: true,
        clinical_config: { catalog_status: 'active', booking_profile: profile } });
      await db.BookingEquipment.create({ id: 402, owner_clinic_id: 100, group_id: 50, name: 'Alternativa sólo prueba',
        family_key: 'owned_fixture_unit', mobility: 'mobile', status: 'available', turnaround_minutes: 10 });
      await db.BookingEquipmentClinic.create({ equipment_id: 402, clinic_id: 100 });
      await db.BookingEquipmentRoomPolicy.update({ equipment_ids: [401, 402] }, { where: { installation_id: 102 } });
      const clinic = await db.Clinica.findByPk(100);
      const search = () => searchTreatmentSlots({ db, clinic, treatmentId: 42, date: '2030-01-07', patientId: 1,
        capabilities: f.capabilities, now: new Date('2030-01-01'), limit: 200 });
      const chosen = (await search()).slots.find(slot => slot.start_at === '2030-01-07T10:00:00.000Z');
      assert(chosen); assert.equal(chosen.end_at, '2030-01-07T10:45:00.000Z'); assert.equal(chosen.phases.length, 2);
      assert.equal(chosen.phases[1].equipment[0].id, 401); assert.match(chosen.booking_plan_sha256, /^[a-f0-9]{64}$/);
      const input = { appointmentValues: f.values({ tratamiento_id: 42, inicio: chosen.start_at, fin: chosen.end_at }),
        expectedPlanSha256: chosen.booking_plan_sha256, selections: Object.fromEntries(chosen.phases.map(phase => [phase.key,
          { doctor_id: phase.doctor_ids[0], installation_id: phase.installation_id }])) };
      const counts = await f.counts();
      // Both are eligible from the start. No caller-selected machine authority:
      // the solver can choose402, but the receipt must reject silent substitution.
      await db.BookingEquipment.update({ status: 'unavailable' }, { where: { id: 401 } });
      const alternative = (await search()).slots.find(slot => slot.start_at === chosen.start_at);
      assert(alternative); assert.equal(alternative.phases[1].equipment[0].id, 402);
      assert.notEqual(alternative.booking_plan_sha256, chosen.booking_plan_sha256);
      await assert.rejects(f.reserve(input), { code: 'booking_plan_changed', statusCode: 409 });
      assert.deepEqual(await f.counts(), counts);
      report.checks.push('Owned SQL preview has two simultaneous-offset steps and45-minute envelope; canonical create rejects eligible machine401→402 substitution before persistence and rolls back resource/occupancy writes');

      await db.BookingEquipment.update({ status: 'available', turnaround_minutes: 15 }, { where: { id: 401 } });
      const longer = (await search()).slots.find(slot => slot.start_at === chosen.start_at);
      assert(longer); assert.equal(longer.phases[1].equipment[0].id, 401);
      assert.equal(longer.phases[1].equipment[0].turnaround_minutes, 15);
      await assert.rejects(f.reserve(input), { code: 'booking_plan_changed', statusCode: 409 });
      assert.deepEqual(await f.counts(), counts);
      for (const expectedPlanSha256 of [null, '', 'malformed', 'A'.repeat(64)]) {
        await assert.rejects(f.reserve({ ...input, expectedPlanSha256 }), { code: 'booking_plan_changed', statusCode: 409 });
        assert.deepEqual(await f.counts(), counts);
      }
      report.checks.push('Real canonical command rejects changed machine turnaround and malformed receipts without any appointment or occupancy mutation');

      await db.BookingEquipment.update({ turnaround_minutes: 10 }, { where: { id: 401 } });
      await db.BookingEquipment.update({ name: 'Sólo cambia la etiqueta' }, { where: { id: 401 } });
      const fresh = (await search()).slots.find(slot => slot.start_at === chosen.start_at);
      assert.equal(fresh.booking_plan_sha256, chosen.booking_plan_sha256);
      const created = await f.reserve(input), stored = await f.read(created.id_cita), booking = stored.import_metadata.booking;
      assert.equal(await db.CitaPaciente.count(), 1); assert.equal(booking.phases.length, 2);
      assert.equal(booking.phases[1].equipment[0].id, 401); assert.equal(booking.phases[1].doctor_ids[0], 2);
      assert.equal(bookingPlanHash(booking.profile, { start_at: stored.inicio, end_at: stored.fin, phases: booking.phases,
        capacity_fully_verified: booking.capacity_fully_verified, attention_requirements_pending: booking.attention_requirements_pending,
        warnings: booking.warnings, requires_priority_acknowledgement: false, requires_overlap_acknowledgement: false }), chosen.booking_plan_sha256);
      const occupancy = await f.occupancy(created.id_cita), machine = occupancy.find(row => row.resource_kind === 'equipment');
      assert(machine); assert.equal(new Date(machine.end_at).toISOString(), '2030-01-07T10:55:00.000Z');
      assert.equal(new Date(stored.fin).toISOString(), '2030-01-07T10:45:00.000Z');
      report.checks.push('Unchanged full preview survives label-only edits and commits one canonical visit, two step snapshots, both professionals and actual machine plus turnaround10; SQL snapshot reproduces exact receipt');

      // v2 inherited partial machine work is frozen as v3 by the real writer.
      // Only this owned catalogue/machine fixture changes, never the app runtime.
      const attention = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };
      await db.BookingEquipment.update({ attention_policy: attention }, { where: { id: 401 } });
      const legacyProfile = f.profile(2, [f.phase('machine', { duration_minutes: 30, equipment_requirements: [{ equipment_ids: [401] }] })]);
      await db.Tratamiento.create({ id_tratamiento: 43, clinica_id: 100, grupo_clinica_id: 50,
        nombre: 'Herencia clínica sólo prueba', origen: 'clinica', activo: true,
        clinical_config: { catalog_status: 'active', booking_profile: legacyProfile } });
      const legacySearch = () => searchTreatmentSlots({ db, clinic, treatmentId: 43, date: '2030-01-08', patientId: 1,
        capabilities: f.capabilities, now: new Date('2030-01-01'), limit: 200 });
      const legacy = (await legacySearch()).slots.find(slot => slot.start_at === '2030-01-08T10:00:00.000Z');
      assert(legacy); assert.deepEqual(legacy.phases[0].staff_attention, [attention]);
      const legacyInput = { appointmentValues: f.values({ tratamiento_id: 43, inicio: legacy.start_at, fin: legacy.end_at }),
        expectedPlanSha256: legacy.booking_plan_sha256, selections: { machine: { doctor_id: 1, installation_id: 101 } } };
      const beforeLegacy = await f.counts();
      await db.BookingEquipment.update({ attention_policy: { ...attention, start_minutes: 10 } }, { where: { id: 401 } });
      const differentCare = (await legacySearch()).slots.find(slot => slot.start_at === legacy.start_at);
      assert(differentCare); assert.notEqual(differentCare.booking_plan_sha256, legacy.booking_plan_sha256);
      await assert.rejects(f.reserve(legacyInput), { code: 'booking_plan_changed', statusCode: 409 });
      assert.deepEqual(await f.counts(), beforeLegacy);
      await db.BookingEquipment.update({ attention_policy: attention }, { where: { id: 401 } });
      const legacyCreated = await f.reserve(legacyInput), legacyStored = await f.read(legacyCreated.id_cita), legacyBooking = legacyStored.import_metadata.booking;
      assert.equal(legacyBooking.profile.version, 3); assert.deepEqual(legacyBooking.profile.phases[0].staff_attention, [attention]);
      assert.equal(bookingPlanHash(legacyBooking.profile, { start_at: legacyStored.inicio, end_at: legacyStored.fin, phases: legacyBooking.phases,
        warnings: legacyBooking.warnings, requires_priority_acknowledgement: false, requires_overlap_acknowledgement: false }), legacy.booking_plan_sha256);
      const source = (await db.Tratamiento.findByPk(43)).clinical_config.booking_profile;
      assert.equal(source.version, 2); assert.equal(source.phases[0].staff_attention, undefined);
      assert.equal(await db.CitaPaciente.count(), 2);
      report.checks.push('Owned SQL inherited machine policy changes invalidate receipt and roll back; restored v2 source commits a frozen effective v3 snapshot with identical receipt, without modifying its source catalogue');

      // A later machine-catalogue edit must not rewrite purchased/saved work.
      // This is an exact existing-ID command, not a second create or enrollment.
      await db.BookingEquipment.update({ attention_policy: { ...attention, start_minutes: 10 } }, { where: { id: 401 } });
      const afterLegacy = await f.counts();
      const retained = await f.reserve({ existingAppointmentId: legacyCreated.id_cita,
        appointmentValues: { nota: 'Nota administrativa sólo prueba' }, expectedPlanSha256: legacy.booking_plan_sha256 });
      assert.equal(retained.id_cita, legacyCreated.id_cita); assert.deepEqual(await f.counts(), afterLegacy);
      const unchanged = await f.read(retained.id_cita);
      assert.deepEqual(unchanged.import_metadata.booking.profile, legacyBooking.profile);
      assert.deepEqual(unchanged.import_metadata.booking.phases, legacyBooking.phases);
      assert.equal(new Date(unchanged.inicio).getTime(), new Date(legacyStored.inicio).getTime());
      assert.equal(new Date(unchanged.fin).getTime(), new Date(legacyStored.fin).getTime());
      report.checks.push('Canonical existing-ID SQL recheck reproduces the same frozen v3 receipt and exact physical/staff snapshot despite a later machine attention-policy edit; no second appointment or resource rows');
      await f.close();
    });
  });
