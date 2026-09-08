'use strict';
// Offline contract checks only: no application models, connection, migration or database writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { createTreatmentDocumentationService, sorting } = require('../../services/treatmentDocumentation.service');

function fixture() {
  const calls = [];
  const state = { treatments: [{ id_tratamiento: 9, nombre: 'Tratamiento ficticio', disciplina: 'estetica', activo: true }], requirements: [], clinicTemplates: [], catalogTemplates: [], protocols: [], total: 51, missingSchema: false };
  const record = (name, result) => async options => { calls.push({ name, options }); return typeof result === 'function' ? result() : result; };
  const db = {
    Sequelize,
    Clinica: { findByPk: record('clinic', { id_clinica: 72, grupoClinicaId: 50 }) },
    Tratamiento: { findAndCountAll: record('treatmentsPage', () => ({ rows: state.treatments, count: state.total })), findAll: record('treatmentNames', () => state.treatments) },
    TreatmentConsentRequirement: { findAll: record('requirements', () => state.requirements) },
    ClinicConsentTemplate: { findAll: record('clinicTemplates', () => state.clinicTemplates) },
    ConsentTemplateCatalog: { findAll: record('catalogTemplates', () => state.catalogTemplates) },
    TreatmentProtocol: {
      findOne: record('schema', () => { if (state.missingSchema) throw Object.assign(new Error('missing'), { original: { code: 'ER_NO_SUCH_TABLE' } }); return null; }),
      findAll: record('protocols', () => state.protocols),
      findAndCountAll: record('protocolsPage', () => ({ rows: state.protocols, count: state.total })),
    },
  };
  return { state, calls, service: createTreatmentDocumentationService(db) };
}

test('server ordering is whitelisted with stable identity tiebreakers', () => {
  assert.deepEqual(sorting({}, 'coverage'), [['nombre', 'ASC'], ['id_tratamiento', 'ASC']]);
  assert.deepEqual(sorting({ sort_by: 'updated_at', sort_direction: 'desc' }, 'library'), [['updated_at', 'DESC'], ['id', 'ASC']]);
  for (const query of [{ sort_by: 'content' }, { sort_by: 'title; DELETE FROM x' }, { sort_by: '__proto__' }, { sort_direction: 'asc;--' }]) assert.throws(() => sorting(query, 'library'), { code: 'invalid_documentation_sort' });
});

test('invalid filters/order fail before any data query', async () => {
  const { service, calls } = fixture();
  for (const query of [{ status: 'active' }, { assignment: 'all OR 1' }, { kind: 'other' }, { sort_by: 'content' }]) await assert.rejects(service.list({ clinicId: 72, query }), { statusCode: 400 });
  await assert.rejects(service.coverage({ clinicId: 72, query: { missing: 'other' } }), { statusCode: 400 });
  assert.equal(calls.length, 0);
  await assert.rejects(service.coverage({ clinicId: '72 OR 1', query: { missing: 'protocol' } }), { code: 'invalid_clinic' });
  assert.equal(calls.length, 0);
});

test('missing consent is a scoped SQL predicate before count/pagination, with no include joins', async () => {
  const { service, calls } = fixture();
  const result = await service.coverage({ clinicId: 72, query: { missing: 'clinical_consent', page: 2, page_size: 10, q: 'Ficticio', sort_direction: 'desc' } });
  const query = calls.find(call => call.name === 'treatmentsPage').options;
  assert.equal(query.limit, 10); assert.equal(query.offset, 20);
  assert.deepEqual(query.order, [['nombre', 'DESC'], ['id_tratamiento', 'ASC']]);
  assert.equal(query.where.nombre[Sequelize.Op.like], '%Ficticio%');
  const sql = query.where[Sequelize.Op.and].at(-1).val;
  assert.match(sql, /^NOT EXISTS /);
  assert.match(sql, /r\.tratamiento_id = Tratamiento\.id_tratamiento/);
  assert.match(sql, /r\.clinica_id = 72 OR r\.clinica_id IS NULL/);
  assert.match(sql, /c\.clinic_id = 72/);
  assert.match(sql, /c\.purpose = 'clinical' AND c\.status = 'active'/);
  assert.match(sql, /FROM ConsentTemplateCatalogs c/);
  assert.equal(result.total, 51); assert.equal(result.page_size, 10); assert.equal(result.page, 2);
  assert(calls.every(call => !call.options?.include), 'relationships must be hydrated in bounded backend queries');
});

