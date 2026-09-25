#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { sourceInfo } = require('./security-schema-release');
const { observedEnvironment } = require('./security-email-login-metadata');
const { snapshot, digest, effectiveContract } = require('../lib/securitySchemaContract');
const release = require('../lib/googleBusinessProfileWritesSchemaRelease');
const { clinicalCutFailure } = require('../lib/clinicalCutFailure');
const { encryptStream, verifyCipher } = require('./meta-clinical-schema-release');

const ROOTS = ['/home/ubuntu/wt/back-staging', '/home/ubuntu/wt/gateway'];
const RECOVERY = '/var/lib/clinicaclick-schema-recovery';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };

function secure(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o077
    || (directory ? !stat.isDirectory() : !stat.isFile())) fail('google_business_profile_writes_private_artifact_invalid');
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function persist(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function write(file, value) {
  persist(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parse(argv) {
  const [action, sourceOption, source, directoryOption, directory, ...rest] = argv;
  if (!['plan', 'backup', 'apply'].includes(action) || sourceOption !== '--source' || directoryOption !== '--dir'
    || rest.length || !source || !path.isAbsolute(source) || !directory || path.dirname(directory) !== RECOVERY
    || !/^[a-z0-9][a-z0-9-]{5,100}$/.test(path.basename(directory))) {
    fail('google_business_profile_writes_arguments_invalid');
  }
  return { action, source: fs.realpathSync(source), directory };
}

function noWriters() {
  for (const id of fs.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value))) {
    let cwd;
    let command;
    try {
      cwd = fs.realpathSync(`/proc/${id}/cwd`);
      command = fs.readFileSync(`/proc/${id}/cmdline`).toString().split('\0');
    } catch { continue; }
    if (ROOTS.includes(cwd) && command.some(value => /(^|\/)(node|npm)(\s|$)|src\/app\.js/.test(value))) {
      fail('google_business_profile_writes_stop_public_writers_first');
    }
  }
  for (const unit of ['clinicaclick-whatsapp-fresh-inbound.service', 'clinicaclick-whatsapp-inbox-consumer.service']) {
    const state = require('node:child_process').execFileSync(
      'systemctl', ['show', unit, '--property=MainPID,ActiveState'], { encoding: 'utf8', timeout: 5000 }
    );
    const values = Object.fromEntries(state.trim().split('\n').map(line => line.split('=')));
    if (values.ActiveState !== 'inactive' || values.MainPID !== '0') {
      fail('google_business_profile_writes_stop_auxiliary_writers_first');
    }
  }
}

async function exclusiveDatabase(query) {
  const [{ total }] = await query('SELECT COUNT(*) AS total FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');
  if (Number(total) !== 0) fail('google_business_profile_writes_other_database_connections');
}

function publicTarget() {
  const runtimes = ['staging', 'gateway'].map(name => observedEnvironment(name));
  const database = runtimes[0].env.DB_NAME;
  if (!/^[a-zA-Z0-9_]+$/.test(database) || database === 'clinicaclick_dev_isolated'
    || runtimes.some(runtime => runtime.env.DB_NAME !== database || !['localhost', '127.0.0.1'].includes(runtime.env.DB_HOST))) {
    fail('google_business_profile_writes_public_target_invalid');
  }
  const files = Object.fromEntries(ROOTS.map(root => [`${root}/.env`, sha256(fs.readFileSync(`${root}/.env`))]));
  return { database, files };
}

function verifyTarget(target) {
  if (!target || !/^[a-zA-Z0-9_]+$/.test(target.database) || target.database === 'clinicaclick_dev_isolated'
    || JSON.stringify(Object.keys(target.files)) !== JSON.stringify(ROOTS.map(root => `${root}/.env`))) {
    fail('google_business_profile_writes_public_target_invalid');
  }
  for (const [file, hash] of Object.entries(target.files)) {
    if (sha256(fs.readFileSync(file)) !== hash || require('dotenv').parse(fs.readFileSync(file)).DB_NAME !== target.database) {
      fail('google_business_profile_writes_runtime_configuration_changed');
    }
  }
}

function contracts(source, env) {
  const info = sourceInfo(source, true);
  info.baseContract = effectiveContract(info.contract, env);
  info.targetContract = effectiveContract(info.contract, {
    ...env,
    GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED: 'true',
    GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED: 'true',
  });
  return info;
}

async function connection(database) {
  secure('/etc/mysql/debian.cnf');
  const section = fs.readFileSync('/etc/mysql/debian.cnf', 'utf8').match(/\[client\]([^]*?)(?=\n\[|$)/)?.[1];
  if (!section) fail('google_business_profile_writes_dba_configuration_invalid');
  const config = require('dotenv').parse(section);
  if (config.socket !== '/var/run/mysqld/mysqld.sock' || !config.user || !config.password) {
    fail('google_business_profile_writes_dba_configuration_invalid');
  }
  return require('mysql2/promise').createConnection({
    socketPath: config.socket,
    user: config.user,
    password: config.password,
    database,
    connectTimeout: 5000,
    multipleStatements: false,
  });
}

async function verifyBackup(directory, plan) {
  for (const name of ['recovery.key', 'schema.sql.enc', 'backup.json']) secure(path.join(directory, name));
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'backup.json')));
  if (receipt.planDigest !== digest(plan) || receipt.beforeDigest !== plan.beforeDigest || receipt.database !== plan.database) {
    fail('google_business_profile_writes_backup_plan_mismatch');
  }
  await verifyCipher(path.join(directory, 'schema.sql.enc'), fs.readFileSync(path.join(directory, 'recovery.key')), receipt);
}

