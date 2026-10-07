'use strict';
// Private native MySQL; no application bootstrap, CRM, or providers.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { sharedPreparationRecipe } = require('../../lib/bs-operational-recipes');
const instant = value => new Date(value).toISOString();

test('Piedad authoring rule persists three same-start preparations while rooms/machines remain occupied; a fourth is atomic rejection',
  { skip: process.env.BS_OPERATIONAL_RECIPES_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      try {
        for (const id of [103, 104]) {
          await db.Instalacion.create({ id, clinica_id: 100, nombre: 'Sala ficticia ' + id, profesionales_permitidos: [1, 2], activo: true });
          for (let day = 1; day <= 5; day++) await db.InstalacionHorario.create({ instalacion_id: id, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
        }
        const variants = [[70, 101, 401, 30, false], [71, 102, 402, 30, false], [72, 103, 403, 45, true], [73, 104, 404, 30, false]];
        for (const [id, room, unit, duration, attended] of variants) {
          if (unit === 401) await db.BookingEquipment.update({ turnaround_minutes: 0 }, { where: { id: unit } });
          else {
            await db.BookingEquipment.create({ id: unit, owner_clinic_id: 100, group_id: 50, name: 'Unidad ficticia ' + unit,
              family_key: 'prep_' + unit, mobility: 'fixed', home_installation_id: room, status: 'available', turnaround_minutes: 0 });
            await db.BookingEquipmentClinic.create({ equipment_id: unit, clinic_id: 100 });
          }
          await db.BookingEquipmentRoomPolicy.upsert({ installation_id: room, mode: 'selected', equipment_ids: [unit] });
          const booking_profile = sharedPreparationRecipe(f.profile(2, [f.phase('care', { duration_minutes: duration, installation_ids: [room],
            equipment_requirements: [{ equipment_ids: [unit] }] })]), { continuousAfterPreparation: attended });
          await db.Tratamiento.create({ id_tratamiento: id, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Preparación ficticia ' + id,
            origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile } });
        }
        // Reserve attended INDIBA first: later preparations cannot rewrite this
        // snapshot and must fit the saved initial fifteen-minute sharing window.
        const at = '2030-01-07T09:00:00.000Z', saved = [];
        for (const [patient, treatment, room, duration] of [[1, 72, 103, 45], [2, 70, 101, 30], [3, 71, 102, 30]]) {
          saved.push(await f.reserve({ appointmentValues: f.values({ paciente_id: patient, tratamiento_id: treatment, instalacion_id: room,
            inicio: at, fin: new Date(Date.parse(at) + duration * 60000).toISOString() }) }));
        }
        assert.equal(await db.CitaPaciente.count(), 3);
        const intervals = [];
        for (const appointment of saved) {
          const rows = await f.occupancy(appointment.id_cita);
          const savedRow = await f.read(appointment.id_cita);
          assert.equal(savedRow.import_metadata.booking.capacity_fully_verified, true);
          assert.deepEqual(savedRow.import_metadata.booking.attention_requirements_pending, []);
          const staff = rows.filter(r => r.resource_kind === 'doctor'); intervals.push(...staff);
          assert.equal(rows.filter(r => r.resource_kind === 'equipment').length, 1);
          for (const row of rows.filter(r => ['equipment', 'installation'].includes(r.resource_kind))) {
            assert.equal(instant(row.start_at), at); assert.equal(instant(row.end_at), instant(savedRow.fin));
          }
        }
        const setup = intervals.filter(r => instant(r.end_at) <= '2030-01-07T09:15:00.000Z');
        assert.equal(setup.length, 3);
        assert.equal(setup.reduce((n, r) => n + (Date.parse(r.end_at) - Date.parse(r.start_at)) / 60000, 0), 15);
        const counts = await f.counts();
        await assert.rejects(f.reserve({ appointmentValues: f.values({ paciente_id: 4, tratamiento_id: 73, instalacion_id: 104,
          inicio: at, fin: '2030-01-07T09:30:00.000Z' }) }));
        assert.deepEqual(await f.counts(), counts);
        report.checks.push('Native SQL: three patients, EMS/preso/attended INDIBA, same start, distinct physical units, 15-minute total preparation; no intermediate booking restriction per owner instruction; fourth rejected without partial rows');
      } finally { await f.close(); }
    });
  });
