#!/usr/bin/env node
'use strict';

// Catalogue-only operator: pinned install/revision, one connection, no app boot,
// scope propagation, provider submission, historical requests or transport.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson, readBytes, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const C = require('../lib/patient-mobile-verification');
const MIGRATION = '20261018100000-prepare-patient-mobile-verification-v2.js';
const FILE = path.resolve(__dirname, '../../migrations', MIGRATION);
const VERSION = 'patient-mobile-verification-catalog-release/v2';
const OPERATIONS = ['install', 'revise-modular'];
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(v))))).digest('hex');
const sourceHash = () => hash([__filename, FILE, require.resolve('../lib/patient-mobile-verification')]
  .map(filename => fs.readFileSync(filename, 'utf8')));
const fail = code => { throw Error('MOBILE_CATALOG_' + code); };

// Frozen predecessor from the original preparation, independent of C.definition().
function legacyNodes() {
  const node = (id, type, config, outputs, x, y) => ({ id, type, config, outputs, position: { x, y } });
  return [
    node('N1', `trigger/${C.REQUEST}`, { response_timeout_minutes: null, enabled_after: null }, { on_success: 'N2' }, 0, 0),
    node('N2', 'action/request_mobile_verification', {}, { on_success: 'N3', on_review: 'N4', on_superseded: 'N5' }, 0, 300),
    node('N3', 'delay/wait_mobile_verification', {}, { on_confirmed: 'N5', on_review: 'N4', on_timeout: 'N4', on_delivery_failed: 'N4', on_superseded: 'N5' }, 0, 650),
    node('N4', 'action/review_mobile_verification', {}, { on_success: 'N5' }, 450, 1100),
    node('N5', 'control/end', {}, {}, 0, 1500),
  ];
}
async function capture(connection, lock = false, operation = 'install') {
  if (!OPERATIONS.includes(operation)) fail('OPERATION_INVALID');
  const end = lock ? ' FOR UPDATE' : '';
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name');
  const [flows] = await connection.query('SELECT * FROM AutomationFlowTemplatesV2 WHERE template_key=? ORDER BY version,id' + end, [C.FAMILY]);
  const [catalog] = await connection.query('SELECT * FROM AutomationFlowCatalog WHERE name=? ORDER BY id' + end, [C.FAMILY]);
  const [whatsapp] = await connection.query('SELECT * FROM WhatsappTemplateCatalog WHERE name=? ORDER BY id' + end, [C.TEMPLATE]);
  const [meta] = await connection.query('SELECT name FROM SequelizeMeta WHERE name=?' + end, [MIGRATION]);
  const snapshot = { database: identity.database_name, flows, catalog, whatsapp, meta };
  if (operation === 'revise-modular') {
    // Include renamed/scope copies and actual usage, even if propagation markers were cleared.
    const [related] = await connection.query(`SELECT * FROM AutomationFlowTemplatesV2 WHERE template_key<>?
      AND (trigger_type=? OR LEFT(template_key,CHAR_LENGTH(?))=? OR public_id=?
        OR JSON_UNQUOTE(JSON_EXTRACT(trigger_config,'$.managed_feature'))=?) ORDER BY id` + end,
    [C.FAMILY, C.REQUEST, C.FAMILY, C.FAMILY, C.definition().public_id, 'patient_mobile_verification']);
    const [instances] = await connection.query(`SELECT id,catalog_template_id,name,status,is_active FROM WhatsappTemplates
      WHERE name=? OR catalog_template_id IN (?) ORDER BY id` + end, [C.TEMPLATE, whatsapp.map(row => row.id).concat(-1)]);
    const [executions] = await connection.query(`SELECT id,template_version_id,trigger_type,status FROM FlowExecutionsV2
      WHERE (template_version_id IN (?) OR trigger_type=?)
        AND (status IS NULL OR status NOT IN ('completed','failed','cancelled','dead_letter')) ORDER BY id` + end,
    [flows.concat(related).map(row => row.id).concat(-1), C.REQUEST]);
    Object.assign(snapshot, { related_flows: related, whatsapp_instances: instances, live_executions: executions });
  }
  return snapshot;
}
function assertInactive(snapshot, complete = false) {
  for (const key of ['flows', 'catalog', 'whatsapp']) {
    if (snapshot[key].length > 1 || complete && snapshot[key].length !== 1) fail('EXACT_CENTRAL_SCOPE_REQUIRED');
    if (snapshot[key].some(row => row.is_active !== false && row.is_active !== 0)) fail('EXISTING_ACTIVE_ENTRY');
  }
  if (snapshot.flows.some(row => !row.is_system || row.clinic_id || row.group_id || row.published_at
    || Number(row.version) !== 1 || row.trigger_type !== C.REQUEST)) fail('EXISTING_FLOW_INCOMPATIBLE');
  if (snapshot.catalog.some(row => row.last_propagated_at || row.is_default_for_trigger)) fail('EXISTING_PROPAGATION');
  if (snapshot.whatsapp.some(row => row.category !== 'UTILITY' || row.last_propagated_at)) fail('EXISTING_PROVIDER_PROPAGATION');
}
function assertRevision(snapshot) {
  assertInactive(snapshot, true);
  const flow = snapshot.flows[0], catalog = snapshot.catalog[0], utility = snapshot.whatsapp[0];
  const definition = C.definition();
  if (flow.public_id !== definition.public_id || flow.template_key !== C.FAMILY || flow.engine_version !== 'v2'
    || flow.clinic_id !== null || flow.group_id !== null || flow.published_at !== null || flow.published_by !== null
    || flow.entry_node_id !== definition.entry_node_id || hash(flow.trigger_config) !== hash(definition.trigger_config)) fail('REVISION_FLOW_INCOMPATIBLE');
  if (catalog.template_key !== C.FAMILY || Number(catalog.template_version) !== 1 || catalog.trigger_type !== C.REQUEST
    || catalog.last_propagated_template_key !== null || catalog.last_propagated_template_version !== null) fail('REVISION_CATALOG_INCOMPATIBLE');
  if (utility.family_key !== C.TEMPLATE || utility.locale !== 'es' || utility.propagation_state !== 'prepared') fail('REVISION_UTILITY_INCOMPATIBLE');
  if (snapshot.meta.length !== 1 || snapshot.meta[0].name !== MIGRATION) fail('MIGRATION_NOT_REGISTERED');
  for (const key of ['related_flows', 'whatsapp_instances', 'live_executions']) {
    if (!Array.isArray(snapshot[key]) || snapshot[key].length) fail(key === 'live_executions' ? 'LIVE_EXECUTIONS' : 'PROPAGATED_CHILDREN');
  }
  if (definition.nodes.length !== 13 || !C.graphValid(definition.nodes)) fail('MODULAR_DEFINITION_INVALID');
  const noOp = hash(flow.nodes) === hash(definition.nodes);
  if (!noOp && hash(flow.nodes) !== hash(legacyNodes())) fail('UNRECOGNIZED_LEGACY_GRAPH');
  return { flow_id: Number(flow.id), columns: ['nodes'], before_nodes_sha256: hash(flow.nodes),
    after_nodes_sha256: hash(definition.nodes), no_op: noOp };
}
function makePlan(before, target, operation = 'install') {
  if (!OPERATIONS.includes(operation)) fail('OPERATION_INVALID');
  assertInactive(before);
  return { schema_version: VERSION, operation, target, source_sha256: sourceHash(), before, before_sha256: hash(before),
    ...(operation === 'revise-modular' ? { change: assertRevision(before) } : {}),
    policy: { central_catalog_only: true, inactive_only: true, historical_requests_unchanged: true,
      no_scope_copies: true, no_jobs: true, no_messages: true, no_provider_submission: true } };
}
async function execute({ connection, plan, approvedHash, backupPath, operation = 'install', dryRun = true, saveBackup = writePrivateJson }) {
  if (!OPERATIONS.includes(operation)) fail('OPERATION_INVALID');
  if (plan?.schema_version !== VERSION || plan.operation !== operation || hash(plan) !== approvedHash || plan.source_sha256 !== sourceHash()
    || hash(plan.before) !== plan.before_sha256) fail('EXACT_REVIEWED_PLAN_REQUIRED');
  if (hash(makePlan(plan.before, plan.target, operation)) !== approvedHash) fail('EXACT_REVIEWED_PLAN_REQUIRED');
  const [[lock]] = await connection.query("SELECT GET_LOCK('cc-patient-mobile-verification-catalog',0) AS acquired");
  if (Number(lock.acquired) !== 1) fail('OPERATOR_BUSY');
  const Sequelize = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
  sequelize.connectionManager.getConnection = async () => connection.connection;
  sequelize.connectionManager.releaseConnection = async () => {};
  const originalTransaction = sequelize.transaction;
  const dryRunSignal = Symbol('rolled_back_dry_run');
  try {
    return await originalTransaction.call(sequelize, { isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const before = await capture(connection, true, operation);
      if (hash(before) !== plan.before_sha256) fail('PLAN_CHANGED_REPLAN_REQUIRED');
      assertInactive(before);
      const [actors] = await connection.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=1 FOR SHARE');
      if (actors.length !== 1 || actors[0].estado_cuenta !== 'activo'
        || !require('../lib/role-helpers').isGlobalAdmin(1)) fail('MIGRATION_OWNER_NOT_ACTIVE');
      const change = operation === 'revise-modular' ? assertRevision(before) : null;
      await saveBackup(backupPath, { schema_version: VERSION + ':backup', operation, plan_sha256: approvedHash,
        source_sha256: plan.source_sha256, before_sha256: plan.before_sha256, before,
        ...(change ? { change } : {}), restoration: change
          ? 'Restore only nodes from before, after separate review and comparison against the exact post-revision snapshot. Never overwrite later edits or propagated/published flows.'
          : 'Additive inactive entries. Never delete after review/propagation or overwrite later edits.' });
      if (change) {
        if (!change.no_op) {
          const [updated] = await connection.query(`UPDATE AutomationFlowTemplatesV2 SET nodes=CAST(? AS JSON)
            WHERE id=? AND template_key=? AND version=1 AND engine_version='v2' AND is_system=1
              AND clinic_id IS NULL AND group_id IS NULL AND is_active=0 AND published_at IS NULL AND published_by IS NULL
              AND entry_node_id=? AND nodes=CAST(? AS JSON) AND trigger_config=CAST(? AS JSON)`,
          [JSON.stringify(C.definition().nodes), change.flow_id, C.FAMILY, before.flows[0].entry_node_id,
            JSON.stringify(before.flows[0].nodes), JSON.stringify(before.flows[0].trigger_config)]);
          if (updated.affectedRows !== 1) fail('REVISION_COMPARE_AND_SWAP_FAILED');
        }
      } else {
        // Reuse the reviewed migration verbatim only for installation.
        sequelize.transaction = callback => callback(transaction);
        try { await require(FILE).up(sequelize.getQueryInterface()); }
        finally { sequelize.transaction = originalTransaction; }
        if (!before.meta.length) await connection.query('INSERT INTO SequelizeMeta (name) VALUES (?)', [MIGRATION]);
      }
      const after = await capture(connection, true, operation);
      assertInactive(after, true);
      if (change) {
        assertRevision(after);
        const expected = { ...before, flows: [{ ...before.flows[0], nodes: C.definition().nodes }] };
        if (hash(after) !== hash(expected)) fail('REVISION_UNEXPECTED_CHANGE');
      } else {
        for (const key of ['flows', 'catalog', 'whatsapp']) {
          if (before[key].some(row => !after[key].some(next => Number(next.id) === Number(row.id) && hash(next) === hash(row)))) fail('EXISTING_ENTRY_CHANGED');
        }
      }
      if (plan.source_sha256 !== sourceHash()) fail('EXACT_REVIEWED_PLAN_REQUIRED');
      const receipt = { schema_version: VERSION + ':receipt', operation, target: plan.target,
        mode: dryRun ? 'rolled_back_dry_run' : 'applied', plan_sha256: approvedHash,
        before_sha256: hash(before), after_sha256: hash(after), ...(change ? { no_op: change.no_op, changed_columns: change.no_op ? [] : ['nodes'] } : {}),
        flow_id: Number(after.flows[0].id), catalog_id: Number(after.catalog[0].id),
        whatsapp_catalog_id: Number(after.whatsapp[0].id), disabled: true, propagated: false,
        migration_registered: after.meta.length === 1 };
      if (dryRun) throw { signal: dryRunSignal, receipt };
      return receipt;
    });
  } catch (error) { if (error.signal === dryRunSignal) return error.receipt; throw error; }
  finally { sequelize.transaction = originalTransaction; await connection.query("SELECT RELEASE_LOCK('cc-patient-mobile-verification-catalog')"); }
}
function privatePlan(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_PLAN_REQUIRED');
  const real = fs.realpathSync(filename), stat = fs.lstatSync(filename), root = fs.realpathSync(PRIVATE_ROOT);
  if (!real.startsWith(root + path.sep) || real !== filename || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_PLAN_INVALID');
  return JSON.parse(readBytes(filename));
}
async function main(argv) {
  const args = parseArgs(argv, ['--mode', '--operation', '--target', '--output', '--plan', '--approved-plan-sha256', '--backup']);
  const mode = args['--mode'] || 'plan', target = args['--target'], operation = args['--operation'] || 'install';
  if (!['plan', 'dry-run', 'apply'].includes(mode)) fail('MODE_INVALID');
  if (!OPERATIONS.includes(operation)) fail('OPERATION_INVALID');
  const configuration = databaseOptions(target), connection = await connectOperatorDatabase(target);
  try {
    if (mode === 'plan') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(connection, false, operation); await connection.rollback();
      if (before.database !== configuration.database) fail('DATABASE_CHANGED');
      const plan = makePlan(before, target, operation); writePrivateJson(args['--output'], plan);
      return { mode, operation, target, plan_sha256: hash(plan), existing: before.catalog.length,
        ...(plan.change ? { change: plan.change } : {}) };
    }
    const plan = privatePlan(args['--plan']);
    if (plan.target !== target || plan.before.database !== configuration.database) fail('TARGET_CHANGED');
    return await execute({ connection, plan, approvedHash: args['--approved-plan-sha256'],
      backupPath: args['--backup'], operation, dryRun: mode === 'dry-run' });
  } finally { await connection.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { capture, assertInactive, makePlan, execute, hash };
