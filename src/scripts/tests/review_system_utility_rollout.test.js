'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20261001153000-update-review-request-system-utility');
const { NAMES, BODY, VARIABLES, componentsFor } = migration._test;
const service = require('../../services/whatsappTemplates.service');
const db = require('../../../models');
const catalog = { id: 9, name: NAMES[0], family_key: NAMES[0], category: 'UTILITY', body_text: BODY,
  components: componentsFor({ name: NAMES[0] }) };
const prior = { name: NAMES[0] + '_v10', language: 'es', components: [{ type: 'BODY', text: 'Hola {{1}}, soy {{3}} de {{2}}.' }] };
const replacement = { id: 'test-meta-11', name: NAMES[0] + '_v11', language: 'es', status: 'APPROVED', components: catalog.components };

test('system upgrade retains the original three semantic positions and appends the attended date', () => {
  assert.deepEqual(VARIABLES.map(v => v.name), ['nombre_paciente', 'nombre_clinica', 'firma_resenas', 'fecha_ultima_cita_asistida']);
  assert.equal(BODY.includes('Soy {{3}} de {{2}}'), true);
  assert.equal(BODY.includes('visita del {{4}}'), true);
  assert.equal(BODY.length <= 1024, true);
  assert.equal(service._test.isStaleReviewRequestTemplate(replacement, catalog), false);
});

test('photo upgrade preserves the existing header and does not rewrite clinic images', () => {
  const header = { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://media.example.invalid/sample.jpg'] } };
  const components = componentsFor({ name: NAMES[1], components: JSON.stringify([header, { type: 'BODY', text: 'Previous' }]) });
  assert.deepEqual(components[0], header);
  assert.equal(components[1].text, BODY);
  assert.throws(() => componentsFor({ name: NAMES[1], components: [] }), /header_missing/);
});

test('migration modifies only the two source catalog entries in one transaction, never provider instances or custom copies', async () => {
  const calls = [], transaction = {};
  const rows = [{ id: 9, name: NAMES[0], components: [] }, { id: 34, name: NAMES[1], components: [{ type: 'HEADER', format: 'IMAGE' }] }];
  await migration.up({ sequelize: { transaction: async callback => callback(transaction), query: async (sql, options) => {
    assert.equal(options.transaction, transaction); calls.push({ sql, options });
    return sql.startsWith('SELECT') ? [rows] : [];
  } } });
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) {
    assert.match(call.sql, /UPDATE WhatsappTemplateCatalog SET category='UTILITY'/);
    assert.equal(call.options.replacements.body, BODY);
  }
  assert.equal(calls.some(call => /UPDATE WhatsappTemplates\b/.test(call.sql)), false);
});

test('a pending, rejected, foreign-language or unmanaged replacement cannot retire an approved previous template', () => {
  for (const candidate of [{ ...replacement, status: 'PENDING' }, { ...replacement, status: 'REJECTED' },
    { ...replacement, language: 'en' }, { ...replacement, id: 'unmanaged-meta' }]) {
    assert.equal(service._test.hasApprovedReviewReplacement(prior, catalog, [candidate], new Set(['test-meta-11'])), false);
  }
  assert.equal(service._test.hasApprovedReviewReplacement(prior, catalog, [], new Set(['test-meta-11'])), false);
});

test('only an approved managed replacement with the current exact contract permits retirement', () => {
  assert.equal(service._test.hasApprovedReviewReplacement(prior, catalog, [replacement], new Set(['test-meta-11'])), true);
  assert.equal(service._test.hasApprovedReviewReplacement(prior, catalog,
    [{ ...replacement, components: [{ type: 'BODY', text: 'Different body' }] }], new Set(['test-meta-11'])), false);
  assert.equal(service._test.hasApprovedReviewReplacement(replacement, catalog, [replacement], new Set(['test-meta-11'])), false);
});

test('a review approved by Meta as MARKETING is not resubmitted indefinitely as UTILITY', () => {
  assert.equal(service._test.hasApprovedReviewReplacement(prior, catalog,
    [{ ...replacement, category: 'MARKETING' }], new Set(['test-meta-11'])), true);
});

test('an approved clinic reference stays unchanged while its new content awaits provider approval', async t => {
  const original = db.WhatsappTemplate.findAll;
  t.after(() => { db.WhatsappTemplate.findAll = original; });
  let updates = 0;
  const existing = { ...prior, id: 400, is_active: true, catalog_template_id: 9,
    status: 'APPROVED', update: async () => { updates++; } };
  db.WhatsappTemplate.findAll = async () => [existing];
  for (const status of ['PENDING', 'REJECTED', 'PENDING_LOCAL']) {
    const result = await service.upsertClinicOverrideTemplateForClinic({ clinicId: 59, template: catalog,
      technicalName: replacement.name, metaTemplateId: replacement.id, status });
    assert.equal(result.action, 'approval_pending');
    assert.equal(result.row, undefined);
  }
  assert.equal(updates, 0);
  assert.equal(existing.name, prior.name);
});

