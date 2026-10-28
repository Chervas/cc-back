'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getBaseContractForArea, getKnownCodes, normalizeContractPayload,
  createMedicalAreaContractsService, contractHash,
} = require('../../services/medicalAreaContracts.service');
const { mergeClinicConfiguration } = require('../../lib/clinic-configuration');

const clone = value => structuredClone(value);
const activeAreas = ['estetica', 'nutricion', 'cirugia_digestiva', 'psicologia', 'capilar'];

// In-memory persistence only: exercise the real publication/review/adoption
// services without loading application models, credentials or a database.
function fixture() {
  const revisions = [], heads = [], pins = [], journal = [];
  const clinic = { id_clinica: 72, nombre_clinica: 'Clínica ficticia',
    configuracion: { disciplinas: [...activeAreas], preserved: 'local' } };
  const mutable = value => Object.assign(value, { async update(patch) { Object.assign(this, patch); return this; } });
  for (const code of ['general', ...activeAreas]) {
    const contract = clone(getBaseContractForArea(code));
    if (code === 'estetica') contract.profile.label = 'Estética';
    const revision = { id: revisions.length + 1, code, revision_number: 1,
      contract_json: contract, content_hash: contractHash(contract) };
    revisions.push(revision);
    heads.push(mutable({ code, active: true, revision_id: revision.id }));
    pins.push(mutable({ clinic_id: 72, code, revision_id: revision.id }));
  }
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  const withRevision = row => ({ ...row, revision: revisions.find(r => r.id === row.revision_id) });
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async id => id === clinic.id_clinica ? clinic : null },
    MedicalAreaContract: {
      findAll: async options => heads.filter(row => matches(row, options.where)).map(row => options.include ? withRevision(row) : row),
      findOne: async options => heads.find(row => matches(row, options.where)),
      create: async value => { const row = mutable(clone(value)); heads.push(row); return row; },
    },
    MedicalAreaContractRevision: {
      findByPk: async id => revisions.find(row => row.id === id),
      findOne: async options => revisions.find(row => matches(row, options.where)),
      create: async value => { const row = { ...clone(value), id: revisions.length + 1 }; revisions.push(row); return row; },
    },
    ClinicMedicalAreaContract: {
      findAll: async options => pins.filter(row => matches(row, options.where)).map(withRevision),
      findOne: async options => pins.find(row => matches(row, options.where)),
      create: async value => { const row = mutable(clone(value)); pins.push(row); return row; },
    },
    MedicalAreaAdoption: { create: async value => { journal.push(clone(value)); return value; } },
  };
  return { service: createMedicalAreaContractsService(models), revisions, heads, pins, journal, clinic };
}

test('aesthetic surgery and aesthetic medicine remain distinct from digestive surgery', () => {
  for (const code of ['estetica', 'cirugia_estetica', 'cirugia_digestiva']) assert(getKnownCodes().includes(code));
  const surgery = normalizeContractPayload('cirugia_estetica', {});
  assert.equal(surgery.code, 'cirugia_estetica');
  assert.equal(surgery.profile.label, 'Cirugía estética');
  assert.equal(surgery.profile.defaultCategory, 'Consulta de cirugía estética');
  assert.equal(surgery.profile.supportsPiece, false);
  assert.equal(surgery.profile.supportsLaboratory, false);
  assert.equal(surgery.patient_workspace.enabled, false);
  assert.equal(surgery.appointment_action.enabled, false);
  assert.deepEqual(surgery.protocol_rules, []);
  assert.deepEqual(surgery.nutrition_measurement_fields, {});
  assert.equal(getBaseContractForArea('estetica').profile.label, 'Medicina estética');
  assert.equal(getBaseContractForArea('cirugia_digestiva').profile.label, 'Cirugía General y Digestiva');
  assert.equal(getBaseContractForArea('cirugia_digestiva').profile.defaultCategory, 'Consulta quirúrgica');
});

