#!/usr/bin/env node
'use strict';
// Explicit additive structure only. No app, runtime models, provider or worker.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { observedEnvironment } = require('./security-email-login-metadata');
const { configuration } = require('./security-database-metadata');
async function main() {
 const [action, runtime, evidence] = process.argv.slice(2);
 if (!['check', 'apply'].includes(action) || !['dev', 'staging'].includes(runtime) || !evidence
   || !path.isAbsolute(evidence) || !fs.realpathSync(path.dirname(evidence)).startsWith('/home/ubuntu/qa-evidence/')) throw Error('link_schema_arguments_invalid');
 const migrationPath = require.resolve('../../migrations/20261007170000-create-appointment-patient-links');
 const hash = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
 const file = fs.openSync(evidence, 'wx', 0o600);
 let sql;
 try {
  const c = configuration(observedEnvironment(runtime).env), S = require('sequelize');
  sql = new S(c.database, c.user, c.password, { dialect: 'mysql', logging: false, dialectOptions: { socketPath: c.socketPath }, pool: { max: 1, min: 0 } });
  const tables = ['AppointmentPatientLinks', 'AppointmentPatientLinkMembers'];
  const [[lock]] = await sql.query("SELECT GET_LOCK('clinicaclick_appointment_patient_links_schema',0) AS acquired");
  if (Number(lock.acquired) !== 1) throw Error('link_schema_busy');
  const [before] = await sql.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentPatientLinks','AppointmentPatientLinkMembers')");
  const receipt = { runtime, action, migration_sha256: hash, before: before.map(row => row.TABLE_NAME), changes: [] };
  fs.writeFileSync(file, JSON.stringify(receipt) + '\n'); // Reserve journal before DDL.
  if (action === 'apply' && !before.length) {
   await sql.query('SET SESSION lock_wait_timeout=15');
   await require(migrationPath).up(sql.getQueryInterface(), S);
   receipt.changes = tables;
  } else if (before.length && before.length !== tables.length) throw Error('link_schema_partially_installed');
  const [columns] = await sql.query("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentPatientLinks','AppointmentPatientLinkMembers') ORDER BY TABLE_NAME,ORDINAL_POSITION");
  const [constraints] = await sql.query("SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('AppointmentPatientLinks','AppointmentPatientLinkMembers') ORDER BY TABLE_NAME,CONSTRAINT_NAME");
  const expected = { AppointmentPatientLinks: ['id','clinic_id','patient_id','owner_appointment_id','revision','created_by','created_at','updated_at'],
    AppointmentPatientLinkMembers: ['appointment_id','link_id','created_at','updated_at'] };
  receipt.installed = tables.every(table => expected[table].every(name => columns.some(row => row.TABLE_NAME === table && row.COLUMN_NAME === name)))
    && constraints.filter(row => row.CONSTRAINT_TYPE === 'FOREIGN KEY').length === 5
    && constraints.filter(row => row.CONSTRAINT_TYPE === 'PRIMARY KEY').length === 2;
  if (action === 'apply' && receipt.installed) await sql.query('INSERT IGNORE INTO SequelizeMeta (name) VALUES (?)', { replacements: [path.basename(migrationPath)] });
  receipt.columns = columns; receipt.constraints = constraints;
  fs.writeFileSync(file, JSON.stringify(receipt) + '\n');
  console.log(JSON.stringify({ runtime, installed: receipt.installed, created: receipt.changes }));
  if (action === 'apply' && !receipt.installed) throw Error('link_schema_not_installed');
 } finally { if (sql) { await sql.query("SELECT RELEASE_LOCK('clinicaclick_appointment_patient_links_schema')").catch(() => {}); await sql.close(); } fs.closeSync(file); }
}
if (require.main === module) main().catch(error => { console.error(error.original?.code || error.code || error.message); process.exitCode = 1; });
