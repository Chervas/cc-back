'use strict';
// Only the nineteen pinned Google migrations. The DEV CLI stays DEV-only.
// This module never loads application models, credentials or a provider.
const assert = require('node:assert/strict');
const { clinicalCutFailure } = require('./clinicalCutFailure');
const { snapshot, compare, digest } = require('./securitySchemaContract');
const MIGRATIONS = Object.freeze([
  '20260913000000-add-business-profile-broker-read-binding.js',
  '20260913010000-create-business-profile-broker-revocations.js',
  '20260913020000-create-google-oauth-broker-flows.js',
  '20260913030000-add-search-console-broker-read-binding.js',
  '20260913040000-add-analytics-broker-read-binding.js',
  '20260913050000-scope-search-console-bindings-by-mapping.js',
  '20260913060000-create-google-property-broker-revocations.js',
  '20260913070000-scope-google-oauth-by-service.js',
  '20260913080000-add-google-ads-broker-bindings.js',
  '20260913090000-create-google-ads-broker-revocations.js',
  '20260913100000-add-ads-google-oauth-cohort.js',
  '20260913110000-stage-google-ads-broker-mappings.js',
  '20260913120000-create-google-ads-enrollment.js',
  '20260918110000-create-google-conversion-submissions.js',
  '20260918190000-create-google-ads-action-journal.js',
  '20260918203000-google-action-recovery-ownership.js',
  '20260918220000-create-google-destination-journal.js',
  '20260918224500-index-google-destination-recovery.js',
  '20260918235000-index-google-receipt-review.js',
]);
const HISTORICAL_MIGRATIONS = Object.freeze([
  '20260711003000-create-google-ads-conversion-upload-attempts.js',
  '20260711012000-add-google-ads-conversion-destination-key.js',
  '20260712090000-add-data-manager-conversion-statuses.js',
]);
const TABLES = Object.freeze([
  'GoogleConnections',
  'ClinicBusinessLocations',
  'ClinicWebAssets',
  'ClinicAnalyticsProperties',
  'ClinicGoogleAdsAccounts',
  'GoogleConnectionAssignments',
  'GroupAssetClinicAssignments',
  'GoogleAdsConversionUploadAttempts',
]);
const NEW_TABLES = Object.freeze([
  'BusinessProfileBrokerBindings',
  'BusinessProfileBrokerRevocations',
  'GoogleOAuthBrokerBindings',
  'GoogleOAuthBrokerRequests',
  'SearchConsoleBrokerBindings',
  'AnalyticsBrokerBindings',
  'GooglePropertyBrokerRevocations',
  'GoogleAdsBrokerBindings',
  'GoogleAdsBrokerRevocations',
  'GoogleAdsEnrollmentScopes',
  'GoogleAdsEnrollmentRequests',
  'GoogleConversionSubmissions',
  'GoogleAdsActionPlans',
  'GoogleAdsActionCommands',
  'GoogleDestinationAuthorizations',
  'GoogleDestinationCommands',
]);
const fail = code => { throw Error(code); };
function originalColumns(before) {
  return Object.fromEntries(TABLES.map(table => {
    const names = before.columns.filter(c => c.TABLE_NAME === table).map(c => c.COLUMN_NAME);
    if (!names.includes('id') || names.some(n => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))) fail('google_schema_columns_invalid');
    return [table, names];
  }));
}
async function rowFingerprints(query, columns) {
  assert.deepEqual(Object.keys(columns), TABLES);
  const result = {};
  for (const table of TABLES) {
    const names = columns[table];
    if (!names.includes('id') || names.some(n => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))) fail('google_schema_columns_invalid');
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM `' + table + '`');
    if (Number(n) > 100000) fail('google_schema_data_review_required');
    // Values, including legacy tokens, remain inside SQL. Return only a digest
    // of each complete old row; preserve nulls, timestamps, JSON and Unicode.
    const pairs = names.map(n => "'" + n + "',`" + n + '`').join(',');
    const rows = await query('SELECT SHA2(CAST(JSON_OBJECT(' + pairs + ') AS CHAR CHARACTER SET utf8mb4),256) AS row_digest FROM `' + table + '` ORDER BY id');
    result[table] = { count: Number(n), digest: digest(rows.map(r => r.row_digest)) };
  }
  return result;
}
function validate(plan, before, rows, info, database) {
  if (plan.version !== 1 || plan.kind !== 'google_clinical_schema_v1' || plan.runtime !== 'staging'
    || !database || database === 'clinicaclick_dev_isolated' || plan.database !== database
    || plan.revision !== info.revision || plan.contractDigest !== info.contractDigest
    || plan.beforeDigest !== digest(before) || plan.beforeDigest !== digest(plan.before)
    || plan.rowsDigest !== digest(rows) || plan.rowsDigest !== digest(plan.rows)
    || JSON.stringify(plan.columns) !== JSON.stringify(originalColumns(before))
    || JSON.stringify(plan.migrations?.map(m => m.name)) !== JSON.stringify(MIGRATIONS)) fail('google_schema_plan_stale_or_invalid');
  if (NEW_TABLES.some(name => before.tables.some(t => t.TABLE_NAME === name))) fail('google_schema_partial_state_requires_review');
  if (before.columns.some(c => ['ClinicBusinessLocations','ClinicWebAssets','ClinicAnalyticsProperties','ClinicGoogleAdsAccounts'].includes(c.TABLE_NAME)
    && ['broker_read_connection_ref','broker_read_asset_ref'].includes(c.COLUMN_NAME))) fail('google_schema_partial_state_requires_review');
  for (const name of HISTORICAL_MIGRATIONS) {
    if (!before.migrations.includes(name) || !info.contract.migrations.some(m => m.name === name && m.sha256 === info.migrations[name])) fail('google_schema_historical_contract_required');
  }
  for (const m of plan.migrations) {
    if (!/^[a-f0-9]{64}$/.test(m.sha256) || info.migrations[m.name] !== m.sha256
      || !info.contract.migrations.some(c => c.name === m.name && c.sha256 === m.sha256)
      || before.migrations.includes(m.name)) fail('google_schema_migration_changed_or_applied');
  }
}
async function prepare({ query, info, database }) {
  const before = await snapshot(query), columns = originalColumns(before), rows = await rowFingerprints(query, columns);
  const plan = { version: 1, kind: 'google_clinical_schema_v1', runtime: 'staging', database,
    revision: info.revision, contractDigest: info.contractDigest, beforeDigest: digest(before),
    rowsDigest: digest(rows), before, columns, rows,
    migrations: MIGRATIONS.map(name => ({ name, sha256: info.migrations[name] })) };
  validate(plan, before, rows, info, database);
  return plan;
}
async function apply({ connection, plan, info, database, verifyWritersStopped, verifyBackup, loadMigration, journal }) {
  for (const f of [verifyWritersStopped, verifyBackup, loadMigration, journal]) if (typeof f !== 'function') fail('google_schema_controls_required');
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [{ actual }] = await query('SELECT DATABASE() AS actual');
  if (actual !== database) fail('google_schema_connection_target_mismatch');
  const [{ acquired }] = await query("SELECT GET_LOCK('clinicaclick_google_clinical_schema_release',0) AS acquired");
  if (Number(acquired) !== 1) fail('google_schema_migration_busy');
  let primaryFailure;
  try {
    await verifyWritersStopped();
    await query('SET SESSION lock_wait_timeout=15');
    await query('SET SESSION innodb_lock_wait_timeout=15');
    const before = await snapshot(query), rows = await rowFingerprints(query, plan.columns);
    validate(plan, before, rows, info, database);
    await verifyBackup(plan);
    const Sequelize = require('sequelize'), sequelize = new Sequelize({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const qi = sequelize.getQueryInterface(), completed = [];
    for (const m of plan.migrations) {
      await verifyWritersStopped();
      journal({ status: 'migration_started', migration: m.name, completed: [...completed] });
      await loadMigration(m).up(qi, Sequelize);
      await query('INSERT INTO SequelizeMeta (name) VALUES (?)', [m.name]);
      completed.push(m.name);
      journal({ status: 'migration_completed', migration: m.name, completed: [...completed] });
    }
    const after = await snapshot(query), result = compare(after, info.contract);
    if (!result.compatible) fail('google_schema_contract_incompatible');
    assert.deepEqual(await rowFingerprints(query, plan.columns), plan.rows, 'google_schema_legacy_rows_changed');
    for (const table of TABLES) assert.deepEqual(after.foreignKeys.filter(f => f.TABLE_NAME === table), before.foreignKeys.filter(f => f.TABLE_NAME === table));
    for (const table of NEW_TABLES) {
      const [{ n }] = await query('SELECT COUNT(*) AS n FROM `' + table + '`');
      if (Number(n)) fail('google_schema_new_tables_not_empty');
    }
    journal({ status: 'clinical_schema_compatible', completed, afterDigest: digest(after), rowsPreserved: plan.rows });
    return { ...result, completed, afterDigest: digest(after), rowsPreserved: plan.rows };
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    try { await query("SELECT RELEASE_LOCK('clinicaclick_google_clinical_schema_release')"); }
    catch (error) {
      if (!primaryFailure) throw error;
      Object.defineProperty(primaryFailure, 'releaseFailure', { value: clinicalCutFailure(error), configurable: true });
    }
  }
}
module.exports = { MIGRATIONS, HISTORICAL_MIGRATIONS, TABLES, NEW_TABLES, originalColumns, rowFingerprints, validate, prepare, apply };
