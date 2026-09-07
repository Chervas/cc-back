'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./adapter');
const { PRIVATE_ROOT, syncDirectory } = require('./io');
const { CLINICS, identityRows } = require('./primary-followups-apply');
const fail = code => { throw new Error(code); };

function settings() {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USERNAME) fail('DATABASE_CONFIGURATION_MISSING');
  return { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, dateStrings: true, timezone: 'Z', multipleStatements: false };
}
async function connect() { return require('mysql2/promise').createConnection(settings()); }

async function captureLive(patientIds) {
  if (!patientIds.length || patientIds.some(id => !Number.isSafeInteger(id) || id <= 0)) fail('INVALID_PATIENT_CAPTURE_SCOPE');
  const connection = await connect();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (?) ORDER BY id_clinica', [CLINICS]);
    const [patients] = await connection.query('SELECT id_paciente, clinica_id, updatedAt FROM Pacientes WHERE id_paciente IN (?) ORDER BY id_paciente', [patientIds]);
    const [memberships] = await connection.query('SELECT id, paciente_id, clinica_id, es_principal, updatedAt FROM PacienteClinicas WHERE paciente_id IN (?) ORDER BY paciente_id, clinica_id, id', [patientIds]);
    // Identity index is deliberately account/clinic-wide to detect an exact
    // source ID newly duplicated onto another patient, not just chosen targets.
    const [identities] = await connection.query("SELECT id, paciente_id, clinica_id, field_key, source_column, source, value FROM PatientCustomFields WHERE clinica_id IN (?) AND source = 'cliniccloud' AND (source_column IN ('idContacto','contacto_1.csv','cliniccloud_contact_snapshot') OR field_key = 'cliniccloud_source_contact_id') ORDER BY id", [CLINICS]);
    const [followups] = await connection.query('SELECT id, public_id, patient_id, clinic_id, source_key, source_kind, source_namespace, source_reference, source_date, clinical_notes, status, version_number FROM PatientFollowUps WHERE clinic_id IN (?) ORDER BY id', [CLINICS]);
    await connection.rollback();
    return { captured_at: new Date().toISOString(), clinics, patients, memberships, identities, followups };
  } finally { await connection.end(); }
}

function createIsolatedModels() {
  // Load only passive model definitions, never models/index, associations,
  // Express, jobs, notifications or model-global initialization hooks.
  const config = settings();
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize(config.database, config.user, config.password, { dialect: 'mysql', host: config.host, port: config.port, timezone: '+00:00', logging: false, pool: { max: 2, min: 0, idle: 1000 } });
  const db = { sequelize, Sequelize };
  for (const name of ['paciente', 'pacienteclinica', 'patientcustomfield', 'patientfollowup', 'patientfollowuprevision', 'usuario', 'clinica', 'citapaciente', 'tratamiento']) {
    const model = require(path.resolve(__dirname, '../../../models', `${name}.js`))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  }
  return db;
}

function privateFile(filename, { existing = true } = {}) {
  if (!path.isAbsolute(filename)) fail('PRIVATE_PATH_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  const rootStat = fs.statSync(root);
  if (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0) fail('PRIVATE_ROOT_PERMISSIONS_INVALID');
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) fail('PATH_OUTSIDE_PRIVATE_IMPORT_ROOT');
  if (existing) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('PRIVATE_FILE_PERMISSIONS_INVALID');
  }
  return filename;
}

function openJournal(filename, preparedHash) {
  privateFile(filename, { existing: fs.existsSync(filename) });
  // One OS-exclusive lockfile per journal plus a DB advisory lock per account.
  // A stale lock is a manual review boundary, not automatically stolen.
  const lockPath = `${filename}.lock`;
  const lockFd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let fd;
  try {
    fs.writeSync(lockFd, `${JSON.stringify({ pid: process.pid, prepared_sha256: preparedHash })}\n`); fs.fsyncSync(lockFd);
    fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    syncDirectory(path.dirname(filename));
    const directoryFd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    const contents = fs.readFileSync(fd, 'utf8');
    if (contents && !contents.endsWith('\n')) fail('JOURNAL_TRUNCATED_REQUIRES_REVIEW');
    const records = contents.split('\n').filter(Boolean).map(line => JSON.parse(line));
    let previous = null;
    for (const row of records) {
      const { record_sha256, ...data } = row;
      if (hash(data) !== record_sha256 || data.previous_sha256 !== previous || data.prepared_sha256 !== preparedHash) fail('JOURNAL_HASH_OR_PLAN_MISMATCH');
      previous = record_sha256;
    }
    return {
      latestPatient: (id, digest) => [...records].reverse().find(row => row.patient_id === id && row.prepared_sha256 === digest),
      append: async value => {
        if (value.prepared_sha256 !== preparedHash) fail('JOURNAL_PLAN_MISMATCH');
        const data = { ...value, previous_sha256: previous }, row = { ...data, record_sha256: hash(data) };
        const bytes = Buffer.from(`${JSON.stringify(row)}\n`); let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
        fs.fsyncSync(fd); records.push(row); previous = row.record_sha256;
      },
      close: () => { fs.closeSync(fd); fs.closeSync(lockFd); fs.unlinkSync(lockPath); },
    };
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(lockFd); fs.unlinkSync(lockPath); throw error; }
}

async function withAccountLock(callback) {
  const connection = await connect(); let acquired = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK('cliniccloud-5880-primary-followups-import',0) AS acquired");
    if (Number(rows[0].acquired) !== 1) fail('ANOTHER_PRIMARY_FOLLOWUP_IMPORT_RUNNING');
    acquired = true; return await callback();
  } finally { if (acquired) await connection.query("SELECT RELEASE_LOCK('cliniccloud-5880-primary-followups-import')"); await connection.end(); }
}

function verifyLiveIdentity(prepared, live) {
  if (prepared.global_identity_sha256 !== hash(identityRows(live.identities))) fail('GLOBAL_SOURCE_IDENTITY_INDEX_CHANGED');
}
module.exports = { captureLive, createIsolatedModels, privateFile, openJournal, withAccountLock, verifyLiveIdentity };