test('publishing the medicine label leaves the clinic and historical revision unchanged until reviewed adoption', async () => {
  const f = fixture(), before = await f.service.getMedicalAreaContracts({ clinicId: 72 });
  const old = clone(before.contracts.estetica), history = clone(f.revisions), config = clone(f.clinic.configuracion);
  assert.equal(old.profile.label, 'Estética', 'reading a pin must not apply the new code default');
  const payload = clone(old); delete payload.revision;
  payload.profile.label = 'Medicina estética';
  const published = await f.service.upsertMedicalAreaContract('estetica', payload, 1, { expectedRevisionId: old.revision.id });
  assert.equal(published.revision.number, 2);
  const { revision, ...snapshot } = published;
  assert.deepEqual(snapshot, payload, 'the full submitted revision changes only its label');
  assert.deepEqual(await f.service.getMedicalAreaContracts({ clinicId: 72 }), before);
  assert.deepEqual(f.revisions.slice(0, history.length), history);
  const review = await f.service.reviewClinicRevision(72, 'estetica', revision.id);
  assert.equal(review.compatible, true);
  assert.deepEqual(review.changes.flatMap(change => change.fields.map(field => field.path)), ['label']);
  await f.service.adoptClinicRevision(72, 'estetica', { revisionId: revision.id, expectedRevisionId: old.revision.id,
    actorId: 1, reviewHash: review.review_hash, acknowledged: true, reason: 'Actualizar etiqueta del área' });
  const after = await f.service.getMedicalAreaContracts({ clinicId: 72 });
  assert.deepEqual(after.contracts.estetica, published);
  for (const code of ['general', ...activeAreas.filter(code => code !== 'estetica')]) {
    assert.deepEqual(after.contracts[code], before.contracts[code]);
  }
  assert.deepEqual(await f.service.getRecordedContract('estetica', old.revision.id), old);
  assert.deepEqual(f.clinic.configuracion, config);
  assert.equal(f.journal.length, 1);
});

test('first publication uses general CAS and initial adoption adds just the missing clinic pin before activation', async () => {
  const f = fixture(), before = await f.service.getMedicalAreaContracts({ clinicId: 72 });
  const config = clone(f.clinic.configuracion), history = clone(f.revisions);
  const payload = clone(getBaseContractForArea('cirugia_estetica'));
  const generalId = before.contracts.general.revision.id;
  await assert.rejects(f.service.upsertMedicalAreaContract('cirugia_estetica', payload, 1,
    { expectedRevisionId: before.contracts.estetica.revision.id }), { code: 'medical_area_revision_conflict' });
  const published = await f.service.upsertMedicalAreaContract('cirugia_estetica', payload, 1, { expectedRevisionId: generalId });
  assert.equal(published.revision.number, 1);
  assert.deepEqual(await f.service.getMedicalAreaContracts({ clinicId: 72 }), before);
  const review = await f.service.reviewClinicRevision(72, 'cirugia_estetica', published.revision.id);
  assert.equal(review.current_revision, null);
  assert.equal(review.direction, 'initial');
  assert.equal(review.enabled_in_clinic, false);
  assert.equal(review.can_apply, true);
  const request = { revisionId: published.revision.id, expectedRevisionId: null,
    actorId: 1, reviewHash: review.review_hash, acknowledged: true, reason: 'Preparar nueva área sin retirar las actuales' };
  await assert.rejects(f.service.adoptClinicRevision(72, 'cirugia_estetica', { ...request, expectedRevisionId: generalId }),
    { code: 'medical_area_revision_conflict' });
  await f.service.adoptClinicRevision(72, 'cirugia_estetica', request);
  const after = await f.service.getMedicalAreaContracts({ clinicId: 72 });
  assert.deepEqual(after.contracts, { ...before.contracts, cirugia_estetica: published });
  assert.deepEqual(f.clinic.configuracion, config, 'adoption must not activate, remove or sort clinic areas');
  assert.deepEqual(f.revisions.slice(0, history.length), history);
  assert.equal(f.journal.length, 1);
  assert.equal(f.journal[0].previous_revision_id, null);
  assert.equal(f.pins.filter(pin => pin.code === 'cirugia_estetica').length, 1);
  // Use the same configuration merge as the subsequent clinic PATCH.
  f.clinic.configuracion = mergeClinicConfiguration(f.clinic.configuracion,
    { disciplinas: [...activeAreas, 'cirugia_estetica'] });
  const enabled = await f.service.reviewClinicRevision(72, 'cirugia_estetica', published.revision.id);
  assert.equal(enabled.enabled_in_clinic, true);
  assert.equal(enabled.can_apply, false);
  assert.deepEqual(f.clinic.configuracion.disciplinas, [...activeAreas, 'cirugia_estetica']);
  assert.equal(f.clinic.configuracion.preserved, 'local');
});
