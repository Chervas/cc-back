#!/usr/bin/env node
'use strict';

// Default mode is not implicit. --mode plan uses a read-only MySQL transaction;
// --mode apply requires an explicitly approved immutable plan and DEV worktree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readBytes, writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const command = require('../lib/cliniccloud-import/protocol-draft');
const SOURCE = '/home/ubuntu/frontend_clinicaclick/temp/Protocolo_Aparatologia.md';
const MIGRATION = '20260907020000-allow-system-import-protocol-actors.js';

function createIsolatedModels() {
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USERNAME, process.env.DB_PASSWORD, {
    dialect: 'mysql', host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    timezone: '+00:00', logging: false, pool: { max: 2, min: 0, idle: 1000 },
  });
  const db = { sequelize, Sequelize };
  for (const name of ['clinica', 'tratamiento', 'treatmentprotocol', 'treatmentprotocolrevision']) {
    const model = require(path.resolve(__dirname, '../../models', `${name}.js`))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  }
  return db;
}

function requirePrivatePlan(filename) {
  if (!path.isAbsolute(filename)) throw new Error('PROTOCOL_PRIVATE_PLAN_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  const rootStat = fs.statSync(root), fileStat = fs.lstatSync(filename);
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('PROTOCOL_PRIVATE_PLAN_REQUIRED');
  if (rootStat.uid !== process.getuid() || rootStat.mode & 0o077 || fileStat.uid !== process.getuid()
    || fileStat.mode & 0o077 || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('PROTOCOL_PRIVATE_PLAN_PERMISSIONS_INVALID');
}

async function readBefore() {
  const connection = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, dateStrings: true, timezone: 'Z', multipleStatements: false });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica = ?', [command.CLINIC_ID]);
    if (clinics.length !== 1 || Number(clinics[0].grupoClinicaId) !== command.GROUP_ID) throw new Error('PROTOCOL_CLINIC_GROUP_CHANGED');
    const [rows] = await connection.query('SELECT * FROM TreatmentProtocols WHERE clinic_id = ? AND (title = ? OR source LIKE ?) ORDER BY id',
      [command.CLINIC_ID, command.TITLE, `${command.SOURCE_PREFIX}%`]);
    await connection.rollback();
    return rows;
  } finally { await connection.end(); }
}

function privateRunDirectory() {
  const root = fs.realpathSync(PRIVATE_ROOT);
  const stat = fs.statSync(root);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('PRIVATE_ROOT_PERMISSIONS_INVALID');
  const directory = fs.mkdtempSync(path.join(root, 'cliniccloud-protocol-apply-'));
  fs.chmodSync(directory, 0o700);
  syncDirectory(root);
  return directory;
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeDurableJson(filename, value) {
  writePrivateJson(filename, value); // exclusive creation + file fsync
  syncDirectory(path.dirname(filename)); // persist the newly created directory entry too
}

async function run(args) {
  const repo = path.resolve(__dirname, '../..');
  if (repo !== '/home/ubuntu/wt/back-dev' || process.cwd() !== repo) throw new Error('PROTOCOL_DEV_WORKTREE_REQUIRED');
  if (execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim() !== 'dev') throw new Error('PROTOCOL_DEV_BRANCH_REQUIRED');
  const options = parseArgs(args, ['--mode', '--private-output', '--plan', '--expected-plan-sha256']);
  if (!['plan', 'apply'].includes(options['--mode'])) throw new Error('PROTOCOL_EXPLICIT_MODE_REQUIRED');
  const sourceBytes = readBytes(SOURCE);
  require('dotenv').config({ path: path.join(repo, '.env'), quiet: true });
  if (options['--mode'] === 'plan') {
    if (!options['--private-output'] || options['--plan'] || options['--expected-plan-sha256']) throw new Error('PROTOCOL_PLAN_ARGUMENTS_INVALID');
    const plan = command.buildProtocolDraftPlan({ sourceBytes, existing: await readBefore() });
    writePrivateJson(options['--private-output'], plan);
    return { mode: 'read_only_plan', plan_sha256: plan.plan_sha256, before_sha256: plan.before_sha256,
      source_sha256: plan.source_sha256, proposed_action: plan.proposed_action, database_written: false, associations: 0, approved: false };
  }
  if (!options['--plan'] || !options['--expected-plan-sha256'] || options['--private-output']) throw new Error('PROTOCOL_APPLY_ARGUMENTS_INVALID');
  requirePrivatePlan(options['--plan']);
  const plan = command.validatePlan(JSON.parse(readBytes(options['--plan']).toString('utf8')), sourceBytes, options['--expected-plan-sha256']);
  const directory = privateRunDirectory();
  writeDurableJson(path.join(directory, 'approved-plan-backup.json'), plan);
  const db = createIsolatedModels();
  try {
    const [migrations] = await db.sequelize.query('SELECT name FROM SequelizeMeta WHERE name = ?', { replacements: [MIGRATION] });
    if (migrations.length !== 1) throw new Error('PROTOCOL_SYSTEM_ACTOR_SCHEMA_PENDING');
    const [columns] = await db.sequelize.query("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'TreatmentProtocols' AND COLUMN_NAME IN ('created_by','updated_by')) OR (TABLE_NAME = 'TreatmentProtocolRevisions' AND COLUMN_NAME = 'actor_id'))");
    if (columns.length !== 3 || columns.some(column => column.is_nullable !== 'YES')) throw new Error('PROTOCOL_SYSTEM_ACTOR_SCHEMA_PENDING');
    const writeJournal = (name, value) => writeDurableJson(path.join(directory, name), { ...value, recorded_at: new Date().toISOString() });
    const result = await command.applyProtocolDraftPlan({ db,
      service: require('../services/treatmentDocumentation.service').createTreatmentDocumentationService(db),
      plan, approvedHash: options['--expected-plan-sha256'], sourceBytes,
      journal: { before: value => writeJournal('before-backup-and-intent.json', value),
        written: value => writeJournal('transaction-write-ahead.json', value), committed: value => writeJournal('committed.json', value) } });
    return { ...result, journal_directory: directory, plan_sha256: plan.plan_sha256, actor_kind: 'system_import', actor_id: null };
  } catch (error) {
    writeDurableJson(path.join(directory, 'stopped.json'), { code: /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'PROTOCOL_APPLY_STOPPED',
      recorded_at: new Date().toISOString(), plan_sha256: plan.plan_sha256,
      caution: 'Check committed.json and source-hash state. A postcommit journal failure is not proof of DB rollback. Never insert blindly.' });
    throw error;
  } finally { await db.sequelize.close(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
  .catch(error => { process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'PROTOCOL_COMMAND_FAILED') + '\n'); process.exitCode = 1; });
module.exports = { run, SOURCE, MIGRATION, createIsolatedModels, requirePrivatePlan };
