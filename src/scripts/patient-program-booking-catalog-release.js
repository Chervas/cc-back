#!/usr/bin/env node
'use strict';

// Catalogue preparation only. One pinned transaction, three inactive central
// rows; no application boot, provider, propagation, historical replay or jobs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson, readBytes, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const C = require('../lib/patient-program-booking-confirmation');
const VERSION = 'patient-program-booking-catalog-release/v1';
const LOCK = 'cc-patient-program-booking-catalog';
const TABLES = Object.freeze({ flows: 'AutomationFlowTemplatesV2', catalog: 'AutomationFlowCatalog', whatsapp: 'WhatsappTemplateCatalog' });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
const fail = code => { throw Error('PROGRAM_CATALOG_' + code); };
const clone = value => JSON.parse(JSON.stringify(value));
const SOURCE_FILES = [__filename, require.resolve('../lib/patient-program-booking-confirmation'),
  require.resolve('../lib/patient-program-booking-notice'), require.resolve('../lib/whatsapp-template-contract'),
  require.resolve('../controllers/automationsV2.controller'), require.resolve('../controllers/automationCatalog.controller'),
  require.resolve('../controllers/whatsapp.controller')];
const sourceHash = () => hash(SOURCE_FILES.map(filename => [path.basename(filename), fs.readFileSync(filename, 'utf8')]));

