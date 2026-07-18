'use strict';

const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const { hashWebDocument } = require('../../lib/webDocument');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

const UUIDS = Object.freeze({
  project: '11111111-1111-4111-8111-111111111111',
  page: '22222222-2222-4222-8222-222222222222',
  draft: '33333333-3333-4333-8333-333333333333',
  revision: '44444444-4444-4444-8444-444444444444',
  template: '55555555-5555-4555-8555-555555555555',
});

function defineModels() {
  const sequelize = new Sequelize('mysql://test:test@127.0.0.1:3306/clinicaclick_contract_test', {
    logging: false,
  });
  const models = {
    Clinica: sequelize.define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
    GrupoClinica: sequelize.define('GrupoClinica', { id_grupo: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
    Usuario: sequelize.define('Usuario', { id_usuario: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
  };
  for (const [name, file] of [
    ['WebProject', 'webproject'],
    ['WebTemplate', 'webtemplate'],
    ['WebPage', 'webpage'],
    ['WebRevision', 'webrevision'],
    ['WebDraft', 'webdraft'],
    ['WebAuditEvent', 'webauditevent'],
  ]) {
    models[name] = require(`../../../models/${file}`)(sequelize, DataTypes);
  }
  for (const modelName of ['WebProject', 'WebTemplate', 'WebPage', 'WebRevision', 'WebDraft', 'WebAuditEvent']) {
    models[modelName].associate(models);
  }
  return { sequelize, models };
}

async function testModelAttributesHooksAndScope() {
  const { sequelize, models } = defineModels();
  try {
    assert.equal(models.WebProject.tableName, 'WebProjects');
    assert.equal(models.WebProject.rawAttributes.campaignContext.field, 'campaign_context');
    assert.equal(models.WebPage.rawAttributes.projectId.field, 'project_id');
    assert.equal(models.WebPage.rawAttributes.id.type.options.length, 36);
    assert.equal(models.WebPage.rawAttributes.parentPageId.type.options.length, 36);
    assert.equal(models.WebDraft.rawAttributes.lockVersion.field, 'lock_version');
    assert.equal(models.WebDraft._versionAttribute, 'lockVersion');
    assert.equal(models.WebRevision.options.timestamps, true);
    assert.equal(models.WebRevision._timestampAttributes.updatedAt, undefined);
    assert.equal(models.WebAuditEvent._timestampAttributes.updatedAt, undefined);
    assert.ok(models.WebProject.associations.pages);
    assert.ok(models.WebProject.associations.draft);
    assert.ok(models.WebPage.associations.template);
    assert.ok(models.WebDraft.associations.baseRevision);

    const invalidProject = models.WebProject.build({
      id: UUIDS.project,
      scopeType: 'clinic',
      clinicaId: null,
      grupoClinicaId: 9,
      name: 'Proyecto inválido',
    });
    await assert.rejects(() => invalidProject.validate(), /alcance clinic/);

    const immutableCampaignProject = models.WebProject.build({
      id: UUIDS.project,
      scopeType: 'clinic',
      clinicaId: 66,
      grupoClinicaId: null,
      name: 'Landing de campana',
      purpose: 'landing',
      campaignContext: { strategy_id: 41, target_kind: 'general', treatment_id: null },
    });
    immutableCampaignProject.isNewRecord = false;
    immutableCampaignProject.changed('campaignContext', false);
    immutableCampaignProject.set('campaignContext', {
      strategy_id: 42, target_kind: 'general', treatment_id: null,
    });
    await assert.rejects(
      () => models.WebProject.runHooks('beforeUpdate', immutableCampaignProject, {}),
      (error) => error.code === 'WEB_PROJECT_CAMPAIGN_CONTEXT_IMMUTABLE'
    );
    await assert.rejects(
      () => models.WebProject.runHooks('beforeBulkUpdate', {
        attributes: { campaignContext: { strategy_id: 42, target_kind: 'general', treatment_id: null } },
      }),
      (error) => error.code === 'WEB_PROJECT_CAMPAIGN_CONTEXT_IMMUTABLE'
    );

    const safeIdPage = models.WebPage.build({
      id: UUIDS.page,
      projectId: UUIDS.project,
      pageKey: 'landing_home_v1',
      title: 'Inicio',
      slug: 'inicio',
      seo: {},
    });
    await safeIdPage.validate();
    assert.equal(safeIdPage.pageKey, 'landing_home_v1');

    const document = buildValidWebDocument();
    const draft = models.WebDraft.build({
      id: UUIDS.draft,
      projectId: UUIDS.project,
      document,
      lockVersion: 1,
    });
    await draft.validate();
    assert.equal(draft.documentHash, hashWebDocument(document));
    assert.equal(draft.schemaVersion, 1);

    draft.isNewRecord = false;
    draft.changed('document', false);
    draft.changed('documentHash', false);
    const updatedDocument = buildValidWebDocument();
    updatedDocument.seo.title_suffix = 'Clínica actualizada';
    draft.set('document', updatedDocument);
    await draft.validate();
    assert.equal(draft.documentHash, hashWebDocument(updatedDocument));

    const wrongHash = models.WebDraft.build({
      id: UUIDS.draft,
      projectId: UUIDS.project,
      document,
      documentHash: '0'.repeat(64),
      lockVersion: 1,
    });
    await assert.rejects(
      () => wrongHash.validate(),
      (error) => error.code === 'WEB_DOCUMENT_HASH_MISMATCH'
    );

    const template = models.WebTemplate.build({
      id: UUIDS.template,
      scopeType: 'global',
      catalogKey: 'lead_generation',
      name: 'Captación general',
      category: 'lead_generation',
      document,
      compatibility: {},
    });
    await template.validate();
    assert.equal(template.scopeKey, 'global');
    assert.equal(template.documentHash, hashWebDocument(document));
  } finally {
    await sequelize.close();
  }
}

async function testImmutableRevisionAndAppendOnlyAudit() {
  const { sequelize, models } = defineModels();
  try {
    const document = buildValidWebDocument();
    const revision = models.WebRevision.build({
      id: UUIDS.revision,
      projectId: UUIDS.project,
      revisionNumber: 1,
      document,
      contentSnapshot: {},
      status: 'draft',
    });
    await revision.validate();
    revision.set('document', { ...document, seo: { ...document.seo, title_suffix: 'Otro' } });
    await assert.rejects(
      () => models.WebRevision.runHooks('beforeUpdate', revision, {}),
      (error) => error.code === 'WEB_REVISION_IMMUTABLE'
    );

    const approvable = models.WebRevision.build({
      id: '66666666-6666-4666-8666-666666666666',
      projectId: UUIDS.project,
      revisionNumber: 2,
      document,
      contentSnapshot: {},
      status: 'review',
    });
    await approvable.validate();
    approvable.isNewRecord = false;
    approvable._previousDataValues = { ...approvable.dataValues, contentSnapshot: {}, status: 'review' };
    for (const field of approvable.changed() || []) approvable.changed(field, false);
    approvable.set('status', 'approved');
    approvable.set('contentSnapshot', {
      schema_version: 1,
      content_entries: {},
      media_assets: {},
      live_bindings: [],
    });
    await models.WebRevision.runHooks('beforeUpdate', approvable, { webContentSnapshotFreeze: true });
    await assert.rejects(
      () => models.WebRevision.runHooks('beforeUpdate', approvable, {}),
      (error) => error.code === 'WEB_REVISION_IMMUTABLE'
    );

    const audit = models.WebAuditEvent.build({
      scopeType: 'clinic',
      clinicaId: 66,
      eventType: 'web_project.created',
      entityType: 'web_project',
      entityId: UUIDS.project,
      metadata: {},
    });
    await audit.validate();
    await assert.rejects(
      () => models.WebAuditEvent.runHooks('beforeUpdate', audit, {}),
      (error) => error.code === 'WEB_AUDIT_EVENT_APPEND_ONLY'
    );
  } finally {
    await sequelize.close();
  }
}

async function run() {
  await testModelAttributesHooksAndScope();
  await testImmutableRevisionAndAppendOnlyAudit();
  console.log('web_models_contract.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
