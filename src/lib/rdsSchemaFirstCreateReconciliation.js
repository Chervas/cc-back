'use strict';
// Deliberately narrow recovery for one reviewed, interrupted CREATE. This is
// not a general migration retry mechanism and never executes SQL.
const { digest } = require('./securitySchemaContract');
const P = require('./rdsSchemaMigrationPolicy');
const SUPPORTED = Object.freeze({ migration: '20261024190000-create-clinic-supplies.js', table: 'ClinicSuppliers',
  migrationSha256: '170da760689aa986f7b46ab3937fe06d776d9ac513c4fadcf478c37fec542e6a',
  sqlSha256: '37ef9ad22f006b17e49d8fdf0f84a00043da30448d9a9d33f744f8f7220c5877' });
const canonicalType = value => String(value).toLowerCase().replace(/\binteger\b/g, 'int').replace(/\b(int|bigint)\(\d+\)/g, '$1').replace(/,\s*/g, ',');
async function definition(source, plan) {
  const S = require('sequelize'), sequelize = new S({ dialect: 'mysql', logging: false });
  const stop = Error('rds_schema_first_create_captured'); let captured, sql;
  const pins = P.migrationFiles(source, plan.selected.map(row => row.name));
  P.need(digest(pins) === digest(plan.moduleFiles) && plan.toApply[0] === SUPPORTED.migration
    && plan.selected[0]?.name === SUPPORTED.migration && plan.selected[0]?.sha256 === SUPPORTED.migrationSha256,
  'rds_schema_reconciliation_source_changed');
  const { migration, facade } = P.loadMigration(source, SUPPORTED.migration, pins, S);
  sequelize.connectionManager.getConnection = async () => { throw Error('rds_schema_reconciliation_network_forbidden'); };
  sequelize.query = async value => { P.need(!sql && typeof value === 'string', 'rds_schema_reconciliation_first_create_only'); sql = value; throw stop; };
  const q = Object.fromEntries(P.METHODS.map(name => [name, async () => { throw Error('rds_schema_reconciliation_first_create_only'); }]));
  q.sequelize = Object.freeze({ query: q.describeTable });
  q.createTable = async (table, columns, options) => {
    P.need(!captured && table === SUPPORTED.table && options === undefined, 'rds_schema_reconciliation_first_create_only');
    captured = { table, columns };
    await sequelize.getQueryInterface().createTable(table, columns);
  };
  try { await migration.up(Object.freeze(q), facade); P.need(false, 'rds_schema_reconciliation_first_create_only'); }
  catch (error) { if (error !== stop) throw error; }
  P.need(captured && P.sha(sql) === SUPPORTED.sqlSha256, 'rds_schema_reconciliation_sql_changed');
  const table = { TABLE_NAME: captured.table, ENGINE: 'InnoDB', TABLE_COLLATION: plan.before.defaults.DEFAULT_COLLATION_NAME };
  const columns = [], primary = [], foreignKeys = [], indexes = [];
  for (const [name, input] of Object.entries(captured.columns)) {
    const attr = sequelize.normalizeAttribute(input), type = canonicalType(attr.type.toSql());
    P.need(!attr.unique && !attr.autoIncrement && !attr.comment && !attr.field && !attr.defaultValue?.val,
      'rds_schema_reconciliation_definition_unsupported');
    const textual = /^(?:varchar|text)\b/.test(type);
    P.need(/^(?:varchar\(\d+\)|text|int(?: unsigned)?|tinyint\(1\)|datetime)$/.test(type), 'rds_schema_reconciliation_definition_unsupported');
    columns.push({ TABLE_NAME: captured.table, COLUMN_NAME: name, COLUMN_TYPE: type,
      IS_NULLABLE: attr.primaryKey || attr.allowNull === false ? 'NO' : 'YES',
      COLUMN_DEFAULT: attr.defaultValue == null ? null : typeof attr.defaultValue === 'boolean' ? attr.defaultValue ? '1' : '0' : String(attr.defaultValue),
      EXTRA: '', CHARACTER_SET_NAME: textual ? plan.before.defaults.DEFAULT_CHARACTER_SET_NAME : null,
      COLLATION_NAME: textual ? plan.before.defaults.DEFAULT_COLLATION_NAME : null, GENERATION_EXPRESSION: '' });
    if (attr.primaryKey) primary.push(name);
    if (attr.references) {
      P.need(typeof attr.references.model === 'string' && typeof attr.references.key === 'string' && attr.onDelete === 'RESTRICT'
        && !attr.onUpdate, 'rds_schema_reconciliation_definition_unsupported');
      foreignKeys.push({ TABLE_NAME: captured.table, CONSTRAINT_NAME: captured.table + '_ibfk_' + (foreignKeys.length + 1), ORDINAL_POSITION: 1,
        COLUMN_NAME: name, REFERENCED_TABLE_SCHEMA: '<self>', REFERENCED_TABLE_NAME: attr.references.model,
        REFERENCED_COLUMN_NAME: attr.references.key, UPDATE_RULE: 'NO ACTION', DELETE_RULE: 'RESTRICT' });
      indexes.push({ TABLE_NAME: captured.table, INDEX_NAME: name, NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: name, SUB_PART: null, INDEX_TYPE: 'BTREE' });
    }
  }
  P.need(primary.length === 1 && foreignKeys.length === 1, 'rds_schema_reconciliation_definition_unsupported');
  indexes.push({ TABLE_NAME: captured.table, INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: primary[0], SUB_PART: null, INDEX_TYPE: 'BTREE' });
  return { table, columns, indexes, foreignKeys };
}
async function validate({ source, originalPlan, observed, identity, result, journal }) {
  P.need(result.status === 'rds_schema_failed_preserve_partial' && result.reason === 'rds_schema_statement_warnings_require_reconciliation'
    && result.writesDispatched === 1 && result.automaticReplayAllowed === false && result.closure?.physicalCloseObserved === true
    && result.closure.physicalStreamDestroyed === true && result.transportOpened === true && !originalPlan.continuation,
  'rds_schema_reconciliation_unsupported_outcome');
  P.need(result.backup?.status === 'available' && result.backup.physicalDbId === originalPlan.identity.physicalDbId
    && Date.parse(result.backup.createdAt) >= originalPlan.createdAtEpochMs, 'rds_schema_reconciliation_backup_binding');
  P.need(digest(originalPlan.before) === originalPlan.beforeDigest && digest(originalPlan.identity) === digest(identity), 'rds_schema_reconciliation_identity_or_baseline_changed');
  const requests = journal.filter(row => row.event === 'statement_request');
  P.need(requests.length === 1 && requests[0].migration === SUPPORTED.migration && requests[0].sqlSha256 === SUPPORTED.sqlSha256
    && requests[0].kind === 'ddl' && !journal.some(row => row.event === 'statement_ack' || row.event === 'statement_reconciled')
    && journal.at(-1)?.event === 'terminal' && journal.at(-1)?.accepted === false, 'rds_schema_reconciliation_prefix_changed');
  const shape = await definition(source, originalPlan), before = originalPlan.before, tableName = SUPPORTED.table;
  P.need(!before.tables.some(row => row.TABLE_NAME === tableName), 'rds_schema_reconciliation_original_table_existed');
  const canonicalRows = rows => rows.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const same = (a, b) => digest(canonicalRows(a)) === digest(canonicalRows(b));
  P.need(digest(before.defaults) === digest(observed.defaults), 'rds_schema_reconciliation_metadata_drift');
  for (const group of ['tables', 'columns', 'indexes', 'foreignKeys']) {
    const wanted = group === 'tables' ? [shape.table] : shape[group];
    const equal = group === 'columns' ? (a, b) => digest(a) === digest(b) : same;
    P.need(equal(observed[group].filter(row => row.TABLE_NAME === tableName), wanted)
      && equal(observed[group].filter(row => row.TABLE_NAME !== tableName), before[group]), 'rds_schema_reconciliation_metadata_drift');
  }
  for (const group of ['checks', 'triggers', 'migrations']) P.need(digest(observed[group]) === digest(before[group]), 'rds_schema_reconciliation_metadata_drift');
  return { migration: SUPPORTED.migration, table: tableName, sqlSha256: SUPPORTED.sqlSha256,
    definitionDigest: digest(shape), originalBeforeDigest: originalPlan.beforeDigest, observedDigest: digest(observed),
    originalWarning: 'not_retained_by_original_operator_unknown' };
}
module.exports = { SUPPORTED, definition, validate };
