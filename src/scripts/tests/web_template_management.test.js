'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
const service = require('../../services/webProjects.service');

function row(values) {
  return {
    ...values,
    async update(patch) { Object.assign(this, patch); return this; },
    get({ plain } = {}) { return plain ? { ...this, update: undefined, get: undefined } : this; },
  };
}

async function main() {
  const document = service.createBlankWebDocument({ name: 'Landing de prueba', locale: 'es-ES' });
  const project = row({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    locale: 'es-ES',
  });
  const draft = row({ projectId: project.id, document });
  const createdTemplates = [];
  const auditEvents = [];
  const featureChecks = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const sequelize = { async transaction(callback) { return callback(transaction); } };
  const models = {
    sequelize,
    WebProject: { async findByPk() { return project; } },
    WebDraft: { async findOne() { return draft; } },
    WebTemplate: {
      async create(values) {
        const template = row({ ...values, created_at: '2026-07-18T10:00:00.000Z', updated_at: '2026-07-18T10:00:00.000Z' });
        createdTemplates.push(template);
        return template;
      },
      async findByPk() { return createdTemplates[0] || null; },
    },
    WebAuditEvent: { async create(values) { auditEvents.push(values); return values; } },
    Clinica: { async findByPk() { return { id_clinica: 66 }; } },
  };
  const assertFeatureAccess = async ({ featureKey, clinicId }) => {
    featureChecks.push({ featureKey, clinicId });
  };

  const created = await service.createTemplateFromProject({
    actorId: 9,
    projectId: project.id,
    body: { name: 'Mi plantilla de implantes', description: 'Landing validada', category: 'treatment' },
    requestId: 'request-template-create',
    models,
    sequelize,
    assertFeatureAccess,
  });
  assert.equal(created.scope_type, 'clinic');
  assert.equal(created.scope_id, 66);
  assert.equal(created.status, 'active');
  assert.match(created.catalog_key, /^custom-mi-plantilla-de-implantes-[a-f0-9]{8}$/);
  assert.deepEqual(createdTemplates[0].document, document, 'la plantilla conserva el documento canónico del borrador');
  assert.notEqual(createdTemplates[0].document, document, 'el documento de la plantilla se copia y no comparte referencia');
  assert.equal(auditEvents[0].eventType, 'web.template.created');
  assert(featureChecks.every((check) => check.featureKey === 'marketing.web.templates.manage' && check.clinicId === 66));

  const updated = await service.updateTemplate({
    actorId: 9,
    templateId: created.id,
    body: { name: 'Plantilla revisada', category: 'custom' },
    requestId: 'request-template-update',
    models,
    sequelize,
    assertFeatureAccess,
  });
  assert.equal(updated.name, 'Plantilla revisada');
  assert.equal(auditEvents.at(-1).eventType, 'web.template.updated');

  const archived = await service.archiveTemplate({
    actorId: 9,
    templateId: created.id,
    requestId: 'request-template-archive',
    models,
    sequelize,
    assertFeatureAccess,
  });
  assert.equal(archived.status, 'archived');
  assert.equal(auditEvents.at(-1).eventType, 'web.template.archived');

  await assert.rejects(
    () => service.createTemplateFromProject({
      actorId: 9, projectId: project.id, body: { name: '', category: 'custom' }, models, sequelize, assertFeatureAccess,
    }),
    (error) => error.code === 'invalid_template_name' && error.status === 422
  );

  const routes = fs.readFileSync(path.join(__dirname, '../../routes/marketing.routes.js'), 'utf8');
  assert.match(routes, /post\('\/web-projects\/:projectId\/templates'.*createTemplateFromProject/);
  assert.match(routes, /patch\('\/web-templates\/:templateId'.*updateTemplate/);
  assert.match(routes, /delete\('\/web-templates\/:templateId'.*archiveTemplate/);
  console.log('web template management: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
