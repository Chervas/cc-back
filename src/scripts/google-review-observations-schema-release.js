#!/usr/bin/env node
'use strict';
// Exact additive migration only. No app bootstrap, provider, worker or business DML.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');
const { Writable } = require('node:stream');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { clientOptions } = require('./cliniccloud-operator-backup');
const NAME = '20261015100000-preserve-google-review-observations.js';
const FIELDS = ['first_seen_at', 'last_seen_at', 'google_missing_at'];
const INDEX = 'bpr_location_presence';
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = code => { throw Error(code); };
async function capture(c) {
  const [columns] = await c.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='BusinessProfileReviews' ORDER BY ORDINAL_POSITION");
  const [indexes] = await c.query("SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='BusinessProfileReviews' ORDER BY INDEX_NAME,SEQ_IN_INDEX");
  const [metadata] = await c.query('SELECT name FROM SequelizeMeta WHERE name=?', [NAME]);
  return { columns, indexes, registered: metadata.length === 1 };
}
function verify(before, after) {
  if (hash(before.columns.filter(c => !FIELDS.includes(c.COLUMN_NAME))) !== hash(after.columns.filter(c => !FIELDS.includes(c.COLUMN_NAME)))
    || hash(before.indexes.filter(i => i.INDEX_NAME !== INDEX)) !== hash(after.indexes.filter(i => i.INDEX_NAME !== INDEX))) fail('REVIEW_SCHEMA_EXISTING_METADATA_CHANGED');
  for (const name of FIELDS) {
    const c = after.columns.find(c => c.COLUMN_NAME === name);
    if (!c || c.COLUMN_TYPE !== 'datetime' || c.IS_NULLABLE !== 'YES' || c.COLUMN_DEFAULT !== null || c.EXTRA) fail('REVIEW_SCHEMA_COLUMN_INVALID');
  }
  const index = after.indexes.filter(i => i.INDEX_NAME === INDEX);
  if (index.length !== 2 || index.some(i => Number(i.NON_UNIQUE) !== 1)
    || index.map(i => i.COLUMN_NAME).join(',') !== 'business_location_id,google_missing_at') fail('REVIEW_SCHEMA_INDEX_INVALID');
}
function boundedInterface(c) {
  return {
    describeTable: async table => {
      if (table !== 'BusinessProfileReviews') fail('REVIEW_SCHEMA_UNEXPECTED_TABLE');
      return Object.fromEntries((await capture(c)).columns.map(row => [row.COLUMN_NAME, row]));
    },
    addColumn: async (table, field, spec) => {
      if (table !== 'BusinessProfileReviews' || !FIELDS.includes(field) || spec.allowNull !== true || spec.type !== require('sequelize').DATE) fail('REVIEW_SCHEMA_UNEXPECTED_DDL');
      await c.query(`ALTER TABLE BusinessProfileReviews ADD COLUMN \`${field}\` DATETIME NULL DEFAULT NULL, ALGORITHM=INSTANT`);
    },
    showIndex: async () => (await capture(c)).indexes.map(row => ({ name: row.INDEX_NAME })),
    addIndex: async (table, fields, spec) => {
      if (table !== 'BusinessProfileReviews' || fields.join(',') !== 'business_location_id,google_missing_at' || spec.name !== INDEX) fail('REVIEW_SCHEMA_UNEXPECTED_DDL');
      await c.query('ALTER TABLE BusinessProfileReviews ADD INDEX bpr_location_presence (business_location_id,google_missing_at), ALGORITHM=INPLACE, LOCK=NONE');
    },
  };
}
async function backup(config, file) {
  const child = spawn('/usr/bin/python3', [path.join(__dirname, 'cliniccloud-private-dump.py'), '--single-transaction', '--quick', '--hex-blob',
    '--no-tablespaces', '--set-gtid-purged=OFF', config.database, 'BusinessProfileReviews', 'SequelizeMeta'],
  { stdio: ['ignore', 'pipe', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('REVIEW_SCHEMA_BACKUP_FAILED'))); });
  child.stdio[3].on('error', () => {}); child.stdio[3].end(clientOptions(config));
  await Promise.all([completed, pipeline(child.stdout, createGzip(), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))]);
  let tail = '';
  await pipeline(fs.createReadStream(file), createGunzip(), new Writable({ write(chunk, _encoding, next) { tail = (tail + chunk.toString()).slice(-2048); next(); } }));
  if (!tail.includes('-- Dump completed on ')) fail('REVIEW_SCHEMA_BACKUP_INCOMPLETE');
  return hash(fs.readFileSync(file));
}
async function run(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--plan', '--approved-plan-sha256']);
  const mode = args['--mode'], target = args['--target'], file = args['--plan'];
  if (!['prepare', 'apply'].includes(mode) || !['dev', 'crm'].includes(target) || !file) fail('REVIEW_SCHEMA_EXPLICIT_ARGUMENTS_REQUIRED');
  const root = path.resolve(__dirname, '../..');
  if (root !== '/home/ubuntu/wt/back-dev' || process.cwd() !== root
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('REVIEW_SCHEMA_CLEAN_COMMITTED_DEV_REQUIRED');
  const migration = path.join(root, 'migrations', NAME), sha = hash(fs.readFileSync(migration));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const config = databaseOptions(target), c = await connectOperatorDatabase(target);
  try {
    await c.query('SET SESSION lock_wait_timeout=5');
    const [[lock]] = await c.query("SELECT GET_LOCK('cc-google-review-observations-schema',0) acquired");
    if (Number(lock.acquired) !== 1) fail('REVIEW_SCHEMA_OPERATOR_ACTIVE');
    const before = await capture(c);
    if (!before.columns.length) fail('REVIEW_SCHEMA_PARENT_REQUIRED');
    if (mode === 'prepare') {
      if (before.registered || before.columns.some(c => FIELDS.includes(c.COLUMN_NAME)) || before.indexes.some(i => i.INDEX_NAME === INDEX)) fail('REVIEW_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
      // Reserve a private plan path before writing the equally private backup.
      writePrivateJson(file + '.intent.json', { target, commit, migration: NAME });
      const backupFile = file + '.before.sql.gz', backupSha = await backup(config, backupFile);
      const plan = { target, database: config.database, configuration: hash(config), commit, migration: NAME, sha,
        preparedAt: new Date().toISOString(), before, backupFile, backupSha };
      writePrivateJson(file, plan);
      return { status: 'prepared', target, plan_sha256: hash(plan), backup_verified: true };
    }
    const plan = privateJson(file);
    if (args['--approved-plan-sha256'] !== hash(plan) || plan.target !== target || plan.database !== config.database
      || plan.configuration !== hash(config) || plan.commit !== commit || plan.sha !== sha || plan.migration !== NAME
      || !Number.isFinite(Date.parse(plan.preparedAt)) || Date.now() - Date.parse(plan.preparedAt) > 7200000
      || Date.parse(plan.preparedAt) > Date.now() || hash(plan.before) !== hash(before)
      || plan.backupFile !== file + '.before.sql.gz' || hash(fs.readFileSync(plan.backupFile)) !== plan.backupSha) fail('REVIEW_SCHEMA_PLAN_CHANGED_OR_EXPIRED');
    writePrivateJson(file + '.apply-intent.json', { target, commit, plan_sha256: hash(plan) });
    await require(migration).up(boundedInterface(c), require('sequelize'));
    verify(before, await capture(c));
    await c.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
    const after = await capture(c); verify(before, after);
    if (!after.registered) fail('REVIEW_SCHEMA_METADATA_NOT_REGISTERED');
    writePrivateJson(file + '.result.json', { target, commit, migration: NAME, verified: true, after });
    return { status: 'applied_verified', target, migration: NAME, business_dml: false };
  } finally { await c.query("SELECT RELEASE_LOCK('cc-google-review-observations-schema')").catch(() => {}); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(/^REVIEW_SCHEMA_[A-Z_]+$/.test(e.message) ? e.message : 'REVIEW_SCHEMA_FAILED_INSPECT_PRIVATE_PLAN'); process.exitCode = 1;
});
module.exports = { NAME, FIELDS, capture, verify, boundedInterface, run };
