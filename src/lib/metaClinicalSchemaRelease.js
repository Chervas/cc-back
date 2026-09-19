'use strict';
// Only the nine additive Meta migrations. The DEV CLI stays DEV-only.
// This module never loads application models, credentials or a provider.
const assert = require('node:assert/strict');
const { snapshot, compare, digest } = require('./securitySchemaContract');
const MIGRATIONS = Object.freeze([
  '20260919040000-meta-marketing-broker-registry.js',
  '20260919050000-meta-marketing-broker-revocations.js',
  '20260919060000-meta-marketing-oauth.js',
  '20260919070000-meta-marketing-parent-identity-indexes.js',
  '20260919080000-meta-marketing-enrollment-journal.js',
  '20260919090000-meta-marketing-enrollment-binding-owner.js',
  '20260919100000-meta-marketing-enrollment-delivery-markers.js',
  '20260919110000-meta-marketing-enrollment-due-index.js',
  '20260919120000-meta-marketing-enrollment-scope-latest.js',
]);
const TABLES = Object.freeze(['MetaConnections', 'ClinicMetaAssets']);
const NEW_TABLES = Object.freeze(['MetaMarketingBrokerBindings', 'MetaMarketingBrokerRevocations',
  'MetaMarketingOAuthSlots', 'MetaMarketingOAuthRequests', 'MetaMarketingEnrollmentRequests',
  'MetaMarketingEnrollmentClaims', 'MetaMarketingEnrollmentIdentities']);
const fail = code => { throw Error(code); };
function originalColumns(before) {
  return Object.fromEntries(TABLES.map(table => {
    const names = before.columns.filter(c => c.TABLE_NAME === table).map(c => c.COLUMN_NAME);
    if (!names.includes('id') || names.some(n => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))) fail('meta_schema_columns_invalid');
    return [table, names];
  }));
}
async function rowFingerprints(query, columns) {
  assert.deepEqual(Object.keys(columns), TABLES);
  const result = {};
  for (const table of TABLES) {
    const names = columns[table];
    if (!names.includes('id') || names.some(n => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(n))) fail('meta_schema_columns_invalid');
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM `' + table + '`');
    if (Number(n) > 100000) fail('meta_schema_data_review_required');
    // Values, including legacy tokens, remain inside SQL. Return only a digest
    // of each complete old row; preserve nulls, timestamps, JSON and Unicode.
    const pairs = names.map(n => "'" + n + "',`" + n + '`').join(',');
    const rows = await query('SELECT SHA2(CAST(JSON_OBJECT(' + pairs + ') AS CHAR CHARACTER SET utf8mb4),256) AS row_digest FROM `' + table + '` ORDER BY id');
    result[table] = { count: Number(n), digest: digest(rows.map(r => r.row_digest)) };
  }
  return result;
}
function validate(plan, before, rows, info, database) {
  if (plan.version !== 1 || plan.kind !== 'meta_clinical_schema_v1' || plan.runtime !== 'staging'
    || !database || database === 'clinicaclick_dev_isolated' || plan.database !== database
    || plan.revision !== info.revision || plan.contractDigest !== info.contractDigest
    || plan.beforeDigest !== digest(before) || plan.beforeDigest !== digest(plan.before)
    || plan.rowsDigest !== digest(rows) || plan.rowsDigest !== digest(plan.rows)
    || JSON.stringify(plan.columns) !== JSON.stringify(originalColumns(before))
    || JSON.stringify(plan.migrations?.map(m => m.name)) !== JSON.stringify(MIGRATIONS)) fail('meta_schema_plan_stale_or_invalid');
  if (NEW_TABLES.some(name => before.tables.some(t => t.TABLE_NAME === name))) fail('meta_schema_partial_state_requires_review');
  for (const m of plan.migrations) {
    if (!/^[a-f0-9]{64}$/.test(m.sha256) || info.migrations[m.name] !== m.sha256
      || !info.contract.migrations.some(c => c.name === m.name && c.sha256 === m.sha256)
      || before.migrations.includes(m.name)) fail('meta_schema_migration_changed_or_applied');
  }
}
async function prepare({ query, info, database }) {
  const before = await snapshot(query), columns = originalColumns(before), rows = await rowFingerprints(query, columns);
  const [{ invalid }] = await query('SELECT COUNT(*) AS invalid FROM MetaConnections WHERE accessToken IS NULL OR CHAR_LENGTH(accessToken)>512');
  if (Number(invalid)) fail('meta_schema_legacy_credentials_require_review');
  const plan = { version: 1, kind: 'meta_clinical_schema_v1', runtime: 'staging', database,
    revision: info.revision, contractDigest: info.contractDigest, beforeDigest: digest(before),
    rowsDigest: digest(rows), before, columns, rows,
    migrations: MIGRATIONS.map(name => ({ name, sha256: info.migrations[name] })) };
  validate(plan, before, rows, info, database);
  return plan;
}
async function apply({ connection, plan, info, database, verifyWritersStopped, verifyBackup, loadMigration, journal }) {
  for (const f of [verifyWritersStopped, verifyBackup, loadMigration, journal]) if (typeof f !== 'function') fail('meta_schema_controls_required');
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [{ actual }] = await query('SELECT DATABASE() AS actual');
  if (actual !== database) fail('meta_schema_connection_target_mismatch');
  const [{ acquired }] = await query("SELECT GET_LOCK('clinicaclick_meta_clinical_schema_release',0) AS acquired");
  if (Number(acquired) !== 1) fail('meta_schema_migration_busy');
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
    if (!result.compatible) fail('meta_schema_contract_incompatible');
    assert.deepEqual(await rowFingerprints(query, plan.columns), plan.rows, 'meta_schema_legacy_rows_changed');
    for (const table of TABLES) assert.deepEqual(after.foreignKeys.filter(f => f.TABLE_NAME === table), before.foreignKeys.filter(f => f.TABLE_NAME === table));
    for (const table of NEW_TABLES) {
      const [{ n }] = await query('SELECT COUNT(*) AS n FROM `' + table + '`');
      if (Number(n)) fail('meta_schema_new_tables_not_empty');
    }
    journal({ status: 'clinical_schema_compatible', completed, afterDigest: digest(after), rowsPreserved: plan.rows });
    return { ...result, completed, afterDigest: digest(after), rowsPreserved: plan.rows };
  } finally { await query("SELECT RELEASE_LOCK('clinicaclick_meta_clinical_schema_release')"); }
}
module.exports = { MIGRATIONS, TABLES, NEW_TABLES, originalColumns, rowFingerprints, validate, prepare, apply };
