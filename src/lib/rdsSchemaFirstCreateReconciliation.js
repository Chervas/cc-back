'use strict';
// Deliberately narrow recovery for one reviewed, interrupted CREATE. This is
// not a general migration retry mechanism and never executes SQL.
const { digest } = require('./securitySchemaContract');
const P = require('./rdsSchemaMigrationPolicy');
const SUPPORTED = Object.freeze({ migration: '20261024190000-create-clinic-supplies.js', table: 'ClinicSuppliers',
  migrationSha256: '170da760689aa986f7b46ab3937fe06d776d9ac513c4fadcf478c37fec542e6a',
  sqlSha256: '37ef9ad22f006b17e49d8fdf0f84a00043da30448d9a9d33f744f8f7220c5877' });
const DELEGATED = Object.freeze({ migration: '20261028110000-create-delegated-sessions.js', table: 'DelegatedSessions',
  migrationSha256: 'd186aa13eee725796d0939b56d6c3fa9d1dfc2fc71eab30cde3012b7d66e0d10',
  sqlSha256: 'b760ee243c517c2d90c45c1d3ed85fdbec1b38af87e0e8b5d95bbd2c7faeb55e',
  sourceRevision: '31663fad9136aab5df102d7c29ac0af4eb1a6927',
  originalPlanSha256: '4f77689336cab7b6ec80a8a72ef3f55243cfb224caa27533bd04496615d0bb90',
  originalOperationNonce: 'e12232be-0657-406c-8033-0dc4a99be329',
  diagnosticMessageSha256: 'a947e3875a510823331e22329aacd5cf0733eb3fe3b6116fca640a79d1e0b2fc' });
