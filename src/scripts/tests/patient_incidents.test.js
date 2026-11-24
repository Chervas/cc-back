'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const incidents = require('../../services/patientIncidents.service');
const previous = { id_cita: 1, estado: 'no_asistio', inicio: '2026-10-02T09:00:00Z' };
const latest = { id_cita: 2, estado: 'reprogramada', inicio: '2026-10-03T10:30:00Z' };
const restricted = { clinic_id: 72, actor_user_id: 4, occurred_at: new Date(), metadata: { active: true, reason: 'Motivo ficticio' } };

test('two latest appointments determine the banner and the acknowledgement', () => {
  const warning = incidents.attendanceIncident([latest, previous]);
  assert.equal(warning.label, 'No suele acudir');
  assert.deepEqual(warning.events.map(row => row.state), ['no_asistio', 'reprogramada']);
  assert.notEqual(warning.revision, incidents.attendanceIncident([{ ...latest, estado: 'no_asistio' }, previous]).revision);
  assert(incidents.attendanceIncident([{ ...latest, estado: 'cancelada' }, { ...previous, estado: 'cancelada' }]));
  assert.equal(incidents.attendanceIncident([{ ...latest, estado: 'completada' }, previous]), null);
  assert.equal(incidents.attendanceIncident([latest]), null);
  assert.equal(incidents.attendanceIncident([previous, latest]), null);
});

test('detail and lead use the same history and scope as the pre-pagination filter', async () => {
  const transaction = { fixture: true };
  const db = { sequelize: {
    getQueryInterface: () => ({ tableExists: async (table, options) => {
      assert.equal(table, 'AppointmentVisitMembers');
      if (options.transaction) assert.equal(options.transaction, transaction);
      return true;
    } }),
    query: async (query, options) => {
      assert.match(query, /a\.paciente_id = :patientId OR a\.lead_intake_id = :leadId/);
      assert.match(query, /INTERVAL 1 YEAR/);
      assert.match(query, /prp_extraction/);
      assert.deepEqual(options.replacements, { clinicIds: [72], patientId: 17, leadId: 41 });
      assert.equal(options.transaction, transaction);
      return [latest, previous];
    },
  } };
  const sql = await incidents.patientFilter({ db, value: 'attendance', clinicIds: [72, '66', '1) OR 1=1'] });
  assert.match(sql, /clinica_id IN \(72,66\)/);
  assert.match(sql, /LIMIT 1 OFFSET 1/);
  assert.match(sql, /prp_extraction/);
  await assert.rejects(incidents.patientFilter({ db, value: 'attendance OR 1=1', clinicIds: [72] }), { code: 'patient_incident_filter_invalid' });
  assert.equal((await incidents.attendance({ db, clinicIds: [72], patientId: 17, leadId: 41, transaction })).label, 'No suele acudir');
});

test('a commercial restriction is enforced for a known patient or the exact destination', async () => {
  const db = {
    PatientOperationalEvent: { findOne: async () => restricted },
    sequelize: { query: async () => [{ telefono_movil: '+34 600 111 222', email: 'qa@example.test' }] },
  };
  for (const identity of [{ patientId: 17 }, { phone: '+34600111222' }, { email: 'QA@example.test' }]) {
    await assert.rejects(incidents.assertCommercialAllowed({ db, clinicId: 72, ...identity }), {
      code: 'PATIENT_INCIDENT_COMMERCIAL_BLOCK', retryable: false,
    });
  }
  assert.equal(await incidents.unwantedRecipient({ db, clinicId: 72, phone: '+34600111223' }), false);
});

test('reason remains limited to the clinic that recorded it even when block applies elsewhere', async () => {
  const db = { PatientOperationalEvent: { findOne: async () => restricted },
    Usuario: { findByPk: async () => ({ nombre: 'Operador', apellidos: 'Ficticio' }) },
    sequelize: { getQueryInterface: () => ({ tableExists: async () => false }), query: async () => [] } };
  const own = await incidents.summary({ db, patientId: 17, clinicIds: [72] });
  assert.equal(own.unwanted.reason, 'Motivo ficticio');
  assert.equal(own.unwanted.editable_in_clinic, 72);
  const other = await incidents.summary({ db, patientId: 17, clinicIds: [66] });
  assert.deepEqual(other.unwanted, { editable_in_clinic: null });
  await assert.rejects(incidents.setUnwanted({ db, patientId: 17, clinicId: 66, active: false }), { code: 'patient_incident_other_clinic' });
});

