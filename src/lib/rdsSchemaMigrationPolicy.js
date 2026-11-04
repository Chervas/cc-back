'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { digest, compare, effectiveContract } = require('./securitySchemaContract');
const enumExtension = require('./mysqlEnumExtension');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => { if (!value) throw Error(code); };
const NAME = /^[0-9]{14}-[a-z0-9-]+\.js$/;
const PLAN_SCHEMA = 'clinicaclick-rds-selective-schema-plan/2';
const METHODS = ['createTable', 'addColumn', 'changeColumn', 'addIndex', 'removeIndex', 'addConstraint',
  'removeConstraint', 'renameColumn', 'removeColumn', 'dropTable', 'describeTable', 'showAllTables',
  'showIndex', 'getForeignKeyReferencesForTable'];

// These modules are reviewed repository code, not an untrusted-code sandbox.
// The restricted loader prevents accidental models/.env/child/network imports.
function migrationFiles(source, names) {
  const files = new Map();
  function visit(file) {
    file = path.resolve(file);
    need(file.startsWith(source + '/migrations/') || file.startsWith(source + '/src/lib/'), 'rds_schema_module_scope');
    need(/\.(js|json)$/.test(file) && fs.realpathSync(file) === file && fs.lstatSync(file).isFile(), 'rds_schema_module_scope');
    if (files.has(file)) return;
    const bytes = fs.readFileSync(file); need(bytes.length <= 1024 * 1024, 'rds_schema_module_size');
    files.set(file, { path: path.relative(source, file), sha256: sha(bytes) });
    if (file.endsWith('.json')) return;
    const text = bytes.toString();
    const requires = [...text.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)];
    need((text.match(/\brequire\s*\(/g) || []).length === requires.length, 'rds_schema_dynamic_import_forbidden');
    need(!/\bimport\s*\(/.test(text), 'rds_schema_dynamic_import_forbidden');
    for (const [, , request] of requires) {
      if (['sequelize', 'crypto', 'node:crypto'].includes(request)) continue;
      need(request.startsWith('.'), 'rds_schema_module_import_forbidden');
      const target = path.resolve(path.dirname(file), request);
      const resolved = /\.(js|json)$/.test(target) ? target : target + '.js';
      visit(resolved);
    }
  }
  for (const name of names) { need(NAME.test(name), 'rds_schema_migration_name'); visit(path.join(source, 'migrations', name)); }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Runtime conditions choose requirements, never which migrations may execute.
// Explicitly selecting a migration also requires its whole feature group after
// DDL, even if that runtime's feature is currently disabled. No real env changes.
function effectiveRequirements(info, selected, env, runtime = 'full-contract') {
  need(Array.isArray(selected) && selected.length <= 20 && new Set(selected).size === selected.length && selected.every(name => NAME.test(name)), 'rds_schema_selection_invalid');
  const raw = info.contract;
  const contract = env === undefined ? structuredClone(raw) : effectiveContract(raw, env);
  const disabled = new Set(contract.disabledFeatureGroups || []);
  const runtimeGroups = Object.keys(raw.featureGroups || {}).filter(name => !disabled.has(name)).sort();
  const forced = [];
  for (const [name, group] of Object.entries(raw.featureGroups || {})) {
    if (!(group.migrations || []).some(migration => selected.includes(migration))) continue;
    forced.push(name); disabled.delete(name);
    for (const table of group.tables || []) {
      need(raw.tables[table], 'rds_schema_feature_contract_invalid');
      contract.tables[table] = structuredClone(raw.tables[table]);
    }
    for (const migration of group.migrations || []) {
      const pinned = raw.migrations.find(row => row.name === migration);
      need(pinned, 'rds_schema_feature_contract_invalid');
      if (!contract.migrations.some(row => row.name === migration)) contract.migrations.push(structuredClone(pinned));
    }
  }
  // Stable source ordering keeps the digest independent of the order groups
  // were restored. Execution order remains the explicitly selected plan order.
  contract.tables = Object.fromEntries(Object.keys(raw.tables).filter(name => Object.hasOwn(contract.tables, name)).map(name => [name, contract.tables[name]]));
  contract.migrations = raw.migrations.filter(row => contract.migrations.some(value => value.name === row.name)).map(row => structuredClone(row));
  if (env !== undefined || Object.hasOwn(contract, 'disabledFeatureGroups')) contract.disabledFeatureGroups = [...disabled].sort();
  const scope = { schema: 'clinicaclick-rds-effective-requirements/1', runtime,
    selectedMigrations: selected.slice().sort(), runtimeFeatureGroups: runtimeGroups, selectedFeatureGroups: forced.sort() };
  return { contract, scope, digest: digest({ contract, scope }) };
}
function requirementsFor(info, selected) {
  if (!info.effectiveContract) return effectiveRequirements(info, selected);
  const result = { contract: info.effectiveContract, scope: info.effectiveContractScope, digest: info.effectiveContractDigest };
  need(result.scope?.schema === 'clinicaclick-rds-effective-requirements/1'
    && digest(result.scope.selectedMigrations) === digest(selected.slice().sort())
    && result.digest === digest({ contract: result.contract, scope: result.scope }), 'rds_schema_effective_requirements_invalid');
  return result;
}
function assertRequirements(plan, info, selected) {
  need(plan?.schema === PLAN_SCHEMA, 'rds_schema_plan_version_unsupported');
  const current = requirementsFor(info, selected);
  need(plan.effectiveContractDigest === current.digest && digest(plan.effectiveContractScope) === digest(current.scope),
    'rds_schema_effective_requirements_changed');
  need(digest(plan.operatorFiles) === digest(info.operatorFiles || []), 'rds_schema_operator_source_changed');
  return current;
}
function buildPlan({ info, before, identity, selected, moduleFiles, profile, at, continuation }) {
  need(Array.isArray(selected) && selected.length <= 20 && new Set(selected).size === selected.length, 'rds_schema_selection_invalid');
  for (const name of selected) need(NAME.test(name) && /^[a-f0-9]{64}$/.test(info.migrations[name] || ''), 'rds_schema_migration_name');
  const pending = selected.filter(name => !before.migrations.includes(name));
  const requirements = requirementsFor(info, selected);
  return { schema: PLAN_SCHEMA, createdAtEpochMs: at,
    sourceRevision: info.revision, contractDigest: info.contractDigest, awsProfile: profile,
    effectiveContractDigest: requirements.digest, effectiveContractScope: requirements.scope, operatorFiles: info.operatorFiles || [],
    identity, beforeDigest: digest(before), before, moduleFiles,
    selected: selected.map(name => ({ name, sha256: info.migrations[name], alreadyApplied: before.migrations.includes(name) })),
    toApply: pending, unselectedPending: Object.keys(info.migrations).filter(name => !before.migrations.includes(name) && !selected.includes(name)).sort(),
    compatibilityBefore: compare(before, requirements.contract), ...(continuation ? { continuation } : {}),
    policy: { schemaOnly: true, clinicalRowDml: false, dcl: false, automaticHistoricalMigrations: false,
      destructiveDdl: false, maxDdlPhaseMs: 600000, maxStatementMs: 300000,
      enumMemberAppendOnly: true,
      warningPolicy: 'mysql-8.4.11-tinyint1-display-width/1',
      bootstrapSequelizeMeta: !before.tables.some(table => table.TABLE_NAME === 'SequelizeMeta'),
      mysqlDdlIsAtomic: false, unknownRequiresManualReconciliation: true } };
}

function validatePlan(plan, { info, before, identity, moduleFiles, at }) {
  assertRequirements(plan, info, plan.selected.map(row => row.name));
  need(Number.isSafeInteger(plan.createdAtEpochMs)
    && plan.createdAtEpochMs <= at && at - plan.createdAtEpochMs <= 86400000, 'rds_schema_plan_expired');
  need(plan.sourceRevision === info.revision && plan.contractDigest === info.contractDigest
    && plan.beforeDigest === digest(before) && digest(plan.identity) === digest(identity)
    && digest(plan.moduleFiles) === digest(moduleFiles), 'rds_schema_plan_stale');
  const rebuilt = buildPlan({ info, before, identity, selected: plan.selected.map(item => item.name),
    moduleFiles, profile: plan.awsProfile, at: plan.createdAtEpochMs, continuation: plan.continuation });
  need(digest(plan) === digest(rebuilt) && plan.toApply.length > 0, 'rds_schema_plan_invalid_or_empty');
}

function statementKind(input, values = [], database = 'clinicaclick') {
  const sql = String(input).trim().replace(/;$/, '');
  need(sql.length > 0 && sql.length <= 1024 * 1024 && !/;|\/\*|--|#/.test(sql), 'rds_schema_sql_scope');
  // Remove SQL string literals before checking keywords/qualified identifiers.
  const tokens = sql.replace(/'(?:''|\\.|[^'\\])*'/g, "''");
  need(!/\b(?:GRANT|REVOKE|TRUNCATE|RENAME|DROP|REPLACE|LOAD|OUTFILE|DUMPFILE|CALL|PREPARE|EXECUTE|DISABLE|FOREIGN_KEY_CHECKS|SLEEP|BENCHMARK|LOAD_FILE)\b/i.test(tokens), 'rds_schema_sql_scope');
  if (/^ALTER\s+TABLE\s+.+?\s+CHANGE\s+/i.test(tokens)) {
    const target = enumExtension.statement(sql); // Live metadata is validated before dispatch.
    need(!/^SequelizeMeta$/i.test(target.table), 'rds_schema_meta_ddl_forbidden');
    return 'enum_extension';
  }
  if (/^(?:ALTER\s+TABLE\s+.+?\s+ADD\s+|CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+)/i.test(tokens)) {
    need(!/\b(?:MODIFY|CHANGE|AS\s+SELECT|SELECT)\b/i.test(tokens), 'rds_schema_destructive_or_data_sql_forbidden');
    const qualified = [...tokens.matchAll(/(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/g)];
    need(qualified.every(match => match[1].replace(/`/g, '') === database), 'rds_schema_cross_database_forbidden');
    need(!/\bSequelizeMeta\b/i.test(tokens), 'rds_schema_meta_ddl_forbidden');
    return 'ddl';
  }
  if (/^(?:SHOW\s+(?:FULL\s+)?(?:COLUMNS|INDEX|INDEXES|KEYS|TABLES|CREATE\s+TABLE)|DESCRIBE)\b/i.test(tokens)) {
    need(!/\b(?:mysql|sys|performance_schema)\s*\./i.test(tokens), 'rds_schema_read_scope');
    return 'metadata';
  }
  if (/^SELECT\b/i.test(tokens)) {
    const from = [...tokens.matchAll(/\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*))?)/gi)];
    need(from.length > 0 && from.every(match => /^(?:`?information_schema`?\s*\.|`?SequelizeMeta`?$)/i.test(match[1])), 'rds_schema_read_scope');
    return 'metadata';
  }
  throw Error('rds_schema_sql_scope');
}

function loadMigration(source, name, pins, Sequelize) {
  const allowed = new Map(pins.map(pin => [path.resolve(source, pin.path), pin.sha256]));
  const cache = new Map();
  const facade = Object.freeze({ ...Sequelize.DataTypes, DataTypes: Sequelize.DataTypes,
    QueryTypes: Sequelize.QueryTypes, Op: Sequelize.Op, literal: Sequelize.literal, fn: Sequelize.fn, col: Sequelize.col });
  function load(file) {
    need(allowed.has(file), 'rds_schema_module_not_pinned');
    const bytes = fs.readFileSync(file); need(sha(bytes) === allowed.get(file), 'rds_schema_module_changed');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    if (file.endsWith('.json')) module.exports = JSON.parse(bytes);
    else {
      const localRequire = request => {
        if (request === 'sequelize') return facade;
        if (['crypto', 'node:crypto'].includes(request)) return crypto;
        need(request.startsWith('.'), 'rds_schema_module_import_forbidden');
        const target = path.resolve(path.dirname(file), request);
        return load(/\.(js|json)$/.test(target) ? target : target + '.js');
      };
      vm.runInNewContext('(function(module,exports,require){"use strict";\n' + bytes.toString() + '\n})(module,exports,require)',
        { module, exports: module.exports, require: localRequire },
        { filename: file, timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
    }
    return module.exports;
  }
  const migration = load(path.join(source, 'migrations', name));
  need(typeof migration.up === 'function', 'rds_schema_migration_up_required');
  return { migration, facade };
}

module.exports = { NAME, PLAN_SCHEMA, METHODS, sha, need, effectiveRequirements, requirementsFor, assertRequirements,
  buildPlan, validatePlan, statementKind, migrationFiles, loadMigration };
