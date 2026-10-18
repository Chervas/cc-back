'use strict';

const assert = require('node:assert/strict');
const C = require('../../lib/patient-mobile-verification');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const createFixture = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

withIsolatedCampaignMysql(async scope => {
  const { db } = await createFixture(scope), { sql, report } = scope;
  db.AutomationFlowCatalogDiscipline = require('../../../models/automationflowcatalogdiscipline')(sql, require('sequelize').DataTypes);
  db.AutomationFlowCatalog.hasMany(db.AutomationFlowCatalogDiscipline, { as: 'disciplinas', foreignKey: 'flow_catalog_id' });
  await db.AutomationFlowCatalogDiscipline.sync();
  const source = await db.AutomationFlowTemplateV2.create({ ...C.definition(), published_at: new Date(), published_by: 1 });
  const catalog = await db.AutomationFlowCatalog.create({ name: C.FAMILY, display_name: source.name,
    trigger_type: C.REQUEST, template_key: C.FAMILY, template_version: 1, steps: [], is_generic: true, is_active: true });
  const service = loadSource('automationDefaults.service', { '../../models': db, './queue.service': {},
    './whatsappTemplates.service': {} }, { PATIENT_MOBILE_VERIFICATION_ENABLED: 'true' });
  const ensure = clinicId => service.ensureCatalogTemplateForClinic({ clinicId, catalogFlow: catalog, actorUserId: 1 });
  const rows = clinicId => db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: clinicId, trigger_type: C.REQUEST }, order: [['id', 'ASC']], raw: true });
  const old = JSON.stringify(await rows(72));
  const first = await ensure(73);
  assert.equal(first.status, 'created');
  const [copy] = await rows(73);
  assert.equal(Number(copy.is_active), 0); assert(copy.published_at); assert.equal(Number(copy.is_system), 0);
  assert.notEqual(copy.public_id, source.public_id); assert.deepEqual(copy.nodes, source.nodes);
  assert.deepEqual(copy.trigger_config, source.trigger_config);
  assert.equal(await db.JobRequest.count() + await db.Message.count(), 0);
  report.checks.push('distribution creates a published inactive clinic copy even with the global gate enabled; no jobs/messages');

  assert.equal((await ensure(73)).status, 'unchanged');
  assert.equal((await rows(73)).length, 1); assert.equal(Number((await rows(73))[0].is_active), 0);
  assert.equal((await ensure(72)).status, 'unchanged'); assert.equal(JSON.stringify(await rows(72)), old);
  report.checks.push('repeat distribution is a no-op; an existing active configured clinic family is preserved byte-for-byte');

  const local = await db.AutomationFlowTemplateV2.findByPk(copy.id);
  const localNodes = structuredClone(local.nodes);
  localNodes[0].config = { response_timeout_minutes: 1440, enabled_after: '2026-10-20T12:00:00Z' };
  await local.update({ template_key: 'testonly_custom_mobile', nodes: localNodes,
    trigger_config: { configured: true, response_timeout_minutes: 1440, enabled_after: '2026-10-20T12:00:00Z' } });
  const customized = JSON.stringify(await rows(73));
  await ensure(73); assert.equal(JSON.stringify(await rows(73)), customized);
  await db.AutomationFlowTemplateV2.create({ ...C.definition(73), public_id: 'flw_TESTONLY_draft',
    template_key: 'testonly_local_draft', version: 2, name: 'TESTONLY local draft' });
  const withDraft = JSON.stringify(await rows(73));
  const result = await service.propagateCatalogAutomationToClinics({ catalogId: catalog.id, backfillScheduled: false });
  assert.equal(result.unchanged, 2); assert.equal(result.created + result.updated + result.failed, 0);
  assert.equal(JSON.stringify(await rows(73)), withDraft); assert.equal(JSON.stringify(await rows(72)), old);
  report.checks.push('renamed/customized published and draft copies survive the native catalog propagation without activation or duplicate creation');

  await db.Clinica.create({ id_clinica: 74, nombre_clinica: 'TESTONLY concurrent' });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => ensure(74)));
  assert.equal(concurrent.filter(r => r.status === 'created').length, 1);
  assert.equal((await rows(74)).length, 1); assert.equal(Number((await rows(74))[0].is_active), 0);
  assert.equal(await db.JobRequest.count() + await db.Message.count(), 0);
  report.checks.push('eight concurrent propagations serialize on the clinic and create exactly one inactive copy');
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
