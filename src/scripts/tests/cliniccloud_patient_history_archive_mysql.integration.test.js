'use strict';
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const core = require('../../lib/cliniccloud-import/patient-history-archive');
const operator = require('../cliniccloud-patient-history-archive');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const c = await require('mysql2/promise').createConnection({ socketPath: report.root + '/mysql.sock', user: 'root', password: '', database: report.database, dateStrings: true, timezone: 'Z' });
  try {
    await c.query('CREATE TABLE Clinicas (id_clinica INT PRIMARY KEY,grupoClinicaId INT NOT NULL) ENGINE=InnoDB');
    await c.query('INSERT INTO Clinicas VALUES (66,29),(72,29),(74,30)');
    await c.query('CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY,public_id VARCHAR(64),clinica_id INT,nombre VARCHAR(255),apellidos VARCHAR(255),dni VARCHAR(255),email VARCHAR(255),telefono_movil VARCHAR(255),telefono_secundario VARCHAR(255),fecha_nacimiento DATETIME,sexo VARCHAR(255),profesion VARCHAR(255),notas_paciente TEXT,updatedAt DATETIME) ENGINE=InnoDB');
    await c.query("INSERT INTO Pacientes (id_paciente,public_id,clinica_id,nombre,apellidos,email,notas_paciente,updatedAt) VALUES (10,'FICT-10',66,'Nombre actual','','actual@example.invalid','Nota local protegida','2026-10-01 10:00:00'),(99,'FICT-99',74,'Ajeno','','ajeno@example.invalid','Otra clínica','2026-10-01 10:00:00')");
    await c.query('CREATE TABLE PacienteClinicas (id INT PRIMARY KEY,paciente_id INT,clinica_id INT,es_principal TINYINT) ENGINE=InnoDB');
    await c.query('INSERT INTO PacienteClinicas VALUES (1,10,66,1),(2,10,72,0),(3,99,74,1)');
    await c.query('CREATE TABLE PatientCustomFields (id INT AUTO_INCREMENT PRIMARY KEY,paciente_id INT,clinica_id INT,field_key VARCHAR(120),label VARCHAR(255),value TEXT,value_type VARCHAR(32),source VARCHAR(64),source_column VARCHAR(255),last_imported_at DATETIME,created_at DATETIME,updated_at DATETIME) ENGINE=InnoDB');
    await c.query("INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,value,source,source_column) VALUES (10,66,'cliniccloud_source_contact_id','20001','cliniccloud','idContacto')");
    const contact = { IDCONTACTO: '20001', NOMBRE: 'Origen ficticio', APELLIDOS: 'Ficticio', DNI: 'EXAMPLE001', EMAIL: 'origen@example.invalid', 'TELF. MOVIL': '+34 600 000 001', 'TELF. FIJO': '', 'F. NACIMIENTO': '20/05/1980', ALTA: '01/10/2026', SEXO: 'F', PROFESION: 'Profesión ficticia', NOTAS: 'Origen que no sustituye notas', WHATSAPP: 'Sí', RGPD: 'Sí' };
    const source = { account: core.SOURCE_ACCOUNT, name: 'BACKUP_CONTACTOS_2026-10-03.csv', date: '2026-10-03', sha256: hash('owned fixture'), rows: [{ source_row: 2, values: contact }] };
    const baseline = await operator.capture(c);
    let plan = core.buildArchivePlan({ source, ...baseline, today: '2026-10-10' }); core.validatePlan(plan);
    assert.equal(plan.operations.length, 1);
    const snapshot = async () => {
      const out = {};
      for (const table of ['Pacientes', 'PacienteClinicas', 'PatientCustomFields']) out[table] = (await c.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
      return hash(out);
    };
    const before = await snapshot();
    await c.beginTransaction(); const rehearsal = await operator.applyBatch(c, plan.operations); assert.equal(rehearsal.length, 1); await c.rollback();
    assert.equal(await snapshot(), before); report.checks.push('Real SQL rehearsal restores full patient, source-field and membership rows');
    await c.beginTransaction(); const committed = await operator.applyBatch(c, plan.operations); await c.commit();
    assert.equal(committed[0].archive_inserted, true);
    const patient = (await c.query('SELECT * FROM Pacientes WHERE id_paciente=10'))[0][0];
    assert.equal(patient.nombre, 'Nombre actual'); assert.equal(patient.email, 'actual@example.invalid'); assert.equal(patient.notas_paciente, 'Nota local protegida');
    assert.equal(patient.sexo, 'mujer'); assert.equal(patient.fecha_nacimiento, '1980-05-20 00:00:00');
    const archive = (await c.query("SELECT * FROM PatientCustomFields WHERE field_key LIKE 'cliniccloud_history_contact_%'"))[0][0];
    assert.equal(archive.source_column, 'BACKUP_CONTACTOS_2026-10-03.csv'); assert.deepEqual(JSON.parse(archive.value).contact, contact);
    report.checks.push('Real SQL fills only empties, stores source intact and preserves local notes/identity/contact edits');
    const repeat = core.buildArchivePlan({ source, ...await operator.capture(c), today: '2026-10-10' });
    assert.equal(repeat.operations.length, 0); assert.equal(repeat.unchanged.length, 1); report.checks.push('Idempotent second prepare does not generate duplicate archives');
    // Prepared source proof cannot silently attach to another patient later.
    await c.query("INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,value,source,source_column) VALUES (99,74,'cliniccloud_source_contact_id','20001','cliniccloud','idContacto')");
    const drifted = core.buildArchivePlan({ source, ...await operator.capture(c), today: '2026-10-10' });
    assert.equal(drifted.operations.length, 0); assert.equal(drifted.holds[0].reason, 'ambiguous_source_owner');
    const afterOther = await snapshot(); await c.beginTransaction();
    await assert.rejects(() => operator.applyBatch(c, plan.operations), /GLOBAL_SOURCE_IDENTITY_DRIFT/); await c.rollback();
    assert.equal(await snapshot(), afterOther); report.checks.push('Cross-clinic duplicate source ID blocks writes atomically');
    await c.query('DELETE FROM PatientCustomFields WHERE paciente_id=99');
    // A current patient change also invalidates the full-row CAS.
    await c.query("UPDATE Pacientes SET telefono_movil=NULL,profesion=NULL WHERE id_paciente=10");
    plan = core.buildArchivePlan({ source, ...await operator.capture(c), today: '2026-10-10' });
    assert.equal(plan.operations.length, 1);
    await c.query("INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,value,source,source_column) VALUES (10,66,'cliniccloud_alias_20002','20002','cliniccloud','idContacto')");
    const aliasDrift = await snapshot(); await c.beginTransaction();
    await assert.rejects(() => operator.applyBatch(c, plan.operations), /SOURCE_LINK_COMPARE_AND_SWAP_DRIFT/); await c.rollback();
    assert.equal(await snapshot(), aliasDrift); report.checks.push('A new alias after prepare invalidates all demographic writes');
    await c.query("DELETE FROM PatientCustomFields WHERE field_key='cliniccloud_alias_20002'");
    await c.query("UPDATE Pacientes SET notas_paciente='Nueva nota local' WHERE id_paciente=10");
    const changed = await snapshot(); await c.beginTransaction();
    await assert.rejects(() => operator.applyBatch(c, plan.operations), /PATIENT_COMPARE_AND_SWAP_DRIFT/); await c.rollback();
    assert.equal(await snapshot(), changed); report.checks.push('Full-row CAS protects edits made after prepare without blind replay');
  } finally { await c.end(); }
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