// Execute the actual native validators/normalizers, with captured model writes
// and unavailable application services. No mutable require cache/process.env,
// application models, queues, sockets, secrets or provider clients are loaded.
function nativeController(name, models) {
  const filename = require.resolve('../controllers/' + name), actual = createRequire(filename), module = { exports: {} };
  const unavailable = new Proxy(function unavailableService() { fail('APP_SERVICE_FORBIDDEN'); }, {
    get() { return () => fail('APP_SERVICE_FORBIDDEN'); },
  });
  const sandbox = { module, exports: module.exports, Buffer, Date, URL, URLSearchParams, structuredClone,
    console: { log() {}, warn() {}, error() {} }, process: { env: { ADMIN_USER_IDS: '1' } },
    require: dependency => dependency === '../../models' ? models
      : ['../lib/marketingScopeAccess', '../lib/metaQuarantineHttp'].includes(dependency) ? unavailable
      : dependency.startsWith('../lib/') || dependency.startsWith('../config/') || ['sequelize', 'crypto'].includes(dependency)
        ? actual(dependency) : unavailable };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename, timeout: 10000 });
  return module.exports;
}
async function nativeCall(fn, body) {
  let status = 200, payload;
  const res = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
  await fn({ userData: { userId: 1 }, body }, res);
  if (status !== 201) fail('NATIVE_CATALOG_INVALID:' + JSON.stringify({ status, payload }));
  return payload;
}
async function proposal() {
  const candidate = C.catalogPreparation(); let utility, catalog;
  const utilityController = nativeController('whatsapp.controller', {
    WhatsappTemplateCatalog: { create: async values => { utility = clone(values); return { id: -1, ...values }; } },
  });
  await nativeCall(utilityController.createCatalog, candidate.whatsapp);
  const validator = nativeController('automationsV2.controller', {
    WhatsappTemplate: { findAll: async () => [] },
    WhatsappTemplateCatalog: { findAll: async () => [{ id: 1, ...utility }] },
  });
  const valid = await validator.validateFlowPayloadForInternalUse(candidate.flow);
  if (!valid.ok) fail('NATIVE_FLOW_INVALID:' + JSON.stringify(valid.errors));
  const flow = { ...candidate.flow, nodes: clone(valid.nodes), trigger_config: clone(valid.trigger_config), published_by: null };
  if (!C.graphValid(flow.nodes) || C.configValid(flow.trigger_config)
    || flow.trigger_config.response_timeout_minutes !== null || flow.trigger_config.enabled_after !== null
    || flow.trigger_config.configured !== false || flow.nodes[0].config.response_timeout_minutes !== null
    || flow.nodes[0].config.enabled_after !== null) fail('UNCONFIGURED_INACTIVE_SOURCE_REQUIRED');
  const catalogController = nativeController('automationCatalog.controller', {
    AutomationFlowTemplateV2: { findOne: async options => options.where?.template_key === C.FAMILY ? flow : null },
    AutomationFlowCatalog: { create: async values => { catalog = clone(values); return { id: -1, ...values }; },
      findByPk: async () => ({ id: -1, ...catalog }) },
  });
  await nativeCall(catalogController.createCatalog, { name: C.FAMILY, display_name: 'Citas de programa · Reserva y reprogramación',
    description: flow.description, template_key: C.FAMILY, template_version: 1, is_generic: true, is_active: false, is_default_for_trigger: false });
  return { flows: flow, catalog: { ...catalog, last_propagated_at: null, last_propagated_template_key: null,
    last_propagated_template_version: null }, whatsapp: { ...utility, last_propagated_at: null } };
}
async function capture(connection, lock = false) {
  const end = lock ? ' FOR UPDATE' : '';
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name');
  const [flows] = await connection.query(`SELECT * FROM AutomationFlowTemplatesV2 WHERE trigger_type=?
    OR template_key LIKE ? OR public_id=? ORDER BY id` + end, [C.REQUEST, C.FAMILY + '%', C.definition().public_id]);
  const [catalog] = await connection.query(`SELECT * FROM AutomationFlowCatalog WHERE trigger_type=? OR name=? OR template_key=? ORDER BY id` + end,
    [C.REQUEST, C.FAMILY, C.FAMILY]);
  const [whatsapp] = await connection.query(`SELECT * FROM WhatsappTemplateCatalog WHERE name=? OR family_key=? ORDER BY id` + end, [C.TEMPLATE, C.TEMPLATE]);
  const [instances] = await connection.query(`SELECT id,name,language,status,is_active,catalog_template_id FROM WhatsappTemplates
    WHERE name=? OR catalog_template_id IN (?) ORDER BY id` + end, [C.TEMPLATE, whatsapp.map(row => Number(row.id)).concat(-1)]);
  const [executions] = await connection.query('SELECT id,template_version_id,trigger_type,status FROM FlowExecutionsV2 WHERE trigger_type=? ORDER BY id' + end, [C.REQUEST]);
  return { database: identity.database_name, flows, catalog, whatsapp, instances, executions };
}
function assertSnapshot(before, rows) {
  if (!before || Object.keys(TABLES).some(key => !Array.isArray(before[key]) || before[key].length > 1)
    || !Array.isArray(before.instances) || !Array.isArray(before.executions)) fail('EXACT_CENTRAL_SCOPE_REQUIRED');
  if (before.instances.length || before.executions.length) fail('EXISTING_USAGE_OR_PROPAGATION');
  const sizes = Object.keys(TABLES).map(key => before[key].length);
  if (sizes.some(Boolean) && sizes.some(size => size !== 1)) fail('PARTIAL_INSTALL_REQUIRES_REVIEW');
  for (const key of Object.keys(TABLES)) {
    const current = before[key][0]; if (!current) continue;
    if (current.is_active !== false && current.is_active !== 0) fail('EXISTING_ACTIVE_ENTRY');
    for (const [field, expected] of Object.entries(rows[key])) {
      const actual = typeof expected === 'boolean' ? !!current[field] : current[field];
      if (hash(actual) !== hash(expected)) fail('EXISTING_ENTRY_DIFFERS:' + key + '.' + field);
    }
  }
  return { no_op: sizes.every(size => size === 1), insert_count: sizes.every(size => size === 1) ? 0 : 3 };
}
async function makePlan(before, target, { now = new Date() } = {}) {
  const rows = await proposal(), change = assertSnapshot(before, rows);
  return { schema_version: VERSION, target, created_at: now.toISOString(), expires_at: new Date(+now + 1800000).toISOString(),
    source_sha256: sourceHash(), before, before_sha256: hash(before), rows, rows_sha256: hash(rows), change,
    policy: { central_catalog_only: true, inactive_only: true, no_scope_copies: true, no_jobs: true, no_messages: true,
      no_provider_submission: true, no_gate_change: true, no_historical_replay: true, timeout_and_cut_explicitly_unset: true } };
}
async function execute({ connection, plan, approvedHash, backupPath, dryRun = true, saveBackup = writePrivateJson, now = new Date() }) {
  const rows = await proposal();
  if (plan?.schema_version !== VERSION || hash(plan) !== approvedHash || plan.source_sha256 !== sourceHash()
    || hash(plan.before) !== plan.before_sha256 || hash(rows) !== plan.rows_sha256 || hash(plan.rows) !== hash(rows)
    || !Number.isFinite(Date.parse(plan.created_at)) || !Number.isFinite(Date.parse(plan.expires_at))
    || +now < Date.parse(plan.created_at) || +now >= Date.parse(plan.expires_at)
    || Date.parse(plan.expires_at) - Date.parse(plan.created_at) !== 1800000) fail('EXACT_FRESH_REVIEWED_PLAN_REQUIRED');
  if (hash(assertSnapshot(plan.before, rows)) !== hash(plan.change)) fail('EXACT_FRESH_REVIEWED_PLAN_REQUIRED');
  const [[locked]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK]);
  if (Number(locked.acquired) !== 1) fail('OPERATOR_BUSY');
  let sequelize;
  try {
    const S = require('sequelize'); sequelize = new S({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const models = { flows: require('../../models/automationflowtemplatev2')(sequelize, S.DataTypes),
      catalog: require('../../models/automationflowcatalog')(sequelize, S.DataTypes),
      whatsapp: require('../../models/whatsapptemplatecatalog')(sequelize, S.DataTypes) };
    const rollback = Symbol('catalogue_dry_run');
    try {
      return await sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, async transaction => {
        const before = await capture(connection, true);
        if (before.database !== plan.before.database || hash(before) !== plan.before_sha256) fail('PLAN_CHANGED_REPLAN_REQUIRED');
        const change = assertSnapshot(before, rows);
        const [actors] = await connection.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=1 FOR SHARE');
        if (actors.length !== 1 || actors[0].estado_cuenta !== 'activo' || !require('../lib/role-helpers').isGlobalAdmin(1)) fail('OPERATOR_NOT_ACTIVE_ADMIN');
        await saveBackup(backupPath, { schema_version: VERSION + ':backup', plan_sha256: approvedHash,
          source_sha256: plan.source_sha256, before_sha256: plan.before_sha256, before,
          intended_rows: rows, restoration: 'Additive inactive central rows only. Never delete reviewed, propagated or used entries; separately review any later revision.' });
        if (!change.no_op) for (const key of Object.keys(TABLES)) await models[key].create(rows[key], { transaction });
        const after = await capture(connection, true); const verified = assertSnapshot(after, rows);
        if (!verified.no_op || plan.source_sha256 !== sourceHash()) fail('POSTCHECK_FAILED');
        if (change.no_op && hash(after) !== hash(before)) fail('NO_OP_CHANGED_DATA');
        const receipt = { schema_version: VERSION + ':receipt', target: plan.target, mode: dryRun ? 'rolled_back_dry_run' : 'applied',
          plan_sha256: approvedHash, source_sha256: plan.source_sha256, before_sha256: hash(before), after_sha256: hash(after),
          flow_id: Number(after.flows[0].id), catalog_id: Number(after.catalog[0].id), whatsapp_catalog_id: Number(after.whatsapp[0].id),
          inserted_rows: change.insert_count, no_op: change.no_op, inactive: true, propagated: false, meta_submitted: false,
          timeout_minutes: null, enabled_after: null };
        if (dryRun) throw { signal: rollback, receipt };
        return receipt;
      });
    } catch (error) { if (error.signal === rollback) return error.receipt; throw error; }
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
}
function privatePlan(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_PLAN_REQUIRED');
  const real = fs.realpathSync(filename), metadata = fs.lstatSync(filename), root = fs.realpathSync(PRIVATE_ROOT);
  if (!real.startsWith(root + path.sep) || real !== filename || !metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink !== 1 || metadata.uid !== process.getuid() || metadata.mode & 0o077) fail('PRIVATE_PLAN_INVALID');
  return JSON.parse(readBytes(filename));
}
async function main(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--output', '--plan', '--approved-plan-sha256', '--backup']);
  const mode = args['--mode'] || 'plan', target = args['--target'];
  if (!['plan', 'dry-run', 'apply'].includes(mode)) fail('MODE_INVALID');
  const config = databaseOptions(target), connection = await connectOperatorDatabase(target);
  try {
    if (mode === 'plan') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(connection); await connection.rollback();
      if (before.database !== config.database) fail('DATABASE_CHANGED');
      const plan = await makePlan(before, target); writePrivateJson(args['--output'], plan);
      return { mode, target, plan_sha256: hash(plan), expires_at: plan.expires_at, change: plan.change,
        source_sha256: plan.source_sha256, rows_sha256: plan.rows_sha256 };
    }
    const plan = privatePlan(args['--plan']);
    if (plan.target !== target || plan.before.database !== config.database) fail('TARGET_CHANGED');
    const receipt = await execute({ connection, plan, approvedHash: args['--approved-plan-sha256'], backupPath: args['--backup'], dryRun: mode === 'dry-run' });
    if (args['--output']) writePrivateJson(args['--output'], receipt);
    return receipt;
  } finally { await connection.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { VERSION, proposal, capture, assertSnapshot, makePlan, execute, hash, sourceHash };
