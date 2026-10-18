#!/usr/bin/env node
'use strict';

// Catalogue-only operator: one pinned migration, one connection, no app boot,
// scope propagation, provider submission, historical requests or transport.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson, readBytes, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const C = require('../lib/patient-mobile-verification');
const MIGRATION = '20261018100000-prepare-patient-mobile-verification-v2.js';
const FILE = path.resolve(__dirname, '../../migrations', MIGRATION);
const VERSION = 'patient-mobile-verification-catalog-release/v1';
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(v))))).digest('hex');
const sourceHash = () => hash([fs.readFileSync(FILE, 'utf8'), fs.readFileSync(require.resolve('../lib/patient-mobile-verification'), 'utf8')]);
const fail = code => { throw Error('MOBILE_CATALOG_' + code); };

async function capture(connection, lock = false) {
  const end = lock ? ' FOR UPDATE' : '';
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name');
  const [flows] = await connection.query('SELECT * FROM AutomationFlowTemplatesV2 WHERE template_key=? ORDER BY version,id' + end, [C.FAMILY]);
  const [catalog] = await connection.query('SELECT * FROM AutomationFlowCatalog WHERE name=? ORDER BY id' + end, [C.FAMILY]);
  const [whatsapp] = await connection.query('SELECT * FROM WhatsappTemplateCatalog WHERE name=? ORDER BY id' + end, [C.TEMPLATE]);
  const [meta] = await connection.query('SELECT name FROM SequelizeMeta WHERE name=?' + end, [MIGRATION]);
  return { database: identity.database_name, flows, catalog, whatsapp, meta };
}
function assertInactive(snapshot, complete = false) {
  for (const key of ['flows', 'catalog', 'whatsapp']) {
    if (snapshot[key].length > 1 || complete && snapshot[key].length !== 1) fail('EXACT_CENTRAL_SCOPE_REQUIRED');
    if (snapshot[key].some(row => row.is_active !== false && row.is_active !== 0)) fail('EXISTING_ACTIVE_ENTRY');
  }
  if (snapshot.flows.some(row => !row.is_system || row.clinic_id || row.group_id || row.published_at
    || Number(row.version) !== 1 || row.trigger_type !== C.REQUEST)) fail('EXISTING_FLOW_INCOMPATIBLE');
  if (snapshot.catalog.some(row => row.last_propagated_at || row.is_default_for_trigger)) fail('EXISTING_PROPAGATION');
  if (snapshot.whatsapp.some(row => row.category !== 'UTILITY' || row.last_propagated_at)) fail('EXISTING_PROVIDER_PROPAGATION');
}
function makePlan(before, target) {
  assertInactive(before);
  return { schema_version: VERSION, target, source_sha256: sourceHash(), before, before_sha256: hash(before),
    policy: { central_catalog_only: true, inactive_only: true, historical_requests_unchanged: true,
      no_scope_copies: true, no_jobs: true, no_messages: true, no_provider_submission: true } };
}
async function execute({ connection, plan, approvedHash, backupPath, dryRun = true, saveBackup = writePrivateJson }) {
  if (plan?.schema_version !== VERSION || hash(plan) !== approvedHash || plan.source_sha256 !== sourceHash()
    || hash(plan.before) !== plan.before_sha256) fail('EXACT_REVIEWED_PLAN_REQUIRED');
  const [[lock]] = await connection.query("SELECT GET_LOCK('cc-patient-mobile-verification-catalog',0) AS acquired");
  if (Number(lock.acquired) !== 1) fail('OPERATOR_BUSY');
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
  sequelize.connectionManager.getConnection = async () => connection.connection;
  sequelize.connectionManager.releaseConnection = async () => {};
  const originalTransaction = sequelize.transaction;
  const dryRunSignal = Symbol('rolled_back_dry_run');
  try {
    return await originalTransaction.call(sequelize, { isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const before = await capture(connection, true);
      if (hash(before) !== plan.before_sha256) fail('PLAN_CHANGED_REPLAN_REQUIRED');
      assertInactive(before);
      const [actors] = await connection.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=1 FOR SHARE');
      if (actors.length !== 1 || actors[0].estado_cuenta !== 'activo'
        || !require('../lib/role-helpers').isGlobalAdmin(1)) fail('MIGRATION_OWNER_NOT_ACTIVE');
      saveBackup(backupPath, { schema_version: VERSION + ':backup', plan_sha256: approvedHash, before,
        restoration: 'Additive inactive entries. Never delete after review/propagation or overwrite later edits.' });
      // Reuse the reviewed migration verbatim inside this single transaction.
      sequelize.transaction = callback => callback(transaction);
      try { await require(FILE).up(sequelize.getQueryInterface()); }
      finally { sequelize.transaction = originalTransaction; }
      if (!before.meta.length) await connection.query('INSERT INTO SequelizeMeta (name) VALUES (?)', [MIGRATION]);
      const after = await capture(connection, true);
      assertInactive(after, true);
      for (const key of ['flows', 'catalog', 'whatsapp']) {
        if (before[key].some(row => !after[key].some(next => Number(next.id) === Number(row.id) && hash(next) === hash(row)))) fail('EXISTING_ENTRY_CHANGED');
      }
      const receipt = { schema_version: VERSION + ':receipt', target: plan.target,
        mode: dryRun ? 'rolled_back_dry_run' : 'applied', plan_sha256: approvedHash,
        flow_id: Number(after.flows[0].id), catalog_id: Number(after.catalog[0].id),
        whatsapp_catalog_id: Number(after.whatsapp[0].id), disabled: true, propagated: false,
        migration_registered: after.meta.length === 1 };
      if (dryRun) throw { signal: dryRunSignal, receipt };
      return receipt;
    });
  } catch (error) { if (error.signal === dryRunSignal) return error.receipt; throw error; }
  finally { sequelize.transaction = originalTransaction; await connection.query("SELECT RELEASE_LOCK('cc-patient-mobile-verification-catalog')"); }
}
function privatePlan(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_PLAN_REQUIRED');
  const real = fs.realpathSync(filename), stat = fs.lstatSync(filename), root = fs.realpathSync(PRIVATE_ROOT);
  if (!real.startsWith(root + path.sep) || real !== filename || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_PLAN_INVALID');
  return JSON.parse(readBytes(filename));
}
async function main(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--output', '--plan', '--approved-plan-sha256', '--backup']);
  const mode = args['--mode'] || 'plan', target = args['--target'];
  if (!['plan', 'dry-run', 'apply'].includes(mode)) fail('MODE_INVALID');
  const configuration = databaseOptions(target), connection = await connectOperatorDatabase(target);
  try {
    if (mode === 'plan') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(connection); await connection.rollback();
      if (before.database !== configuration.database) fail('DATABASE_CHANGED');
      const plan = makePlan(before, target); writePrivateJson(args['--output'], plan);
      return { mode, target, plan_sha256: hash(plan), existing: before.catalog.length };
    }
    const plan = privatePlan(args['--plan']);
    if (plan.target !== target || plan.before.database !== configuration.database) fail('TARGET_CHANGED');
    return await execute({ connection, plan, approvedHash: args['--approved-plan-sha256'],
      backupPath: args['--backup'], dryRun: mode === 'dry-run' });
  } finally { await connection.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { capture, assertInactive, makePlan, execute, hash };
