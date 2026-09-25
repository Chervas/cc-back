'use strict';

const { snapshot, compare, digest } = require('./securitySchemaContract');

const MIGRATIONS = Object.freeze([
  '20260919200000-create-business-profile-mutation-journal.js',
  '20260919210000-create-business-profile-cache-coordination.js',
]);

const TABLES = Object.freeze([
  'BusinessProfileMutations',
  'BusinessProfileMutationLocks',
  'BusinessProfileCacheStates',
]);

const fail = code => { throw Error(code); };

function withoutWriteSchema(value) {
  const omittedTables = new Set(TABLES);
  const omittedMigrations = new Set(MIGRATIONS);
  return {
    defaults: value.defaults,
    tables: value.tables.filter(row => !omittedTables.has(row.TABLE_NAME)),
    columns: value.columns.filter(row => !omittedTables.has(row.TABLE_NAME)),
    indexes: value.indexes.filter(row => !omittedTables.has(row.TABLE_NAME)),
    checks: value.checks.filter(row => !omittedTables.has(row.TABLE_NAME)),
    foreignKeys: value.foreignKeys.filter(row => !omittedTables.has(row.TABLE_NAME)),
    migrations: value.migrations.filter(name => !omittedMigrations.has(name)),
  };
}

function validate(plan, before, info, database) {
  if (!plan || plan.version !== 1 || plan.kind !== 'google_business_profile_writes_schema_v1'
    || plan.runtime !== 'staging' || !database || database === 'clinicaclick_dev_isolated'
    || plan.database !== database || plan.revision !== info.revision
    || plan.contractDigest !== info.contractDigest || plan.beforeDigest !== digest(before)
    || plan.beforeDigest !== digest(plan.before)
    || JSON.stringify(plan.migrations?.map(row => row.name)) !== JSON.stringify(MIGRATIONS)) {
    fail('google_business_profile_writes_plan_stale_or_invalid');
  }

  const base = compare(before, info.baseContract);
  if (!base.compatible) fail('google_business_profile_writes_base_schema_incompatible');

  const target = compare(before, info.targetContract);
  const missingTables = target.issues
    .filter(issue => issue.reason === 'missing_table')
    .map(issue => issue.table)
    .sort();
  if (target.compatible
    || JSON.stringify(missingTables) !== JSON.stringify([...TABLES].sort())
    || target.issues.some(issue => issue.reason !== 'missing_table')
    || JSON.stringify([...target.missingMigrations].sort()) !== JSON.stringify([...MIGRATIONS].sort())) {
    fail('google_business_profile_writes_target_schema_unexpected');
  }

  for (const migration of plan.migrations) {
    if (!/^[a-f0-9]{64}$/.test(migration.sha256)
      || info.migrations[migration.name] !== migration.sha256
      || !info.targetContract.migrations.some(row => row.name === migration.name && row.sha256 === migration.sha256)
      || before.migrations.includes(migration.name)) {
      fail('google_business_profile_writes_migration_changed_or_applied');
    }
  }
  if (TABLES.some(name => before.tables.some(row => row.TABLE_NAME === name))) {
    fail('google_business_profile_writes_partial_state_requires_review');
  }
}

async function prepare({ query, info, database }) {
  const before = await snapshot(query);
  const plan = {
    version: 1,
    kind: 'google_business_profile_writes_schema_v1',
    runtime: 'staging',
    database,
    revision: info.revision,
    contractDigest: info.contractDigest,
    beforeDigest: digest(before),
    before,
    migrations: MIGRATIONS.map(name => ({ name, sha256: info.migrations[name] })),
  };
  validate(plan, before, info, database);
  return plan;
}

async function apply({ connection, plan, info, database, verifyWritersStopped, verifyBackup, loadMigration, journal }) {
  for (const control of [verifyWritersStopped, verifyBackup, loadMigration, journal]) {
    if (typeof control !== 'function') fail('google_business_profile_writes_controls_required');
  }
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [{ actual }] = await query('SELECT DATABASE() AS actual');
  if (actual !== database) fail('google_business_profile_writes_target_mismatch');
  const [{ acquired }] = await query("SELECT GET_LOCK('clinicaclick_google_business_profile_writes_schema_release',0) AS acquired");
  if (Number(acquired) !== 1) fail('google_business_profile_writes_migration_busy');

  let primaryFailure;
  try {
    await verifyWritersStopped();
    await query('SET SESSION lock_wait_timeout=15');
    await query('SET SESSION innodb_lock_wait_timeout=15');
    const before = await snapshot(query);
    validate(plan, before, info, database);
    await verifyBackup(plan);

    const Sequelize = require('sequelize');
    const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const queryInterface = sequelize.getQueryInterface();
    const completed = [];

    for (const migration of plan.migrations) {
      await verifyWritersStopped();
      journal({ status: 'migration_started', migration: migration.name, completed: [...completed] });
      await loadMigration(migration).up(queryInterface, Sequelize);
      await query('INSERT INTO SequelizeMeta (name) VALUES (?)', [migration.name]);
      completed.push(migration.name);
      journal({ status: 'migration_completed', migration: migration.name, completed: [...completed] });
    }

    const after = await snapshot(query);
    const target = compare(after, info.targetContract);
    if (!target.compatible) fail('google_business_profile_writes_contract_incompatible');
    if (digest(withoutWriteSchema(after)) !== digest(withoutWriteSchema(before))) {
      fail('google_business_profile_writes_existing_schema_changed');
    }
    for (const table of TABLES) {
      const [{ total }] = await query(`SELECT COUNT(*) AS total FROM \`${table}\``);
      if (Number(total) !== 0) fail('google_business_profile_writes_new_tables_not_empty');
    }
    journal({ status: 'google_business_profile_writes_schema_compatible', completed, afterDigest: digest(after) });
    return { ...target, completed, afterDigest: digest(after) };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await query("SELECT RELEASE_LOCK('clinicaclick_google_business_profile_writes_schema_release')");
    } catch (error) {
      if (!primaryFailure) throw error;
      Object.defineProperty(primaryFailure, 'releaseFailure', { value: error.message, configurable: true });
    }
  }
}

module.exports = { MIGRATIONS, TABLES, withoutWriteSchema, validate, prepare, apply };