test('coverage resolves scoped template names and preview counters on backend', async () => {
  const { service, state, calls } = fixture();
  state.requirements = [1, 2, 3, 4].map(id => ({ tratamiento_id: 9, clinic_template_id: id, required: true }));
  state.requirements.push({ tratamiento_id: 9, catalog_template_id: 10 });
  state.clinicTemplates = [1, 2, 3, 4].map(id => ({ id, name: `Consentimiento ficticio ${id}`, purpose: 'clinical', status: 'active' }));
  state.catalogTemplates = [{ id: 10, name: 'Modelo ficticio', purpose: 'clinical', status: 'draft' }];
  state.protocols = [1, 2, 3, 4, 5].map(id => ({ id, title: `Documento ficticio ${id}`, kind: id === 5 ? 'aftercare' : 'protocol', status: 'draft', version: 1, treatment_ids: [9] }));
  const item = (await service.coverage({ clinicId: 72 })).items[0];
  assert.equal(item.has_active_clinical_consent, true);
  assert.equal(item.consents.length, 5); assert.equal(item.consents_preview.length, 3); assert.equal(item.consents_more_count, 2);
  assert.equal(item.protocols.length, 4); assert.equal(item.protocols_preview.length, 3); assert.equal(item.protocols_more_count, 1);
  assert.equal(item.aftercare_preview.length, 1); assert.equal(item.aftercare_more_count, 0);
  assert.equal(item.consents[4].source, 'catalog');
  assert.equal(calls.find(call => call.name === 'clinicTemplates').options.where.clinic_id, 72);
  assert.deepEqual(calls.find(call => call.name === 'requirements').options.where.tratamiento_id[Sequelize.Op.in], [9]);
});

test('missing protocol filters exclude archived records before pagination; pending schema is explicit', async () => {
  const { service, state, calls } = fixture();
  for (const kind of ['protocol', 'aftercare']) {
    await service.coverage({ clinicId: 72, query: { missing: kind } });
    const sql = calls.filter(call => call.name === 'treatmentsPage').at(-1).options.where[Sequelize.Op.and].at(-1).val;
    assert.match(sql, new RegExp(`p.kind = '${kind}'`));
    assert.match(sql, /p.clinic_id = 72/); assert.match(sql, /p.status <> 'archived'/);
    assert.match(sql, /JSON_CONTAINS\(p.treatment_ids, JSON_ARRAY\(Tratamiento.id_tratamiento\)\)/);
  }
  state.missingSchema = true;
  const before = calls.filter(call => call.name === 'treatmentsPage').length;
  await assert.rejects(service.coverage({ clinicId: 72, query: { missing: 'protocol' } }), { code: 'documentation_schema_pending', statusCode: 503 });
  assert.equal(calls.filter(call => call.name === 'treatmentsPage').length, before);
});

test('library status/assignment sorting and totals are computed server-side, unavailable treatment is not leaked', async () => {
  const { service, state, calls } = fixture();
  state.protocols = [{ id: 1, title: 'Ficticio', status: 'draft', kind: 'protocol', version: 2, treatment_ids: [9, 10, 11, 12] }];
  const result = await service.list({ clinicId: 72, query: { kind: 'protocol', status: 'draft', assignment: 'assigned', page: 1, page_size: 10, sort_by: 'updated_at', sort_direction: 'desc' } });
  const query = calls.find(call => call.name === 'protocolsPage').options;
  assert.equal(query.where.clinic_id, 72); assert.equal(query.where.status, 'draft'); assert.equal(query.where.kind, 'protocol');
  assert.equal(query.where[Sequelize.Op.and][0].attribute.fn, 'JSON_LENGTH');
  assert.equal(query.where[Sequelize.Op.and][0].logic[Sequelize.Op.gt], 0);
  assert.equal(query.offset, 10); assert.equal(query.limit, 10);
  assert.deepEqual(query.order, [['updated_at', 'DESC'], ['id', 'ASC']]);
  assert.deepEqual(query.attributes.exclude, ['content']);
  assert.equal(result.total, 51); assert.equal(result.items[0].treatment_count, 4);
  assert.equal(result.items[0].treatments_preview.length, 3); assert.equal(result.items[0].treatments_more_count, 1);
  assert.equal(result.items[0].treatments[1].name, 'Tratamiento no disponible'); assert.equal(result.items[0].treatments[1].available, false);
  await service.list({ clinicId: 72, query: { assignment: 'unassigned' } });
  assert.equal(calls.filter(call => call.name === 'protocolsPage').at(-1).options.where[Sequelize.Op.and][0].logic, 0);
});

test('coverage predicate model alias/table identifiers match local Sequelize model metadata offline', async () => {
  const sequelize = new Sequelize.Sequelize('offline_only', 'fixture', 'fixture', { dialect: 'mysql', logging: false });
  const Tratamiento = require('../../../models/tratamiento')(sequelize, Sequelize.DataTypes);
  const catalog = require('../../../models/consenttemplatecatalog')(sequelize, Sequelize.DataTypes);
  const { service, calls } = fixture();
  await service.coverage({ clinicId: 72, query: { missing: 'clinical_consent' } });
  const options = calls.find(call => call.name === 'treatmentsPage').options;
  const sql = sequelize.getQueryInterface().queryGenerator.selectQuery(Tratamiento.getTableName(), { ...options, model: Tratamiento }, Tratamiento);
  assert.match(sql, /FROM `Tratamientos` AS `Tratamiento`/);
  assert(sql.includes(`FROM ${catalog.getTableName()} c`));
  assert.doesNotMatch(sql, /LEFT (?:OUTER )?JOIN/);
});
