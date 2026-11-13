#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createInterface } = require('node:readline/promises');
const { createRunner, safeCode, safeResultRef } = require('../lib/rdsSchemaMigration');
const { need, sha, effectiveRequirements } = require('../lib/rdsSchemaMigrationPolicy');
const transport = require('../lib/rdsSchemaMigrationTransport');
const SOURCE = path.resolve(__dirname, '../..');
const OPERATOR_CODE = Object.freeze(['package.json', 'package-lock.json',
  'src/lib/rdsSchemaMigration.js', 'src/lib/rdsSchemaMigrationPolicy.js', 'src/lib/rdsSchemaMigrationTransport.js',
  'src/lib/rdsSchemaWarningPolicy.js', 'src/lib/rdsSchemaFirstCreateReconciliation.js', 'src/lib/mysqlEnumExtension.js',
  'src/lib/rdsSchemaGbpGenerationIndexReplacement.js',
  'src/lib/securitySchemaContract.js', 'src/lib/schemaReleaseDatabase.js', 'src/lib/databaseTlsConfig.js',
  'src/lib/databaseEncryptionMetadata.js', 'src/scripts/security-rds-schema-migrate.js', 'src/scripts/security-schema-release.js',
  'src/scripts/security-email-login-metadata.js', 'src/scripts/security-database-metadata.js']);
function operatorPins(source) {
  return OPERATOR_CODE.slice().sort().map(relative => {
    const file = path.join(source, relative), loaded = path.join(SOURCE, relative);
    need(fs.realpathSync(file) === file && fs.lstatSync(file).isFile(), 'rds_schema_operator_source_invalid');
    const sha256 = sha(fs.readFileSync(file));
    need(sha256 === sha(fs.readFileSync(loaded)), 'rds_schema_operator_source_changed');
    return { path: relative, sha256 };
  });
}
function runtimeRequirements(info, selected, observe = require('./security-email-login-metadata').observedEnvironment) {
  const env = observe('staging').env;
  need(env.DB_TLS_REQUIRED === 'true' && env.DB_HOST === transport.HOST && env.DB_NAME === transport.DATABASE
    && String(env.DB_PORT || '3306') === '3306', 'rds_schema_runtime_configuration');
  return effectiveRequirements(info, selected, env, 'staging');
}

function parse(argv) {
  const action = String(argv.shift() || '').replace(/-rds$/, '');
  need(['plan', 'apply', 'verify', 'release', 'reconcile'].includes(action), 'rds_schema_arguments_invalid');
  const options = { action, source: SOURCE, selected: [], profile: 'clinicaclick-prov-temp' }; const seen = new Set();
  while (argv.length) {
    const key = argv.shift(); const value = argv.shift();
    need(value && ['--source', '--migration', '--out', '--plan', '--approve-plan', '--run', '--aws-profile'].includes(key)
      && (key === '--migration' || !seen.has(key)), 'rds_schema_arguments_invalid');
    seen.add(key);
    if (key === '--migration') options.selected.push(value);
    else options[{ '--source': 'source', '--out': 'out', '--plan': 'planFile', '--approve-plan': 'approvePlan',
      '--run': 'runDirectory', '--aws-profile': 'profile' }[key]] = value;
  }
  need(path.isAbsolute(options.source) && (!options.out || path.isAbsolute(options.out)), 'rds_schema_arguments_invalid');
  need(action === 'plan' || action === 'release' ? !options.planFile && !options.approvePlan && !options.runDirectory
    : action === 'apply' ? options.planFile && /^[a-f0-9]{64}$/.test(options.approvePlan || '') && !options.runDirectory && !options.selected.length && !options.out
      : options.runDirectory && !options.planFile && !options.approvePlan && !options.selected.length
        && (action === 'reconcile' || !options.out), 'rds_schema_arguments_invalid');
  if (options.planFile) need(path.isAbsolute(options.planFile), 'rds_schema_arguments_invalid');
  if (options.runDirectory) need(path.isAbsolute(options.runDirectory), 'rds_schema_arguments_invalid');
  options.source = fs.realpathSync(options.source); return options;
}

async function run(argv, dependencies = {}) {
  const options = parse([...argv]);
  const runner = dependencies.runner || createRunner({ sourceInfo: dependencies.sourceInfo || require('./security-schema-release').sourceInfo,
    resolveEffectiveContract: (info, selected) => runtimeRequirements(info, selected, dependencies.observe),
    operatorPins: dependencies.operatorPins || operatorPins });
  if (options.action === 'plan') return runner.plan(options);
  if (options.action === 'apply') return runner.apply(options);
  if (options.action === 'verify') return runner.verify(options);
  if (options.action === 'reconcile') return runner.reconcile(options);
  need(options.selected.length > 0, 'rds_schema_selection_required');
  const plan = await runner.plan(options);
  need(plan.toApply.length > 0, 'rds_schema_no_selected_pending_migrations');
  if (dependencies.confirm) {
    need(await dependencies.confirm(plan) === plan.planRef.sha256, 'rds_schema_explicit_plan_approval_required');
  } else {
    need(process.stdin.isTTY && process.stdout.isTTY, 'rds_schema_use_plan_apply_without_tty');
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { need((await terminal.question('DDL auto-COMMIT; review selected code and backup policy. Type the full plan SHA to apply: ')).trim() === plan.planRef.sha256, 'rds_schema_explicit_plan_approval_required'); }
    finally { terminal.close(); }
  }
  return runner.apply({ source: options.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 });
}

if (require.main === module) run(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch(error => {
  const resultRef = safeResultRef(error.resultRef);
  process.stderr.write(JSON.stringify({ status: 'failed', reason: safeCode(error), ...(resultRef ? { resultRef } : {}) }) + '\n');
  process.exitCode = 1;
});
module.exports = { parse, run, operatorPins, runtimeRequirements };
