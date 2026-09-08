'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProtocol, createTreatmentDocumentationService, pagination } = require('../../services/treatmentDocumentation.service');
const Op = { or: Symbol('or'), and: Symbol('and'), in: Symbol('in'), ne: Symbol('ne'), like: Symbol('like') };
const approved = { title: 'Protocolo aportado', kind: 'protocol', status: 'approved', content: 'Texto aportado por el responsable.', source: 'Documento clínico revisado', treatment_ids: [9] };
test('paginación documental es entera, acotada y no admite NaN', () => {
  assert.deepEqual(pagination({}), { page: 0, size: 25 });
  for (const query of [{ page: -1 }, { page: 'bad' }, { page_size: 1.5 }, { page_size: 51 }]) assert.throws(() => pagination(query), { code: 'invalid_documentation_page' });
});
test('ninguna aprobación sin texto y procedencia; borrador puede estar vacío', () => {
  assert.throws(() => normalizeProtocol({ ...approved, content: '' }), { code: 'protocol_approval_incomplete' });
  assert.throws(() => normalizeProtocol({ ...approved, source: '' }), { code: 'protocol_approval_incomplete' });
  assert.equal(normalizeProtocol({ title: 'Pendiente', content: '' }).status, 'draft');
});
test('normalización rechaza tipos/IDs impropios y conserva texto sin inventar contenido', () => {
  assert.throws(() => normalizeProtocol({ ...approved, treatment_ids: [0] }));
  assert.throws(() => normalizeProtocol({ ...approved, kind: 'prescription' }));
  assert.deepEqual(normalizeProtocol({ ...approved, treatment_ids: [9, 9] }), approved);
});
function fixture() {
  const revisions = []; let current = null;
  const row = value => ({ ...value, toJSON() { const { toJSON, update, ...plain } = this; return plain; }, async update(values) { Object.assign(this, values); return this; } });
  const db = {
    Sequelize: { Op, where: () => ({}), fn: () => ({}), col: () => ({}) },
    sequelize: { transaction: async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async () => ({ id_clinica: 72, grupoClinicaId: null }) },
    Tratamiento: { findAll: async () => [{ id_tratamiento: 9, nombre: 'Individual', clinical_config: null }] },
    TreatmentProtocol: {
      findOne: async options => !options.where || Number(options.where.clinic_id) === 72 ? current : null,
      create: async values => { current = row({ ...values, id: 1 }); return current; },
    },
    TreatmentProtocolRevision: { create: async values => { revisions.push(JSON.parse(JSON.stringify(values))); }, findOne: async options => revisions.find(revision => revision.protocol_id === options.where.protocol_id && revision.version === options.where.version) },
  };
  return { db, revisions, service: createTreatmentDocumentationService(db) };
}
test('editar contenido aprobado crea borrador; snapshot aprobado previo no cambia', async () => {
  const { service, revisions } = fixture();
  const first = await service.save({ clinicId: 72, actorId: 1, payload: approved });
  assert.equal(first.item.status, 'approved');
  const second = await service.save({ clinicId: 72, actorId: 1, id: 1, payload: { expected_version: 1, content: 'Contenido revisado' } });
  assert.equal(second.item.status, 'draft');
  assert.equal(second.item.version, 2);
  assert.equal(revisions[0].snapshot.content, approved.content);
  assert.equal(revisions[0].snapshot.status, 'approved');
  assert.equal(second.item.approved_by, null);
  assert.equal((await service.get({ clinicId: 72, id: 1, version: 1 })).item.content, approved.content);
});
test('versionado optimista rechaza sobrescribir y clínica ajena no obtiene documento', async () => {
  const { service, revisions } = fixture();
  await service.save({ clinicId: 72, actorId: 1, payload: approved });
  await assert.rejects(service.save({ clinicId: 72, actorId: 1, id: 1, payload: { expected_version: 0, title: 'Sobrescribir' } }), { code: 'protocol_version_conflict' });
  assert.equal(revisions.length, 1);
  await assert.rejects(service.get({ clinicId: 66, id: 1 }), { code: 'protocol_not_found' });
});
test('biblioteca sin migración comunica 503, no resultados vacíos aparentes', async () => {
  const { db, service } = fixture();
  db.TreatmentProtocol.findOne = async () => { throw Object.assign(new Error('missing'), { original: { code: 'ER_NO_SUCH_TABLE' } }); };
  await assert.rejects(service.list({ clinicId: 72 }), { code: 'documentation_schema_pending', statusCode: 503 });
});
