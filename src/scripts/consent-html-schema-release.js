#!/usr/bin/env node
'use strict';

// Additive legal-HTML capacity only. No app bootstrap, document edits or sends.
// MySQL DDL commits implicitly: retain the additive schema and durable journal
// on a partial failure; never automatically downgrade or restore patient rows.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');
const ROOT = '/home/ubuntu/wt/back-dev';
const NAME = '20261015100000-expand-consent-html-mediumtext.js';
const COLUMNS = Object.freeze([['ClinicConsentTemplateVersions', 'body_html'],
  ['ConsentTemplateCatalogVersions', 'body_html'], ['PatientConsentDocuments', 'snapshot_html']]);
const fail = code => { throw Error('CONSENT_HTML_RELEASE_' + code); };
const equal = (a, b) => hash(a) === hash(b);
function source() {
  if (process.cwd() !== ROOT || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('CLEAN_COMMITTED_DEV_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = ['migrations/' + NAME, 'src/scripts/consent-html-schema-release.js',
    'src/lib/cliniccloud-import/operator-database.js', 'src/lib/databaseTlsConfig.js'];
  const pins = Object.fromEntries(files.map(file => {
    const bytes = readBytes(path.join(ROOT, file));
    if (hash(bytes) !== hash(execFileSync('git', ['show', commit + ':' + file], { maxBuffer: 2 * 1024 * 1024 }))) fail('SOURCE_CHANGED');
    return [file, hash(bytes)];
  }));
  return { commit, pins };
}
async function capture(connection, includeRows = false) {
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name');
  const [columns] = await connection.query(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,
    CHARACTER_SET_NAME,COLLATION_NAME,EXTRA,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND ((TABLE_NAME IN ('ClinicConsentTemplateVersions','ConsentTemplateCatalogVersions') AND COLUMN_NAME='body_html')
    OR (TABLE_NAME='PatientConsentDocuments' AND COLUMN_NAME='snapshot_html')) ORDER BY TABLE_NAME`);
  validateColumns(columns);
  const [metadata] = await connection.query('SELECT name FROM SequelizeMeta ORDER BY name');
  const contents = {}, rows = {};
  for (const [table] of COLUMNS) {
    const [result] = await connection.query('SELECT * FROM `' + table + '` ORDER BY id LIMIT 100001');
    if (result.length > 100000) fail('BOUNDED_BACKUP_EXCEEDED');
    contents[table] = { count: result.length, sha256: hash(result) };
    if (includeRows) rows[table] = result;
  }
  return { state: { identity_sha256: hash(identity), columns, contents, metadata_names: metadata.map(r => r.name) }, rows };
}
function validateColumns(columns) {
  if (!Array.isArray(columns) || columns.length !== 3) fail('EXACT_COLUMNS_REQUIRED');
  for (const [table, column] of COLUMNS) {
    const matching = columns.filter(r => r.TABLE_NAME === table && r.COLUMN_NAME === column), r = matching[0];
    if (matching.length !== 1 || !['text', 'mediumtext'].includes(r.COLUMN_TYPE) || r.IS_NULLABLE !== 'YES'
      || r.COLUMN_DEFAULT !== null || r.EXTRA !== '' || r.COLUMN_COMMENT !== '' || r.CHARACTER_SET_NAME !== 'utf8mb4'
      || !/^utf8mb4_[a-z0-9_]+$/.test(r.COLLATION_NAME)) fail('COLUMN_CONTRACT_CHANGED');
  }
}
function validatePlan(plan, target, info, now = Date.now()) {
  if (plan?.version !== 1 || plan.target !== target || plan.migration !== NAME || !equal(plan.source, info)
    || !Number.isFinite(Date.parse(plan.generated_at)) || Date.parse(plan.generated_at) > now
    || now - Date.parse(plan.generated_at) > 7200000) fail('PLAN_INVALID_OR_EXPIRED');
  validateColumns(plan.before.columns);
  if (plan.before.metadata_names.includes(NAME) || plan.before.columns.some(r => r.COLUMN_TYPE !== 'text')) fail('PREEXISTING_OR_PARTIAL_REQUIRES_REVIEW');
}
function verifyAfter(before, after, registered) {
  const expected = { ...before, columns: before.columns.map(r => ({ ...r, COLUMN_TYPE: 'mediumtext' })),
    metadata_names: registered ? [...before.metadata_names, NAME].sort() : before.metadata_names };
  if (!equal(expected, after)) fail('CONTENT_SCHEMA_OR_METADATA_CHANGED');
}
function freshPaths(options, mode) {
  const fields = mode === 'prepare' ? ['--private-output', '--private-backup']
    : mode === 'apply' ? ['--private-output', '--private-journal'] : ['--private-output'];
  const root = fs.realpathSync('/home/ubuntu/secure-imports');
  const paths = fields.map(field => {
    const filename = options[field];
    if (!path.isAbsolute(filename || '')) fail('PRIVATE_FRESH_ARTIFACT_REQUIRED');
    const parent = fs.realpathSync(path.dirname(filename));
    for (const dir of [root, parent]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_FRESH_ARTIFACT_REQUIRED');
    }
    const resolved = path.join(parent, path.basename(filename));
    if ((parent !== root && !parent.startsWith(root + path.sep)) || fs.existsSync(resolved)) fail('PRIVATE_FRESH_ARTIFACT_REQUIRED');
    return resolved;
  });
  if (new Set(paths).size !== paths.length || paths.some(p => [options['--plan'], mode !== 'prepare' && options['--private-backup']].includes(p))) fail('DISTINCT_ARTIFACTS_REQUIRED');
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--private-output', '--private-backup', '--plan', '--approved-plan-sha256', '--private-journal']);
  const mode = options['--mode'], target = options['--target'];
  if (!['prepare', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target) || !options['--private-output']) fail('EXPLICIT_TARGET_MODE_OUTPUT_REQUIRED');
  freshPaths(options, mode); // Detect unusable/overlapping receipts before DDL.
  const info = source(), connection = await connectOperatorDatabase(target);
  let journal, locked = false;
  try {
    await connection.query('SET SESSION lock_wait_timeout=5');
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', ['cc-consent-html-schema-20261015']);
    if (Number(lock.acquired) !== 1) fail('OPERATOR_LOCK_BUSY');
    locked = true;
    if (mode === 'prepare') {
      if (!options['--private-backup']) fail('BACKUP_REQUIRED');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let captured;
      try { captured = await capture(connection, true); } finally { await connection.rollback(); }
      const backup = { version: 1, target, migration: NAME, source: info, ...captured };
      const plan = { version: 1, target, migration: NAME, source: info, generated_at: new Date().toISOString(),
        backup_sha256: hash(backup), before: captured.state };
      validatePlan(plan, target, info);
      writePrivateJson(options['--private-backup'], backup);
      writePrivateJson(options['--private-output'], plan);
      return { status: 'prepared', target, plan_sha256: hash(plan), content_counts: Object.fromEntries(Object.entries(plan.before.contents).map(([k, v]) => [k, v.count])) };
    }
    if (!options['--plan'] || !options['--approved-plan-sha256']) fail('APPROVED_PLAN_REQUIRED');
    const plan = privateJson(options['--plan']);
    if (hash(plan) !== options['--approved-plan-sha256']) fail('EXACT_PLAN_APPROVAL_REQUIRED');
    validatePlan(plan, target, info);
    if (mode === 'verify') {
      const { state } = await capture(connection);
      verifyAfter(plan.before, state, true);
      writePrivateJson(options['--private-output'], { status: 'verified', target, source: info, state, business_data_written: false });
      return { status: 'verified', target, business_data_written: false };
    }
    if (!options['--private-backup'] || !options['--private-journal']) fail('BACKUP_AND_JOURNAL_REQUIRED');
    const backup = privateJson(options['--private-backup']);
    if (hash(backup) !== plan.backup_sha256 || !equal(backup.state, plan.before)
      || !equal(backup.source, info) || backup.target !== target) fail('BACKUP_CHANGED');
    for (const [table] of COLUMNS) if (hash(backup.rows[table]) !== plan.before.contents[table].sha256) fail('BACKUP_ROWS_CHANGED');
    const { state: before } = await capture(connection);
    // Replay only after independent exact readback. No DDL or metadata write.
    if (before.metadata_names.includes(NAME)) {
      verifyAfter(plan.before, before, true);
      writePrivateJson(options['--private-output'], { status: 'already_applied_verified', target, business_data_written: false });
      return { status: 'already_applied_verified', target, business_data_written: false };
    }
    if (!equal(before, plan.before)) fail('PREPARED_STATE_DRIFT');
    journal = newJournal(options['--private-journal'], hash(plan));
    await journal.append({ phase: 'before_ddl', target, source: info, before_sha256: hash(before), backup_sha256: plan.backup_sha256 });
    if (!equal(source(), info)) fail('SOURCE_CHANGED');
    const queryInterface = { sequelize: { getDialect: () => 'mysql', query: async sql => {
      if (!/^\s*(?:SELECT|ALTER TABLE)\b/.test(sql)) fail('UNEXPECTED_MIGRATION_QUERY');
      const result = await connection.query(sql);
      if (/^\s*ALTER TABLE\b/.test(sql)) await journal.append({ phase: 'one_additive_ddl_completed', statement_sha256: hash(sql), target });
      return result;
    } } };
    const migration = require('../../migrations/' + NAME);
    await migration.up(queryInterface);
    const { state: after } = await capture(connection);
    verifyAfter(before, after, false);
    // The migration itself is idempotent before registering it.
    await migration.up(queryInterface);
    if (!equal(source(), info)) fail('SOURCE_CHANGED');
    await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
    const { state: registered } = await capture(connection);
    verifyAfter(before, registered, true);
    await journal.append({ phase: 'verified', target, after_sha256: hash(registered), business_data_written: false });
    writePrivateJson(options['--private-output'], { status: 'applied_verified', target, source: info, state: registered, business_data_written: false });
    return { status: 'applied_verified', target, business_data_written: false };
  } finally {
    journal?.close();
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', ['cc-consent-html-schema-20261015']).catch(() => {});
    await connection.end();
  }
}
module.exports = { COLUMNS, NAME, validateColumns, validatePlan, verifyAfter, freshPaths, run };
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'failed', reason: /^CONSENT_HTML_RELEASE_/.test(error.message) ? error.message : error.code || error.name }) + '\n');
  process.exitCode = 1;
});
