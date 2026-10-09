'use strict';
// One freshly owned mysqld and explicitly registered loopback POST server.
// Declared synthetic actor boundary; real command, locks, SQL and HTTP receipt.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');

test('manual restriction receipts: owned POST SQL, stale evidence rollback and one receipt for an entire linked move',
  { skip: process.env.BOOKING_RESTRICTIONS_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      Object.assign(process.env, { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' });
      const links = require('../../services/appointmentPatientLinks.service');
      const { bookingErrorPayload } = require('../../services/treatmentBookingProfile.service');
      const { bookingSegments } = require('../../lib/appointment-booking-segments');
      const activityFile = require.resolve('../../services/appointmentActivity.service');
      require.cache[activityFile] = { id: activityFile, filename: activityFile, loaded: true, exports: { recordAppointmentStatusChange: async () => {} } };
      let server;
      try {
        await require('../../../migrations/20261007170000-create-appointment-patient-links').up(sql.getQueryInterface(), S);
        db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(sql, S.DataTypes);
        db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(sql, S.DataTypes);
        server = http.createServer(async (request, response) => {
          let body = ''; request.setEncoding('utf8'); request.on('data', value => { body += value; });
          request.on('end', async () => {
            try {
              const input = JSON.parse(body), actorId = 1; // Explicit test auth boundary.
              const options = { restrictionConfirmation: { actorId, acknowledgement: input.booking_restriction_acknowledgement },
                expectedPlanSha256: input.booking_plan_sha256 };
              const result = request.url === '/appointments'
                ? await f.reserve({ appointmentValues: { ...input.values, created_by: actorId }, ...options })
                : await links.moveTogether(db, input.appointment_id, { ...input.values, updated_by: actorId }, options);
              response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
            } catch (error) {
              response.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(bookingErrorPayload(error)));
            }
          });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); registerOwnedLoopbackServer(server);
        const post = (route, input) => new Promise((resolve, reject) => {
          const request = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: 'POST', agent: false,
            headers: { 'Content-Type': 'application/json' } }, response => {
            let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value; });
            response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
          }); request.on('error', reject); request.end(JSON.stringify(input));
        });
        const input = { values: f.values({ tratamiento_id: 4, doctor_id: 2, instalacion_id: 102,
          inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' }) };
        const before = await f.counts(), warning = await post('/appointments', input);
        assert.equal(warning.status, 409); assert.equal(warning.body.can_confirm_restrictions, true);
        assert.match(warning.body.booking_restriction_acknowledgement, /^[a-f0-9]{64}$/);
        assert.deepEqual(await f.counts(), before);
        await db.DoctorBloqueo.create({ doctor_id: 2, clinica_id: 100, tipo: 'otro', recurrente: 'none',
          fecha_inicio: new Date('2030-01-07T10:00:00Z'), fecha_fin: new Date('2030-01-07T10:30:00Z'), motivo: 'Bloqueo ficticio' });
        const stale = await post('/appointments', { ...input, booking_restriction_acknowledgement: warning.body.booking_restriction_acknowledgement,
          booking_plan_sha256: warning.body.booking_plan_sha256 });
        assert.equal(stale.status, 409); assert.notEqual(stale.body.booking_restriction_acknowledgement, warning.body.booking_restriction_acknowledgement);
        assert.deepEqual(await f.counts(), before);
        const accepted = await post('/appointments', { ...input, booking_restriction_acknowledgement: stale.body.booking_restriction_acknowledgement,
          booking_plan_sha256: stale.body.booking_plan_sha256 });
        assert.equal(accepted.status, 201); assert.equal(accepted.body.doctor_id, 2); assert.equal(accepted.body.instalacion_id, 102);
        assert.equal(bookingSegments(accepted.body).length, 1);
        assert.deepEqual(accepted.body.import_metadata.booking_restriction_confirmation.original_profile.phases[0].professionals.ids, [1]);
        assert.equal((await f.occupancy(accepted.body.id_cita)).length, 2);
        const linkedProfile = f.profile(1, [f.phase('linked', { duration_minutes: 30, installation_ids: [101, 102],
          professionals: { mode: 'any', ids: [1, 2], preferred_id: 1 } })]);
        await db.Tratamiento.create({ id_tratamiento: 41, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Individual con alternativas ficticias',
          origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: linkedProfile } });
        const owner = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 41,
          inicio: '2030-01-07T11:00:00Z', fin: '2030-01-07T11:30:00Z' }) });
        await owner.reload();
        const follower = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 41,
          inicio: '2030-01-07T11:30:00Z', fin: '2030-01-07T12:00:00Z' }), persist: async ({ values, transaction }) => {
            const row = await db.CitaPaciente.create(values, { transaction });
            await links.linkAtBirth(db, row, { mode: 'link', appointment_id: owner.id_cita, updated_at: owner.updated_at }, 1, transaction); return row;
          } });
        await db.DoctorBloqueo.create({ doctor_id: 1, clinica_id: 100, tipo: 'otro', recurrente: 'none',
          fecha_inicio: new Date('2030-01-07T13:00:00Z'), fecha_fin: new Date('2030-01-07T13:30:00Z'), motivo: 'Sólo bloquea el primer miembro' });
        const move = { appointment_id: follower.id_cita, values: { inicio: '2030-01-07T13:30:00Z', fin: '2030-01-07T14:00:00Z',
          estado: 'reprogramada', reschedule_reason: 'administrative_error' } };
        const originalRows = await Promise.all([owner.id_cita, follower.id_cita].map(id => f.read(id)));
        const originalOccupancies = await Promise.all([owner.id_cita, follower.id_cita].map(id => f.occupancy(id)));
        const groupWarning = await post('/linked/move', move);
        assert.equal(groupWarning.status, 409); assert.equal(groupWarning.body.details.linked_appointments, 2);
        assert.deepEqual(await Promise.all([owner.id_cita, follower.id_cita].map(id => f.read(id))), originalRows);
        await follower.update({ estado: 'info_confirmada' }); // DATE precision can keep updated_at in the same second.
        const staleGroup = await post('/linked/move', { ...move, booking_restriction_acknowledgement: groupWarning.body.booking_restriction_acknowledgement,
          booking_plan_sha256: groupWarning.body.booking_plan_sha256 });
        assert.equal(staleGroup.status, 409); assert.notEqual(staleGroup.body.booking_restriction_acknowledgement, groupWarning.body.booking_restriction_acknowledgement);
        assert.deepEqual(await Promise.all([owner.id_cita, follower.id_cita].map(id => f.occupancy(id))), originalOccupancies);
        const groupAccepted = await post('/linked/move', { ...move, booking_restriction_acknowledgement: staleGroup.body.booking_restriction_acknowledgement,
          booking_plan_sha256: staleGroup.body.booking_plan_sha256 });
        assert.equal(groupAccepted.status, 201, JSON.stringify(groupAccepted.body)); assert.equal(groupAccepted.body.rows.length, 2);
        assert.equal(+new Date((await f.read(owner.id_cita)).inicio), +new Date('2030-01-07T13:00:00Z'));
        assert.equal(+new Date((await f.read(follower.id_cita)).inicio), +new Date('2030-01-07T13:30:00Z'));
        // A strict resource plan can still need a PATIENT-only exception. Keep
        // its real catalog alternatives, priority proof and plan SHA unchanged.
        const overlappingOwner = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 41,
          inicio: '2030-01-08T10:00:00Z', fin: '2030-01-08T10:30:00Z' }) });
        await overlappingOwner.reload();
        await db.Tratamiento.create({ id_tratamiento: 42, clinica_id: 100, grupo_clinica_id: 50, nombre: 'Segundo individual con alternativas ficticias',
          origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: f.profile(1, [f.phase('linked', {
            duration_minutes: 30, installation_ids: [101, 102], professionals: { mode: 'any', ids: [1, 2], preferred_id: 2 } })]) } });
        const overlappingOptions = { appointmentValues: f.values({ tratamiento_id: 42, doctor_id: 2, instalacion_id: 102, created_by: 1,
          inicio: '2030-01-08T10:15:00Z', fin: '2030-01-08T10:45:00Z' }), priorityAcknowledged: true,
          restrictionConfirmation: { actorId: 1 }, persist: async ({ values, transaction }) => {
            const row = await db.CitaPaciente.create(values, { transaction });
            await links.linkAtBirth(db, row, { mode: 'link', appointment_id: overlappingOwner.id_cita,
              updated_at: overlappingOwner.updated_at }, 1, transaction); return row;
          } };
        let patientWarning;
        await assert.rejects(f.reserve(overlappingOptions), error => { patientWarning = error;
          return error.code === 'booking_restriction_confirmation_required'; });
        const overlappingFollower = await f.reserve({ ...overlappingOptions,
          expectedPlanSha256: patientWarning.details.booking_plan_sha256,
          restrictionConfirmation: { actorId: 1, acknowledgement: patientWarning.details.booking_restriction_acknowledgement } });
        const overlappingMove = { appointment_id: overlappingFollower.id_cita, values: {
          inicio: '2030-01-08T12:15:00Z', fin: '2030-01-08T12:45:00Z', estado: 'reprogramada', reschedule_reason: 'administrative_error' } };
        const overlappingWarning = await post('/linked/move', overlappingMove);
        assert.equal(overlappingWarning.status, 409);
        assert(overlappingWarning.body.booking_restrictions.some(row => row.code === 'PATIENT_OVERLAP'));
        const overlappingAccepted = await post('/linked/move', { ...overlappingMove,
          booking_restriction_acknowledgement: overlappingWarning.body.booking_restriction_acknowledgement,
          booking_plan_sha256: overlappingWarning.body.booking_plan_sha256 });
        assert.equal(overlappingAccepted.status, 201, JSON.stringify(overlappingAccepted.body));
        assert.equal(overlappingAccepted.body.rows.length, 2);
        assert.equal(+new Date((await f.read(overlappingOwner.id_cita)).inicio), +new Date('2030-01-08T12:00:00Z'));
        assert.equal(+new Date((await f.read(overlappingFollower.id_cita)).inicio), +new Date('2030-01-08T12:15:00Z'));
        report.checks.push('Owned loopback POST with real command/MySQL: explicit outside-profile assignment, stale warning rollback, accepted exact receipt, complete effective segments; one linked-group receipt includes free-member state/evidence, rejects its change and atomically moves every member. No production auth, DB, queue or provider connection.');
        report.checks.push('Strict resource plan with catalog alternatives and only patient overlap preserves its exact SHA through acknowledgement, during linked birth and one atomic linked movement with different doctors/rooms.');
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await f.close();
      }
    });
  });
