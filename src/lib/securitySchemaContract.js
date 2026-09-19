'use strict';
// Schema metadata only: never import application models or select business rows.
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(query) {
  const [defaults] = await query('SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()', []);
  const tables = await query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", []);
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION', []);
  const indexes = await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', []);
  const checks = await query("SELECT t.TABLE_NAME,t.CONSTRAINT_NAME,t.ENFORCED,c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.CONSTRAINT_SCHEMA=DATABASE() AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME", []);
  const foreignKeys = await query("SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION,k.COLUMN_NAME,IF(k.REFERENCED_TABLE_SCHEMA=DATABASE(),'<self>',k.REFERENCED_TABLE_SCHEMA) AS REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION", []);
  const migrations = tables.some(t => t.TABLE_NAME === 'SequelizeMeta') ? (await query('SELECT name FROM SequelizeMeta ORDER BY name', [])).map(r => r.name) : [];
  return { defaults, tables, columns, indexes, checks, foreignKeys, migrations };
}
function compare(actual, contract) {
  const issues = [];
  for (const [key, value] of Object.entries(contract.defaults || {})) if (actual.defaults?.[key] !== value) issues.push({ reason: 'database_default', field: key });
  for (const [name, expected] of Object.entries(contract.tables)) {
    const table = actual.tables.find(t => t.TABLE_NAME === name);
    if (!table) { issues.push({ table: name, reason: 'missing_table' }); continue; }
    for (const key of ['ENGINE', 'TABLE_COLLATION']) if (table[key] !== expected[key]) issues.push({ table: name, reason: 'table_definition', field: key });
    for (const col of expected.columns) {
      const found = actual.columns.find(c => c.TABLE_NAME === name && c.COLUMN_NAME === col.COLUMN_NAME);
      if (!found) { issues.push({ table: name, column: col.COLUMN_NAME, reason: 'missing_column' }); continue; }
      for (const key of Object.keys(col)) if (found[key] !== col[key]) issues.push({ table: name, column: col.COLUMN_NAME, reason: 'column_definition', field: key });
    }
    for (const index of expected.indexes) {
      const found = actual.indexes.filter(i => i.TABLE_NAME === name && i.INDEX_NAME === index.name).map(({ TABLE_NAME, ...i }) => i);
      if (JSON.stringify(found) !== JSON.stringify(index.columns)) issues.push({ table: name, index: index.name, reason: 'index_definition' });
    }
    for (const check of expected.checks || []) {
      const found = (actual.checks || []).find(c => c.TABLE_NAME === name && c.CONSTRAINT_NAME === check.CONSTRAINT_NAME);
      if (!found || Object.keys(check).some(key => found[key] !== check[key])) {
        issues.push({ table: name, constraint: check.CONSTRAINT_NAME, reason: 'check_definition' });
      }
    }
    // An explicit empty set protects independent security journals against a
    // future cascade. Existing contracts without this property remain additive.
    if (Object.hasOwn(expected, 'foreignKeys')) {
      const found = (actual.foreignKeys || []).filter(k => k.TABLE_NAME === name).map(({ TABLE_NAME, ...key }) => key);
      if (JSON.stringify(found) !== JSON.stringify(expected.foreignKeys)) issues.push({ table: name, reason: 'foreign_key_definition' });
    }
  }
  const missingMigrations = contract.migrations.filter(m => !actual.migrations.includes(m.name)).map(m => m.name);
  return { compatible: issues.length === 0 && missingMigrations.length === 0, issues, missingMigrations };
}
function validatePlan(plan, actual, revision, contractDigest, migrations) {
  if (plan.version !== 1 || plan.runtime !== 'dev' || plan.database !== 'clinicaclick_dev_isolated'
    || plan.revision !== revision || plan.contractDigest !== contractDigest || plan.beforeDigest !== digest(actual)
    || !Array.isArray(plan.migrations) || !plan.migrations.length || plan.migrations.length > 20
    || new Set(plan.migrations.map(m => m.name)).size !== plan.migrations.length) throw Error('schema_plan_stale_or_invalid');
  for (const m of plan.migrations) if (!/^[0-9]{14}-[a-z0-9-]+\.js$/.test(m.name)
    || !/^[a-f0-9]{64}$/.test(m.sha256) || migrations[m.name] !== m.sha256 || actual.migrations.includes(m.name)) throw Error('schema_migration_changed_or_applied');
}
module.exports = { snapshot, compare, digest, validatePlan };
