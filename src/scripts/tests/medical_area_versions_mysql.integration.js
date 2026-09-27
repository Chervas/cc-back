'use strict';

const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20260926180000-version-medical-area-contracts');
const adoptionMigration = require('../../../migrations/20260927103000-create-medical-area-adoptions');
const { verifyAdoptionSchema, run: schemaRelease } = require('../medical-area-schema-release');
const { createMedicalAreaContractsService, getKnownCodes, contractHash } = require('../../services/medicalAreaContracts.service');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
    configuracion: D.JSON }, { tableName: 'Clinicas', timestamps: false });
  await models.Clinica.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 1, nombre_clinica: 'Clínica ficticia A', configuracion: { disciplinas: ['nutricion'], preserved: 'local' } },
    { id_clinica: 2, nombre_clinica: 'Clínica ficticia B', configuracion: { disciplinas: ['dental'] } }]);
  await qi.createTable('PatientNutritionMeasurements', { id: { type: D.INTEGER, primaryKey: true } });
  const legacy = require('../../../models/medicalareacontract')(sql, D);
  legacy.removeAttribute('revision_id'); await legacy.sync();
  await legacy.create({ code: 'dental', contract_json: { profile: { defaultDuration: 55 } }, version: 'custom-v1', active: true });
  await migration.up(qi); await migration.up(qi);
  await adoptionMigration.up(qi); await adoptionMigration.up(qi);
  assert.equal(Number((await verifyAdoptionSchema(sql, qi)).adoptions), 0);
  await assert.rejects(verifyAdoptionSchema(sql, {
    describeTable: qi.describeTable.bind(qi), showIndex: async () => [],
  }), /AREA_ADOPTION_INDEX_VERIFICATION_FAILED/);
  await schemaRelease(['--migration', '../not-approved.js']).then(() => assert.fail('arbitrary migration accepted'),
    error => assert.equal(error.message, 'AREA_SCHEMA_MIGRATION_NOT_ALLOWED'));
  for (const file of ['medicalareacontract', 'medicalareacontractrevision', 'clinicmedicalareacontract', 'medicalareaadoption']) {
    const model = require('../../../models/' + file)(sql, D); models[model.name] = model;
  }
  models.MedicalAreaContract.associate(models);
  models.ClinicMedicalAreaContract.associate(models);
  const service = createMedicalAreaContractsService(models);
  async function adoptReviewed(clinic, code, options) {
    const review = await service.reviewClinicRevision(clinic, code, options.revisionId);
    return service.adoptClinicRevision(clinic, code, { ...options, reviewHash: review.review_hash,
      acknowledged: true, reason: 'Revisión ficticia de integración' });
  }
  const heads = models.MedicalAreaContract, revisions = models.MedicalAreaContractRevision, pins = models.ClinicMedicalAreaContract;
  const codes = getKnownCodes();
  assert.equal(await revisions.count(), codes.length);
  assert.equal(await pins.count(), codes.length * 2);
  const before = await service.getContractForArea('nutricion', { clinicId: 1 });
  assert.equal(before.profile.defaultDuration, 45);
  assert.equal((await service.getContractForArea('dental', { clinicId: 1 })).profile.defaultDuration, 55);
  assert.equal(before.revision.number, 1);
  const response = await service.getMedicalAreaContracts({ clinicId: 1 });
  assert.equal(response.configuration_scope, 'clinic');
  assert.equal(response.clinic_id, 1);
  report.checks.push('DDL and initialization replay preserve the effective legacy override and freeze all areas for both existing clinics');

  const noChange = await service.upsertMedicalAreaContract('nutricion', before, 10, { expectedRevisionId: before.revision.id });
  assert.deepEqual(noChange, before, 'saving a baseline snapshot unchanged must not run a newer normalizer');
  assert.equal(await revisions.count(), codes.length);

  const payload = { ...before, profile: { ...before.profile, defaultDuration: 65 } };
  const next = await service.upsertMedicalAreaContract('nutricion', payload, 10, { expectedRevisionId: before.revision.id });
  assert.equal(next.revision.number, 2);
  assert.equal((await service.getContractForArea('nutricion')).profile.defaultDuration, 65);
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 1 }), before);
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 2 }), before);
  assert.deepEqual(await service.getRecordedContract('nutricion', before.revision.id), before);
  assert.deepEqual(await service.getRecordedContract('nutricion'), before);
  await migration.up(qi);
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 1 }), before);
  assert.equal((await service.getContractForArea('nutricion')).revision.id, next.revision.id);
  const repeated = await service.upsertMedicalAreaContract('nutricion', payload, 10, { expectedRevisionId: next.revision.id });
  assert.deepEqual(repeated, next);
  assert.equal(await revisions.count(), codes.length + 1);
  report.checks.push('Publishing and migration replay do not update existing clinics; identical save is idempotent');

  await sql.transaction(async transaction => {
    await models.Clinica.create({ id_clinica: 3 }, { transaction });
    await service.initializeClinic(3, { transaction, actorId: 10 });
  });
  assert.equal((await service.getContractForArea('nutricion', { clinicId: 3 })).revision.id, next.revision.id);
  await assert.rejects(sql.transaction(async transaction => {
    await models.Clinica.create({ id_clinica: 4 }, { transaction });
    await service.initializeClinic(4, { transaction, actorId: 10 });
    throw Error('fictitious_onboarding_failure');
  }), /fictitious_onboarding_failure/);
  assert.equal(await models.Clinica.findByPk(4), null);
  assert.equal(await pins.count({ where: { clinic_id: 4 } }), 0);
  await assert.rejects(service.getMedicalAreaContracts({ clinicId: 99 }), { code: 'medical_area_configuration_not_initialized' });
  await assert.rejects(service.initializeClinic(3), { code: 'medical_area_initialization_requires_transaction' });
  report.checks.push('Onboarding selects published revisions atomically; failed onboarding rolls back clinic and pins; missing scope never falls back to latest');

  const overview = await service.listClinicVersions({ search: 'ficticia', pageSize: 1 });
  assert.equal(overview.total, 2); assert.equal(overview.items.length, 1);
  assert.equal(overview.items[0].updates_available, 1);
  assert.equal(overview.items[0].areas.find(a => a.code === 'nutricion').current_revision.id, before.revision.id);
  const review = await service.reviewClinicRevision(1, 'nutricion', next.revision.id);
  assert.equal(review.compatible, true); assert.equal(review.can_apply, true);
  assert(review.changes.some(c => c.key === 'profile'));
  const reviewedOptions = { revisionId: next.revision.id, expectedRevisionId: before.revision.id, actorId: 10,
    reviewHash: review.review_hash, acknowledged: true, reason: 'Revisión ficticia' };
  await assert.rejects(service.adoptClinicRevision(1, 'nutricion', { ...reviewedOptions, acknowledged: false }), { code: 'medical_area_review_required' });
  await assert.rejects(service.adoptClinicRevision(1, 'nutricion', { ...reviewedOptions, reviewHash: '0'.repeat(64) }), { code: 'medical_area_review_stale' });
  await assert.rejects(service.adoptClinicRevision(1, 'nutricion', { ...reviewedOptions, reason: '' }), { code: 'medical_area_reason_required' });
  await models.Clinica.update({ configuracion: { disciplinas: ['nutricion'], preserved: 'new local value' } }, { where: { id_clinica: 1 } });
  await assert.rejects(service.adoptClinicRevision(1, 'nutricion', reviewedOptions), { code: 'medical_area_review_stale' });
  assert.equal(await models.MedicalAreaAdoption.count(), 0);
  const adopted = await adoptReviewed(1, 'nutricion', { revisionId: next.revision.id, expectedRevisionId: before.revision.id, actorId: 10 });
  assert.deepEqual(adopted, next);
  assert.equal((await pins.findOne({ where: { clinic_id: 1, code: 'nutricion' } })).previous_revision_id, before.revision.id);
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 2 }), before);
  await assert.rejects(adoptReviewed(1, 'nutricion', { revisionId: before.revision.id, expectedRevisionId: before.revision.id, actorId: 10 }), { code: 'medical_area_revision_conflict' });
  const dental = await service.getContractForArea('dental');
  await assert.rejects(adoptReviewed(1, 'nutricion', { revisionId: dental.revision.id, expectedRevisionId: next.revision.id, actorId: 10 }), { code: 'medical_area_revision_scope_mismatch' });
  await adoptReviewed(1, 'nutricion', { revisionId: before.revision.id, expectedRevisionId: next.revision.id, actorId: 10 });
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 1 }), before);
  report.checks.push('Explicit adoption and reversal are clinic/area scoped with optimistic concurrency and retained old revisions');
  const history = await service.getClinicRevisionHistory(1, 'nutricion');
  assert.equal(history.items.length, 2); assert.equal(history.items[0].actor_id, 10);
  assert.equal((await models.Clinica.findByPk(1)).configuracion.preserved, 'new local value');
  await assert.rejects(models.MedicalAreaAdoption.destroy({ where: { clinic_id: 1 } }), /medical_area_adoption_immutable/);
  const record = models.MedicalAreaAdoption.create;
  models.MedicalAreaAdoption.create = async () => { throw Error('fictitious_journal_failure'); };
  await assert.rejects(adoptReviewed(1, 'nutricion', { revisionId: next.revision.id, expectedRevisionId: before.revision.id, actorId: 10 }), /fictitious_journal_failure/);
  models.MedicalAreaAdoption.create = record;
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 1 }), before);
  assert.equal(await models.MedicalAreaAdoption.count(), 2);
  report.checks.push('Review rejects missing acknowledgement, stale local configuration and forged review hash; immutable journal and assignment commit atomically');

  const concurrent = await Promise.allSettled([70, 75].map(duration => service.upsertMedicalAreaContract('nutricion', {
    ...next, profile: { ...next.profile, defaultDuration: duration },
  }, 10, { expectedRevisionId: next.revision.id })));
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(r => r.status === 'rejected').reason.code, 'medical_area_revision_conflict');
  assert.equal(await revisions.count(), codes.length + 2);
  const current = await service.getContractForArea('nutricion');
  await assert.rejects(service.upsertMedicalAreaContract('nutricion', current, 10), { code: 'medical_area_revision_required' });
  await assert.rejects(service.upsertMedicalAreaContract('nutricion', { ...current, code: 'dental' }, 10, { expectedRevisionId: current.revision.id }), { code: 'medical_area_code_mismatch' });
  await assert.rejects(service.upsertMedicalAreaContract('nutricion', { ...current,
    nutrition_measurement_fields: { weight_kg: { unit: 'lb' } },
  }, 10, { expectedRevisionId: current.revision.id }), { code: 'medical_area_measurement_unit_fixed:weight_kg' });
  const old = await revisions.findByPk(before.revision.id);
  await assert.rejects(old.update({ content_hash: 'bad' }), /medical_area_revision_immutable/);
  await assert.rejects(revisions.destroy({ where: { id: old.id } }), /medical_area_revision_immutable/);
  await assert.rejects(migration.down(qi), /Preserve medical area/);
  report.checks.push('Concurrent publication has one winner; stale clients, code substitution, unit changes and destructive rollback are rejected');

  // Simulate a future application default without rewriting the persisted revision.
  const definitions = require('../../lib/medical-area-contracts');
  const base = definitions.getBaseContractForArea;
  definitions.getBaseContractForArea = () => { throw Error('must_not_merge_new_defaults'); };
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 2 }), before);
  definitions.getBaseContractForArea = base;
  const originalJson = old.contract_json;
  await sql.query('UPDATE MedicalAreaContractRevisions SET content_hash = :bad WHERE id = :id', { replacements: { bad: '0'.repeat(64), id: old.id } });
  await assert.rejects(service.getContractForArea('nutricion', { clinicId: 2 }), { code: 'medical_area_revision_corrupt' });
  await sql.query('UPDATE MedicalAreaContractRevisions SET content_hash = :hash WHERE id = :id', { replacements: { hash: contractHash(originalJson), id: old.id } });
  assert.deepEqual(await service.getContractForArea('nutricion', { clinicId: 2 }), before);
  report.checks.push('Runtime never re-normalizes pinned snapshots and detects stored-content corruption without fallback');

  const general = await service.getContractForArea('general');
  const custom = await service.upsertMedicalAreaContract('dermatologia', { ...general, code: 'dermatologia',
    profile: { ...general.profile, label: 'Dermatología' } }, 10, { expectedRevisionId: general.revision.id });
  assert.equal(custom.code, 'dermatologia'); assert.equal(custom.revision.number, 1);
  assert.equal((await service.getMedicalAreaContracts({ clinicId: 2 })).contracts.dermatologia, undefined);
  await adoptReviewed(2, 'dermatologia', { revisionId: custom.revision.id, expectedRevisionId: null, actorId: 10 });
  assert.deepEqual(await service.getContractForArea('dermatologia', { clinicId: 2 }), custom);
  await migration.up(qi);
  assert.equal((await service.getMedicalAreaContracts({ clinicId: 1 })).contracts.dermatologia, undefined);
  report.checks.push('Custom areas publish from the pinned generic template and are adopted only by an explicitly selected clinic');
  const brokenPayload = { ...current, patient_workspace: { ...current.patient_workspace, enabled: false } };
  const incompatible = await service.upsertMedicalAreaContract('nutricion', brokenPayload, 10, { expectedRevisionId: current.revision.id });
  const incompatibleReview = await service.reviewClinicRevision(1, 'nutricion', incompatible.revision.id);
  // A new default may exist for new clinics, but a destructive adoption needs a migration.
  assert.equal(incompatibleReview.compatible, false);
  await assert.rejects(adoptReviewed(1, 'nutricion', { revisionId: incompatible.revision.id, expectedRevisionId: before.revision.id, actorId: 10 }), { code: 'medical_area_update_incompatible' });
  const prepared = await service.reviewClinicRevision(1, 'nutricion', next.revision.id);
  const raceOptions = { revisionId: next.revision.id, expectedRevisionId: before.revision.id, actorId: 10,
    reviewHash: prepared.review_hash, acknowledged: true, reason: 'Prueba de adopción concurrente' };
  const races = await Promise.allSettled([service.adoptClinicRevision(1, 'nutricion', raceOptions), service.adoptClinicRevision(1, 'nutricion', raceOptions)]);
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(races.find(r => r.status === 'rejected').reason.code, 'medical_area_revision_conflict');
  assert.equal(await models.MedicalAreaAdoption.count({ where: { clinic_id: 1 } }), 3);
  report.checks.push('Incompatible adoption cannot be forced; concurrent adoption has one winner and exactly one additional journal record');
  await assert.rejects(service.listClinicVersions({ pageSize: 500 }), { code: 'medical_area_pagination_invalid' });
  await assert.rejects(service.reviewClinicRevision(99, 'nutricion'), { code: 'medical_area_clinic_not_found' });
  await assert.rejects(adoptionMigration.down(), /Preserve medical area/);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
