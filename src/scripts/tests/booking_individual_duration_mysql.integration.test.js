'use strict';

// Opt-in only: new mysqld, datadir 0700, private Unix socket, --skip-networking;
// launcher's TCP/fetch/queue guard forbids real DB, app bootstrap and providers.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 BOOKING_INDIVIDUAL_DURATION_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test');
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const iso = value => new Date(value).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('individual request duration: owned MySQL HTTP/solver/transaction/snapshot, real physical conflicts, rollback and row-lock stale-range CAS',
  { skip: process.env.BOOKING_INDIVIDUAL_DURATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models, registerOwnedLoopbackServer });
      try {
      const baseline = await f.counts();
      // Absent choice cannot produce a fake slot, a default 30 or any write.
      for (const handler of ['check', 'treatmentSlots', 'slots', 'grid', 'summary']) {
        await assert.rejects(f.http(handler, { duration_minutes: undefined, dates: ['2030-01-07'], column_ids: [1], mode: 'doctor' }), { code: 'booking_duration_required' });
        await assert.rejects(f.http(handler, { duration_minutes: '45x', dates: ['2030-01-07'], column_ids: [1], mode: 'doctor' }), { code: 'booking_duration_invalid' });
        const missingHttp = await f.transport(handler, { duration_minutes: undefined, dates: ['2030-01-07'], column_ids: [1], mode: 'doctor' });
        assert.equal(missingHttp.statusCode, 422); assert.equal(missingHttp.body.code, 'booking_duration_required');
      }
      await assert.rejects(f.reserve({ appointmentValues: f.values() }), { code: 'booking_duration_required' });
      await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: 5 }), durationSelection: { duration_minutes: 45 } }), { code: 'booking_profile_missing' });
      await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: 4 }), durationSelection: { duration_minutes: 45 } }), { code: 'booking_duration_locked' });
      assert.deepEqual(await f.counts(), baseline);
      report.checks.push('Falta/selección inválida: HTTP y command reales rechazan sin citas, ocupación ni anchors; perfil ausente no se habilita y duración fija no se sobreescribe');

      const search = await f.transport('treatmentSlots');
      assert.equal(search.statusCode, 200); assert.equal(search.body.duration_minutes, 45);
      const slot = search.body.slots.find(row => row.start_at === '2030-01-07T09:00:00.000Z');
      assert(slot); assert.equal(slot.end_at, '2030-01-07T09:45:00.000Z');
      const check = await f.transport('check'); assert.equal(check.body.available, true);
      const first = await f.reserve({ appointmentValues: f.values({ inicio: slot.start_at, fin: null }), durationSelection: { duration_minutes: 45 } });
      let stored = await f.read(first.id_cita);
      assert.equal(iso(stored.inicio), slot.start_at); assert.equal(iso(stored.fin), slot.end_at);
      const receipt = { duration_minutes: 45, phase_durations: { care: 45 } };
      assert.deepEqual(stored.import_metadata.booking.duration_selection, receipt);
      assert.equal(stored.import_metadata.booking.profile.phases[0].duration_minutes, 45);
      assert.equal((await models.Tratamiento.findByPk(1)).clinical_config.booking_profile.phases[0].duration_minutes, null);
      let occupancy = await f.occupancy(first.id_cita);
      assert.deepEqual(occupancy.map(row => row.resource_kind).sort(), ['doctor', 'installation']);
      assert(occupancy.every(row => iso(row.start_at) === slot.start_at && iso(row.end_at) === slot.end_at));
      assert((await sql.query('SELECT @@transaction_isolation AS level'))[0][0].level);
      report.checks.push('HTTP -> búsqueda/contexto/solver reales -> transacción READ COMMITTED -> DATETIME y JSON reales congelan 45 min, receipt y dos recursos; catálogo permanece NULL');

      // A future catalog revision does not reinterpret an existing appointment.
      await models.Tratamiento.update({ clinical_config: { catalog_status: 'active', booking_profile: f.profile(1,
        [f.phase('catalog_changed', { duration_minutes: 20, installation_ids: [102] })]) } }, { where: { id_tratamiento: 1 } });
      const existing = { ignore_cita_id: String(first.id_cita), duration_minutes: '45' };
      assert.equal((await f.transport('check', existing)).body.available, true);
      assert.equal((await f.transport('treatmentSlots', existing)).body.duration_minutes, 45);
      await assert.rejects(f.http('check', { ...existing, duration_minutes: '20' }), { code: 'booking_duration_locked' });
      const moved = await f.reserve({ existingAppointmentId: first.id_cita,
        appointmentValues: { inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:45:00Z' } });
      stored = await f.read(first.id_cita); occupancy = await f.occupancy(first.id_cita);
      assert.deepEqual(stored.import_metadata.booking.duration_selection, receipt);
      assert.equal(stored.import_metadata.booking.profile.phases[0].key, 'care');
      assert(occupancy.every(row => iso(row.start_at) === '2030-01-07T10:00:00.000Z'));
      await f.reserve({ existingAppointmentId: first.id_cita, appointmentValues: { estado: 'cancelada' } });
      assert.equal((await f.http('check', { ...existing, inicio_local: '2030-01-07T11:00' })).body.available, true);
      assert.deepEqual((await f.read(first.id_cita)).import_metadata.booking.duration_selection, receipt);
      await f.reserve({ existingAppointmentId: first.id_cita, appointmentValues: { estado: 'pendiente' } });
      assert.deepEqual((await f.read(first.id_cita)).import_metadata.booking.duration_selection, receipt);
      report.checks.push('Snapshot original se usa en preview, mover, cancelar y reabrir pese a catálogo cambiado; filas físicas se reemplazan con tiempos nuevos, nunca quedan en hueco viejo');

      // Known v4 offsets are frozen using span40, not duration sum60.
      const relative = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 2, inicio: '2030-01-08T09:00:00Z', fin: null }),
        durationSelection: { phase_durations: { one: 40, two: 20 } } });
      const relativeStored = await f.read(relative.id_cita), relativeRows = await f.occupancy(relative.id_cita);
      assert.equal(iso(relativeStored.fin), '2030-01-08T09:40:00.000Z');
      assert.deepEqual(relativeStored.import_metadata.booking.profile.phases.map(row => row.start_offset_minutes), [0, 15]);
      assert.equal(relativeStored.import_metadata.booking.capacity_fully_verified, true);
      assert(relativeRows.some(row => row.phase_key === 'two' && iso(row.start_at) === '2030-01-08T09:15:00.000Z'
        && iso(row.end_at) === '2030-01-08T09:35:00.000Z'));
      report.checks.push('V4 por dos pasos: NULL individuales se instancian explícitamente, offsets0/15 y span40 completos se congelan; segundo paso ocupa09:15–09:35');

      // Shared physical room across clinics cannot be bypassed by force.
      const peer = await f.reserve({ appointmentValues: f.values({ clinica_id: 200, tratamiento_id: 11, doctor_id: 2,
        instalacion_id: 201, paciente_id: 2, inicio: '2030-01-09T09:00:00Z', fin: null }), durationSelection: { duration_minutes: 45 } });
      assert((await f.occupancy(peer.id_cita)).some(row => row.resource_key === 'installation:101'));
      await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: 4, paciente_id: 3,
        inicio: '2030-01-09T09:00:00Z', fin: '2030-01-09T09:30:00Z' }), force: true }), { code: 'booking_unavailable' });
      const foreignCheck = await f.transport('check', { tratamiento_id: '4', duration_minutes: '30', inicio_local: '2030-01-09T10:00' });
      assert.equal(foreignCheck.statusCode, 409); assert.equal(foreignCheck.body.can_force, false);
      assert.doesNotMatch(JSON.stringify(foreignCheck.body), /Clínica ficticia 200|paciente_id|patient_id|Sólo prueba|id_cita/);
      report.checks.push('Sala física101/alias201 en dos clínicas comparte ocupación SQL real; no se fuerza ni se revela paciente/detalle de clínica ajena');

      // Another professional and room still contend for the same machine and
      // its real turnaround minutes, independently of the entered duration.
      const machine = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 3, inicio: '2030-01-10T09:00:00Z', fin: null }),
        durationSelection: { duration_minutes: 45 } });
      const machineRows = await f.occupancy(machine.id_cita);
      assert(machineRows.some(row => row.resource_key === 'equipment:401' && iso(row.end_at) === '2030-01-10T09:55:00.000Z'));
      for (const at of ['09:00:00', '09:45:00']) await assert.rejects(f.reserve({ appointmentValues: f.values({ paciente_id: 2,
        tratamiento_id: 12, doctor_id: 2, instalacion_id: 102, inicio: `2030-01-10T${at}Z`, fin: null }),
        durationSelection: { duration_minutes: 30 }, force: true }), { code: 'booking_unavailable' });
      const machineCheck = await f.transport('check', { tratamiento_id: '12', duration_minutes: '30', inicio_local: '2030-01-10T10:45' });
      assert.equal(machineCheck.statusCode, 409); assert.equal(machineCheck.body.can_force, false);
      report.checks.push('Maquinaria real de fixture: otra sala/profesional no libera unidad401 ni turnaround10; duración elegida y force no evitan el conflicto');

      // Failure after INSERT but before occupancy completion rolls everything
      // back, including the resource lock anchors created by the transaction.
      const beforeRollback = await f.counts();
      const hook = () => { throw Error('OWNED_OCCUPANCY_RECEIPT_FAILURE'); };
      models.AppointmentBookingOccupancy.addHook('beforeBulkCreate', 'owned-duration-fail', hook);
      try {
        await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: 3,
          inicio: '2030-01-11T09:00:00Z', fin: null }), durationSelection: { duration_minutes: 40 } }), /OWNED_OCCUPANCY_RECEIPT_FAILURE/);
      } finally { models.AppointmentBookingOccupancy.removeHook('beforeBulkCreate', 'owned-duration-fail'); }
      assert.deepEqual(await f.counts(), beforeRollback);
      report.checks.push('Fallo real después de INSERT cita y antes de bulk INSERT ocupación provoca rollback sin cita/receipt/ocupación parcial');

      const beforeRace = await f.counts();
      const emptySlotRace = await Promise.allSettled([1, 2].map(paciente_id => f.reserve({ appointmentValues: f.values({
        tratamiento_id: 3, paciente_id, inicio: '2030-01-11T14:00:00Z', fin: null }), durationSelection: { duration_minutes: 40 } })));
      assert.equal(emptySlotRace.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(emptySlotRace.find(result => result.status === 'rejected').reason.code, 'booking_unavailable');
      assert.equal((await f.counts()).CitaPaciente, beforeRace.CitaPaciente + 1);
      report.checks.push('Dos escritores reales concurrentes sobre hueco vacío compiten por anchors InnoDB: sólo una cita confirma, la otra observa la ocupación después del lock y revierte');

      // Canonical row lock + existing stale-range comparison (not a newly
      // invented CAS): a second transaction must observe the committed move.
      const hold = await sql.transaction({ isolationLevel: 'READ COMMITTED' });
      let race, settled = false;
      try {
        await f.reserve({ existingAppointmentId: moved.id_cita, transaction: hold,
          appointmentValues: { inicio: '2030-01-07T10:15:00Z', fin: '2030-01-07T11:00:00Z' } });
        race = f.reserve({ existingAppointmentId: moved.id_cita, supportOnly: true, additionalStaffIds: [],
          expectedRange: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T10:45:00Z' }, appointmentValues: { updated_by: 1 } })
          .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
        await sleep(60); assert.equal(settled, false);
        await hold.commit(); assert.equal((await race).error?.code, 'booking_appointment_changed');
      } finally { if (!hold.finished) await hold.rollback(); if (race) await race; }
      assert.equal(iso((await f.read(moved.id_cita)).inicio), '2030-01-07T10:15:00.000Z');
      assert.deepEqual((await f.read(moved.id_cita)).import_metadata.booking.duration_selection, receipt);
      report.checks.push('CAS existente de expectedRange con lock UPDATE real: segunda transacción queda esperando, lee el movimiento confirmado y rechaza rango obsoleto sin sobrescribirlo');
      assert(f.acl.length > 0);
      report.boundary = 'Wiring real de HTTP disponibilidad con ACL sintética; no acredita autenticación/rutas completas ni habilitación de flags en aplicación';
      report.bookingDurationChecks = report.checks.length;
      } finally { await f.close(); }
    });
  });
