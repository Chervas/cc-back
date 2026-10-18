'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const op = require('../patient-mobile-verification-catalog-release');
const C = require('../../lib/patient-mobile-verification');
const MIGRATION = '20261018100000-prepare-patient-mobile-verification-v2.js';
const REVISION = 'revise-modular';
// Original five-node preparation, kept independent of the current modular definition.
const legacyNodes = () => [
  { id: 'N1', type: `trigger/${C.REQUEST}`, config: { response_timeout_minutes: null, enabled_after: null }, outputs: { on_success: 'N2' }, position: { x: 0, y: 0 } },
  { id: 'N2', type: 'action/request_mobile_verification', config: {}, outputs: { on_success: 'N3', on_review: 'N4', on_superseded: 'N5' }, position: { x: 0, y: 300 } },
  { id: 'N3', type: 'delay/wait_mobile_verification', config: {}, outputs: { on_confirmed: 'N5', on_review: 'N4', on_timeout: 'N4', on_delivery_failed: 'N4', on_superseded: 'N5' }, position: { x: 0, y: 650 } },
  { id: 'N4', type: 'action/review_mobile_verification', config: {}, outputs: { on_success: 'N5' }, position: { x: 450, y: 1100 } },
  { id: 'N5', type: 'control/end', config: {}, outputs: {}, position: { x: 0, y: 1500 } },
];
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  for (const [name, file] of Object.entries({ AutomationFlowTemplateV2: 'automationflowtemplatev2',
    AutomationFlowCatalog: 'automationflowcatalog', WhatsappTemplateCatalog: 'whatsapptemplatecatalog',
    WhatsappTemplate: 'whatsapptemplate', FlowExecutionV2: 'flowexecutionv2' })) {
    models[name] = require('../../../models/' + file)(sql, S.DataTypes);
  }
  const D = S.DataTypes;
  const actors = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, estado_cuenta: D.STRING }, { tableName: 'Usuarios', timestamps: false });
  const meta = sql.define('SequelizeMeta', { name: { type: D.STRING, primaryKey: true } }, { tableName: 'SequelizeMeta', timestamps: false });
  const history = sql.define('PatientOperationalEvent', { id: { type: D.INTEGER, primaryKey: true }, metadata: D.JSON }, { tableName: 'PatientOperationalEvents', timestamps: false });
  const jobs = sql.define('JobRequest', { id: { type: D.INTEGER, primaryKey: true }, payload: D.JSON }, { tableName: 'JobRequests', timestamps: false });
  const messages = sql.define('Message', { id: { type: D.INTEGER, primaryKey: true }, metadata: D.JSON }, { tableName: 'Messages', timestamps: false });
  await sql.sync();
  await actors.create({ id_usuario: 1, estado_cuenta: 'activo' });
  const frozen = await history.create({ id: 1, metadata: { delivery_enabled: false, state: 'pending', marker: 'TESTONLY' } });
  const beforeHistory = frozen.toJSON();
  const frozenJob = await jobs.create({ id: 1, payload: { marker: 'TESTONLY', unchanged: true } });
  const frozenMessage = await messages.create({ id: 1, metadata: { marker: 'TESTONLY', unchanged: true } });
  const beforeJob = frozenJob.toJSON(), beforeMessage = frozenMessage.toJSON();
  const raw = await sql.connectionManager.getConnection(), connection = raw.promise();
  const backups = [];
  try {
    const before = await op.capture(connection), plan = op.makePlan(before, 'owned');
    const run = args => op.execute({ connection, plan, approvedHash: op.hash(plan), backupPath: 'TESTONLY',
      saveBackup: (_file, value) => backups.push(value), ...args });
    await assert.rejects(run({ approvedHash: 'wrong' }), /EXACT_REVIEWED_PLAN_REQUIRED/);
    assert.equal(backups.length, 0);
    const dry = await run({ dryRun: true });
    assert.equal(dry.mode, 'rolled_back_dry_run'); assert.equal(dry.disabled, true);
    assert.equal(await models.AutomationFlowCatalog.count() + await models.AutomationFlowTemplateV2.count()
      + await models.WhatsappTemplateCatalog.count() + await meta.count(), 0);
    assert.equal(backups.length, 1);
    report.checks.push('exact source/plan hash required; native migration dry-run rolls back all three catalogue rows and its migration receipt, retaining backup');
    await actors.update({ estado_cuenta: 'inactivo' }, { where: { id_usuario: 1 } });
    await assert.rejects(run({ dryRun: false }), /MIGRATION_OWNER_NOT_ACTIVE/);
    await actors.update({ estado_cuenta: 'activo' }, { where: { id_usuario: 1 } });
    const applied = await run({ dryRun: false });
    assert.equal(applied.mode, 'applied'); assert.equal(applied.propagated, false);
    const after = await op.capture(connection); op.assertInactive(after, true);
    assert.equal(after.flows[0].trigger_type, C.REQUEST); assert.equal(after.flows[0].published_at, null);
    assert.equal(after.flows[0].clinic_id, null); assert.equal(after.catalog[0].last_propagated_at, null);
    assert.equal(await meta.count(), 1);
    assert.deepEqual((await frozen.reload()).toJSON(), beforeHistory);
    report.checks.push('apply requires an active migration owner, creates only inactive central entries, and leaves original pending requests untouched');
    await assert.rejects(run({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
    const repeat = op.makePlan(after, 'owned');
    await op.execute({ connection, plan: repeat, approvedHash: op.hash(repeat), backupPath: 'TESTONLY',
      saveBackup: () => {}, dryRun: false });
    assert.equal(op.hash(await op.capture(connection)), op.hash(after));
    report.checks.push('stale plans fail closed; re-planning an already installed inactive catalogue is idempotent and does not duplicate entries');
    await models.AutomationFlowCatalog.update({ is_active: true }, { where: { id: applied.catalog_id } });
    assert.throws(() => op.makePlan({ ...after, catalog: [{ ...after.catalog[0], is_active: 1 }] }, 'owned'), /EXISTING_ACTIVE_ENTRY/);
    report.checks.push('existing active or propagated entries cannot be silently replaced or deactivated');

    await models.AutomationFlowCatalog.update({ is_active: false }, { where: { id: applied.catalog_id } });
    // Use the known CRM IDs inside this disposable database, preserving distinctive metadata.
    await connection.query(`UPDATE AutomationFlowTemplatesV2 SET id=1898,nodes=CAST(? AS JSON),
      name='TESTONLY original title',description='TESTONLY original description',created_by=99 WHERE id=?`,
    [JSON.stringify(legacyNodes()), applied.flow_id]);
    await connection.query("UPDATE AutomationFlowCatalog SET id=18,steps=CAST(? AS JSON),display_name='TESTONLY original catalogue' WHERE id=?",
      [JSON.stringify([{ marker: 'TESTONLY original steps' }]), applied.catalog_id]);
    await connection.query("UPDATE WhatsappTemplateCatalog SET id=117,display_name='TESTONLY original Utility' WHERE id=?", [applied.whatsapp_catalog_id]);
    const capture = () => op.capture(connection, false, REVISION);
    const baseline = await capture(), revision = op.makePlan(baseline, 'owned', REVISION);
    const writes = [], query = connection.query.bind(connection);
    connection.query = async (statement, ...args) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(statement)) writes.push(statement);
      return query(statement, ...args);
    };
    const revise = args => op.execute({ connection, operation: REVISION, plan: revision,
      approvedHash: op.hash(revision), backupPath: 'TESTONLY', saveBackup: (_file, value) => backups.push(value), ...args });
    const unchanged = async snapshot => assert.equal(op.hash(await capture()), op.hash(snapshot));
    const rejectedBeforeBackup = async (action, error) => {
      const count = backups.length, writeCount = writes.length;
      await assert.rejects(action(), error);
      assert.equal(backups.length, count); assert.equal(writes.length, writeCount);
    };
    assert.equal(revision.operation, REVISION); assert.equal(op.makePlan(await op.capture(connection), 'owned').operation, 'install');
    assert.deepEqual(revision.change.columns, ['nodes']); assert.equal(revision.change.flow_id, 1898);
    assert.equal(revision.change.no_op, false);
    assert.throws(() => op.makePlan(baseline, 'owned', 'revise'), /OPERATION_INVALID/);
    await rejectedBeforeBackup(() => revise({ operation: 'revise' }), /OPERATION_INVALID/);
    await rejectedBeforeBackup(() => revise({ operation: 'install' }), /EXACT_REVIEWED_PLAN_REQUIRED/);
    await rejectedBeforeBackup(() => revise({ approvedHash: 'wrong' }), /EXACT_REVIEWED_PLAN_REQUIRED/);
    for (const patch of [{ schema_version: 'patient-mobile-verification-catalog-release/v1' },
      { operation: undefined }, { source_sha256: 'outdated' }, { before_sha256: 'outdated' },
      { change: { ...revision.change, columns: ['nodes', 'is_active'] } }]) {
      const invalid = { ...revision, ...patch };
      await rejectedBeforeBackup(() => revise({ plan: invalid, approvedHash: op.hash(invalid) }), /EXACT_REVIEWED_PLAN_REQUIRED/);
    }
    const oldInstall = op.makePlan(await op.capture(connection), 'owned');
    await op.execute({ connection, plan: oldInstall, approvedHash: op.hash(oldInstall), backupPath: 'TESTONLY',
      saveBackup: () => {}, dryRun: false });
    await unchanged(baseline);
    assert.equal(writes.length, 0);
    report.checks.push('install remains the default and never revises existing nodes; explicit revision rejects v1, wrong-operation, modified, and stale-source plans before backup or writes');

    // Revision must never call the already applied migration, including on a no-op.
    const migration = require('../../../migrations/' + MIGRATION), originalUp = migration.up;
    migration.up = async () => { throw Error('TESTONLY revision reran the migration'); };
    try {
      const writeStart = writes.length, backupStart = backups.length;
      const preview = await revise({ dryRun: true });
      assert.equal(preview.mode, 'rolled_back_dry_run'); assert.equal(preview.no_op, false);
      assert.deepEqual(preview.changed_columns, ['nodes']);
      assert.equal(preview.flow_id, 1898); assert.equal(preview.catalog_id, 18); assert.equal(preview.whatsapp_catalog_id, 117);
      const backup = backups.at(-1);
      assert.equal(backups.length, backupStart + 1); assert.equal(backup.operation, REVISION);
      assert.equal(backup.plan_sha256, op.hash(revision)); assert.equal(backup.source_sha256, revision.source_sha256);
      assert.equal(backup.before_sha256, op.hash(baseline)); assert.equal(op.hash(backup.before), op.hash(baseline));
      assert.equal(backup.change.before_nodes_sha256, op.hash(legacyNodes()));
      await unchanged(baseline);
      assert.equal(writes.length, writeStart + 1); assert.match(writes.at(-1), /^UPDATE AutomationFlowTemplatesV2 SET nodes=CAST/);
      report.checks.push('revision dry-run exercises a single nodes-only CAS update then rolls back; full original snapshot and source/plan hashes are retained in backup without rerunning migration');

      const noWriteStart = writes.length;
      await assert.rejects(revise({ dryRun: false, saveBackup: async () => { throw Error('TESTONLY backup refused'); } }), /backup refused/);
      assert.equal(writes.length, noWriteStart); await unchanged(baseline);
      await assert.rejects(revise({ dryRun: false, saveBackup: async () => {
        await query('UPDATE AutomationFlowTemplatesV2 SET nodes=CAST(? AS JSON) WHERE id=1898', [JSON.stringify([])]);
      } }), /REVISION_COMPARE_AND_SWAP_FAILED/);
      await unchanged(baseline);
      await assert.rejects(revise({ dryRun: false, saveBackup: async () => {
        await query("UPDATE AutomationFlowTemplatesV2 SET name='TESTONLY foreign change' WHERE id=1898");
      } }), /REVISION_UNEXPECTED_CHANGE/);
      await unchanged(baseline);
      report.checks.push('failed backup prevents writes; failed node CAS or unexpected metadata change rolls back the entire revision transaction');

      const patchRow = async (table, id, column, value) => {
        const json = ['nodes', 'trigger_config', 'steps'].includes(column);
        await query(`UPDATE ${table} SET ${column}=${json ? 'CAST(? AS JSON)' : '?'} WHERE id=?`,
          [json ? JSON.stringify(value) : value, id]);
      };
      const invalidRow = async (table, key, id, column, value, error) => {
        await patchRow(table, id, column, value);
        try {
          const edited = await capture();
          assert.throws(() => op.makePlan(edited, 'owned', REVISION), error);
          await rejectedBeforeBackup(() => revise({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
          await unchanged(edited);
        } finally { await patchRow(table, id, column, baseline[key][0][column]); }
        await unchanged(baseline);
      };
      for (const [column, value, error] of [
        ['is_active', 1, /EXISTING_ACTIVE_ENTRY/], ['published_at', new Date('2026-10-18T10:00:00Z'), /EXISTING_FLOW_INCOMPATIBLE/],
        ['published_by', 1, /REVISION_FLOW_INCOMPATIBLE/], ['is_system', 0, /EXISTING_FLOW_INCOMPATIBLE/],
        ['clinic_id', 72, /EXISTING_FLOW_INCOMPATIBLE/], ['group_id', 4, /EXISTING_FLOW_INCOMPATIBLE/],
        ['engine_version', 'v1', /REVISION_FLOW_INCOMPATIBLE/], ['version', 2, /EXISTING_FLOW_INCOMPATIBLE/],
        ['public_id', 'TESTONLY_foreign', /REVISION_FLOW_INCOMPATIBLE/], ['entry_node_id', 'N2', /REVISION_FLOW_INCOMPATIBLE/],
        ['trigger_config', { ...C.definition().trigger_config, configured: true }, /REVISION_FLOW_INCOMPATIBLE/],
        ['trigger_config', { ...C.definition().trigger_config, response_timeout_minutes: 60 }, /REVISION_FLOW_INCOMPATIBLE/],
        ['trigger_config', { ...C.definition().trigger_config, enabled_after: '2026-10-20T12:00:00Z' }, /REVISION_FLOW_INCOMPATIBLE/],
      ]) await invalidRow('AutomationFlowTemplatesV2', 'flows', 1898, column, value, error);
      for (const [column, value, error] of [
        ['is_active', 1, /EXISTING_ACTIVE_ENTRY/], ['is_default_for_trigger', 1, /EXISTING_PROPAGATION/],
        ['last_propagated_at', new Date('2026-10-18T10:00:00Z'), /EXISTING_PROPAGATION/],
        ['last_propagated_template_key', C.FAMILY, /REVISION_CATALOG_INCOMPATIBLE/],
        ['last_propagated_template_version', 1, /REVISION_CATALOG_INCOMPATIBLE/],
        ['template_key', 'TESTONLY_foreign', /REVISION_CATALOG_INCOMPATIBLE/],
        ['template_version', 2, /REVISION_CATALOG_INCOMPATIBLE/],
      ]) await invalidRow('AutomationFlowCatalog', 'catalog', 18, column, value, error);
      for (const [column, value, error] of [
        ['is_active', 1, /EXISTING_ACTIVE_ENTRY/], ['category', 'MARKETING', /EXISTING_PROVIDER_PROPAGATION/],
        ['last_propagated_at', new Date('2026-10-18T10:00:00Z'), /EXISTING_PROVIDER_PROPAGATION/],
        ['propagation_state', 'propagated', /REVISION_UTILITY_INCOMPATIBLE/],
        ['family_key', 'TESTONLY_foreign', /REVISION_UTILITY_INCOMPATIBLE/],
      ]) await invalidRow('WhatsappTemplateCatalog', 'whatsapp', 117, column, value, error);
      for (const mutate of [
        nodes => { nodes[1].type = 'action/send_whatsapp'; }, nodes => { nodes[1].config.unexpected = true; },
        nodes => { nodes[0].config.response_timeout_minutes = 60; }, nodes => { nodes[0].config.enabled_after = '2026-10-20T12:00:00Z'; },
        nodes => { nodes[1].outputs.on_success = 'N5'; }, nodes => { nodes[1].id = 'edited'; },
        nodes => { nodes[1].position.y++; }, nodes => { delete nodes[1].config; },
        nodes => { nodes.push({ id: 'extra', type: 'control/end', config: {}, outputs: {} }); },
        nodes => { nodes.reverse(); },
      ]) {
        const nodes = legacyNodes(); mutate(nodes);
        await invalidRow('AutomationFlowTemplatesV2', 'flows', 1898, 'nodes', nodes, /UNRECOGNIZED_LEGACY_GRAPH/);
      }
      report.checks.push('active, published, scoped, configured, versioned, relinked and propagated entries fail closed; old graph requires exact default node configs, types, IDs, routes, order and positions');

      for (const [table, key, id, column, value] of [
        ['AutomationFlowTemplatesV2', 'flows', 1898, 'description', 'TESTONLY later description'],
        ['AutomationFlowCatalog', 'catalog', 18, 'steps', [{ marker: 'TESTONLY later steps' }]],
        ['WhatsappTemplateCatalog', 'whatsapp', 117, 'display_name', 'TESTONLY later Utility'],
      ]) {
        await patchRow(table, id, column, value);
        try {
          const edited = await capture();
          assert.doesNotThrow(() => op.makePlan(edited, 'owned', REVISION));
          await rejectedBeforeBackup(() => revise({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
          await unchanged(edited);
        } finally { await patchRow(table, id, column, baseline[key][0][column]); }
      }
      report.checks.push('foreign edits to any captured flow, catalogue or Utility metadata invalidate reviewed plans and remain untouched');

      const rejectUsage = async (error, field) => {
        const used = await capture(); assert.equal(used[field].length, 1);
        assert.throws(() => op.makePlan(used, 'owned', REVISION), error);
        await rejectedBeforeBackup(() => revise({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
        await unchanged(used);
      };
      for (const patch of [{}, { template_key: C.FAMILY + '_clinic_72', trigger_type: 'TESTONLY_changed' },
        { template_key: 'TESTONLY_renamed', trigger_type: C.REQUEST },
        { template_key: 'TESTONLY_group_copy', trigger_type: 'TESTONLY_changed', clinic_id: null, group_id: 4 }]) {
        const child = await models.AutomationFlowTemplateV2.create({ ...C.definition(72), ...patch });
        try { await rejectUsage(/PROPAGATED_CHILDREN/, 'related_flows'); }
        finally { await child.destroy(); }
      }
      const secondVersion = await models.AutomationFlowTemplateV2.create({ ...C.definition(), version: 2 });
      try {
        const duplicate = await capture();
        assert.throws(() => op.makePlan(duplicate, 'owned', REVISION), /EXACT_CENTRAL_SCOPE_REQUIRED/);
      }
      finally { await secondVersion.destroy(); }
      for (const patch of [{ name: C.TEMPLATE, catalog_template_id: null }, { name: 'TESTONLY_renamed', catalog_template_id: 117 }]) {
        const instance = await models.WhatsappTemplate.create({ ...patch, language: 'es_ES', category: 'UTILITY', status: 'PENDING', is_active: false });
        try { await rejectUsage(/PROPAGATED_CHILDREN/, 'whatsapp_instances'); }
        finally { await instance.destroy(); }
      }
      const execution = await models.FlowExecutionV2.create({ template_version_id: 1898, trigger_type: 'TESTONLY_changed',
        status: 'running', idempotency_key: 'TESTONLY', context: { marker: 'TESTONLY' }, created_by: 1 });
      for (const status of ['running', 'waiting', 'paused']) {
        await execution.update({ status });
        await rejectUsage(/LIVE_EXECUTIONS/, 'live_executions');
      }
      await execution.update({ status: 'completed' });
      const completed = (await execution.reload()).toJSON();
      await unchanged(baseline);
      report.checks.push('inactive clinic/group copies, extra family versions, renamed provider copies and running/waiting/paused executions block revision even without propagation timestamps');

      await actors.update({ estado_cuenta: 'inactivo' }, { where: { id_usuario: 1 } });
      await rejectedBeforeBackup(() => revise({ dryRun: false }), /MIGRATION_OWNER_NOT_ACTIVE/);
      await actors.update({ estado_cuenta: 'activo' }, { where: { id_usuario: 1 } });
      await meta.destroy({ where: { name: MIGRATION } });
      const unregistered = await capture();
      assert.throws(() => op.makePlan(unregistered, 'owned', REVISION), /MIGRATION_NOT_REGISTERED/);
      await rejectedBeforeBackup(() => revise({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
      await meta.create({ name: MIGRATION });
      await unchanged(baseline);

      const beforeApplyWrites = writes.length;
      const revised = await revise({ dryRun: false });
      assert.equal(revised.mode, 'applied'); assert.equal(revised.no_op, false);
      assert.equal(revised.operation, REVISION); assert.equal(revised.migration_registered, true);
      assert.equal(writes.length, beforeApplyWrites + 1);
      const modular = await capture(), expected = { ...baseline, flows: [{ ...baseline.flows[0], nodes: C.definition().nodes }] };
      assert.equal(op.hash(modular), op.hash(expected));
      assert.equal(revised.before_sha256, op.hash(baseline)); assert.equal(revised.after_sha256, op.hash(modular));
      assert.equal(modular.flows[0].nodes.length, 13);
      assert.deepEqual((await execution.reload()).toJSON(), completed);
      await rejectedBeforeBackup(() => revise({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
      const repeatRevision = op.makePlan(modular, 'owned', REVISION), repeatWriteStart = writes.length;
      assert.equal(repeatRevision.change.no_op, true);
      for (const dryRun of [true, false]) {
        const repeated = await revise({ plan: repeatRevision, approvedHash: op.hash(repeatRevision), dryRun });
        assert.equal(repeated.no_op, true); assert.deepEqual(repeated.changed_columns, []);
        await unchanged(modular); assert.equal(writes.length, repeatWriteStart);
      }
      const customized = structuredClone(C.definition().nodes); customized[1].config.quiet_hours_enabled = false;
      await patchRow('AutomationFlowTemplatesV2', 1898, 'nodes', customized);
      const editedModular = await capture();
      assert.throws(() => op.makePlan(editedModular, 'owned', REVISION), /UNRECOGNIZED_LEGACY_GRAPH/);
      await patchRow('AutomationFlowTemplatesV2', 1898, 'nodes', C.definition().nodes);
      await unchanged(modular);
      report.checks.push('apply replaces only id1898 nodes with the 13-node graph, preserves all original timestamps/config/metadata, catalogue18, Utility117 and migration receipt; exact modular repeats perform no writes and customized modular graphs are rejected');
    } finally { migration.up = originalUp; }
    assert.deepEqual((await frozen.reload()).toJSON(), beforeHistory); assert.equal(await history.count(), 1);
    assert.deepEqual((await frozenJob.reload()).toJSON(), beforeJob); assert.equal(await jobs.count(), 1);
    assert.deepEqual((await frozenMessage.reload()).toJSON(), beforeMessage); assert.equal(await messages.count(), 1);
    assert.equal(await models.AutomationFlowTemplateV2.count(), 1); assert.equal(await models.AutomationFlowCatalog.count(), 1);
    assert.equal(await models.WhatsappTemplateCatalog.count(), 1); assert.equal(await models.WhatsappTemplate.count(), 0);
    assert.equal(await meta.count(), 1);
    report.checks.push('historical requests/events, jobs, messages and completed executions remain unchanged; no scopes, instances or migration rows are created by revision');
  } finally { await sql.connectionManager.releaseConnection(raw); }
}).catch(error => { console.error(error); process.exitCode = 1; });