test('the filters and messages read the actual MySQL history with and without visit packages, without crossing clinic scope',
  { skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
    await withIsolatedCampaignMysql(async ({ sql, models, report }) => {
      await sql.query('CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY, clinica_id INT, telefono_movil VARCHAR(32), telefono_secundario VARCHAR(32), email VARCHAR(80))');
      await sql.query('CREATE TABLE PacienteClinicas (paciente_id INT, clinica_id INT)');
      await sql.query('CREATE TABLE CitasPacientes (id_cita INT PRIMARY KEY,paciente_id INT,lead_intake_id INT,clinica_id INT,estado VARCHAR(24),inicio DATETIME,updated_at DATETIME,es_provisional BOOLEAN,reschedule_reason VARCHAR(32))');
      const { DataTypes } = require('sequelize');
      models.PatientOperationalEvent = sql.define('PatientOperationalEvent', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        patient_id: DataTypes.INTEGER, clinic_id: DataTypes.INTEGER, actor_user_id: DataTypes.INTEGER,
        event_type: DataTypes.STRING, source: DataTypes.STRING, metadata: DataTypes.JSON, occurred_at: DataTypes.DATE,
      }, { tableName: 'PatientOperationalEvents', timestamps: false });
      await models.PatientOperationalEvent.sync();
      await sql.query("INSERT INTO Pacientes VALUES (17,72,'+34 600 111 222','0034 600 111 233','qa@example.test'),(18,66,'+34 600 111 222',NULL,'other@example.test')");
      await sql.query(`INSERT INTO CitasPacientes VALUES
        (1,17,41,72,'no_asistio',UTC_TIMESTAMP()-INTERVAL 18 DAY,UTC_TIMESTAMP()-INTERVAL 18 DAY,0,NULL),
        (2,17,41,72,'reprogramada',UTC_TIMESTAMP()+INTERVAL 1 DAY,UTC_TIMESTAMP()-INTERVAL 4 DAY,0,'patient_request'),
        (3,17,41,72,'cancelada',UTC_TIMESTAMP()-INTERVAL 1 DAY,UTC_TIMESTAMP()-INTERVAL 1 DAY,1,NULL),
        (5,17,41,66,'completada',UTC_TIMESTAMP()-INTERVAL 1 DAY,UTC_TIMESTAMP()-INTERVAL 1 DAY,0,NULL)`);
      await incidents.setUnwanted({ db: models, patientId: 17, clinicId: 72, actorId: 4, active: true, reason: 'Motivo ficticio' });
      const checkFilter = async value => {
        const condition = await incidents.patientFilter({ db: models, value, clinicIds: [72] });
        const [rows] = await sql.query(`SELECT id_paciente FROM Pacientes Paciente WHERE ${condition}`);
        assert.deepEqual(rows.map(row => row.id_paciente), [17]);
      };
      // The deployed CRM schema lacks the visit-package tables. All common
      // entry points must still use attendance data and accept a new contact.
      await checkFilter('unwanted');
      await checkFilter('attendance');
      await sql.transaction(async transaction => {
        assert.equal(await incidents.attendance({ db: models, clinicIds: [72], patientId: 18, transaction }), null);
        assert.equal((await incidents.attendance({ db: models, clinicIds: [72], patientId: 17, transaction })).label, 'No suele acudir');
        assert.equal((await incidents.attendance({ db: models, clinicIds: [72], leadId: 41, transaction })).label, 'No suele acudir');
      });
      assert.equal(await incidents.attendance({ db: models, clinicIds: [66], leadId: 41 }), null);
      await sql.query('CREATE TABLE AppointmentVisitMembers (appointment_id INT PRIMARY KEY,role VARCHAR(24))');
      await sql.query("INSERT INTO CitasPacientes VALUES (4,17,41,72,'completada',UTC_TIMESTAMP()-INTERVAL 2 DAY,UTC_TIMESTAMP()-INTERVAL 2 DAY,0,NULL)");
      await sql.query("INSERT INTO AppointmentVisitMembers VALUES (4,'prp_extraction')");
      await checkFilter('attendance');
      assert.equal((await incidents.attendance({ db: models, clinicIds: [72], leadId: 41 })).label, 'No suele acudir');
      await assert.rejects(incidents.assertCommercialAllowed({ db: models, clinicId: 72, phone: '+34600111222' }), { code: 'PATIENT_INCIDENT_COMMERCIAL_BLOCK' });
      assert.equal(await incidents.unwantedRecipient({ db: models, clinicId: 66, phone: '+34600111222' }), false);
      assert.equal(await incidents.unwantedRecipient({ db: models, clinicId: 72, phone: '+34600111233' }), true);
      await incidents.setUnwanted({ db: models, patientId: 17, clinicId: 72, actorId: 4, active: false });
      assert.equal(await incidents.unwantedRecipient({ db: models, clinicId: 72, patientId: 17 }), false);
      report.checks.push('SQL filters, histories and exact commercial destinations matched synthetic authenticated clinic scope');
    });
  });