const supported = plan => plan.toApply?.[0] === DELEGATED.migration ? DELEGATED : SUPPORTED;
const canonicalType = value => String(value).toLowerCase().replace(/\binteger\b/g, 'int').replace(/\b(int|bigint)\(\d+\)/g, '$1').replace(/,\s*/g, ',');
async function definition(source, plan) {
  const selected = supported(plan), delegated = selected === DELEGATED;
  const S = require('sequelize'), sequelize = new S({ dialect: 'mysql', logging: false });
  const stop = Error('rds_schema_first_create_captured'); let captured, sql;
  const pins = P.migrationFiles(source, plan.selected.map(row => row.name));
  P.need(digest(pins) === digest(plan.moduleFiles) && plan.toApply[0] === selected.migration
    && plan.selected[0]?.name === selected.migration && plan.selected[0]?.sha256 === selected.migrationSha256
    && (!delegated || plan.sourceRevision === DELEGATED.sourceRevision && plan.selected.length === 1 && plan.toApply.length === 1),
  'rds_schema_reconciliation_source_changed');
  const { migration, facade } = P.loadMigration(source, selected.migration, pins, S);
  sequelize.connectionManager.getConnection = async () => { throw Error('rds_schema_reconciliation_network_forbidden'); };
  sequelize.query = async value => { P.need(!sql && typeof value === 'string', 'rds_schema_reconciliation_first_create_only'); sql = value; throw stop; };
  const q = Object.fromEntries(P.METHODS.map(name => [name, async () => { throw Error('rds_schema_reconciliation_first_create_only'); }]));
  q.sequelize = Object.freeze({ query: q.describeTable });
  q.createTable = async (table, columns, options) => {
    P.need(!captured && table === selected.table && options === undefined, 'rds_schema_reconciliation_first_create_only');
    captured = { table, columns };
    await sequelize.getQueryInterface().createTable(table, columns);
  };
  try { await migration.up(Object.freeze(q), facade); P.need(false, 'rds_schema_reconciliation_first_create_only'); }
  catch (error) { if (error !== stop) throw error; }
  P.need(captured && P.sha(sql) === selected.sqlSha256, 'rds_schema_reconciliation_sql_changed');
  const table = { TABLE_NAME: captured.table, ENGINE: 'InnoDB', TABLE_COLLATION: plan.before.defaults.DEFAULT_COLLATION_NAME };
  const columns = [], primary = [], foreignKeys = [], indexes = [];
  for (const [name, input] of Object.entries(captured.columns)) {
    const attr = sequelize.normalizeAttribute(input), rawType = canonicalType(attr.type.toSql());
    const uuid = delegated && rawType === 'char(36) binary' && attr.type.key === 'UUID';
    const type = uuid ? 'char(36)' : rawType;
    const unique = delegated && name === 'handoff_digest' && attr.unique === true;
    P.need((!attr.unique || unique) && !attr.autoIncrement && !attr.comment && !attr.field && !attr.defaultValue?.val,
      'rds_schema_reconciliation_definition_unsupported');
    const textual = uuid || /^(?:varchar|text)\b/.test(type);
    P.need(/^(?:varchar\(\d+\)|text|int(?: unsigned)?|tinyint\(1\)|datetime)$/.test(type)
      || delegated && (uuid || type === 'datetime(3)'), 'rds_schema_reconciliation_definition_unsupported');
    columns.push({ TABLE_NAME: captured.table, COLUMN_NAME: name, COLUMN_TYPE: type,
      IS_NULLABLE: attr.primaryKey || attr.allowNull === false ? 'NO' : 'YES',
      COLUMN_DEFAULT: attr.defaultValue == null ? null : typeof attr.defaultValue === 'boolean' ? attr.defaultValue ? '1' : '0' : String(attr.defaultValue),
      EXTRA: '', CHARACTER_SET_NAME: textual ? plan.before.defaults.DEFAULT_CHARACTER_SET_NAME : null,
      COLLATION_NAME: uuid ? 'utf8mb4_bin' : textual ? plan.before.defaults.DEFAULT_COLLATION_NAME : null, GENERATION_EXPRESSION: '' });
    if (attr.primaryKey) primary.push(name);
    if (unique) indexes.push({ TABLE_NAME: captured.table, INDEX_NAME: name, NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: name, SUB_PART: null, INDEX_TYPE: 'BTREE' });
    if (attr.references) {
      P.need(typeof attr.references.model === 'string' && typeof attr.references.key === 'string' && attr.onDelete === 'RESTRICT'
        && (delegated ? attr.onUpdate === 'RESTRICT' : !attr.onUpdate), 'rds_schema_reconciliation_definition_unsupported');
      foreignKeys.push({ TABLE_NAME: captured.table, CONSTRAINT_NAME: captured.table + '_ibfk_' + (foreignKeys.length + 1), ORDINAL_POSITION: 1,
        COLUMN_NAME: name, REFERENCED_TABLE_SCHEMA: '<self>', REFERENCED_TABLE_NAME: attr.references.model,
        REFERENCED_COLUMN_NAME: attr.references.key, UPDATE_RULE: delegated ? 'RESTRICT' : 'NO ACTION', DELETE_RULE: 'RESTRICT' });
      indexes.push({ TABLE_NAME: captured.table, INDEX_NAME: name, NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: name, SUB_PART: null, INDEX_TYPE: 'BTREE' });
    }
  }
  P.need(primary.length === 1 && foreignKeys.length === (delegated ? 3 : 1)
    && (!delegated || columns.length === 20 && indexes.filter(row => row.NON_UNIQUE === 0).length === 1
      && columns.filter(row => row.COLUMN_TYPE === 'char(36)' && row.COLLATION_NAME === 'utf8mb4_bin').length === 2
      && plan.before.defaults.DEFAULT_CHARACTER_SET_NAME === 'utf8mb4'), 'rds_schema_reconciliation_definition_unsupported');
  indexes.push({ TABLE_NAME: captured.table, INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: primary[0], SUB_PART: null, INDEX_TYPE: 'BTREE' });
  return { table, columns, indexes, foreignKeys };
}
async function validate({ source, originalPlan, observed, identity, result, journal }) {
  const selected = supported(originalPlan), delegated = selected === DELEGATED;
  P.need(result.status === 'rds_schema_failed_preserve_partial' && result.reason === 'rds_schema_statement_warnings_require_reconciliation'
    && result.writesDispatched === 1 && result.automaticReplayAllowed === false && result.closure?.physicalCloseObserved === true
    && result.closure.physicalStreamDestroyed === true && result.transportOpened === true && !originalPlan.continuation,
  'rds_schema_reconciliation_unsupported_outcome');
  P.need(result.backup?.status === 'available' && result.backup.physicalDbId === originalPlan.identity.physicalDbId
    && Date.parse(result.backup.createdAt) >= originalPlan.createdAtEpochMs, 'rds_schema_reconciliation_backup_binding');
  P.need(digest(originalPlan.before) === originalPlan.beforeDigest && digest(originalPlan.identity) === digest(identity), 'rds_schema_reconciliation_identity_or_baseline_changed');
  const requests = journal.filter(row => row.event === 'statement_request');
  P.need(requests.length === 1 && requests[0].migration === selected.migration && requests[0].sqlSha256 === selected.sqlSha256
    && requests[0].kind === 'ddl' && !journal.some(row => row.event === 'statement_ack' || row.event === 'statement_reconciled')
    && journal.at(-1)?.event === 'terminal' && journal.at(-1)?.accepted === false, 'rds_schema_reconciliation_prefix_changed');
  let originalDiagnostics;
  if (delegated) {
    P.need(result.operationNonce === DELEGATED.originalOperationNonce && result.planRef?.sha256 === DELEGATED.originalPlanSha256
      && originalPlan.sourceRevision === DELEGATED.sourceRevision && identity.engineVersion === '8.4.11', 'rds_schema_reconciliation_original_run_changed');
    const diagnostics = journal.filter(row => row.event === 'statement_diagnostics');
    const expected = Array.from({ length: 2 }, () => ({ level: 'Warning', code: 1287, messageSha256: DELEGATED.diagnosticMessageSha256 }));
    P.need(diagnostics.length === 1 && diagnostics[0].migration === selected.migration && diagnostics[0].sqlSha256 === selected.sqlSha256
      && diagnostics[0].kind === 'ddl' && diagnostics[0].warningReadFailed === false && diagnostics[0].warningStatus === 2
      && diagnostics[0].policy === 'mysql-8.4.11-tinyint1-display-width/1' && digest(diagnostics[0].diagnostics) === digest(expected)
      && journal.indexOf(diagnostics[0]) > journal.indexOf(requests[0]) && journal.indexOf(diagnostics[0]) < journal.length - 1,
    'rds_schema_reconciliation_original_diagnostics_changed');
    originalDiagnostics = { journalIndex: journal.indexOf(diagnostics[0]), journalRowDigest: digest(diagnostics[0]),
      warningReadFailed: false, warningStatus: 2, diagnostics: expected, policy: diagnostics[0].policy };
  }
  const shape = await definition(source, originalPlan), before = originalPlan.before, tableName = selected.table;
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
  return { migration: selected.migration, table: tableName, sqlSha256: selected.sqlSha256,
    definitionDigest: digest(shape), originalBeforeDigest: originalPlan.beforeDigest, observedDigest: digest(observed),
    originalWarning: delegated ? 'retained_by_original_operator_hashed_diagnostics' : 'not_retained_by_original_operator_unknown',
    ...(delegated ? { originalDiagnostics } : {}) };
}
module.exports = { SUPPORTED, DELEGATED, definition, validate };
