'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { Sequelize, DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createPropagation, catalogDigest } = require('../../lib/whatsapp-catalog-propagation');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.sequelize = sql; db.Sequelize = Sequelize;
  db.JobRequest = require('../../../models/jobrequest')(sql, DataTypes);
  db.WhatsappTemplateCatalog = require('../../../models/whatsapptemplatecatalog')(sql, DataTypes);
  db.WhatsappTemplateCatalogDiscipline = require('../../../models/whatsapptemplatecatalogdiscipline')(sql, DataTypes);
  db.WhatsappTemplateCatalog.hasMany(db.WhatsappTemplateCatalogDiscipline, { as: 'disciplinas', foreignKey: 'template_catalog_id' });
  await sql.sync();
  const jobs = require('../../services/jobRequests.service');
  const catalog = { id: 20, body_text: 'TESTONLY appointment {{1}}', is_generic: true, is_active: true, disciplinas: [] };
  const provider = [], settlements = [];
  let injectFailure = false;
  const coordinator = createPropagation({
    JobRequest: db.JobRequest, sequelize: sql, loadCatalog: async () => catalog,
    listClinics: async () => [1, 2, 3, 4].map(id_clinica => ({ id_clinica })), applies: () => true,
    resolveConfig: async id => id === 4 ? null : { wabaId: id < 3 ? '101' : '102' },
    enqueue: async (input, options) => {
      if (injectFailure && input.payload.target.key === 'waba:102') throw Error('TESTONLY outbox failure');
      return jobs.enqueueUniqueJobRequest(input, options);
    },
    acquireLease: async () => ({ acquired: true, release: async () => {} }),
    propagate: async input => { provider.push(input); if (input.wabaIds?.[0] === '101') throw Error('TESTONLY provider timeout'); return { errors: [] }; },
    settleCatalog: async value => settlements.push(value),
  });
  const birth = () => db.JobRequest.create({ type: 'whatsapp_template_create', status: 'running', attempts: 1,
    payload: { mode: 'propagate_catalog_item', templateCatalogId: 20, __runtime_namespace: 'testonly' } });
  const parent = await birth();
  injectFailure = true;
  await assert.rejects(coordinator.parent(parent.payload, parent), /outbox failure/);
  assert.equal(await db.JobRequest.count(), 1);
  assert.equal((await db.JobRequest.findByPk(parent.id)).payload.catalog_propagation_v1, undefined);
  report.checks.push('Native MySQL transaction rolls back all children and parent plan when enqueue fails.');
  injectFailure = false;
  const concurrent = [await db.JobRequest.findByPk(parent.id), await db.JobRequest.findByPk(parent.id)];
  const results = await Promise.all(concurrent.map(row => coordinator.parent(row.payload, row)));
  assert(results.every(r => r.status === 'waiting'));
  await parent.reload();
  const plan = parent.payload.catalog_propagation_v1;
  assert.equal(plan.targets.length, 3); assert.equal(await db.JobRequest.count(), 4);
  assert.equal(provider.length, 0);
  assert.deepEqual(plan.targets.find(t => t.wabaId === '101').clinicIds, [1, 2]);
  report.checks.push('Two concurrent native parent executions create one durable plan, one child per shared WABA, and one disconnected-clinic task.');
  const children = await db.JobRequest.findAll({ where: { id: plan.targets.map(t => t.jobId) }, order: [['id', 'ASC']] });
  for (const child of children) {
    await child.update({ status: 'running', attempts: 1 });
    try {
      const result = await coordinator.target(child.payload, child);
      assert.equal(result.status, 'completed'); await child.update({ status: result.status });
    } catch (error) { assert.match(error.message, /provider timeout/); await child.update({ status: 'failed', error_message: error.message }); }
  }
  const result = await coordinator.parent(parent.payload, parent);
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
  assert.equal(result.result.targets_completed, 2); assert.equal(result.result.targets_failed, 1);
  assert.equal(provider.length, 3); assert.equal(settlements[0].state, 'failed');
  report.checks.push('One provider account fails while the second and disconnected clinic finish; the parent reports partial failure only after all children settle.');
  const replay = await db.JobRequest.findByPk(parent.id);
  await coordinator.parent(replay.payload, replay);
  assert.equal(await db.JobRequest.count(), 4);
  report.checks.push('Restart/retry reuses all original child IDs, including completed and failed jobs; no work is respawned.');
  const foreign = await db.JobRequest.findByPk(children[1].id);
  await foreign.update({ payload: { ...foreign.payload, __runtime_namespace: 'foreign' } });
  await assert.rejects(coordinator.target(foreign.payload, foreign), /target_changed/);
  assert.equal(provider.length, 3);
  report.checks.push('A foreign namespace is rejected before invoking the simulated provider.');
  const source = fs.readFileSync(require.resolve('../../services/whatsappTemplates.service'), 'utf8');
  const start = source.indexOf('function catalogPropagationCoordinator()');
  const code = source.slice(start, source.indexOf('\nasync function runCatalogPropagationJob', start));
  const native = vm.runInNewContext('(' + code + ')', {
    require: name => { assert.equal(name, '../lib/whatsapp-catalog-propagation'); return { catalogDigest, createPropagation: deps => deps }; },
    db, Op: Sequelize.Op, WhatsappTemplateCatalog: db.WhatsappTemplateCatalog,
    WhatsappTemplateCatalogDiscipline: db.WhatsappTemplateCatalogDiscipline, getCatalogTemplateById: async () => {},
    jobRequestsService: jobs, propagateCatalogTemplateToAllClinics: async () => {},
  })();
  const entry = await db.WhatsappTemplateCatalog.create({ name: 'testonly_appointment', family_key: 'testonly_appointment',
    locale: 'es', category: 'UTILITY', body_text: 'TESTONLY appointment', is_generic: true, propagation_state: 'pending' });
  await db.WhatsappTemplateCatalogDiscipline.create({ template_catalog_id: entry.id, disciplina_code: 'dental' });
  const loaded = await db.WhatsappTemplateCatalog.findByPk(entry.id, { include: [{ model: db.WhatsappTemplateCatalogDiscipline,
    as: 'disciplinas', attributes: ['id', 'disciplina_code'] }] });
  const digest = catalogDigest(loaded), input = { catalogId: entry.id, generation: digest, parentId: parent.id, runtimeNamespace: 'testonly' };
  await native.settleCatalog({ ...input, state: 'completed' }); await entry.reload();
  assert.equal(entry.propagation_state, 'completed'); assert(entry.last_propagated_at);
  const newer = await db.JobRequest.create({ type: 'whatsapp_template_create', origin: 'whatsapp_catalog_propagation', status: 'pending',
    payload: { templateCatalogId: entry.id, __runtime_namespace: 'testonly' } });
  await native.settleCatalog({ ...input, state: 'failed' }); await entry.reload(); assert.equal(entry.propagation_state, 'completed');
  await entry.update({ body_text: 'TESTONLY edited', propagation_state: 'pending' });
  await native.settleCatalog({ ...input, parentId: newer.id, state: 'completed' }); await entry.reload(); assert.equal(entry.propagation_state, 'pending');
  report.checks.push('Native MySQL catalog settlement matches the exact semantic contract and cannot overwrite a newer operation or edited catalog; association metadata does not corrupt the fingerprint.');
  assert.equal(report.rejected.length, 0);
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
