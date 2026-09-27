#!/usr/bin/env node
'use strict';

// Operator-only, one explicit allowlisted migration per run; no app bootstrap.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const NAME = '20260926180000-version-medical-area-contracts.js';
const ADOPTION_NAME = '20260927103000-create-medical-area-adoptions.js';
const ALLOWED = Object.freeze([NAME, ADOPTION_NAME]);

async function verifyAdoptionSchema(connection, qi) {
  const columns = await qi.describeTable('MedicalAreaAdoptions');
  for (const name of ['id', 'clinic_id', 'code', 'revision_id', 'actor_id', 'review_hash', 'review_json', 'reason', 'created_at']) {
    if (!columns[name] || columns[name].allowNull) throw Error('AREA_ADOPTION_SCHEMA_VERIFICATION_FAILED');
  }
  if (!columns.id.primaryKey || !columns.previous_revision_id?.allowNull || columns.updated_at
    || columns.review_json.type.toUpperCase() !== 'JSON'
    || !columns.review_hash.type.includes('64') || !columns.reason.type.includes('500')) throw Error('AREA_ADOPTION_SCHEMA_VERIFICATION_FAILED');
  const indexes = await qi.showIndex('MedicalAreaAdoptions');
  if (!indexes.some(index => index.name === 'medical_area_adoption_clinic_code'
    && index.fields.map(field => field.attribute).join(',') === 'clinic_id,code,id')) throw Error('AREA_ADOPTION_INDEX_VERIFICATION_FAILED');
  const [constraints] = await connection.query(`SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='MedicalAreaAdoptions'`);
  for (const [column, table, referenced] of [['clinic_id', 'Clinicas', 'id_clinica'], ['revision_id', 'MedicalAreaContractRevisions', 'id']]) {
    if (!constraints.some(row => row.COLUMN_NAME === column && row.REFERENCED_TABLE_NAME === table
      && row.REFERENCED_COLUMN_NAME === referenced && ['RESTRICT', 'NO ACTION'].includes(row.DELETE_RULE))) throw Error('AREA_ADOPTION_FOREIGN_KEY_VERIFICATION_FAILED');
  }
  const [[counts]] = await connection.query('SELECT COUNT(*) AS adoptions FROM MedicalAreaAdoptions');
  return counts;
}

async function run(args) {
  const o = parseArgs(args, ['--target', '--migration', '--approved-migration-sha256', '--backup-manifest', '--private-journal']);
  const name = o['--migration'] || NAME;
  if (!ALLOWED.includes(name)) throw Error('AREA_SCHEMA_MIGRATION_NOT_ALLOWED');
  if (!['dev', 'crm'].includes(o['--target']) || !o['--private-journal']) throw Error('AREA_SCHEMA_EXPLICIT_TARGET_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev'
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('AREA_SCHEMA_COMMITTED_DEV_SOURCE_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const file = path.resolve(__dirname, '../../migrations', name), sha = hash(readBytes(file));
  if (sha !== o['--approved-migration-sha256']) throw Error('AREA_SCHEMA_APPROVED_MIGRATION_REQUIRED');
  const manifest = privateJson(o['--backup-manifest']);
  if (manifest.database_target !== o['--target'] || manifest.full_gzip_verified !== true || manifest.dump_completion_verified !== true
    || !Number.isFinite(Date.parse(manifest.generated_at)) || Date.now() - Date.parse(manifest.generated_at) > 7200000) {
    throw Error('AREA_SCHEMA_FRESH_VERIFIED_TARGET_BACKUP_REQUIRED');
  }
  await validateBackup(o['--backup-manifest']);
  const connection = await connectOperatorDatabase(o['--target']);
  let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    await acquireExecutorLocks(connection, sha, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], sha);
    const Sequelize = require('sequelize');
    const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const qi = sequelize.getQueryInterface();
    const [meta] = await connection.query('SELECT name FROM SequelizeMeta WHERE name=?', [name]);
    await journal.append({ phase: 'before_migration', target: o['--target'], migration: name, sha256: sha, source_commit: commit,
      backup_manifest_sha256: hash(readBytes(o['--backup-manifest'])) });
    let assignmentsBefore;
    const assignmentsHash = async () => hash(Buffer.from(JSON.stringify((await connection.query('SELECT * FROM ClinicMedicalAreaContracts ORDER BY id'))[0])));
    if (name === ADOPTION_NAME) assignmentsBefore = await assignmentsHash();
    if (!meta.length) await require(file).up(qi);
    let counts;
    if (name === ADOPTION_NAME) {
      counts = await verifyAdoptionSchema(connection, qi);
      if (assignmentsBefore !== await assignmentsHash()) throw Error('AREA_ADOPTION_ASSIGNMENTS_CHANGED');
    } else {
    [[counts]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM MedicalAreaContractRevisions) AS revisions,
      (SELECT COUNT(*) FROM ClinicMedicalAreaContracts) AS assignments,
      (SELECT COUNT(*) FROM MedicalAreaContracts WHERE active = 1 AND revision_id IS NULL) AS unversioned,
      (SELECT COUNT(*) FROM Clinicas c CROSS JOIN MedicalAreaContractRevisions r
       LEFT JOIN ClinicMedicalAreaContracts p ON p.clinic_id = c.id_clinica AND p.code = r.code
       WHERE r.revision_number = 1 AND r.created_by IS NULL AND p.id IS NULL) AS missing_assignments`);
    const column = (await qi.describeTable('PatientNutritionMeasurements')).area_contract_revision_id;
    if (!Number(counts.revisions) || Number(counts.unversioned) || Number(counts.missing_assignments) || !column?.allowNull) throw Error('AREA_SCHEMA_VERIFICATION_FAILED');
    }
    if (!meta.length) await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [name]);
    await journal.append({ phase: 'verified', target: o['--target'], migration: name, counts,
      ...(assignmentsBefore ? { assignments_unchanged_sha256: assignmentsBefore } : {}),
      reminders_changed: false, historical_documents_changed: false });
    return { status: meta.length ? 'already_applied_verified' : 'applied_verified', target: o['--target'], migration: name, counts };
  } finally { journal?.close(); await connection.end(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'AREA_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL');
  process.exitCode = 1;
});
module.exports = { run, NAME, ADOPTION_NAME, verifyAdoptionSchema };
