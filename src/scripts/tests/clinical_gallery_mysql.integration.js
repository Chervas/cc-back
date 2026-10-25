'use strict';
// Owned socket-only MySQL, fictional patients and a private fixture storage root.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.sequelize = sql; db.Sequelize = Sequelize;
  const define = (name, attributes, tableName) => sql.define(name, attributes, { tableName, timestamps: false });
  db.Clinica = define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, 'Clinicas');
  db.Paciente = define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, clinica_id: D.INTEGER }, 'Pacientes');
  db.PacienteClinica = define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, 'PacienteClinicas');
  db.Paciente.belongsTo(db.Clinica, { as: 'clinica', foreignKey: 'clinica_id' });
  db.PatientVoucher = define('PatientVoucher', { id: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, patient_id: D.INTEGER, clinic_id: D.INTEGER, name: D.STRING, treatment_id: D.INTEGER, program_snapshot: D.JSON }, 'PatientVouchers');
  db.AppointmentClinicalReport = define('AppointmentClinicalReport', { id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: D.STRING, patient_id: D.INTEGER, clinic_id: D.INTEGER,
    title: D.STRING, status: D.STRING, occurred_at: D.DATE, version_number: D.INTEGER, material_refs: D.JSON, service_ref: D.JSON, treatment_id: D.INTEGER, appointment_id: D.INTEGER }, 'AppointmentClinicalReports');
  db.ClinicalPrivateAsset = require('../../../models/clinicalprivateasset')(sql, D);
  for (const model of Object.values(db)) if (model.sync) await model.sync();
  const migration = require('../../../migrations/20261025100000-clinical-gallery-pairs-classification');
  await migration.up(sql.getQueryInterface(), Sequelize); await migration.up(sql.getQueryInterface(), Sequelize);
  for (const file of ['clinicalphotopair', 'clinicalphotopairrevision', 'clinicalattachmentlibrarystate', 'clinicalattachmentlibraryrevision']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  await db.Clinica.bulkCreate([{ id_clinica: 72 }, { id_clinica: 73 }]);
  await db.Paciente.bulkCreate([{ id_paciente: 11, public_id: 'fictional-patient', clinica_id: 72 }, { id_paciente: 12, public_id: 'other-patient', clinica_id: 72 }]);
  await db.PacienteClinica.create({ id: 1, paciente_id: 11, clinica_id: 73 });
  await db.PatientVoucher.bulkCreate([{ id: 1, public_id: 'voucher-11', patient_id: 11, clinic_id: 72, name: 'Servicio ficticio' },
    { id: 2, public_id: 'voucher-12', patient_id: 12, clinic_id: 72, name: 'Servicio ajeno' }]);
  const denied = new Set(), calls = [];
  const canAccess = async ({ actorId, clinicId, featureKey }) => { calls.push(featureKey); return !denied.has(featureKey) && Number(clinicId) === 72 && (Number(actorId) === 7 || Number(actorId) === 8 && ['patients.view', 'patients.sensitive.view', 'clinical.reports.view'].includes(featureKey)); };
  const accessFile = require.resolve('../../lib/access-policy'); require.cache[accessFile] = { id: accessFile, filename: accessFile, loaded: true, exports: { canUserAccessFeature: canAccess } };
  process.env.CLINICAL_PRIVATE_STORAGE_ROOT = path.join(report.root, 'owned-clinical-files'); process.env.CLINICAL_PRIVATE_STORAGE_PROVIDER = 'local_private';
  const storage = require('../../services/clinicalPrivateStorage.service'), attachments = require('../../services/patientClinicalAttachments.service');
  const pairs = require('../../services/clinicalPhotoPairs.service').createService({ db, canAccess });
  const gallery = require('../../services/clinicalMaterialGallery.service').createClinicalMaterialGalleryService({ db, canAccess });
  const scope = { patientIdentifier: 'fictional-patient', clinicId: 72, actorId: 7 }, ref = { kind: 'voucher', id: 'voucher-11' };
  const bytes = Buffer.from('PRIVATE_FICTIONAL_ORIGINAL_BYTES');
  const original = (name, patientId = 11, clinicId = 72, metadata = {}) => storage.storeClinicalPrivateAsset({ purpose: 'clinical_attachment', clinicId, patientId, ownerType: 'patient', ownerId: String(patientId), originalFilename: name,
    contentType: 'image/png', buffer: bytes, createdBy: 7, metadata });
  const before = await original('Antes ficticio.png'), after = await original('Después ficticio.png', 11, 72, { classification: 'photo', clinical_context: { service_ref: { ...ref, title: 'Servicio ficticio', area_key: 'general' } } });
  const third = await original('Tercera ficticia.png', 11, 72, { classification: 'test' }), foreign = await original('Otra persona.png', 12), secondary = await original('Otra clínica.png', 11, 73);
  await db.AppointmentClinicalReport.create({ public_id: 'episode-final', patient_id: 11, clinic_id: 72, title: 'Episodio final ficticio', status: 'final', version_number: 3,
    material_refs: [{ kind: 'attachment', id: before.public_id, phase: 'before' }], service_ref: { ...ref, title: 'Servicio ficticio', area_key: 'general' } });
  const payload = { title: 'Comparación ficticia', service_ref: ref, before: { asset_id: before.public_id, episode_id: 'episode-final' }, after: { asset_id: after.public_id }, idempotency_key: 'owned-pair-create' };
  const parallel = await Promise.all([pairs.create({ ...scope, payload }), pairs.create({ ...scope, payload })]);
  assert.equal(parallel.filter(value => value.created).length, 1); assert.equal(await db.ClinicalPhotoPair.count(), 1); assert.equal(await db.ClinicalPhotoPairRevision.count(), 1);
  let item = parallel[0].item; assert.equal(item.version, 1); assert.equal(item.before.episode_version, 3); assert.deepEqual(item.scope.service_ref, ref);
  const id = item.id;
  assert(!JSON.stringify(item).includes('object_key')); assert(!JSON.stringify(item).includes('internal_asset_id'));
  const second = await pairs.create({ ...scope, payload: { ...payload, title: 'Segunda comparación', idempotency_key: 'owned-pair-second' } });
  assert.notEqual(second.item.id, id); assert.equal((await pairs.list(scope)).items.length, 2);
  assert.equal((await pairs.list({ ...scope, query: { scope: 'service', service_ref: JSON.stringify(ref) } })).items.length, 2);
  assert.equal((await pairs.list({ ...scope, query: { scope: 'service', service_ref: JSON.stringify({ kind: 'voucher', id: 'voucher-12' }) } })).items.length, 0);
  await assert.rejects(pairs.create({ ...scope, payload: { ...payload, title: 'Changed', idempotency_key: payload.idempotency_key } }), { code: 'clinical_gallery_request_conflict' });
  for (const data of [{ ...payload, after: { asset_id: foreign.public_id } }, { ...payload, after: { asset_id: secondary.public_id } }, { ...payload, service_ref: { kind: 'voucher', id: 'voucher-12' } }]) await assert.rejects(pairs.create({ ...scope, payload: { ...data, idempotency_key: 'owned-invalid-' + data.after.asset_id } }), { statusCode: 404 });
  await assert.rejects(pairs.create({ ...scope, actorId: 8, payload: { ...payload, idempotency_key: 'owned-readonly' } }), { statusCode: 403 });
  await assert.rejects(pairs.get({ ...scope, patientIdentifier: 12, id }), { statusCode: 404 });
  await assert.rejects(pairs.get({ ...scope, clinicId: 73, id }), { statusCode: 403 });
  assert(!calls.includes('appointments.manage'), 'Clinical gallery does not require agenda management');
  report.checks.push('Multiple private pairs persist; exact create replay serializes on patient lock, tenant and service identities validated, no appointment/economic writes or agenda permission.');

  const change = { expected_version: 1, title: 'Revisada', after: { asset_id: third.public_id }, idempotency_key: 'owned-pair-update' };
  const updates = await Promise.all([pairs.save({ ...scope, id, payload: change }), pairs.save({ ...scope, id, payload: change })]);
  assert.equal(updates.filter(value => value.replayed).length, 1); item = updates[0].item; assert.equal(item.version, 2); assert.equal(item.after.asset_id, third.public_id);
  assert.equal((await pairs.get({ ...scope, id, version: 1 })).item.after.asset_id, after.public_id);
  await assert.rejects(pairs.save({ ...scope, id, payload: { expected_version: 1, title: 'Stale' } }), { code: 'clinical_gallery_version_conflict' });
  const writeRevision = db.ClinicalPhotoPairRevision.create;
  db.ClinicalPhotoPairRevision.create = async () => { throw Error('owned-audit-failure'); };
  await assert.rejects(pairs.save({ ...scope, id, payload: { expected_version: 2, title: 'Must rollback' } }), /owned-audit-failure/);
  db.ClinicalPhotoPairRevision.create = writeRevision; assert.equal((await pairs.get({ ...scope, id })).item.version, 2); assert.equal((await pairs.get({ ...scope, id })).item.title, 'Revisada');
  await assert.rejects(after.destroy(), error => error.name === 'SequelizeForeignKeyConstraintError');
  await assert.rejects((await db.ClinicalPhotoPairRevision.findOne()).update({ change_type: 'changed' }), /clinical_photo_pair_revision_immutable/);
  const archived = await pairs.archive({ ...scope, id, payload: { expected_version: 2, idempotency_key: 'owned-pair-archive' } }); assert.equal(archived.item.archived, true); assert.equal(archived.item.version, 3);
  assert.equal((await pairs.list(scope)).items.length, 1); assert.equal((await pairs.list({ ...scope, query: { status: 'all' } })).items.length, 2);
  assert.equal((await pairs.get({ ...scope, id, version: 1 })).item.archived, false);
  assert.equal((await db.AppointmentClinicalReport.findOne()).version_number, 3, 'Closed episode unchanged');
  report.checks.push('Pair CAS, immutable revisions, archive visibility, original FK preservation (including superseded sides), rollback on audit failure, and final episode immutability.');

  let view = await gallery.read({ ...scope, query: { scope: 'patient' } }); assert.equal(view.items.length, 3); assert.equal(view.items.find(row => row.id === before.public_id).classification, 'unknown');
  assert.equal(view.items.find(row => row.id === after.public_id).episode_id, null); assert.equal(view.items.find(row => row.id === after.public_id).service_title, 'Servicio ficticio');
  assert.equal((await gallery.read({ ...scope, query: { scope: 'service', service_ref: JSON.stringify(ref) } })).items.length, 2);
  assert.equal((await gallery.read({ ...scope, query: { scope: 'patient', classification: 'test' } })).items.length, 1);
  const page = await gallery.read({ ...scope, query: { scope: 'patient', limit: 1 } }); assert.equal(page.items.length, 1); assert(page.next_cursor);
  const next = await gallery.read({ ...scope, query: { scope: 'patient', limit: 1, cursor: page.next_cursor } }); assert.notEqual(next.items[0].id, page.items[0].id);
  await assert.rejects(gallery.read({ ...scope, query: { scope: 'patient', classification: 'photo', cursor: page.next_cursor } }), { code: 'clinical_gallery_cursor' });
  const classified = await pairs.classifyAttachment({ ...scope, id: before.public_id, payload: { expected_version: 1, classification: 'photo', idempotency_key: 'owned-classify' } }); assert.equal(classified.item.library_version, 2);
  assert.equal((await pairs.classifyAttachment({ ...scope, id: before.public_id, payload: { expected_version: 1, classification: 'photo', idempotency_key: 'owned-classify' } })).replayed, true);
  await assert.rejects(pairs.archiveAttachment({ ...scope, id: before.public_id, payload: { expected_version: 1 } }), { code: 'clinical_gallery_version_conflict' });
  const libraryArchive = { expected_version: 2, idempotency_key: 'owned-library-archive' };
  await pairs.archiveAttachment({ ...scope, id: before.public_id, payload: libraryArchive });
  assert.equal((await pairs.archiveAttachment({ ...scope, id: before.public_id, payload: libraryArchive })).replayed, true);
  assert.equal((await gallery.read({ ...scope, query: { scope: 'patient' } })).items.length, 2);
  assert.equal((await attachments.listPatientClinicalAttachments('11', 7, { clinic_id: 72 })).items.length, 2);
  assert.deepEqual((await attachments.readPatientClinicalAttachment('11', before.public_id, 7)).buffer, bytes);
  assert.equal((await db.ClinicalPrivateAsset.findByPk(before.id)).status, 'active'); assert.deepEqual((await db.ClinicalPrivateAsset.findByPk(before.id)).metadata, {});
  assert.equal((await pairs.get({ ...scope, id, version: 1 })).item.before.asset_id, before.public_id);
  await assert.rejects(pairs.create({ ...scope, payload: { ...payload, idempotency_key: 'owned-archived-source' } }), { code: 'clinical_gallery_asset_archived' });
  const originalWrite = db.ClinicalAttachmentLibraryRevision.create;
  db.ClinicalAttachmentLibraryRevision.create = async () => { throw Error('owned-library-audit-failure'); };
  await assert.rejects(pairs.classifyAttachment({ ...scope, id: third.public_id, payload: { expected_version: 1, classification: 'photo' } }), /owned-library-audit-failure/);
  db.ClinicalAttachmentLibraryRevision.create = originalWrite; assert.equal(await db.ClinicalAttachmentLibraryState.findByPk(third.id), null);
  denied.add('patients.edit'); await assert.rejects(pairs.archiveAttachment({ ...scope, id: after.public_id, payload: { expected_version: 1 } }), { statusCode: 403 }); denied.delete('patients.edit');
  report.checks.push('Library classification explicit and filterable, old unknown safe, patient originals without episode included, service scope exact, cursor bound to filters. Archive hides library only; private bytes/hash and final episode/history survive, audit transaction atomic.');

  const nutrition = await db.ClinicalPrivateAsset.create({ public_id: 'nutrition-private', clinic_id: 72, patient_id: 11, scope_type: 'clinic', purpose: 'nutrition_clinical_photo', provider: 'local_private', bucket: 'owned', object_key: 'PRIVATE_OBJECT', content_type: 'image/png', sha256: 'a'.repeat(64), status: 'active' });
  const restricted = await pairs.create({ ...scope, payload: { before: { asset_id: nutrition.public_id }, after: { asset_id: after.public_id }, idempotency_key: 'owned-purpose-specific' } });
  denied.add('nutrition.workspace.view'); await assert.rejects(pairs.get({ ...scope, id: restricted.item.id }), { statusCode: 403 }); assert(!(await pairs.list(scope)).items.some(row => row.id === restricted.item.id)); denied.delete('nutrition.workspace.view');
  // Existing sides are snapshots: editing only the pair title after removing
  // an attachment from an open episode neither fails nor repins that side.
  const draftSource = await db.AppointmentClinicalReport.create({ public_id: 'episode-draft-source', patient_id: 11, clinic_id: 72, title: 'Consulta abierta ficticia', status: 'draft', version_number: 1,
    material_refs: [{ kind: 'attachment', id: after.public_id }] });
  const fixed = await pairs.create({ ...scope, payload: { before: { asset_id: after.public_id, episode_id: draftSource.public_id }, after: { asset_id: third.public_id }, idempotency_key: 'owned-fixed-episode-snapshot' } });
  await draftSource.update({ version_number: 2, material_refs: [] });
  const renamed = await pairs.save({ ...scope, id: fixed.item.id, payload: { title: 'Sólo título nuevo', expected_version: 1,
    before: { asset_id: fixed.item.before.asset_id, episode_id: fixed.item.before.episode_id }, after: { asset_id: fixed.item.after.asset_id, episode_id: fixed.item.after.episode_id }, idempotency_key: 'owned-fixed-episode-rename' } });
  assert.equal(renamed.item.before.episode_version, 1); assert.equal(renamed.item.before.episode_id, draftSource.public_id);
  assert.equal((await pairs.get({ ...scope, id: fixed.item.id, version: 1 })).item.title, 'Antes y después');
  report.checks.push('Unchanged comparison sides retain their exact episode snapshot during a title edit, even after the original is unlinked from a later draft revision. Current asset ACL remains enforced.');
  const mismatchedOriginal = await db.ClinicalPrivateAsset.create({ public_id: 'other-service-original', clinic_id: 72, patient_id: 11, scope_type: 'clinic', purpose: 'clinical_attachment', provider: 'local_private', bucket: 'owned', object_key: 'PRIVATE_OTHER', content_type: 'image/png', sha256: 'c'.repeat(64), status: 'active', metadata: { clinical_context: { service_ref: { kind: 'voucher', id: 'voucher-other' } } } });
  await assert.rejects(pairs.create({ ...scope, payload: { service_ref: ref, before: { asset_id: mismatchedOriginal.public_id }, after: { asset_id: after.public_id }, idempotency_key: 'owned-wrong-original-service' } }), { code: 'clinical_photo_pair_service_mismatch' });
  report.checks.push('An original already attributed to a different canonical service cannot be silently reassigned by creating a comparison without an episode.');
  const originalBytes = await fs.readFile(path.join(process.env.CLINICAL_PRIVATE_STORAGE_ROOT, before.object_key)); assert.deepEqual(originalBytes, bytes);
  report.checks.push('Purpose-specific access independently rechecked for comparison source originals; revoked purpose cannot leak titles or historical pair details. Migration repeat safe, selected schema only, no historical backfill.');
}).catch(error => { console.error(error); process.exitCode = 1; });
