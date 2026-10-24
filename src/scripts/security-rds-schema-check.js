#!/usr/bin/env node
'use strict';
// One read-only publication preflight. No master secret, backup or DDL path.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const C = require('../lib/rdsSchemaMigration');
const T = require('../lib/rdsSchemaMigrationTransport');
const P = require('../lib/rdsSchemaMigrationPolicy');
const publicDatabase = require('../lib/schemaReleaseDatabase');
const ROOTS = Object.freeze({ staging: '/home/ubuntu/wt/back-staging', gateway: '/home/ubuntu/wt/gateway' });
const CODE = ['src/scripts/security-schema-release.js', 'src/scripts/security-email-login-metadata.js',
  'src/scripts/security-database-metadata.js', 'src/lib/securitySchemaContract.js',
  'src/lib/schemaReleaseDatabase.js', 'src/lib/databaseTlsConfig.js'];

function parse(argv) {
  if (['check-rds', 'preflight-rds'].includes(argv[0])) argv.shift();
  const options = { required: [], profile: 'clinicaclick-prov-temp' }; const seen = new Set();
  while (argv.length) {
    const key = argv.shift(); const value = argv.shift();
    P.need(value && ['--runtime', '--source', '--out', '--require-migration', '--aws-profile'].includes(key)
      && (key === '--require-migration' || !seen.has(key)), 'rds_schema_check_arguments');
    seen.add(key);
    if (key === '--require-migration') options.required.push(value);
    else options[{ '--runtime': 'runtime', '--source': 'source', '--out': 'out', '--aws-profile': 'profile' }[key]] = value;
  }
  P.need(Object.hasOwn(ROOTS, options.runtime) && options.required.length <= 20
    && new Set(options.required).size === options.required.length && options.required.every(name => P.NAME.test(name)), 'rds_schema_check_arguments');
  options.source ||= ROOTS[options.runtime];
  P.need(path.isAbsolute(options.source) && (!options.out || path.isAbsolute(options.out)), 'rds_schema_check_arguments');
  return options;
}
function codePins(root) {
  return CODE.map(relative => {
    const file = path.join(root, relative);
    P.need(fs.realpathSync(file) === file && fs.lstatSync(file).isFile(), 'rds_schema_runtime_check_code');
    return { path: file, sha256: P.sha(fs.readFileSync(file)) };
  });
}
async function run(argv, dependencies = {}) {
  const options = parse([...argv]); const now = dependencies.now || Date.now;
  P.need((dependencies.operatorUid || (() => process.getuid()))() === 0, 'rds_schema_root_required');
  const root = ROOTS[options.runtime];
  const readPins = dependencies.codePins || codePins; const beforePins = readPins(root);
  const check = dependencies.check || require(root + '/src/scripts/security-schema-release');
  P.need(typeof check.run === 'function' && typeof check.sourceInfo === 'function', 'rds_schema_runtime_check_abi');
  const info = check.sourceInfo(options.source, false);
  for (const name of options.required) P.need(/^[a-f0-9]{64}$/.test(info.migrations[name] || ''), 'rds_schema_required_migration_invalid');
  const observe = dependencies.observe || require(root + '/src/scripts/security-email-login-metadata').observedEnvironment;
  const env = observe(options.runtime).env;
  P.need(env.DB_HOST === T.HOST && String(env.DB_PORT || '3306') === '3306' && env.DB_NAME === T.DATABASE
    && env.DB_USERNAME === publicDatabase.USERS[options.runtime] && typeof env.DB_PASSWORD === 'string'
    && env.DB_PASSWORD.length >= 16 && env.DB_PASSWORD.length <= 512 && env.DB_TLS_REQUIRED === 'true'
    && env.DB_TLS_CA_FILE === T.CA, 'rds_schema_app_configuration');
  const aws = (dependencies.awsFactory || T.createAws)({ profile: options.profile });
  const db = await aws.inspect(); // STS/DescribeDB only; never aws.secret/backup.
  let admin; let closure; let identity; let observedAt; let missing = [];
  try {
    admin = await (dependencies.connect || T.connectAdmin)({ aws, db,
      secret: { username: env.DB_USERNAME, password: env.DB_PASSWORD } });
    identity = admin.identity; observedAt = now();
    P.need(identity.host === T.HOST && identity.database === T.DATABASE && identity.physicalDbId === T.PRIMARY_DBI
      && identity.strictTls === true && identity.hostnameVerified === true && identity.caSha256 === T.CA_SHA, 'rds_schema_app_identity');
    if (options.required.length) {
      const rows = await admin.query('SELECT name FROM SequelizeMeta WHERE name IN (' + options.required.map(() => '?').join(',') + ')', options.required);
      P.need(Array.isArray(rows) && rows.every(row => options.required.includes(row.name)), 'rds_schema_meta_readback');
      missing = options.required.filter(name => !rows.some(row => row.name === name));
    }
  } finally { if (admin) closure = await admin.close(); }
  P.need(closure?.physicalCloseObserved === true && closure.physicalStreamDestroyed === true, 'rds_schema_physical_close_unproven');
  const binding = { schema: 'clinicaclick-rds-schema-check-binding/1', rootReviewed: true, runtime: options.runtime,
    checkedAtEpochMs: observedAt, expiresAtEpochMs: observedAt + 900000, host: T.HOST, port: 3306,
    database: T.DATABASE, serverUuid: identity.serverUuid, engineVersion: identity.engineVersion,
    caSha256: T.CA_SHA, expectedUsername: publicDatabase.USERS[options.runtime] };
  publicDatabase.validateBinding(binding, options.runtime, now());
  const directory = options.out ? path.dirname(options.out) : '/home/ubuntu/qa-evidence/rds-schema-check-' + randomUUID();
  (dependencies.privateDirectory || C.privateDirectory)(directory);
  const write = dependencies.writePrivate || C.writePrivate;
  const bindingRef = write(directory + '/binding-' + options.runtime + '.json', binding);
  const reportPath = directory + '/runtime-check-' + options.runtime + '.json';
  // Use that runtime's actual helper/contract semantics, including gateway's
  // independent contract; do not copy the DEV feature-contract implementation.
  const checked = await check.run(['check', '--source', options.source, '--runtime', options.runtime,
    '--out', reportPath, '--binding', bindingRef.path, '--binding-sha', bindingRef.sha256]);
  publicDatabase.validateBinding(binding, options.runtime, now());
  P.need(JSON.stringify(beforePins) === JSON.stringify(readPins(root)), 'rds_schema_runtime_check_changed');
  const afterInfo = check.sourceInfo(options.source, false);
  P.need(info.revision === afterInfo.revision && info.contractDigest === afterInfo.contractDigest
    && JSON.stringify(info.migrations) === JSON.stringify(afterInfo.migrations), 'rds_schema_source_changed');
  const report = { status: checked.compatible && missing.length === 0 ? 'rds_schema_preflight_compatible' : 'rds_schema_preflight_incompatible',
    compatible: checked.compatible === true && missing.length === 0, runtime: options.runtime, sourceRevision: info.revision,
    bindingRef, runtimeCheckResultRef: { path: reportPath, sha256: (dependencies.hashFile || (file => P.sha(fs.readFileSync(file))))(reportPath) },
    runtimeCheckCodeRefs: beforePins, requiredMigrations: options.required, missingRequiredMigrations: missing,
    identityObservationClosure: closure, administrationSecretRead: false, snapshotCreated: false, ddlStatements: 0,
    metadataCheckTransportClosure: 'Existing runtime helper requests destroy/stream.destroy; this field does not claim a remote absence observation.' };
  const resultRef = write(options.out || directory + '/result.json', report);
  return { ...report, resultRef };
}
if (require.main === module) run(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n'); if (!result.compatible) process.exitCode = 2;
}).catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', reason: C.safeCode(error) }) + '\n'); process.exitCode = 1; });
module.exports = { ROOTS, CODE, parse, codePins, run };
