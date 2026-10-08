#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const ROOT = '/home/ubuntu/wt/back-dev';
const MIGRATION = '20261008150000-appointment-care-lifecycle.js';
const ADDED = ['care_completed_at', 'care_completed_by', 'care_legacy_attendance'];
const OLD = ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado',
  'cambio_solicitado', 'completada', 'no_asistio', 'cancelada', 'reprogramada'];
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = code => { throw Error(code); };
const same = (a, b) => digest(a) === digest(b);

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('CARE_SCHEMA_COMMITTED_CANONICAL_DEV_REQUIRED');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    migration_sha256: digest(fs.readFileSync(path.join(ROOT, 'migrations', MIGRATION))) };
}
function privatePath(filename, existing = false) {
  if (!filename || path.resolve(filename) !== filename || !path.isAbsolute(filename) || !filename.startsWith('/home/ubuntu/secure-imports/')) fail('CARE_SCHEMA_PRIVATE_PATH_REQUIRED');
  let directory = path.dirname(filename);
  while (directory !== '/home/ubuntu/secure-imports') {
    const s = fs.lstatSync(directory);
    if (s.isSymbolicLink() || !s.isDirectory() || s.mode & 0o077) fail('CARE_SCHEMA_PRIVATE_DIRECTORY_REQUIRED');
    directory = path.dirname(directory);
  }
  if (existing) {
    const s = fs.lstatSync(filename);
    if (s.isSymbolicLink() || !s.isFile() || s.mode & 0o077) fail('CARE_SCHEMA_PRIVATE_FILE_REQUIRED');
  } else if (fs.existsSync(filename)) fail('CARE_SCHEMA_OUTPUT_EXISTS');
  return filename;
}
function write(filename, value) { fs.writeFileSync(privatePath(filename), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function enumValues(type) { return [...String(type).matchAll(/'([^']+)'/g)].map(m => m[1]); }
function expectedRows(rows) {
  return rows.map(row => {
    const out = { ...row };
    for (const name of ADDED) delete out[name];
    if (row.estado === 'completada' && row.care_completed_at == null) out.estado = 'ha_acudido';
    else if (!row.care_legacy_attendance && ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
      'recordatorio_confirmado', 'reprogramada'].includes(row.estado) && row.arrived_at != null
      && row.care_schedule_start != null && row.care_schedule_start === row.inicio) {
      out.estado = row.care_started_at == null ? 'ha_acudido' : 'en_atencion';
    }
    return out;
  });
}
async function capture(connection) {
  const q = async (sql, args = []) => (await connection.query(sql, args))[0];
  const columns = await q('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['CitasPacientes']);
  const rows = await q('SELECT * FROM CitasPacientes ORDER BY id_cita');
  const doctors = await q('SELECT * FROM DoctorClinicas ORDER BY id');
  const metadata = (await q('SELECT name FROM SequelizeMeta ORDER BY name')).map(r => r.name);
  const triggers = await q('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?,?) ORDER BY TRIGGER_NAME', ['CitasPacientes', 'SequelizeMeta']);
  if (triggers.length) fail('CARE_SCHEMA_TRIGGERS_REQUIRE_REVIEW');
  const stripped = rows.map(row => { const copy = { ...row }; ADDED.forEach(name => delete copy[name]); return copy; });
  return { columns, rows, summary: { count: rows.length, row_sha256: digest(stripped), expected_row_sha256: digest(expectedRows(rows)),
    legacy_count: rows.filter(r => r.estado === 'completada' && r.care_completed_at == null).length,
    doctors_sha256: digest(doctors), columns, metadata } };
}
function assertBefore(state) {
  if (ADDED.some(name => state.columns.some(c => c.COLUMN_NAME === name)) || state.metadata.includes(MIGRATION)
    || !same(enumValues(state.columns.find(c => c.COLUMN_NAME === 'estado')?.COLUMN_TYPE), OLD)) fail('CARE_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
}
function assertAfter(before, current) {
  const after = current.summary;
  const ordinary = columns => columns.filter(c => c.COLUMN_NAME !== 'estado' && !ADDED.includes(c.COLUMN_NAME));
  if (!same(ordinary(before.columns), ordinary(after.columns))
    || !same(enumValues(after.columns.find(c => c.COLUMN_NAME === 'estado')?.COLUMN_TYPE), [...OLD, 'ha_acudido', 'en_atencion'])
    || !ADDED.every(name => after.columns.some(c => c.COLUMN_NAME === name))) fail('CARE_SCHEMA_SCHEMA_VERIFICATION_FAILED');
  if (before.expected_row_sha256 !== after.row_sha256 || before.count !== after.count
    || before.doctors_sha256 !== after.doctors_sha256) fail('CARE_SCHEMA_DATA_VERIFICATION_FAILED');
  const legacy = current.rows.filter(r => Number(r.care_legacy_attendance) === 1);
  if (legacy.length !== before.legacy_count || legacy.some(r => r.estado !== 'ha_acudido')
    || current.rows.some(r => r.care_completed_at != null || r.care_completed_by != null)) fail('CARE_SCHEMA_FABRICATED_COMPLETION_OR_LEGACY_FAILED');
}
function assertStopped(target) {
  if (target === 'dev') {
    for (const unit of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
      if (!['inactive', 'failed'].includes(execFileSync('systemctl', ['show', '--property=ActiveState', '--value', unit], { encoding: 'utf8' }).trim())) fail('CARE_SCHEMA_STOP_DEV_WRITERS_FIRST');
    }
  } else {
    if (!['inactive', 'failed'].includes(execFileSync('systemctl', ['show', '--property=ActiveState', '--value',
      'clinicaclick-whatsapp-fresh-inbound.service'], { encoding: 'utf8' }).trim())) fail('CARE_SCHEMA_STOP_CRM_DISPATCHER_FIRST');
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
    const process = processes.find(p => p.name === 'pm2-back-staging');
    if (!process || !['stopped', 'errored'].includes(process.pm2_env.status)) fail('CARE_SCHEMA_STOP_CRM_WRITERS_FIRST');
  }
}
async function applyMigration(connection) {
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
  sequelize.connectionManager.getConnection = async () => connection.connection;
  sequelize.connectionManager.releaseConnection = async () => {};
  await require(path.join(ROOT, 'migrations', MIGRATION)).up(sequelize.getQueryInterface());
}
async function run(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--mode', '--target', '--private-output', '--plan', '--approved-plan-sha256'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('CARE_SCHEMA_ARGUMENT_INVALID');
    options[args[i]] = args[i + 1];
  }
  const mode = options['--mode'], target = options['--target'];
  if (!['prepare', 'apply'].includes(mode) || !['dev', 'crm'].includes(target)) fail('CARE_SCHEMA_MODE_TARGET_REQUIRED');
  const info = source(), output = privatePath(options['--private-output']);
  const connection = await connectOperatorDatabase(target);
  let locked = false;
  try {
    if (mode === 'prepare') {
      await connection.query('START TRANSACTION READ ONLY');
      const current = await capture(connection); assertBefore(current.summary);
      await connection.rollback();
      const plan = { version: 'appointment-care-schema/1', target, source: info, generated_at: new Date().toISOString(), before: current.summary };
      write(output, plan);
      return { status: 'prepared_no_changes', target, plan_sha256: digest(plan), appointments: plan.before.count, legacy_attendance: plan.before.legacy_count };
    }
    const plan = JSON.parse(fs.readFileSync(privatePath(options['--plan'], true)));
    if (digest(plan) !== options['--approved-plan-sha256'] || plan.version !== 'appointment-care-schema/1'
      || plan.target !== target || !same(plan.source, info) || !Number.isFinite(Date.parse(plan.generated_at))
      || Date.now() - Date.parse(plan.generated_at) > 7200000 || Date.parse(plan.generated_at) > Date.now()) fail('CARE_SCHEMA_PLAN_INVALID');
    assertStopped(target);
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [`cc-appointment-care-schema:${target}`]);
    if (Number(lock.acquired) !== 1) fail('CARE_SCHEMA_OPERATOR_LOCK_REQUIRED'); locked = true;
    const current = await capture(connection); assertBefore(current.summary);
    if (!same(current.summary, plan.before)) fail('CARE_SCHEMA_PLAN_DRIFT');
    const backup = `${output}.appointments.json.gz`;
    const bytes = zlib.gzipSync(Buffer.from(JSON.stringify({ target, source: info, columns: current.columns, rows: current.rows, before: current.summary })));
    fs.writeFileSync(privatePath(backup), bytes, { flag: 'wx', mode: 0o600 });
    if (digest(zlib.gunzipSync(fs.readFileSync(backup))) !== digest(zlib.gunzipSync(bytes))) fail('CARE_SCHEMA_BACKUP_VERIFICATION_FAILED');
    const journal = { target, source: info, plan_sha256: digest(plan), backup_sha256: digest(bytes), phase: 'before_migration' };
    write(output, journal);
    await applyMigration(connection);
    assertAfter(plan.before, await capture(connection));
    await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [MIGRATION]);
    const final = await capture(connection); assertAfter(plan.before, final);
    if (!same(final.summary.metadata, [...plan.before.metadata, MIGRATION].sort())) fail('CARE_SCHEMA_METADATA_VERIFICATION_FAILED');
    journal.phase = 'applied_verified'; journal.after = final.summary;
    fs.writeFileSync(output, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    return { status: journal.phase, target, migration: MIGRATION, appointments: final.summary.count,
      legacy_attendance: plan.before.legacy_count, piedad_and_personal_unchanged: true, fabricated_completions: 0, automations_dispatched: 0 };
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [`cc-appointment-care-schema:${target}`]);
    await connection.end();
  }
}
module.exports = { digest, enumValues, expectedRows, capture, assertBefore, assertAfter, privatePath, assertStopped, applyMigration, run };
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ status: 'care_schema_stopped_preserve_backup', code: error.code || error.message })); process.exitCode = 1;
});