test('an approved replacement keeps the local reference identity and an existing clinic deactivation', async t => {
  const original = db.WhatsappTemplate.findAll;
  t.after(() => { db.WhatsappTemplate.findAll = original; });
  let payload;
  const existing = { ...prior, id: 400, is_active: false, catalog_template_id: 9,
    status: 'APPROVED', update: async input => { payload = input; } };
  db.WhatsappTemplate.findAll = async options => {
    assert.equal(options.where.is_active, undefined);
    assert.equal(options.where.superseded_by_template_id, null);
    return [existing];
  };
  const result = await service.upsertClinicOverrideTemplateForClinic({ clinicId: 59,
    template: { ...catalog, is_active: true, variables: VARIABLES }, technicalName: replacement.name,
    metaTemplateId: replacement.id, status: 'APPROVED' });
  assert.equal(result.row.id, 400);
  assert.equal(payload.is_active, false);
  assert.equal(payload.meta_template_id, replacement.id);
  assert.equal(payload.variables.length, 4);
});

test('invalid selective catalog requests fail before obtaining credentials or touching Meta', async () => {
  for (const catalogTemplateIds of [[], [0], [-1], ['9'], {}, [9.1]]) {
    await assert.rejects(service.createTemplatesFromCatalog({ wabaId: 'test-waba', catalogTemplateIds }), /catalog_template_ids_invalid/);
  }
});

test('secondary provisioning retains selected catalog IDs in the native job and respects broker checks', async t => {
  const broker = require('../../lib/whatsappAuthorizedBrokerClient');
  const jobs = require('../../services/jobRequests.service');
  const binding = broker.templateBinding, enqueue = jobs.enqueueUniqueJobRequest;
  t.after(() => { broker.templateBinding = binding; jobs.enqueueUniqueJobRequest = enqueue; });
  broker.templateBinding = async () => ({ sendEnabled: true });
  let captured;
  jobs.enqueueUniqueJobRequest = async input => { captured = input; return { job: { id: 1 } }; };
  await service.enqueueCreateTemplatesJob({ wabaId: 'test-waba', clinicId: 59, assignmentScope: 'clinic', catalogTemplateIds: [9, 34] });
  assert.deepEqual(captured.payload.catalogTemplateIds, [9, 34]);
  assert.equal(captured.type, 'whatsapp_template_create');
});

test('native propagation provisions an authorized shared secondary once and leaves voluntarily stopped assets closed', async t => {
  const broker = require('../../lib/whatsappAuthorizedBrokerClient');
  const whatsapp = require('../../services/whatsapp.service');
  const jobs = require('../../services/jobRequests.service');
  const originals = [];
  const stub = (object, key, value) => { originals.push([object, key, object[key]]); object[key] = value; };
  t.after(() => { for (const [object, key, value] of originals.reverse()) object[key] = value; });
  const template = { ...catalog, is_active: true, is_generic: true, update: async () => {} };
  stub(db.WhatsappTemplateCatalog, 'findByPk', async () => template);
  stub(db.Clinica, 'findAll', async () => [{ id_clinica: 59, configuracion: {} }]);
  stub(whatsapp, 'getClinicConfig', async () => null);
  stub(db.WhatsappTemplate, 'findAll', async () => []);
  stub(db.WhatsappTemplate, 'create', async () => ({}));
  stub(broker, 'configuration', () => ({ bindings: [
    { clinicId: 59, assetId: 101, wabaId: 'shared', sendEnabled: true },
    { clinicId: 60, assetId: 101, wabaId: 'shared', sendEnabled: true },
    { clinicId: 59, assetId: 102, wabaId: 'stopped', sendEnabled: true },
  ] }));
  stub(broker, 'templateBinding', async wabaId => wabaId === 'stopped' ? null : ({ assetId: 101, sendEnabled: true }));
  stub(db.ClinicMetaAsset, 'findByPk', async () => ({ id: 101, assignmentScope: 'group', grupoClinicaId: 5, additionalData: {} }));
  const queued = [];
  stub(jobs, 'enqueueUniqueJobRequest', async input => { queued.push(input); return { job: { id: queued.length } }; });
  const summary = await service.propagateCatalogTemplateToAllClinics({ templateCatalogId: 9,
    enqueueFollowupSync: false, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(summary.additional_wabas_queued, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.wabaId, 'shared');
  assert.deepEqual(queued[0].payload.catalogTemplateIds, [9]);
  assert.equal(queued[0].payload.assignmentScope, 'group');
});

test('a revoked selective provisioning request cannot fall back to the legacy queue', async t => {
  const broker = require('../../lib/whatsappAuthorizedBrokerClient');
  const originalBinding = broker.templateBinding, originalConfiguration = broker.configuration;
  t.after(() => { broker.templateBinding = originalBinding; broker.configuration = originalConfiguration; });
  broker.templateBinding = async () => null;
  broker.configuration = () => ({ bindings: [] });
  await assert.rejects(service.enqueueCreateTemplatesJob({ wabaId: 'revoked', catalogTemplateIds: [9] }),
    /whatsapp_authorized_binding_unavailable/);
});
