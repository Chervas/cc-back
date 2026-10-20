'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const op = require('../patient-program-booking-catalog-release');
const C = require('../../lib/patient-program-booking-confirmation');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  for (const [name, file] of Object.entries({ AutomationFlowTemplateV2: 'automationflowtemplatev2',
    AutomationFlowCatalog: 'automationflowcatalog', WhatsappTemplateCatalog: 'whatsapptemplatecatalog',
    WhatsappTemplate: 'whatsapptemplate', FlowExecutionV2: 'flowexecutionv2' })) {
    models[name] = require('../../../models/' + file)(sql, S.DataTypes);
  }
  const D = S.DataTypes, options = { timestamps: false };
  const actors = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, estado_cuenta: D.STRING }, { ...options, tableName: 'Usuarios' });
  const history = sql.define('PatientOperationalEvent', { id: { type: D.INTEGER, primaryKey: true }, metadata: D.JSON }, { ...options, tableName: 'PatientOperationalEvents' });
  const jobs = sql.define('JobRequest', { id: { type: D.INTEGER, primaryKey: true }, payload: D.JSON }, { ...options, tableName: 'JobRequests' });
  const messages = sql.define('Message', { id: { type: D.INTEGER, primaryKey: true }, metadata: D.JSON }, { ...options, tableName: 'Messages' });
  await sql.sync(); await actors.create({ id_usuario: 1, estado_cuenta: 'activo' });
  const oldEvent = await history.create({ id: 1, metadata: { TESTONLY: true, delivery_enabled: false, hold: true } });
  const oldJob = await jobs.create({ id: 1, payload: { TESTONLY: true, historical: true } });
  const oldMessage = await messages.create({ id: 1, metadata: { TESTONLY: true, state: 'held' } });
  const original = [oldEvent, oldJob, oldMessage].map(row => row.toJSON());
  const raw = await sql.connectionManager.getConnection(), connection = raw.promise(), backups = [];
  const before = await op.capture(connection), plan = await op.makePlan(before, 'owned');
  const run = (extra = {}) => op.execute({ connection, plan, approvedHash: op.hash(plan), backupPath: 'TESTONLY',
    saveBackup: (_file, value) => backups.push(value), ...extra });
  const unchanged = async snapshot => assert.equal(op.hash(await op.capture(connection)), op.hash(snapshot));
  try {
    const dml = [], query = connection.query.bind(connection);
    connection.query = async (statement, ...args) => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(statement)) dml.push(statement); return query(statement, ...args); };
    await assert.rejects(run({ approvedHash: 'wrong' }), /EXACT_FRESH_REVIEWED_PLAN_REQUIRED/);
    assert.equal(backups.length, 0); assert.equal(dml.length, 0);
    await assert.rejects(run({ saveBackup: async () => { throw Error('TESTONLY backup refused'); }, dryRun: false }), /backup refused/);
    assert.equal(dml.length, 0); await unchanged(before);
    const preview = await run(); assert.equal(preview.mode, 'rolled_back_dry_run'); assert.equal(preview.inserted_rows, 3);
    assert.equal(preview.inactive, true); assert.equal(preview.meta_submitted, false);
    await unchanged(before); assert.equal(backups.length, 1); assert.equal(backups[0].before_sha256, op.hash(before));
    report.checks.push('source/plan hashes precede access; failed backup causes zero writes; native three-row inactive install rolls back completely in dry-run');
    await actors.update({ estado_cuenta: 'inactivo' }, { where: { id_usuario: 1 } });
    await assert.rejects(run({ dryRun: false }), /OPERATOR_NOT_ACTIVE_ADMIN/); await unchanged(before);
    await actors.update({ estado_cuenta: 'activo' }, { where: { id_usuario: 1 } });

    const contenders = await Promise.all(Array.from({ length: 5 }, async () => {
      const client = await sql.connectionManager.getConnection();
      try { return await op.execute({ connection: client.promise(), plan, approvedHash: op.hash(plan), backupPath: 'TESTONLY',
        saveBackup: (_file, value) => backups.push(value), dryRun: false }); }
      catch (error) { return { error: error.message }; }
      finally { await sql.connectionManager.releaseConnection(client); }
    }));
    assert.equal(contenders.filter(value => value.mode === 'applied').length, 1, JSON.stringify(contenders));
    assert(contenders.filter(value => value.error).every(value => /OPERATOR_BUSY|PLAN_CHANGED_REPLAN_REQUIRED/.test(value.error)));
    const after = await op.capture(connection); assert.deepEqual(op.assertSnapshot(after, plan.rows), { no_op: true, insert_count: 0 });
    assert.equal(after.flows.length + after.catalog.length + after.whatsapp.length, 3);
    assert.equal(after.instances.length + after.executions.length, 0);
    assert.equal(after.whatsapp[0].locale, 'es'); assert.equal(after.whatsapp[0].category, 'UTILITY');
    assert.equal(after.flows[0].trigger_config.response_timeout_minutes, null); assert.equal(after.flows[0].nodes[0].config.enabled_after, null);
    report.checks.push('five independent concurrent operators serialize: exactly one installation, three central inactive rows, no technical instances/executions, unset timeout/cut');
    await assert.rejects(run({ dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
    const repeated = await op.makePlan(after, 'owned');
    const same = await op.execute({ connection, plan: repeated, approvedHash: op.hash(repeated), backupPath: 'TESTONLY', saveBackup: () => {}, dryRun: false });
    assert.equal(same.no_op, true); assert.equal(same.inserted_rows, 0); await unchanged(after);
    report.checks.push('full-row before snapshot rejects stale plans; re-planning an identical inactive preparation is idempotent with zero new rows');
    const expired = { ...repeated, created_at: '2026-10-01T12:00:00.000Z', expires_at: '2026-10-01T12:30:00.000Z' };
    await assert.rejects(op.execute({ connection, plan: expired, approvedHash: op.hash(expired), backupPath: 'TESTONLY', saveBackup: () => {}, dryRun: false }), /EXACT_FRESH_REVIEWED_PLAN_REQUIRED/);
    const originalDescription = after.catalog[0].description;
    await models.AutomationFlowCatalog.update({ description: 'TESTONLY foreign edit' }, { where: { id: after.catalog[0].id } });
    const edited = await op.capture(connection);
    await assert.rejects(op.execute({ connection, plan: repeated, approvedHash: op.hash(repeated), backupPath: 'TESTONLY', saveBackup: () => {}, dryRun: false }), /PLAN_CHANGED_REPLAN_REQUIRED/);
    await assert.rejects(op.makePlan(edited, 'owned'), /EXISTING_ENTRY_DIFFERS/); await unchanged(edited);
    await models.AutomationFlowCatalog.update({ description: originalDescription, updated_at: after.catalog[0].updated_at }, { where: { id: after.catalog[0].id }, silent: true });
    const clean = await op.capture(connection);
    const instance = await models.WhatsappTemplate.create({ name: C.TEMPLATE, language: 'es_ES', category: 'UTILITY', status: 'PENDING', is_active: false,
      catalog_template_id: clean.whatsapp[0].id });
    await assert.rejects(op.makePlan(await op.capture(connection), 'owned'), /EXISTING_USAGE_OR_PROPAGATION/);
    await instance.destroy();
    await models.AutomationFlowCatalog.update({ is_active: true }, { where: { id: clean.catalog[0].id } });
    await assert.rejects(op.makePlan(await op.capture(connection), 'owned'), /EXISTING_ACTIVE_ENTRY/);
    await models.AutomationFlowCatalog.update({ is_active: false }, { where: { id: clean.catalog[0].id } });
    report.checks.push('expired, foreign-edited, active or already propagated candidates fail closed and cannot be overwritten by this install-only operator');
    assert.deepEqual((await oldEvent.reload()).toJSON(), original[0]); assert.deepEqual((await oldJob.reload()).toJSON(), original[1]);
    assert.deepEqual((await oldMessage.reload()).toJSON(), original[2]);
    assert.equal(await history.count(), 1); assert.equal(await jobs.count(), 1); assert.equal(await messages.count(), 1);
    assert.equal(await models.FlowExecutionV2.count(), 0); assert.equal(await models.WhatsappTemplate.count(), 0);
    report.checks.push('original HOLD/history/job/message remain byte-equivalent; no new events, jobs, messages, technical templates, runs, Meta or transport');
  } finally { await sql.connectionManager.releaseConnection(raw); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
