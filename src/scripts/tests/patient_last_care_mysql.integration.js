'use strict';

const assert = require('node:assert/strict');
const { QueryTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createPatientLastCareReader, createSqlPatientLastCareRepository, ARRIAGA_BUNDLE } = require('../../services/patientLastCare.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  // Minimal owned fixture only: no production models, migrations, database,
  // secrets or messaging transport are loaded by this test.
  const ddl = [
    'CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY,clinica_id INT NOT NULL,fecha_baja DATETIME NULL)',
    'CREATE TABLE PacienteClinicas (paciente_id INT NOT NULL,clinica_id INT NOT NULL)',
    'CREATE TABLE CitasPacientes (id_cita BIGINT UNSIGNED PRIMARY KEY,paciente_id INT NOT NULL,clinica_id INT NOT NULL,estado VARCHAR(40) NOT NULL,inicio DATETIME NOT NULL)',
    'CREATE TABLE ImportedClinicalCatalogs (id BIGINT UNSIGNED PRIMARY KEY,clinic_id INT,source_system VARCHAR(50),source_instance VARCHAR(100),bundle_sha256 CHAR(64))',
    'CREATE TABLE PatientImportedIdentities (id BIGINT UNSIGNED PRIMARY KEY,catalog_id BIGINT UNSIGNED,patient_id INT,clinic_id INT,source_system VARCHAR(50),source_instance VARCHAR(100),source_patient_id VARCHAR(80),bundle_sha256 CHAR(64),messages_hold BOOLEAN NOT NULL)',
    'CREATE TABLE PatientImportedSourceRecords (id BIGINT UNSIGNED PRIMARY KEY,identity_id BIGINT UNSIGNED,patient_id INT,clinic_id INT,source_key CHAR(64),source_database VARCHAR(120),source_table VARCHAR(80),category VARCHAR(32),record_date DATE,row_sha256 CHAR(64),database_sha256 CHAR(64),bundle_sha256 CHAR(64),record_json MEDIUMTEXT)',
  ];
  for (const statement of ddl) await sql.query(statement);
  await sql.query('INSERT INTO Pacientes VALUES (41,1,NULL),(43,1,\'2026-01-01\')');
  await sql.query('INSERT INTO PacienteClinicas VALUES (41,70)');
  await sql.query(`INSERT INTO CitasPacientes VALUES
    (71,41,1,'completada','2026-08-01 09:00:00'),
    (72,41,1,'pendiente','2026-10-10 09:00:00'),
    (73,41,1,'completada','2026-12-01 09:00:00'),
    (74,41,70,'completada','2026-10-02 09:00:00'),
    (75,41,1,'COMPLETADA','2026-10-05 09:00:00')`);
  for (const [id, clinicId] of [[10, 1], [11, 70]]) await sql.query(`INSERT INTO ImportedClinicalCatalogs
    VALUES (:id,:clinicId,'arriaga_excel',:instance,:bundle)`, {
    replacements: { id, clinicId, instance: `arriaga-excel-20261026:clinic-${clinicId}`, bundle: ARRIAGA_BUNDLE },
  });
  for (const [id, catalogId, clinicId, held] of [[20, 10, 1, 0], [21, 11, 70, 0], [99, 99, 99, 1]]) {
    await sql.query(`INSERT INTO PatientImportedIdentities VALUES
      (:id,:catalogId,41,:clinicId,'arriaga_excel',:instance,'master-row-fictitious',:bundle,:held)`, {
      replacements: { id, catalogId, clinicId, instance: `arriaga-excel-20261026:clinic-${clinicId}`, bundle: ARRIAGA_BUNDLE, held },
    });
  }
  async function insertRecord(id, date, changes = {}) {
    const sourceKey = BigInt(id).toString(16).padStart(64, '0');
    const row = { id, identity_id: 20, patient_id: 41, clinic_id: 1, source_key: sourceKey,
      source_database: 'procedencia servicios 2026.xlsx', source_table: '2026 servicios', category: 'historical',
      record_date: date, row_sha256: 'a'.repeat(64), database_sha256: 'b'.repeat(64), bundle_sha256: ARRIAGA_BUNDLE, ...changes.row };
    const envelope = { version: 'arriaga_patient_source_record/1', provider: 'arriaga_excel',
      source_instance: 'arriaga-excel-20261026:clinic-1', source_patient_id: 'master-row-fictitious',
      clinic_id: 1, source_database: row.source_database, source_table: row.source_table,
      source_row: 2, source_key: sourceKey, record_date: date, category: 'historical',
      row_sha256: row.row_sha256, database_sha256: row.database_sha256, bundle_sha256: ARRIAGA_BUNDLE,
      record: { service_label: 'Servicio ficticio realizado', service_family: 'fictitious',
        source_classification: 'FICTITIOUS', site_assignment: 'fictitious-site' }, ...changes.envelope };
    row.record_json = changes.invalidJson ? '{broken' : JSON.stringify(envelope);
    const keys = Object.keys(row);
    await sql.query(`INSERT INTO PatientImportedSourceRecords (${keys.join(',')}) VALUES (${keys.map(key => `:${key}`).join(',')})`, { replacements: row });
  }
  await insertRecord('90071992547409931', '2026-09-30');
  await insertRecord('90071992547409932', '2026-09-30');
  await insertRecord('103', '2026-10-10', { envelope: { record: { service_label: 'PAGO', service_family: 'fictitious',
    source_classification: 'FICTITIOUS', site_assignment: 'fictitious-site' } } });
  await insertRecord('104', '2026-10-11', { invalidJson: true });
  await insertRecord('105', '2026-10-12', { row: { source_table: 'Pagos' } });
  await insertRecord('106', '2026-10-13', { envelope: { source_patient_id: 'another-source-patient' } });
  await insertRecord('107', '2026-10-14', { envelope: { clinic_id: 70 } });
  await insertRecord('108', '2026-10-15', { envelope: { record: { service_label: 'Servicio ficticio', service_family: 'fictitious',
    source_classification: 'FICTITIOUS', site_assignment: 'fictitious-site', notes: 'MUST_NOT_ESCAPE' } } });
  await insertRecord('109', '2026-12-01');
  await insertRecord('110', '2026-10-16', { envelope: { clinic_id: '1junk' } });
  await insertRecord('111', '2026-10-17', { envelope: { version: 'ARRIAGA_PATIENT_SOURCE_RECORD/1' } });
  await insertRecord('112', '2026-10-18', { row: { row_sha256: 'g'.repeat(64) } });
  await insertRecord('113', '2026-10-19', { row: { source_database: 'PROCEDENCIA SERVICIOS 2026.xlsx' } });

  const calls = [];
  const repository = createSqlPatientLastCareRepository({ query: async (statement, replacements) => {
    assert.match(statement, /^(SELECT|WITH) /);
    assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    calls.push(statement);
    return sql.query(statement, { replacements, type: QueryTypes.SELECT });
  } });
  const reader = createPatientLastCareReader({ repository, now: () => new Date('2026-11-12T12:00:00Z'),
    authorize: async () => ({ actorId: 501, sessionRef: 'owned-fixture' }) });
  const first = (await reader.read({ clinicId: 1, patientIds: [41] })).items[0];
  assert.equal(first.latestAttendance.date, '2026-08-01');
  assert.equal(first.latestPerformedService.date, '2026-09-30');
  assert.equal(first.latestPerformedService.provenance.length, 2);
  assert.equal(first.latestPerformedService.provenance[0].sourceRecordId, '90071992547409931');
  assert.equal(first.latestCare.kind, 'performed_service_import');
  assert.equal(first.importedMessagesHold, true, 'a hold on any imported identity remains a global patient hold');
  assert.equal(first.communicationEligibility, 'not_assessed');
  assert.equal(JSON.stringify(first).includes('MUST_NOT_ESCAPE'), false);
  assert.equal(JSON.stringify(first).includes('Servicio ficticio'), false);
  report.checks.push('Real MySQL CTE qualifies metadata before MAX, ignores pending/future/admin/invalidJSON/foreignsubject/foreignclinic/notes/coercion/case/digest envelopes, preserves exact BIGINT IDs and latest-day ties');

  const other = (await reader.read({ clinicId: 70, patientIds: [41] })).items[0];
  assert.equal(other.latestCare.date, '2026-10-02');
  assert.equal(other.latestPerformedService, null);
  assert.equal(other.importedMessagesHold, true);
  await assert.rejects(reader.read({ clinicId: 1, patientIds: [43] }), { code: 'patient_last_care_patient_scope_denied' });
  await assert.rejects(reader.read({ clinicId: 2, patientIds: [41] }), { code: 'patient_last_care_patient_scope_denied' });
  report.checks.push('Exact pair membership, active patient and cross-clinic separation enforced by real SELECT; global HOLD remains independent');
  const [counts] = await sql.query('SELECT COUNT(*) AS n FROM PatientImportedSourceRecords', { type: QueryTypes.SELECT });
  assert.equal(Number(counts.n), 13);
  assert.ok(calls.length > 0);
  report.checks.push('Reader executed SELECT/WITH only and did not alter source records or create appointments/events/queues/messages');
}).catch(error => { console.error(error); process.exitCode = 1; });
