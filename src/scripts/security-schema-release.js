#!/usr/bin/env node
'use strict';
// Deployment tooling. Metadata only for checks; explicit, pinned DEV migrations
// for writes. Never imports application models, providers, workers or .env files
// from the development checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { snapshot, compare, digest, validatePlan } = require('../lib/securitySchemaContract');
const { observedEnvironment } = require('./security-email-login-metadata');
const { configuration } = require('./security-database-metadata');
const SOURCE = path.resolve(__dirname, '../..');
const DEV_DATABASE = 'clinicaclick_dev_isolated';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error(code); };
function writeJson(file, value, exclusive = true) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w', mode: 0o600 });
}
function sourceInfo(source, requireClean = false) {
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + source, '-C', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  let revision;
  if (fs.existsSync(path.join(source, '.git'))) {
    revision = git(['rev-parse', 'HEAD']);
    if (requireClean && git(['status', '--porcelain'])) fail('schema_source_must_be_committed');
  } else {
    if (requireClean) fail('schema_apply_requires_checkout');
    revision = JSON.parse(fs.readFileSync(path.join(source, 'release.json'))).commit;
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('schema_revision_invalid');
  const bytes = fs.readFileSync(path.join(source, 'ops/security/schema-contract.json'));
  const contract = JSON.parse(bytes);
  if (contract.version !== 1) fail('schema_contract_invalid');
  const migrations = {};
  for (const name of fs.readdirSync(path.join(source, 'migrations')).filter(n => /^[0-9]{14}-[a-z0-9-]+\.js$/.test(n))) {
    migrations[name] = sha256(fs.readFileSync(path.join(source, 'migrations', name)));
  }
  for (const m of contract.migrations) if (migrations[m.name] !== m.sha256) fail('schema_required_migration_changed');
  return { revision, contractDigest: sha256(bytes), contract, migrations };
}
function environment(runtime) {
  if (process.getuid() !== 0) fail('schema_operator_requires_root');
  if (runtime !== 'dev') return observedEnvironment(runtime).env;
  const env = require('dotenv').parse(fs.readFileSync('/etc/clinicaclick-dev/runtime.env'));
  if (env.DB_NAME !== DEV_DATABASE || env.DB_USERNAME !== 'cc_dev_api'
    || env.DEV_SECURITY_PROFILE !== 'isolated-v1') fail('schema_dev_boundary_invalid');
  return env;
}
function settings(env) {
  return Object.fromEntries(['RUNTIME_NAMESPACE','JOB_RUNTIME_NAMESPACE','QUEUE_PREFIX','AUTH_SESSION_MODE',
    'AUTH_EMAIL_MFA_MODE','EMAIL_ENABLED','JOBS_WORKER_ENABLED','JOBS_CRON_LEADER'].map(k => [k, env[k] ?? null]));
}
function parse(argv) {
  const action = argv.shift(); const options = { source: SOURCE, runtime: 'dev', migrations: [] };
  if (!['check', 'plan-dev', 'apply-dev'].includes(action)) fail('schema_arguments_invalid');
  const seen = new Set();
  while (argv.length) {
    const key = argv.shift(); const value = argv.shift();
    if (!value || !['--source','--runtime','--out','--migration','--plan'].includes(key) || key !== '--migration' && seen.has(key)) fail('schema_arguments_invalid');
    seen.add(key);
    if (key === '--migration') options.migrations.push(value); else options[key.slice(2)] = value;
  }
  if (!['dev','staging','gateway'].includes(options.runtime) || !options.out || !path.isAbsolute(options.out)
    || action !== 'check' && options.runtime !== 'dev'
    || action === 'apply-dev' && (!options.plan || options.migrations.length)
    || action === 'plan-dev' && (!options.migrations.length || options.plan)
    || action === 'check' && (options.plan || options.migrations.length)) fail('schema_arguments_invalid');
  options.source = fs.realpathSync(options.source);
  return { action, ...options };
}
// Exposed for isolated-MySQL tests; connection is the same session holding the
// lock and executing DDL. A journal is required before the first write.
async function applyPlan({ connection, plan, info, loadMigration, journal }) {
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [lock] = await query("SELECT GET_LOCK('clinicaclick_dev_schema_release',0) AS acquired");
  if (Number(lock.acquired) !== 1) fail('schema_migration_busy');
  try {
    await query('SET SESSION lock_wait_timeout=15');
    await query('SET SESSION innodb_lock_wait_timeout=15');
    validatePlan(plan, await snapshot(query), info.revision, info.contractDigest, info.migrations);
    // Sequelize is only used as the migration API, with an explicitly supplied
    // single connection. No pool, config file or runtime models are initialized.
    const Sequelize = require('sequelize');
    const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const q = sequelize.getQueryInterface();
    const completed = [];
    for (const m of plan.migrations) {
      // SELECTs and DDL only in reviewed modules. Journal BEFORE execution;
      // MySQL DDL is not transactional and must not be described as rollbackable.
      journal({ status: 'migration_started', migration: m.name, completed });
      const migration = loadMigration(m);
      await migration.up(q, Sequelize);
      await query('INSERT INTO SequelizeMeta (name) VALUES (?)', [m.name]);
      completed.push(m.name);
      journal({ status: 'migration_completed', migration: m.name, completed });
    }
    const after = await snapshot(query);
    const compatibility = compare(after, info.contract);
    journal({ status: compatibility.compatible ? 'dev_schema_compatible' : 'dev_schema_still_incompatible', completed,
      afterDigest: digest(after), ...compatibility });
    return { completed, afterDigest: digest(after), ...compatibility };
  } finally { await query("SELECT RELEASE_LOCK('clinicaclick_dev_schema_release')"); }
}
async function run(argv) {
  const options = parse([...argv]);
  const info = sourceInfo(options.source, options.action !== 'check');
  const env = environment(options.runtime);
  const connection = await require('mysql2/promise').createConnection(configuration(env));
  const query = async (sql, values = []) => (await connection.query({ sql, values, timeout: 30000 }))[0];
  let journalFd;
  try {
    if (options.action !== 'apply-dev') {
      await query('SET TRANSACTION READ ONLY'); await connection.beginTransaction();
      const before = await snapshot(query); await connection.commit();
      const compatibility = compare(before, info.contract);
      if (options.action === 'check') {
        const report = { status: compatibility.compatible ? 'compatible' : 'incompatible', runtime: options.runtime,
          revision: info.revision, contractDigest: info.contractDigest, snapshotDigest: digest(before),
          settings: settings(env), checkedTables: Object.keys(info.contract.tables).length, ...compatibility };
        writeJson(options.out, report); return report;
      }
      const plan = { version: 1, runtime: 'dev', database: DEV_DATABASE, revision: info.revision,
        contractDigest: info.contractDigest, beforeDigest: digest(before), before, compatibility,
        migrations: options.migrations.map(name => ({ name, sha256: info.migrations[name] })) };
      validatePlan(plan, before, info.revision, info.contractDigest, info.migrations);
      writeJson(options.out, plan); return { status: 'dev_schema_plan_created', migrations: plan.migrations.map(m => m.name) };
    }
    const state = execFileSync('systemctl', ['show', '--property=ActiveState', '--value', 'clinicaclick-back-dev.service'], { stdio: ['ignore','pipe','pipe'] }).toString().trim();
    if (state !== 'inactive') fail('schema_stop_dev_service_first');
    const plan = JSON.parse(fs.readFileSync(options.plan));
    journalFd = fs.openSync(options.out, 'wx', 0o600);
    const journal = event => { fs.writeSync(journalFd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fs.fsyncSync(journalFd); };
    try {
      return await applyPlan({ connection, plan, info, journal, loadMigration: m => {
        const file = path.join(options.source, 'migrations', m.name);
        if (sha256(fs.readFileSync(file)) !== m.sha256) fail('schema_migration_changed');
        return require(file);
      } });
    } catch {
      journal({ status: 'dev_schema_failed_preserve_partial', instruction: 'Keep DEV stopped; inspect schema and journal before a new explicit plan. No automatic retry.' });
      fail('schema_apply_failed_inspect_journal');
    }
  } finally { if (journalFd !== undefined) fs.closeSync(journalFd); await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.compatible === false) process.exitCode = 2;
}).catch(error => {
  const reason = /^schema_[a-z_]+$/.test(error.message) ? error.message : 'schema_operation_failed';
  process.stderr.write(JSON.stringify({ status: 'failed', reason }) + '\n'); process.exitCode = 1;
});
module.exports = { run, parse, sourceInfo, applyPlan };
