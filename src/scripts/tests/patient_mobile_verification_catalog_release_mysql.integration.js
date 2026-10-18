'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const op = require('../patient-mobile-verification-catalog-release');
const C = require('../../lib/patient-mobile-verification');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  for (const [name, file] of Object.entries({ AutomationFlowTemplateV2: 'automationflowtemplatev2',
    AutomationFlowCatalog: 'automationflowcatalog', WhatsappTemplateCatalog: 'whatsapptemplatecatalog' })) {
    models[name] = require('../../../models/' + file)(sql, S.DataTypes);
  }
  const D = S.DataTypes;
  const actors = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, estado_cuenta: D.STRING }, { tableName: 'Usuarios', timestamps: false });
  const meta = sql.define('SequelizeMeta', { name: { type: D.STRING, primaryKey: true } }, { tableName: 'SequelizeMeta', timestamps: false });
  const history = sql.define('PatientOperationalEvent', { id: { type: D.INTEGER, primaryKey: true }, metadata: D.JSON }, { tableName: 'PatientOperationalEvents', timestamps: false });
  await sql.sync();
  await actors.create({ id_usuario: 1, estado_cuenta: 'activo' });
  const frozen = await history.create({ id: 1, metadata: { delivery_enabled: false, state: 'pending', marker: 'TESTONLY' } });
  const beforeHistory = frozen.toJSON();
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
  } finally { await sql.connectionManager.releaseConnection(raw); }
}).catch(error => { console.error(error); process.exitCode = 1; });