async function backup(directory, plan, query) {
  noWriters();
  await exclusiveDatabase(query);
  if (plan.beforeDigest !== digest(await snapshot(query))) fail('google_business_profile_writes_plan_stale_or_invalid');
  const key = crypto.randomBytes(32);
  persist(path.join(directory, 'recovery.key'), key);
  const child = spawn('/usr/bin/mysqldump', [
    '--defaults-file=/etc/mysql/debian.cnf',
    '--no-data',
    '--skip-comments',
    '--skip-dump-date',
    '--skip-lock-tables',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    plan.database,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let receipt;
  try {
    receipt = await encryptStream(child.stdout, path.join(directory, 'schema.sql.enc'), key, crypto.randomBytes(12));
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited.catch(() => {});
    throw error;
  }
  const status = await exited;
  if (status.code !== 0) fail('google_business_profile_writes_backup_dump_failed');
  noWriters();
  await exclusiveDatabase(query);
  if (plan.beforeDigest !== digest(await snapshot(query))) fail('google_business_profile_writes_backup_data_changed');
  write(path.join(directory, 'backup.json'), {
    at: new Date().toISOString(),
    database: plan.database,
    planDigest: digest(plan),
    beforeDigest: plan.beforeDigest,
    ...receipt,
  });
  await verifyBackup(directory, plan);
}

async function run(argv) {
  if (process.getuid() !== 0) fail('google_business_profile_writes_operator_requires_root');
  const options = parse(argv);
  if (!fs.existsSync(RECOVERY)) fs.mkdirSync(RECOVERY, { mode: 0o700 });
  secure(RECOVERY, true);

  let plan;
  let target;
  let contractEnvironment;
  if (options.action === 'plan') {
    fs.mkdirSync(options.directory, { mode: 0o700 });
    syncDirectory(RECOVERY);
    contractEnvironment = observedEnvironment('staging').env;
    target = publicTarget();
  } else {
    secure(options.directory, true);
    secure(path.join(options.directory, 'plan.json'));
    plan = JSON.parse(fs.readFileSync(path.join(options.directory, 'plan.json')));
    target = plan.target;
    verifyTarget(target);
    // The public processes must be stopped before backup/apply, so their
    // /proc environments are intentionally unavailable. The plan pins both
    // protected files; use the verified staging file only to select feature
    // groups and never persist its credentials.
    contractEnvironment = require('dotenv').parse(fs.readFileSync(`${ROOTS[0]}/.env`));
    noWriters();
  }
  const info = contracts(options.source, contractEnvironment);

  const database = await connection(target.database);
  const query = async (sql, values = []) => (await database.query({ sql, values, timeout: 30000 }))[0];
  let journal;
  try {
    if (options.action === 'plan') {
      await query('SET TRANSACTION READ ONLY');
      await database.beginTransaction();
      plan = { ...await release.prepare({ query, info, database: target.database }), target };
      await database.commit();
      write(path.join(options.directory, 'plan.json'), plan);
      return { status: 'google_business_profile_writes_plan_created', revision: info.revision, migrations: plan.migrations.map(row => row.name) };
    }
    if (options.action === 'backup') {
      await backup(options.directory, plan, query);
      return { status: 'google_business_profile_writes_backup_verified' };
    }
    journal = fs.openSync(path.join(options.directory, 'journal.jsonl'), 'wx', 0o600);
    syncDirectory(options.directory);
    const append = event => {
      fs.writeSync(journal, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      fs.fsyncSync(journal);
    };
    try {
      return await release.apply({
        connection: database,
        plan,
        info,
        database: target.database,
        verifyWritersStopped: async () => { verifyTarget(target); noWriters(); await exclusiveDatabase(query); },
        verifyBackup: value => verifyBackup(options.directory, value),
        journal: append,
        loadMigration: migration => {
          const file = path.join(options.source, 'migrations', migration.name);
          if (sha256(fs.readFileSync(file)) !== migration.sha256) fail('google_business_profile_writes_migration_changed');
          return require(file);
        },
      });
    } catch (error) {
      append({
        status: 'google_business_profile_writes_schema_failed_preserve_partial',
        failure: clinicalCutFailure(error),
        releaseFailure: error.releaseFailure || null,
        instruction: 'Inspect schema and journal. No automatic retry or destructive rollback.',
      });
      throw error;
    }
  } finally {
    if (journal !== undefined) fs.closeSync(journal);
    await database.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ status: 'failed', failure: clinicalCutFailure(error) }));
    process.exitCode = 1;
  });
}

module.exports = { run, parse, noWriters, publicTarget, verifyTarget, contracts };
