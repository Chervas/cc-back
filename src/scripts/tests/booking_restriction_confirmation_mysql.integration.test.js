'use strict';
// One freshly owned mysqld and explicitly registered loopback POST server.
// Declared synthetic actor boundary; real command, locks, SQL and HTTP receipt.
// No configured DB, real patient, sender, production auth or browser is used.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');

test('manual/simple/combined restriction receipts: owned POST SQL, exact reasons, cancelled warnings, atomic birth and linked move',
  { skip: process.env.BOOKING_RESTRICTIONS_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer, includePatientScope: true });
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
                expectedPlanSha256: input.booking_plan_sha256,
                selections: input.booking_selection || {}, priorityAcknowledged: input.acknowledge_priority === true };
              if (input.same_day_choice) options.persist = async ({ values, transaction }) => {
                const row = await db.CitaPaciente.create(values, { transaction });
                await links.linkAtBirth(db, row, input.same_day_choice, actorId, transaction); return row;
              };
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
        const acknowledge = (input, warning) => ({ ...input,
          booking_restriction_acknowledgement: warning.body.booking_restriction_acknowledgement,
          booking_plan_sha256: warning.body.booking_plan_sha256 });
        const utc = value => new Date(value).toISOString();
        const snapshot = async () => ({ counts: await f.counts(),
          rows: await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true }),
          occupancy: await db.AppointmentBookingOccupancy.findAll({ order: [['id', 'ASC']], raw: true }) });
        const assertSpan = async (row, start, end, { room = 101, doctor = 1 } = {}) => {
          assert.equal(utc(row.inicio), start); assert.equal(utc(row.fin), end);
          const occupancies = await f.occupancy(row.id_cita);
          assert.equal(occupancies.length, room === null ? 1 : 2);
          assert.deepEqual(occupancies.map(item => [item.resource_kind, item.resource_key, utc(item.start_at), utc(item.end_at)]).sort(),
            [...(room === null ? [] : [['installation', `installation:${room}`, start, end]]), ['doctor', `doctor:${doctor}`, start, end]].sort());
        };
        const manual = { values: f.values({ tratamiento_id: null, paciente_id: 2, tipo_cita: 'primera_sin_trat',
          inicio: '2030-01-09T10:00:00Z', fin: '2030-01-09T10:30:00Z' }) };
        const freeManualBefore = await snapshot();
        const freeManualCheck = await f.transport('check', { tratamiento_id: undefined, inicio_local: '2030-01-09T11:00',
          fin_local: '2030-01-09T11:30', doctor_id: 1, instalacion_id: 101, paciente_id: 2, duration_minutes: undefined });
        assert.equal(freeManualCheck.statusCode, 200, JSON.stringify(freeManualCheck.body)); assert.equal(freeManualCheck.body.available, true);
        assert.deepEqual(await snapshot(), freeManualBefore, 'Checking an unconfigured/manual appointment writes no rows');
        const freeManual = await post('/appointments', manual);
        assert.equal(freeManual.status, 201, JSON.stringify(freeManual.body));
        assert.equal(freeManual.body.tratamiento_id, null);
        await assertSpan(freeManual.body, '2030-01-09T10:00:00.000Z', '2030-01-09T10:30:00.000Z');

        // A distinct patient starts 15 minutes into a genuinely persisted
        // appointment. GET and POST must identify the same occupied full span.
        const busyManual = { values: { ...manual.values, paciente_id: 3,
          inicio: '2030-01-09T10:15:00Z', fin: '2030-01-09T10:45:00Z' } };
        const busyBefore = await snapshot();
        const manualCheck = await f.transport('check', { tratamiento_id: undefined, inicio_local: '2030-01-09T11:15',
          fin_local: '2030-01-09T11:45', doctor_id: 1, instalacion_id: 101, paciente_id: 3, duration_minutes: undefined });
        assert.equal(manualCheck.statusCode, 409); assert.equal(manualCheck.body.can_confirm_restrictions, true);
        for (const code of ['STAFF_OVERLAP', 'INSTALLATION_OVERLAP']) {
          const reason = manualCheck.body.booking_restrictions.find(item => item.code === code);
          assert(reason, JSON.stringify(manualCheck.body));
          assert.equal(reason.conflict_start_at, '2030-01-09T10:00:00.000Z');
          assert.equal(reason.conflict_end_at, '2030-01-09T10:30:00.000Z');
          assert.match(reason.message, /11:00.*11:30/);
        }
        const manualGrid = await f.transport('grid', { tratamiento_id: undefined, dates: ['2030-01-09'], mode: 'installation',
          column_ids: [101], context_doctor_id: 1, duracion_min: 30, granularity_min: 15,
          from_local: '11:00', to_local: '12:00', duration_minutes: undefined });
        assert.equal(manualGrid.statusCode, 200); assert.equal(manualGrid.body.rows[0].ok, true);
        const busyAt = +new Date(busyManual.values.inicio), row = manualGrid.body.rows[0];
        assert(!row.slots.some(slot => +new Date(slot.start_utc) === busyAt), 'An occupied start is not falsely returned as an ordinary available slot');
        assert(row.unavailable_intervals.some(interval => +new Date(interval.start_utc) <= busyAt && busyAt < +new Date(interval.end_utc)),
          'The manual start belongs to the native unavailable agenda band');
        const manualWarning = await post('/appointments', busyManual);
        assert.equal(manualWarning.status, 409); assert.equal(manualWarning.body.can_confirm_restrictions, true);
        assert.deepEqual(manualWarning.body.booking_restrictions.map(item => item.code).sort(),
          manualCheck.body.booking_restrictions.map(item => item.code).sort());
        assert.deepEqual(await snapshot(), busyBefore, 'Showing a warning, hovering its GET reason and cancelling means no mutation');
        const movedManual = await post('/appointments', acknowledge({ values: { ...busyManual.values,
          inicio: '2030-01-09T10:20:00Z', fin: '2030-01-09T10:50:00Z' } }, manualWarning));
        assert.equal(movedManual.status, 409); assert.notEqual(movedManual.body.booking_restriction_acknowledgement,
          manualWarning.body.booking_restriction_acknowledgement);
        assert.deepEqual(await snapshot(), busyBefore, 'A receipt for the old range cannot save the changed span');
        const acceptedManual = await post('/appointments', acknowledge(busyManual, manualWarning));
        assert.equal(acceptedManual.status, 201, JSON.stringify(acceptedManual.body));
        await assertSpan(acceptedManual.body, '2030-01-09T10:15:00.000Z', '2030-01-09T10:45:00.000Z');
        assert.equal(acceptedManual.body.import_metadata.booking_restriction_confirmation.confirmed_by, 1);
        assert.equal(await db.Tratamiento.count(), 7, 'Manual booking and acknowledgement never invent a catalog treatment');

        const roomless = await post('/appointments', { values: f.values({ tratamiento_id: null, paciente_id: 4,
          instalacion_id: null, tipo_cita: 'primera_sin_trat', inicio: '2030-01-09T12:00:00Z', fin: '2030-01-09T12:30:00Z' }) });
        assert.equal(roomless.status, 201, JSON.stringify(roomless.body));
        await assertSpan(roomless.body, '2030-01-09T12:00:00.000Z', '2030-01-09T12:30:00.000Z', { room: null });

        const overrun = { values: f.values({ tratamiento_id: null, paciente_id: 2,
          inicio: '2030-01-09T18:45:00Z', fin: '2030-01-09T19:15:00Z' }) };
        const overrunBefore = await snapshot(), overrunWarning = await post('/appointments', overrun);
        assert.equal(overrunWarning.status, 409); assert.equal(overrunWarning.body.can_confirm_restrictions, true);
        assert(overrunWarning.body.booking_restrictions.some(reason => reason.code === 'CLINIC_OUT_OF_HOURS'));
        for (const code of ['STAFF_OUT_OF_HOURS', 'INSTALLATION_OUT_OF_HOURS']) {
          const reason = overrunWarning.body.booking_restrictions.find(item => item.code === code);
          assert(reason); assert.equal(reason.overrun_minutes, 15); assert.equal(reason.schedule_end, '2030-01-09T19:00:00.000Z');
          assert.match(reason.message, /15 minutos.*20:00/);
        }
        assert.deepEqual(await snapshot(), overrunBefore);
        const acceptedOverrun = await post('/appointments', acknowledge(overrun, overrunWarning));
        assert.equal(acceptedOverrun.status, 201, JSON.stringify(acceptedOverrun.body));
        await assertSpan(acceptedOverrun.body, '2030-01-09T18:45:00.000Z', '2030-01-09T19:15:00.000Z');
        report.checks.push('Manual no-treatment and doctor-only native births persist the complete30-minute span and exactly the corresponding resource occupancies. GET/check and unavailable grid are read-only; genuine15-minute overlap reasons match POST; cancelled warnings create nothing, a changed-range receipt rejects, and exact acknowledgement reserves the full span. A15-minute end-of-hours overrun is precise and requires its own acknowledgement; no catalog treatment is created.');

        const simple = { values: f.values({ tratamiento_id: 4, paciente_id: 2,
          inicio: '2030-01-10T10:00:00Z', fin: '2030-01-10T10:30:00Z' }) };
        const simpleFree = await post('/appointments', simple); assert.equal(simpleFree.status, 201, JSON.stringify(simpleFree.body));
        assert.equal(bookingSegments(simpleFree.body).length, 1);
        await assertSpan(simpleFree.body, '2030-01-10T10:00:00.000Z', '2030-01-10T10:30:00.000Z');
        const simpleBusy = { values: { ...simple.values, paciente_id: 3, inicio: '2030-01-10T10:15:00Z', fin: '2030-01-10T10:45:00Z' } };
        const simpleBefore = await snapshot(), simpleWarning = await post('/appointments', simpleBusy);
        assert.equal(simpleWarning.status, 409); assert(simpleWarning.body.booking_restrictions.some(item => item.code === 'STAFF_OVERLAP'));
        assert.deepEqual(await snapshot(), simpleBefore);
        const simpleAccepted = await post('/appointments', acknowledge(simpleBusy, simpleWarning));
        assert.equal(simpleAccepted.status, 201, JSON.stringify(simpleAccepted.body));
        await assertSpan(simpleAccepted.body, '2030-01-10T10:15:00.000Z', '2030-01-10T10:45:00.000Z');
        assert.equal(bookingSegments(simpleAccepted.body).length, 1);
        assert.deepEqual(simpleAccepted.body.import_metadata.booking_restriction_confirmation.original_profile.phases[0].professionals.ids, [1]);
        report.checks.push('Simple fixed30 catalog treatment is actually reserved natively; a real same-clinic occupied start produces precise restrictions without writes, then one exact receipt persists the same complete profile, one card segment and its two occupancies.');

        const combinedProfile = f.profile(4, [
          f.phase('first', { duration_minutes: 30, start_offset_minutes: 0 }),
          f.phase('second', { duration_minutes: 30, start_offset_minutes: 15, installation_ids: [102],
            professionals: { mode: 'any', ids: [2], preferred_id: 2 } }),
        ]);
        await db.Tratamiento.create({ id_tratamiento: 43, clinica_id: 100, grupo_clinica_id: 50,
          nombre: 'OWNED genuine two-room combined treatment', origen: 'clinica', activo: true,
          clinical_config: { catalog_status: 'active', booking_profile: combinedProfile } });
        const combinedSelection = { first: { doctor_id: 1, installation_id: 101 }, second: { doctor_id: 2, installation_id: 102 } };
        const combined = { values: f.values({ tratamiento_id: 43, paciente_id: 2,
          inicio: '2030-01-11T10:00:00Z', fin: '2030-01-11T10:45:00Z' }), booking_selection: combinedSelection };
        const combinedFree = await post('/appointments', combined);
        assert.equal(combinedFree.status, 201, JSON.stringify(combinedFree.body));
        const segments = bookingSegments(combinedFree.body);
        assert.equal(segments.length, 2); assert.deepEqual(segments.map(item => item.phase_index), [1, 2]);
        assert.deepEqual(segments.map(item => [item.phase_key, utc(item.start_at), utc(item.end_at), item.installation_id, item.doctor_ids]), [
          ['first', '2030-01-11T10:00:00.000Z', '2030-01-11T10:30:00.000Z', 101, [1]],
          ['second', '2030-01-11T10:15:00.000Z', '2030-01-11T10:45:00.000Z', 102, [2]],
        ]);
        assert.equal((await f.occupancy(combinedFree.body.id_cita)).length, 4);
        assert.equal(utc(combinedFree.body.fin), '2030-01-11T10:45:00.000Z');

        // Only the SECOND step is occupied by a real distinct appointment.
        // The combined visit must not collapse to a free first-step row.
        const secondBusy = await post('/appointments', { values: f.values({ tratamiento_id: null, paciente_id: 4,
          doctor_id: 2, instalacion_id: 102, inicio: '2030-01-14T10:00:00Z', fin: '2030-01-14T10:30:00Z' }) });
        assert.equal(secondBusy.status, 201, JSON.stringify(secondBusy.body));
        const restrictedCombined = { ...combined, values: { ...combined.values,
          inicio: '2030-01-14T10:00:00Z', fin: '2030-01-14T10:45:00Z' } };
        const combinedBefore = await snapshot(), combinedWarning = await post('/appointments', restrictedCombined);
        assert.equal(combinedWarning.status, 409); assert.equal(combinedWarning.body.can_confirm_restrictions, true);
        assert(combinedWarning.body.booking_restrictions.some(reason => reason.code === 'STAFF_OVERLAP' && reason.phase_key === 'second'));
        assert(combinedWarning.body.booking_restrictions.some(reason => reason.code === 'INSTALLATION_OVERLAP' && reason.phase_key === 'second'));
        assert.deepEqual(await snapshot(), combinedBefore);
        const missingPhaseChoice = await post('/appointments', acknowledge({ ...restrictedCombined,
          booking_selection: { first: combinedSelection.first } }, combinedWarning));
        assert.equal(missingPhaseChoice.status, 409); assert.notEqual(missingPhaseChoice.body.can_confirm_restrictions, true);
        assert.deepEqual(await snapshot(), combinedBefore, 'One explicit phase cannot acknowledge unchosen resources of another phase');
        const combinedAccepted = await post('/appointments', acknowledge(restrictedCombined, combinedWarning));
        assert.equal(combinedAccepted.status, 201, JSON.stringify(combinedAccepted.body));
        assert.equal(bookingSegments(combinedAccepted.body).length, 2); assert.equal((await f.occupancy(combinedAccepted.body.id_cita)).length, 4);
        assert.deepEqual(combinedAccepted.body.import_metadata.booking.profile.phases.map(phase => [phase.start_offset_minutes, phase.duration_minutes]), [[0,30],[15,30]]);
        assert.equal(utc(combinedAccepted.body.fin), '2030-01-14T10:45:00.000Z');

        const failedBirthBefore = await snapshot();
        db.AppointmentBookingOccupancy.addHook('beforeBulkCreate', 'owned-combined-occupancy-failure', () => { throw Error('OWNED simulated occupancy INSERT failure'); });
        try {
          const failedBirth = await post('/appointments', { ...combined, values: { ...combined.values,
            inicio: '2030-01-15T10:00:00Z', fin: '2030-01-15T10:45:00Z' } });
          assert.equal(failedBirth.status, 500); assert.deepEqual(await snapshot(), failedBirthBefore,
            'A failed native multi-phase occupancy INSERT rolls back the actual appointment and every phase');
        } finally { db.AppointmentBookingOccupancy.removeHook('beforeBulkCreate', 'owned-combined-occupancy-failure'); }
        report.checks.push('A genuinely new v4 combined treatment birth persists ONE appointment with TWO real30-minute phases at offsets0/15, correct45-minute shared span, two rendered segment projections and four native occupancies. A busy SECOND phase cannot masquerade as a free first phase: its exact warning writes nothing, one acknowledgement saves every phase, and an injected native occupancy INSERT failure rolls the entire birth back.');

        // A foreign physical-room reservation may explain occupancy, but its
        // clinical/patient data is never part of the caller's warning payload.
        await db.Tratamiento.create({ id_tratamiento: 44, clinica_id: 200, grupo_clinica_id: 50,
          nombre: 'OWNED PRIVATE foreign treatment', origen: 'clinica', activo: true,
          clinical_config: { catalog_status: 'active', booking_profile: f.profile(1, [f.phase('foreign', {
            duration_minutes: 30, installation_ids: [201], professionals: { mode: 'any', ids: [2], preferred_id: 2 } })]) } });
        const foreign = await post('/appointments', { values: f.values({ clinica_id: 200, tratamiento_id: 44,
          paciente_id: 4, doctor_id: 2, instalacion_id: 201, motivo: 'OWNED PRIVATE foreign reason', nota: 'OWNED PRIVATE foreign note',
          inicio: '2030-01-16T10:00:00Z', fin: '2030-01-16T10:30:00Z' }) });
        assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
        const foreignBefore = await snapshot(), foreignWarning = await post('/appointments', { values: f.values({ tratamiento_id: null,
          paciente_id: 3, doctor_id: 1, instalacion_id: 101, inicio: '2030-01-16T10:15:00Z', fin: '2030-01-16T10:45:00Z' }) });
        assert.equal(foreignWarning.status, 409); assert(foreignWarning.body.booking_restrictions.some(item => item.other_clinic));
        assert(!JSON.stringify(foreignWarning.body).includes('OWNED PRIVATE'));
        assert.deepEqual(await snapshot(), foreignBefore);
        const inactiveOwn = await db.DoctorClinica.findOne({ where: { doctor_id: 2, clinica_id: 100 } });
        await inactiveOwn.update({ recibe_citas: false });
        const inactiveBefore = await snapshot(), inactiveWarning = await post('/appointments', { values: f.values({ tratamiento_id: null,
          paciente_id: 3, doctor_id: 2, instalacion_id: 102, inicio: '2030-01-16T12:00:00Z', fin: '2030-01-16T12:30:00Z' }) });
        assert.equal(inactiveWarning.status, 409); assert.notEqual(inactiveWarning.body.can_confirm_restrictions, true);
        assert.deepEqual(await snapshot(), inactiveBefore, 'A generic acknowledgement path never activates a non-receiving professional');
        await inactiveOwn.update({ recibe_citas: true });
        report.checks.push('Foreign alias occupancy warning redacts the real stored note/reason and foreign treatment label. A professional who does not receive appointments in this clinic is not made bookable or reactivated through the manual receipt path. No cross-clinic access grant is simulated by this synthetic actor boundary.');

        const linkedOwner = await post('/appointments', { values: f.values({ tratamiento_id: 4, paciente_id: 2,
          inicio: '2030-01-17T10:00:00Z', fin: '2030-01-17T10:30:00Z' }) });
        assert.equal(linkedOwner.status, 201, JSON.stringify(linkedOwner.body));
        const linkedOwnerRead = await f.read(linkedOwner.body.id_cita);
        const linkedFollower = await post('/appointments', { values: f.values({ tratamiento_id: 4, paciente_id: 2,
          inicio: '2030-01-17T10:30:00Z', fin: '2030-01-17T11:00:00Z' }),
          same_day_choice: { mode: 'link', appointment_id: linkedOwnerRead.id_cita, updated_at: linkedOwnerRead.updated_at } });
        assert.equal(linkedFollower.status, 201, JSON.stringify(linkedFollower.body));
        const linkedMember = await db.AppointmentPatientLinkMember.findByPk(linkedFollower.body.id_cita);
        assert(linkedMember); const linkedLedger = await db.AppointmentPatientLink.findByPk(linkedMember.link_id);
        assert.equal(linkedLedger.clinic_id, 100); assert.equal(linkedLedger.patient_id, 2);
        assert.equal(linkedLedger.owner_appointment_id, linkedOwnerRead.id_cita);
        assert.deepEqual((await db.AppointmentPatientLinkMember.findAll({ where: { link_id: linkedMember.link_id }, raw: true }))
          .map(item => Number(item.appointment_id)).sort((a,b)=>a-b), [linkedOwnerRead.id_cita, linkedFollower.body.id_cita].sort((a,b)=>a-b));
        await assertSpan(linkedFollower.body, '2030-01-17T10:30:00.000Z', '2030-01-17T11:00:00.000Z');
        const invalidLinksBefore = await snapshot();
        const combinedRead = await f.read(combinedFree.body.id_cita);
        const invalidCombinedLink = await post('/appointments', { values: f.values({ tratamiento_id: 4, paciente_id: 2,
          inicio: '2030-01-11T11:00:00Z', fin: '2030-01-11T11:30:00Z' }),
          same_day_choice: { mode: 'link', appointment_id: combinedRead.id_cita, updated_at: combinedRead.updated_at } });
        assert.equal(invalidCombinedLink.status, 409); assert.equal(invalidCombinedLink.body.code, 'appointment_link_invalid');
        assert.deepEqual(await snapshot(), invalidLinksBefore, 'A combined appointment cannot be transformed into separately editable linked children');
        const foreignRead = await f.read(foreign.body.id_cita);
        const invalidForeignLink = await post('/appointments', { values: f.values({ tratamiento_id: 4, paciente_id: 4,
          inicio: '2030-01-16T11:00:00Z', fin: '2030-01-16T11:30:00Z' }),
          same_day_choice: { mode: 'link', appointment_id: foreignRead.id_cita, updated_at: foreignRead.updated_at } });
        assert.equal(invalidForeignLink.status, 409); assert.equal(invalidForeignLink.body.code, 'appointment_link_invalid');
        assert.deepEqual(await snapshot(), invalidLinksBefore, 'A patient link cannot cross clinics even when a physical room is shared');
        report.checks.push('Actual loopback linked birth persists two distinct adjacent appointments and exactly one same-patient/same-clinic group with both IDs and notice owner. Attempts to link a combined appointment or a foreign-clinic appointment roll back birth and occupancy; linked groups never grant access or split combined phases.');

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
        report.restrictionIntegration = { native_sql: true, native_http_receipts: true, production_auth: false,
          synthetic_clinic_ids: [100,200], synthetic_patient_ids: [1,2,3,4],
          final_counts: await f.counts(), linked_groups: await db.AppointmentPatientLink.count(),
          linked_members: await db.AppointmentPatientLinkMember.count(),
          boundary: 'OWNED private MySQL and registered loopback only; real availability controllers/solver/booking command/link service/models/locks/receipt/persistence. Synthetic actor1 ACL boundary, no browser or production authentication claim; actual JWT/MFA/per-clinic ACL is covered by the separate shared-room suite.',
          cleanup: 'Only OWNED loopback handles and OWNED SQL/mysqld PID close; no actual patient, configured DB, sender, historical import or runtime configuration is used.' };
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        await f.close();
      }
    });
  });
