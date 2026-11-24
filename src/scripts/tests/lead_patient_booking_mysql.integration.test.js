'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedLeadPatientBookingFixture } = require('./helpers/owned-lead-patient-booking-fixture');

test('lead booking HTTP: stable occupied-slot confirmation, patient/NHC rollback, existing identity and concurrent attempts',
  { skip: process.env.LEAD_PATIENT_BOOKING_MYSQL_TEST !== '1', timeout: 180000 }, async t => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedLeadPatientBookingFixture(context), { db } = f;
      try {
        const acknowledge = (body, warning) => ({ ...body, booking_restriction_acknowledgement: warning.body.booking_restriction_acknowledgement,
          booking_plan_sha256: warning.body.booking_plan_sha256 });
        await f.lead();
        await f.physical.reserve({ appointmentValues: f.physical.values({ tratamiento_id: null, paciente_id: 1,
          inicio: '2030-01-11T10:00:00Z', fin: '2030-01-11T10:05:00Z' }) });
        const body = f.body(); let warning;
        await t.test('eight unconfirmed POSTs create no patient, clinic membership, NHC, lead transition or appointment', async () => {
          const before = await f.snapshot();
          for (let index = 0; index < 8; index++) {
            const result = await f.post(body); assert.equal(result.statusCode, 409, JSON.stringify(result.body));
            assert.equal(result.body.code, 'booking_restriction_confirmation_required');
            assert.equal(result.body.can_confirm_restrictions, true);
            assert.deepEqual(result.body.booking_restrictions.map(x => x.code).sort(), ['INSTALLATION_OVERLAP', 'STAFF_OVERLAP']);
            if (warning) assert.equal(result.body.booking_restriction_acknowledgement, warning.body.booking_restriction_acknowledgement);
            warning = result; assert.deepEqual(await f.snapshot(), before);
          }
          assert.equal(f.observers.length, 0);
        });
        await t.test('one explicit OK commits exactly one new patient, NHC, link, lead and full sixteen-minute appointment', async () => {
          const result = await f.post(acknowledge(body, warning));
          assert.equal(result.statusCode, 201, JSON.stringify(result.body));
          assert.equal(result.body.inicio, '2030-01-11T09:55:00.000Z'); assert.equal(result.body.fin, '2030-01-11T10:11:00.000Z');
          assert.equal(await db.Paciente.count(), 5); assert.equal(await db.CitaPaciente.count(), 2);
          const patient = await db.Paciente.findByPk(result.body.paciente_id);
          assert.equal(patient.telefono_movil, body.paciente.telefono); assert.equal(patient.numero_historia, '5');
          assert.equal(await db.PacienteClinica.count({ where: { paciente_id: patient.id_paciente, clinica_id: 100 } }), 1);
          assert.equal((await db.PatientHistoryCounter.findByPk('group:50')).next_number, 6);
          const lead = await db.LeadIntake.findByPk(701); assert.equal(lead.status_lead, 'citado');
          assert.equal(lead.call_outcome_appointment_id, result.body.id_cita);
          assert.match(result.body.import_metadata.booking_restriction_confirmation.prospective_patient_identity, /^[a-f0-9]{64}$/);
          assert.equal((await f.physical.occupancy(result.body.id_cita)).length, 2);
          const before = await f.snapshot(), repeated = await f.post(acknowledge(body, warning));
          assert.equal(repeated.statusCode, 409, JSON.stringify(repeated.body)); assert.deepEqual(await f.snapshot(), before);
        });
        await t.test('same contact lookup reuses its clinic patient for both numeric and text clinic IDs', async () => {
          const before = await db.Paciente.count();
          for (const clinica_id of [100, '100']) {
            const result = await f.resolve({ clinica_id, nombre: body.paciente.nombre, telefono: body.paciente.telefono });
            assert.equal(result.created, false); assert.equal(result.patient.numero_historia, '5');
          }
          assert.equal(await db.Paciente.count(), before);
        });
        await t.test('actual native afterPersist failure rolls back patient, NHC, membership, lead and booking together', async () => {
          await f.lead(702); const before = await f.snapshot(); f.failPersist(true);
          try {
            const result = await f.post(f.body({ lead_intake_id: 702, inicio: '2030-01-14T09:00:00Z', fin: '2030-01-14T09:16:00Z',
              paciente: { ...body.paciente, telefono: '34600000702' } }));
            assert.equal(result.statusCode, 500, JSON.stringify(result.body)); assert.deepEqual(await f.snapshot(), before);
          } finally { f.failPersist(false); }
        });
        await t.test('denied appointment permission does not resolve or register a patient', async () => {
          const before = await f.snapshot(); f.allow(false);
          try { assert.equal((await f.post(f.body())).statusCode, 403); assert.deepEqual(await f.snapshot(), before); }
          finally { f.allow(true); }
        });
        await t.test('four simultaneous free-slot requests reuse one patient and preserve the first booking', async () => {
          await f.lead(703); const beforePatients = await db.Paciente.count(), beforeAppointments = await db.CitaPaciente.count();
          const input = f.body({ lead_intake_id: 703, inicio: '2030-01-15T09:00:00Z', fin: '2030-01-15T09:16:00Z',
            paciente: { ...body.paciente, telefono: '34600000703' } });
          const results = await Promise.all(Array.from({ length: 4 }, () => f.post(input)));
          assert.equal(results.filter(x => x.statusCode === 201).length, 1, JSON.stringify(results));
          assert(results.filter(x => x.statusCode !== 201).every(x => x.statusCode === 409));
          assert.equal(await db.Paciente.count(), beforePatients + 1); assert.equal(await db.CitaPaciente.count(), beforeAppointments + 1);
          assert.equal(await db.Paciente.count({ where: { telefono_movil: input.paciente.telefono, clinica_id: 100 } }), 1);
        });
        await t.test('foreign contact candidates above twenty never hide a local or explicitly linked identity', async () => {
          const phone = '34600000704';
          for (let index = 0; index < 24; index++) await db.Paciente.create({ public_id: 'pac_owned_foreign_' + index,
            nombre: 'Paciente extranjero ficticio', apellidos: String(index), telefono_movil: phone, clinica_id: 200 });
          const local = await db.Paciente.create({ public_id: 'pac_owned_late_local', nombre: 'Paciente local ficticio', apellidos: 'Prueba',
            telefono_movil: phone, clinica_id: 100 });
          const before = await db.Paciente.count();
          const resolved = await f.resolve({ clinica_id: '100', nombre: 'Paciente local ficticio', telefono: phone });
          assert.equal(resolved.created, false); assert.equal(resolved.patient.id_paciente, local.id_paciente);
          assert.equal(await db.Paciente.count(), before);
          const linked = await db.Paciente.create({ public_id: 'pac_owned_linked_foreign', nombre: 'Paciente vinculado ficticio',
            apellidos: 'Prueba', telefono_movil: '34600000705', clinica_id: 200 });
          await db.PacienteClinica.create({ paciente_id: linked.id_paciente, clinica_id: 100, es_principal: false });
          const linkedResult = await f.resolve({ clinica_id: '100', nombre: linked.nombre, telefono: linked.telefono_movil });
          assert.equal(linkedResult.created, false); assert.equal(linkedResult.patient.id_paciente, linked.id_paciente);
        });
        await t.test('an unlinked foreign clinic patient is not silently reused or linked by contact matching', async () => {
          const foreign = await db.Paciente.create({ public_id: 'pac_owned_unlinked_foreign', nombre: 'Paciente ajeno ficticio',
            apellidos: 'Prueba', telefono_movil: '34600000706', clinica_id: 200 });
          const resolved = await f.resolve({ clinica_id: '100', nombre: 'Paciente local distinto', telefono: foreign.telefono_movil });
          assert.equal(resolved.created, true); assert.notEqual(resolved.patient.id_paciente, foreign.id_paciente);
          assert.equal(resolved.patient.clinica_id, 100);
          assert.equal(await db.PacienteClinica.count({ where: { paciente_id: foreign.id_paciente, clinica_id: 100 } }), 0);
        });
        await t.test('normal registration holding its native NHC counter and a simultaneous lead booking both commit without a clinic-FK deadlock', async () => {
          const [[schema]] = await f.sql.query('SHOW CREATE TABLE Pacientes');
          assert.match(schema['Create Table'], /FOREIGN KEY \(`clinica_id`\) REFERENCES `Clinicas` \(`id_clinica`\)/,
            'This interleaving requires the actual native patient-to-clinic foreign key');
          await f.lead(707);
          const beforePatients = await db.Paciente.count(), beforeAppointments = await db.CitaPaciente.count();
          const beforeCounter = Number((await db.PatientHistoryCounter.findByPk('group:50')).next_number);
          let releaseNormal, sawNormalCounter;
          const normalCanInsert = new Promise(resolve => { releaseNormal = resolve; });
          const normalOwnsCounter = new Promise(resolve => { sawNormalCounter = resolve; });
          // This hook is registered AFTER the native beforeCreate hook. Reaching
          // it proves the ordinary Paciente.create has already allocated/locked
          // its real group NHC and has not yet INSERTed or taken the clinic FK.
          const hook = 'owned-normal-registration-after-native-nhc';
          db.Paciente.addHook('beforeCreate', hook, async row => {
            if (row.public_id !== 'pac_owned_concurrent_normal') return;
            sawNormalCounter(); await normalCanInsert;
          });
          let normal, booking;
          try {
            normal = f.sql.transaction(async transaction => {
              const row = await db.Paciente.create({ public_id: 'pac_owned_concurrent_normal', nombre: 'Alta normal ficticia',
                apellidos: 'Concurrente', telefono_movil: '34600000907', clinica_id: 100 }, { transaction });
              await db.PacienteClinica.create({ paciente_id: row.id_paciente, clinica_id: 100, es_principal: true }, { transaction });
              return row;
            });
            normal.catch(() => {});
            await normalOwnsCounter;
            booking = f.post(f.body({ lead_intake_id: 707, inicio: '2030-01-16T09:00:00Z', fin: '2030-01-16T09:16:00Z',
              paciente: { nombre: 'Reserva ficticia', apellidos: 'Concurrente', telefono: '34600000707' } }));
            booking.catch(() => {});
            let counterWait = [];
            const deadline = Date.now() + 10000;
            do {
              [counterWait] = await f.sql.query(`SELECT requested.OBJECT_NAME, requested.LOCK_MODE, requested.LOCK_STATUS
                FROM performance_schema.data_lock_waits waits
                JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
                WHERE requested.OBJECT_SCHEMA=DATABASE() AND requested.OBJECT_NAME='PatientHistoryCounters'`);
              if (!counterWait.length) await new Promise(resolve => setTimeout(resolve, 15));
            } while (!counterWait.length && Date.now() < deadline);
            assert(counterWait.length, 'The lead booking must be observed actually waiting for the ordinary registration NHC lock');
            // On the old Clinic UPDATE -> NHC order this INSERT now waits for
            // the booking's clinic lock and MySQL detects a real deadlock. The
            // corrected order holds no incompatible clinic lock while waiting.
            releaseNormal();
            const [registered, reserved] = await Promise.all([normal, booking]);
            assert.equal(reserved.statusCode, 201, JSON.stringify(reserved.body));
            assert.notEqual(registered.id_paciente, reserved.body.paciente_id);
            assert.equal(await db.Paciente.count(), beforePatients + 2);
            assert.equal(await db.CitaPaciente.count(), beforeAppointments + 1);
            assert.equal(Number((await db.PatientHistoryCounter.findByPk('group:50')).next_number), beforeCounter + 2);
            assert.equal(Number(registered.numero_historia), beforeCounter);
            assert.equal(Number((await db.Paciente.findByPk(reserved.body.paciente_id)).numero_historia), beforeCounter + 1);
            assert.equal(await db.PacienteClinica.count({ where: { paciente_id: [registered.id_paciente, reserved.body.paciente_id], clinica_id: 100 } }), 2);
          } finally {
            releaseNormal(); db.Paciente.removeHook('beforeCreate', hook);
            await Promise.allSettled([normal, booking].filter(Boolean));
          }
        });
        await t.test('occupied booking requires both the dominant patient incident and the availability acknowledgement', async () => {
          const { DataTypes: D } = require('sequelize');
          db.PatientOperationalEvent = f.sql.define('PatientOperationalEvent', {
            id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
            patient_id: D.INTEGER, clinic_id: D.INTEGER, event_type: D.STRING, metadata: D.JSON,
          }, { timestamps: false });
          await db.PatientOperationalEvent.sync();
          const incidents = require('../../services/patientIncidents.service');
          const patient = await db.Paciente.create({ public_id: 'pac_incident_booking_fixture', nombre: 'Paciente ficticio', apellidos: 'Incidencia',
            telefono_movil: '34600000650', clinica_id: 100 });
          const patientId = patient.id_paciente;
          for (const daysAgo of [7, 3]) {
            const inicio = new Date(Date.now() - daysAgo * 86400000);
            await db.CitaPaciente.create(f.physical.values({ paciente_id: patientId, estado: 'no_asistio',
              inicio, fin: new Date(+inicio + 600000) }));
          }
          await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: 100, event_type: 'patient.incident.unwanted',
            metadata: { active: true, reason: 'Motivo ficticio' } });
          const input = f.body({ lead_intake_id: undefined,
            paciente: { id_paciente: patientId, nombre: patient.nombre, telefono: patient.telefono_movil } });
          const before = await f.snapshot();
          const pending = await f.post(input);
          assert.equal(pending.statusCode, 409, JSON.stringify(pending.body));
          assert.equal(pending.body.code, 'booking_restriction_confirmation_required');
          assert.equal(pending.body.booking_incident.kind, 'unwanted');
          assert.equal(pending.body.booking_incident.events, undefined);
          assert.equal(pending.body.booking_incident.reason, undefined);
          const patientOnly = await f.post({ ...input, attendance_incident_ack: pending.body.booking_incident.revision });
          assert.equal(patientOnly.body.code, 'booking_restriction_confirmation_required');
          const availability = acknowledge(input, pending);
          const slotOnly = await f.post(availability);
          assert.equal(slotOnly.body.code, 'patient_attendance_confirmation_required');
          assert.deepEqual(await f.snapshot(), before);
          assert.equal((await f.post({ ...availability, attendance_incident_ack: pending.body.booking_incident.revision })).statusCode, 201);

          await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: 100, event_type: 'patient.incident.unwanted',
            metadata: { active: false } });
          const warning = await incidents.bookingIncident({ db, patientId, clinicIds: [100] });
          assert.equal(warning.kind, 'attendance');
          assert.equal(warning.events.length, 2);
        });
        context.report.checks.push('Actual createCita controller and patient resolver, native patient/NHC hooks, identity/resource locks and canonical writer over owned MySQL: repeated/cancelled warnings roll back every patient-side write; an exact acknowledgement saves once; downstream failure is atomic; concurrency shares one patient; clinic scope precedes the twenty-contact limit. Native ordinary registration and lead booking interleave under an observed performance_schema NHC wait and both commit without a clinic-FK deadlock. Synthetic ACL and post-commit observer boundaries, zero provider/network/business-DB calls.');
      } finally { await f.close(); }
    }, { performanceSchema: true });
  });
