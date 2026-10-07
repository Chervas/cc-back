'use strict';

// Native private MySQL + command/search/HTTP handlers. Synthetic ACL boundary
// is declared by the reused fixture; this is not a CRM authentication test.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { prpLedRecipe, indibaPrpRecipe, sharedPreparationRecipe } = require('../../lib/bs-operational-recipes');
const instant = value => new Date(value).toISOString();

test('PRP/INDIBA recipes reserve native resources atomically and move every phase, freeing only previous windows',
  { skip: process.env.BS_OPERATIONAL_RECIPES_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      try {
        await db.Instalacion.create({ id: 103, clinica_id: 100, nombre: 'INDIBA ficticia', profesionales_permitidos: [1, 2], activo: true });
        for (let day = 1; day <= 5; day++) await db.InstalacionHorario.create({ instalacion_id: 103, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
        for (const [id, room, name] of [[402, 103, 'INDIBA ficticia'], [403, 102, 'LED ficticio']]) {
          await db.BookingEquipment.create({ id, owner_clinic_id: 100, group_id: 50, name, family_key: 'bs_recipe_' + id,
            mobility: 'fixed', home_installation_id: room, status: 'available', turnaround_minutes: 0 });
          await db.BookingEquipmentClinic.create({ equipment_id: id, clinic_id: 100 });
          await db.BookingEquipmentRoomPolicy.upsert({ installation_id: room, mode: 'selected', equipment_ids: [id] });
        }
        const resources = { doctorId: 1, applicationDoctorId: 2, extractionRoomId: 101, applicationRoomId: 102, ledId: 403, indibaRoomId: 103, indibaId: 402 };
        for (const [id, booking_profile] of [[51, prpLedRecipe(resources)], [52, indibaPrpRecipe(resources)]]) {
          await db.Tratamiento.create({ id_tratamiento: id, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Receta ficticia ' + id,
            origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile } });
        }
        const at = '2030-01-07T09:00:00.000Z';
        const reservation = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 52, doctor_id: 2, instalacion_id: 103,
          inicio: at, fin: '2030-01-07T09:50:00.000Z' }) });
        const saved = await f.read(reservation.id_cita), phases = saved.import_metadata.booking.phases;
        assert.equal(phases.length, 3); assert.deepEqual(phases.map(p => p.installation_id), [103, 101, 102]);
        assert.deepEqual(phases.map(p => p.doctor_ids), [[2], [1], [2]]);
        assert.deepEqual(phases.map(p => p.equipment?.map(e => e.id) || []), [[402], [], [403]]);
        assert.equal(await db.CitaPaciente.count(), 1);
        const occupancies = await f.occupancy(saved.id_cita);
        assert.equal(occupancies.filter(r => r.resource_kind === 'equipment').length, 2);
        const slots = async () => {
          const response = await f.transport('treatmentSlots', { tratamiento_id: '52', duration_minutes: undefined, limit: '200' });
          assert.equal(response.statusCode, 200); return response.body.slots;
        };
        assert(!(await slots()).some(s => s.start_at === at), 'Occupied resources must not be advertised');
        const moved = await f.reserve({ existingAppointmentId: saved.id_cita, appointmentValues: {
          inicio: '2030-01-07T10:00:00.000Z', fin: '2030-01-07T10:50:00.000Z', estado: 'reprogramada', reschedule_reason: 'administrative_error', updated_by: 1 } });
        assert.equal(moved.id_cita, saved.id_cita); assert.equal(await db.CitaPaciente.count(), 1);
        const after = await f.read(saved.id_cita);
        assert.equal(instant(after.inicio), '2030-01-07T10:00:00.000Z');
        assert.deepEqual(after.import_metadata.booking.phases.map(p => [p.installation_id, p.doctor_ids, p.equipment?.map(e => e.id) || []]),
          phases.map(p => [p.installation_id, p.doctor_ids, p.equipment?.map(e => e.id) || []]));
        assert((await f.occupancy(saved.id_cita)).every(row => instant(row.start_at) >= '2030-01-07T10:00:00.000Z'));
        assert((await slots()).some(s => s.start_at === at), 'Moving frees the original complete slot');
        report.checks.push('Three-phase INDIBA + PRP: native resource locks, one appointment, two machines, canonical move preserves rooms/professionals and frees old HTTP-advertised slot');
        const prp = await f.reserve({ appointmentValues: f.values({ paciente_id: 2, tratamiento_id: 51, inicio: at, fin: '2030-01-07T09:30:00.000Z' }) });
        const prpSaved = await f.read(prp.id_cita);
        assert.equal(prpSaved.import_metadata.booking.phases.length, 2);
        assert.equal(instant(prpSaved.fin), '2030-01-07T09:30:00.000Z');
        assert.deepEqual(prpSaved.import_metadata.booking.phases[1].equipment.map(e => e.id), [403]);
        assert.equal(await db.CitaPaciente.count(), 2, 'One canonical appointment per patient, not per phase');
        const counts = await f.counts();
        await assert.rejects(f.reserve({ appointmentValues: f.values({ paciente_id: 3, tratamiento_id: 51, inicio: at, fin: '2030-01-07T09:30:00.000Z' }) }));
        assert.deepEqual(await f.counts(), counts, 'Failed joint reservation writes no partial rows');
        report.checks.push('PRP with LED: native 13+17-minute one-appointment reservation; occupied resources reject another patient atomically');
      } finally { await f.close(); }
    });
  });
