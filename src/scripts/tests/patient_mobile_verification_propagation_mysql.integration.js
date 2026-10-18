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

  const controller = loadSource('../controllers/automationsV2.controller', { '../../models': db,
    '../services/leadAutoReply.service': { validateFlowActivation: async () => ({ managed: false, ready: true }) },
    '../services/patientMobileVerificationLifecycle.service': { current: () => ({ inspect: async () => ({ ready: false }) }) },
  }, { PATIENT_MOBILE_VERIFICATION_ENABLED: 'false' }, 10000);
  const invoke = async (handler, params, body, subject = controller) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await subject[handler]({ userData: { userId: 1 }, params, body }, res);
    assert(res.statusCode < 400, JSON.stringify(res.body)); return res.body.data;
  };
  const [distributed] = await rows(74);
  const scopedDraft = await invoke('createTemplateDraft', {}, { ...distributed, id: undefined });
  assert.equal(scopedDraft.public_id, distributed.public_id);
  assert.equal(scopedDraft.template_key, distributed.template_key);
  assert.equal(scopedDraft.version, 2);
  assert.equal(await db.AutomationFlowTemplateV2.count({ where: { clinic_id: 74, is_active: true } }), 0);
  report.checks.push('native new-draft editing preserves the propagated double-underscore clinic family, public identity and next version rather than creating a second flow');
  await db.Clinica.create({ id_clinica: 75, nombre_clinica: 'TESTONLY controller' });
  const definition = C.definition(75), cutoff = '2026-10-20T12:00:00.000Z';
  definition.nodes[0].config = { response_timeout_minutes: 1440, enabled_after: cutoff };
  const draft = await invoke('createTemplateDraft', {}, definition);
  const stored = await db.AutomationFlowTemplateV2.findByPk(draft.id);
  assert.equal(stored.nodes[0].config.response_timeout_minutes, 1440);
  assert.equal(stored.nodes[0].config.enabled_after, cutoff);
  assert(C.configValid(stored.trigger_config));
  await invoke('updateTemplateDraft', { template_ref: draft.public_id, version: draft.version }, { nodes: stored.nodes });
  await stored.reload(); assert.equal(stored.nodes[0].config.enabled_after, cutoff);
  const published = await invoke('publishTemplateVersion', { template_ref: draft.public_id, version: draft.version }, {});
  await stored.reload(); assert.equal(stored.nodes[0].config.response_timeout_minutes, 1440);
  assert.equal(stored.nodes[0].config.enabled_after, cutoff); assert(C.configValid(stored.trigger_config));
  assert.equal(published.is_active, false); assert.equal(stored.is_active, false);
  report.checks.push('native create, repeated save and publish preserve 1440 minutes and the exact activation cut in both trigger node and derived config; closed gate publishes inactive');

  const enabledController = loadSource('../controllers/automationsV2.controller', { '../../models': db,
    '../services/leadAutoReply.service': { validateFlowActivation: async () => ({ managed: false, ready: true }) },
    '../services/patientMobileVerificationLifecycle.service': { current: () => ({ inspect: async () => ({ ready: true }) }) },
  }, { PATIENT_MOBILE_VERIFICATION_ENABLED: 'true' }, 10000);
  const next = await invoke('createTemplateDraft', {}, definition, enabledController);
  const active = await invoke('publishTemplateVersion', { template_ref: next.public_id, version: next.version }, {}, enabledController);
  assert.equal(active.is_active, true); assert.equal(await db.AutomationFlowTemplateV2.count({ where: { clinic_id: 75, is_active: true } }), 1);
  const master = { ...C.definition(), template_key: 'testonly_publication_master', nodes: definition.nodes };
  const masterDraft = await invoke('createTemplateDraft', {}, master, enabledController);
  const publishedMaster = await invoke('publishTemplateVersion', { template_ref: masterDraft.public_id, version: masterDraft.version }, {}, enabledController);
  assert.equal(publishedMaster.is_active, false);
  report.checks.push('enabled gate plus simulated sender/template readiness activates exactly the configured local version; the configured system master still never activates');
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
