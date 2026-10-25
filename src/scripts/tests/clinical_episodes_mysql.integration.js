'use strict';
const assert = require('node:assert/strict'), { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const C = require('../../lib/clinical-episode-contract');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const define = (name, fields, tableName, options = {}) => sql.define(name, fields, { tableName, timestamps: false, ...options });
  db.Sequelize = Sequelize;
  db.Clinica = define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, configuracion: D.JSON }, 'Clinicas');
  db.SequelizeMeta = define('SequelizeMeta', { name: { type: D.STRING, primaryKey: true } }, 'SequelizeMeta');
  db.Paciente = define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, clinica_id: D.INTEGER }, 'Pacientes');
  db.PacienteClinica = define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, 'PacientesClinicas');
  db.CitaPaciente = define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, paciente_id: D.INTEGER,
    doctor_id: D.INTEGER, tratamiento_id: D.INTEGER, titulo: D.STRING, motivo: D.STRING, inicio: D.DATE, fin: D.DATE,
    estado: D.STRING, voucher_id: D.INTEGER, es_provisional: D.BOOLEAN }, 'CitasPacientes');
  db.Tratamiento = define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING }, 'Tratamientos');
  db.Usuario = define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING }, 'Usuarios');
  db.ClinicalPrivateAsset = define('ClinicalPrivateAsset', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, public_id: D.STRING,
    clinic_id: D.INTEGER, patient_id: D.INTEGER, scope_type: D.STRING, status: D.STRING, purpose: D.STRING,
    original_filename: D.STRING, content_type: D.STRING, sha256: D.STRING }, 'ClinicalPrivateAssets');
  // Deliberately start with the old schema and a real immutable old revision.
  const OldReport = define('AppointmentClinicalReport', {
    id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: D.STRING(36), unique: true, allowNull: false },
    clinic_id: D.INTEGER, patient_id: D.INTEGER, appointment_id: { type: D.INTEGER, allowNull: false, unique: true,
      references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'CASCADE' },
    treatment_id: D.INTEGER, professional_id: D.INTEGER, status: D.STRING(20), version_number: D.INTEGER.UNSIGNED,
    ...Object.fromEntries(C.TEXT_FIELDS.map(key => [key, key === 'reason' ? D.STRING(500) : D.TEXT])),
    finalized_at: D.DATE, finalized_by: D.INTEGER, created_by: D.INTEGER, updated_by: D.INTEGER,
  }, 'AppointmentClinicalReports', { timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  const OldRevision = define('AppointmentClinicalReportRevision', {
    id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, report_id: D.BIGINT.UNSIGNED,
    version_number: D.INTEGER.UNSIGNED, status: D.STRING(20), snapshot: D.JSON, change_type: D.STRING(20), actor_id: D.INTEGER,
  }, 'AppointmentClinicalReportRevisions', { timestamps: true, createdAt: 'created_at', updatedAt: false });
  await sql.sync();
  await db.SequelizeMeta.create({ name: 'owned-baseline.js' });
  await db.Clinica.bulkCreate([{ id_clinica: 72 }, { id_clinica: 73 }]);
  await db.Paciente.bulkCreate([{ id_paciente: 1, public_id: 'owned-patient', clinica_id: 72 }, { id_paciente: 2, public_id: 'other-patient', clinica_id: 73 }]);
  await db.Usuario.create({ id_usuario: 7, nombre: 'Profesional', apellidos: 'Ficticio' });
  await db.Tratamiento.create({ id_tratamiento: 20, nombre: 'Tratamiento ficticio' });
  await db.CitaPaciente.bulkCreate(Array.from({ length: 20 }, (_, index) => ({ id_cita: 101 + index, clinica_id: 72, paciente_id: 1,
    doctor_id: 7, tratamiento_id: 20, titulo: 'Reserva ficticia ' + index, inicio: new Date(`2026-10-${String(index >= 1 && index <= 4 ? 2 : index + 1).padStart(2, '0')}T${String(10 + (index >= 1 && index <= 4 ? index : 0)).padStart(2, '0')}:00:00Z`),
    fin: new Date(`2026-10-${String(index >= 1 && index <= 4 ? 2 : index + 1).padStart(2, '0')}T${String(10 + (index >= 1 && index <= 4 ? index : 0)).padStart(2, '0')}:30:00Z`), estado: 'pendiente', voucher_id: 99, es_provisional: false })));
  await db.CitaPaciente.create({ id_cita: 201, clinica_id: 73, paciente_id: 2, titulo: 'Reserva de otro ámbito', inicio: new Date(), fin: new Date(), estado: 'pendiente' });
  const old = await OldReport.create({ public_id: 'legacy-report', clinic_id: 72, patient_id: 1, appointment_id: 101,
    treatment_id: 20, professional_id: 7, status: 'final', version_number: 1, summary: 'Narrativa histórica exacta', plan: 'Plan histórico',
    private_notes: 'Nota privada histórica', created_by: 7, updated_by: 7, finalized_at: new Date('2026-10-01T11:00:00Z') });
  const originalSnapshot = { public_id: 'legacy-report', summary: 'Narrativa histórica exacta', status: 'final', private_notes: 'Nota privada histórica' };
  await OldRevision.create({ report_id: old.id, version_number: 1, status: 'final', snapshot: originalSnapshot, change_type: 'created', actor_id: 7 });
  const legacyBefore = await OldReport.findByPk(old.id, { raw: true });
  const schemaCut = require('../clinical-workspace-schema-release');
  // Only the identity SELECT is stubbed for this owned mysqld. Every metadata
  // query/DDL runs against its actual temporary schema and Unix socket.
  const metadataSql = { query: (query, options) => query.startsWith('SELECT DATABASE()')
    ? Promise.resolve([[{ database_name: 'clinicaclick_dev_isolated', database_user: 'cc_dev_api@localhost', server_name: 'owned-fixture', fictional_anchor: 1 }]])
    : sql.query(query, options) };
  const releaseBefore = await schemaCut.capture(metadataSql); schemaCut.assertUnapplied(releaseBefore);
  const migration = require('../../../migrations/20261020193000-clinical-episodes-foundation');
  await migration.up(sql.getQueryInterface(), Sequelize);
  await migration.up(sql.getQueryInterface(), Sequelize);
  for (const file of ['appointmentclinicalreport', 'appointmentclinicalreportrevision', 'clinicalepisodeappointment']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  // This suite verifies only the two original foundation migrations. Later
  // additive fields have their own full-schema integration suites.
  for (const field of ['template_snapshot', 'form_data', 'diagnoses', 'service_ref']) db.AppointmentClinicalReport.removeAttribute(field);
  const R = db.AppointmentClinicalReport, V = db.AppointmentClinicalReportRevision, L = db.ClinicalEpisodeAppointment;
  const migrated = await R.findByPk(old.id, { raw: true });
  for (const key of Object.keys(legacyBefore)) assert.deepEqual(migrated[key], legacyBefore[key]);
  assert.equal(migrated.rich_document, null); assert.equal(migrated.material_refs, null); assert.equal(migrated.title, null);
  assert.deepEqual((await V.findOne({ where: { report_id: old.id } })).snapshot, originalSnapshot);
  await assert.rejects(migration.down(), /history_preserved/);
  const appointmentHash = hash(await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true }));
  const materialCalls = [];
  const { createClinicalEpisodeService } = require('../../services/clinicalEpisodes.service');
  const service = createClinicalEpisodeService({ db, now: () => new Date('2026-10-20T12:00:00Z'),
    validateMaterialRefs: async input => {
      materialCalls.push(input);
      if (!Array.isArray(input.refs) || input.refs.some(ref => ref.id !== 'owned-drawing')) throw C.error(404, 'clinical_material_not_found', 'Material no encontrado.');
      return input.refs.map(ref => ({ kind: 'drawing', id: ref.id, version: ref.version || 2, title: 'Modelo facial' }));
    } });
  const base = { patientIdentifier: 'owned-patient', clinicId: 72, actorId: 7 };
  const create = payload => service.create({ ...base, payload: { expected_version: 0, idempotency_key: 'request-' + Math.random().toString(36).slice(2), ...payload } });
  const save = (id, payload, mode = 'save') => service.save({ id, clinicId: 72, actorId: 7, payload, mode });
  const read = async id => (await service.get({ id, clinicId: 72 })).item;
  const rich = value => ({ ops: [{ insert: value, attributes: { bold: true } }, { insert: '\n' }] });

  const empty = await create({ title: 'Valoración', template_key: 'general', occurred_at: '2026-10-20T11:30:00Z', idempotency_key: 'request-empty-draft' });
  assert.equal(empty.item.appointment_id, null); assert.deepEqual(empty.item.appointment_ids, []); assert.equal(empty.item.status, 'draft');
  assert.equal((await create({ title: 'Valoración', template_key: 'general', occurred_at: '2026-10-20T11:30:00Z', idempotency_key: 'request-empty-draft' })).created, false);
  await assert.rejects(create({ title: 'Otro título', idempotency_key: 'request-empty-draft' }), { code: 'clinical_episode_idempotency_conflict' });
  await assert.rejects(save(empty.item.id, { expected_version: 1 }, 'finalize'), { code: 'clinical_report_empty' });
  await save(empty.item.id, { expected_version: 1, private_notes: 'Solo nota privada' });
  await assert.rejects(save(empty.item.id, { expected_version: 2 }, 'finalize'), { code: 'clinical_report_empty' });
  const materialFinal = await save(empty.item.id, { expected_version: 2, material_refs: [{ kind: 'drawing', id: 'owned-drawing', version: 2 }] }, 'finalize');
  assert.equal(materialFinal.item.status, 'final'); assert.equal(materialFinal.item.material_refs[0].version, 2);
  assert.equal(materialCalls[0].clinicId, 72); assert.equal(materialCalls[0].patientId, 1); assert(materialCalls[0].transaction);
  await assert.rejects(save(empty.item.id, { expected_version: 3, summary: 'No editable' }), { code: 'clinical_report_final' });
  const reopened = await save(empty.item.id, { expected_version: 3 }, 'reopen');
  assert.equal(reopened.item.version, 4); assert.equal(reopened.item.material_refs[0].version, 2);
  assert.equal(materialCalls.length, 1, 'omitted refs retain exact pinned revision');

  const multi = await create({ title: 'Sesión de estética', template_key: 'estetica', appointment_ids: [102, 103],
    summary: 'Buena evolución', plan: 'Revisión en dos semanas', findings: 'Piel sensible', private_notes: 'Nota privada',
    rich_document: { version: 1, sections: { summary: rich('Buena evolución'), plan: rich('Revisión en dos semanas') } } });
  assert.equal(multi.item.appointment_id, 102); assert.deepEqual(multi.item.appointment_ids, [102, 103]);
  assert.equal((await service.getForAppointment({ appointmentId: 103, clinicId: 72 })).item.id, multi.item.id);
  const legacyUpdate = await service.saveLegacy({ appointmentId: 103, actorId: 7, payload: { expected_version: 1, summary: 'Actualizado desde agenda' } });
  assert.equal(legacyUpdate.id, multi.item.id); assert.equal(legacyUpdate.version, 2);
  assert.equal(legacyUpdate.plan, 'Revisión en dos semanas'); assert.equal(legacyUpdate.findings, 'Piel sensible'); assert.equal(legacyUpdate.private_notes, 'Nota privada');
  assert.deepEqual(legacyUpdate.rich_document.sections.plan, rich('Revisión en dos semanas'));
  assert.deepEqual(legacyUpdate.rich_document.sections.summary, C.plainDocument('Actualizado desde agenda'));
  await assert.rejects(create({ appointment_ids: [101] }), { code: 'clinical_episode_appointment_linked' });
  await assert.rejects(create({ appointment_ids: [103] }), { code: 'clinical_episode_appointment_linked' });
  await assert.rejects(create({ appointment_ids: [201] }), { code: 'clinical_episode_appointment_not_found' });
  await assert.rejects(service.get({ id: multi.item.id, clinicId: 73 }), { code: 'clinical_episode_not_found' });
  await assert.rejects(service.list({ patientIdentifier: 'other-patient', clinicId: 72 }), { code: 'clinical_episode_patient_not_found' });
  const filtered = await service.list({ ...base, query: { appointment_id: 103 } }); assert.deepEqual(filtered.items.map(item => item.id), [multi.item.id]);

  const linkedChanged = await save(multi.item.id, { expected_version: 2, appointment_ids: [104, 105] });
  assert.equal(linkedChanged.item.appointment_id, 104); assert.deepEqual(linkedChanged.item.appointment_ids, [104, 105]);
  assert.equal((await service.getForAppointment({ appointmentId: 102, clinicId: 72 })).item, null);
  assert.deepEqual((await V.findOne({ where: { report_id: (await R.findOne({ where: { public_id: multi.item.id } })).id, version_number: 2 } })).snapshot.appointment_ids, [102, 103]);

  const concurrent = await Promise.allSettled([create({ appointment_ids: [106], summary: 'Concurrente A' }), create({ appointment_ids: [106], summary: 'Concurrente B' })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'clinical_episode_appointment_linked');
  const race = await Promise.allSettled([save(multi.item.id, { expected_version: 3, summary: 'Editor A' }), save(multi.item.id, { expected_version: 3, summary: 'Editor B' })]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected').reason.code, 'clinical_report_version_conflict');
  const once = await save(multi.item.id, { expected_version: 4, interventions: 'Aplicación registrada', idempotency_key: 'mutation-idempotent-1' });
  assert.equal(once.item.version, 5);
  const retry = await save(multi.item.id, { expected_version: 4, interventions: 'Aplicación registrada', idempotency_key: 'mutation-idempotent-1' });
  assert.equal(retry.replayed, true); assert.equal(retry.item.version, 5);
  await assert.rejects(save(multi.item.id, { expected_version: 4, interventions: 'Otra acción', idempotency_key: 'mutation-idempotent-1' }), { code: 'clinical_episode_idempotency_conflict' });
  const closed = await save(multi.item.id, { expected_version: 5 }, 'finalize'); assert.equal(closed.item.version, 6);
  assert.equal((await service.getLegacy({ appointmentId: 105 })).status, 'final');
  const versions = await service.revisions({ id: multi.item.id, clinicId: 72, query: { limit: 1 } });
  assert.equal(versions.items[0].version, 6); assert.equal(versions.items[0].snapshot.rich_document.version, 1);
  const previous = await service.revisions({ id: multi.item.id, clinicId: 72, query: { limit: 1, cursor: versions.next_cursor } }); assert.equal(previous.items[0].version, 5);
  await assert.rejects(service.revisions({ id: empty.item.id, clinicId: 72, query: { cursor: versions.next_cursor } }), { code: 'clinical_episode_invalid_cursor' });

  const all = [], page = await service.list({ ...base, query: { limit: 2 } }); all.push(...page.items);
  let cursor = page.next_cursor;
  while (cursor) { const next = await service.list({ ...base, query: { limit: 2, cursor } }); all.push(...next.items); cursor = next.next_cursor; }
  assert.equal(new Set(all.map(item => item.id)).size, all.length); assert.equal(all.length, await R.count());
  assert(all.some(item => item.id === 'legacy-report' && item.occurred_at.toISOString() === '2026-10-01T10:00:00.000Z'));
  await assert.rejects(service.list({ ...base, query: { status: 'final', cursor: page.next_cursor } }), { code: 'clinical_episode_invalid_cursor' });
  const unchanged = await read(empty.item.id), beforeRows = hash(await L.findAll({ order: [['appointment_id', 'ASC']], raw: true }));
  const createRevision = V.create; V.create = async () => { throw Error('OWNED_REVISION_FAILURE'); };
  await assert.rejects(save(empty.item.id, { expected_version: unchanged.version, occurred_at: '2026-10-07T10:00:00Z', appointment_ids: [107], summary: 'Debe revertirse' }), /OWNED_REVISION_FAILURE/);
  V.create = createRevision;
  assert.equal((await read(empty.item.id)).version, unchanged.version); assert.equal((await read(empty.item.id)).summary, null);
  assert.equal(hash(await L.findAll({ order: [['appointment_id', 'ASC']], raw: true })), beforeRows);
  assert.equal(hash(await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })), appointmentHash,
    'all episode create/save/finalize/reopen operations leave appointments, care and voucher references unchanged');
  assert.deepEqual((await V.findOne({ where: { report_id: old.id, version_number: 1 } })).snapshot, originalSnapshot);
  report.checks.push('Migration applied twice without narrative backfill; old identity, fields and revision unchanged; destructive rollback refused.');
  report.checks.push('0/1/N explicit reservations, same patient/clinic and one episode per reservation; secondary agenda API shares the same canonical report.');
  report.checks.push('Empty draft, safe native Delta and partial legacy updates; pinned materials permit documentary finalization; private notes alone do not.');
  report.checks.push('CAS races, creation and mutation idempotency, stale/conflicting saves, immutable version pagination, scoped chronological keyset lists and transactional rollback.');
  report.checks.push('No appointment status, attendance, treatment, schedule or voucher change; no payment, message, provider or host database connection.');

  const drawingMigration = require('../../../migrations/20261020200000-clinical-drawings');
  await drawingMigration.up(sql.getQueryInterface(), Sequelize); await drawingMigration.up(sql.getQueryInterface(), Sequelize);
  schemaCut.verifyAfter(releaseBefore, await schemaCut.capture(metadataSql), false);
  await db.SequelizeMeta.bulkCreate(schemaCut.MIGRATIONS.map(name => ({ name })));
  schemaCut.verifyAfter(releaseBefore, await schemaCut.capture(metadataSql), true);
  for (const file of ['clinicaldrawing', 'clinicaldrawingrevision']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  await db.ClinicalPrivateAsset.bulkCreate([
    { public_id: 'cpa_owned_image', clinic_id: 72, patient_id: 1, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment', content_type: 'image/png', original_filename: 'Imagen clínica', sha256: 'a'.repeat(64) },
    { public_id: 'cpa_owned_pdf', clinic_id: 72, patient_id: 1, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment', content_type: 'application/pdf', original_filename: 'Prueba PDF', sha256: 'b'.repeat(64) },
    { public_id: 'cpa_foreign_image', clinic_id: 73, patient_id: 2, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment', content_type: 'image/png', sha256: 'c'.repeat(64) },
    { public_id: 'cpa_wrong_purpose', clinic_id: 72, patient_id: 1, scope_type: 'clinic', status: 'active', purpose: 'accounting_expense_document', content_type: 'image/png', sha256: 'd'.repeat(64) },
  ]);
  const { createService } = require('../../services/clinicalDrawings.service');
  const drawingService = createService({ db, canAccess: async () => true, readAsset: async () => ({ buffer: Buffer.from('OWNED_PDF') }), getPdfPageCount: async () => 2 });
  const document = { version: 1, views: { front: { strokes: [{ id: 's1', type: 'pen', color: '#4f46e5', width: 2, points: [{ x: 0.25, y: 0.5 }] }],
    notes: [{ id: 'n1', x: 0.25, y: 0.5, text: 'Punto de observación' }], photos: [{ id: 'cpa_owned_image', region: 'frontal' }], regions: { frontal: 'Observación' } } } };
  const drawingPayload = { expected_version: 0, idempotency_key: 'drawing-owned-first', title: 'Modelo facial', template_key: 'facial', document };
  const createdDrawing = await drawingService.create({ ...base, payload: drawingPayload });
  assert.equal(createdDrawing.created, true); assert.equal(createdDrawing.item.version, 1); assert.equal(createdDrawing.item.template_version, 1);
  await assert.rejects(drawingService.create({ ...base, payload: { ...drawingPayload, idempotency_key: 'drawing-template-v3', template_version: 3 } }), { code: 'clinical_drawing_template_version_invalid' });
  await assert.rejects(drawingService.create({ ...base, payload: { ...drawingPayload, idempotency_key: 'drawing-template-text', template_version: '1' } }), { code: 'clinical_drawing_template_version_invalid' });
  assert.equal((await drawingService.create({ ...base, payload: drawingPayload })).created, false);
  await assert.rejects(drawingService.create({ ...base, payload: { ...drawingPayload, title: 'Otro título' } }), { code: 'clinical_drawing_idempotency_conflict' });
  const drawId = createdDrawing.item.id;
  const { createMaterialValidator } = require('../../services/clinicalEpisodeMaterials.service');
  const realValidator = createMaterialValidator({ db, canAccess: async () => true });
  const pinnedService = createClinicalEpisodeService({ db, validateMaterialRefs: realValidator });
  const pinned = await pinnedService.create({ ...base, payload: { expected_version: 0, idempotency_key: 'episode-pinned-drawing', title: 'Consulta con modelo',
    material_refs: [{ kind: 'drawing', id: drawId, version: 1 }, { kind: 'attachment', id: 'cpa_owned_image' }] } });
  assert.equal(pinned.item.material_refs[0].version, 1); assert.equal(pinned.item.material_refs[0].template_version, 1); assert.equal(pinned.item.material_refs[1].sha256, 'a'.repeat(64));
  await pinnedService.save({ id: pinned.item.id, clinicId: 72, actorId: 7, payload: { expected_version: 1 }, mode: 'finalize' });
  const drawRace = await Promise.allSettled([drawingService.save({ ...base, id: drawId, payload: { expected_version: 1, title: 'Modelo facial actualizado' } }),
    drawingService.save({ ...base, id: drawId, payload: { expected_version: 1, title: 'Editor antiguo' } })]);
  assert.equal(drawRace.filter(value => value.status === 'fulfilled').length, 1); assert.equal(drawRace.find(value => value.status === 'rejected').reason.code, 'clinical_report_version_conflict');
  const historical = await drawingService.get({ ...base, id: drawId, version: 1 });
  assert.equal(historical.historical, true); assert.equal(historical.item.title, 'Modelo facial');
  assert.equal(historical.item.template_version, 1);
  assert.equal((await pinnedService.get({ id: pinned.item.id, clinicId: 72 })).item.material_refs[0].version, 1, 'closed episode never auto-upgrades a drawing revision');
  await assert.rejects(drawingService.save({ ...base, id: drawId, payload: { expected_version: 2, template_key: 'capilar' } }), { code: 'clinical_drawing_source_immutable' });
  await assert.rejects(drawingService.save({ ...base, id: drawId, payload: { expected_version: 2, template_version: 2 } }), { code: 'clinical_drawing_source_immutable' });
  await drawingService.save({ ...base, id: drawId, payload: { expected_version: 2, status: 'archived' } });
  assert.equal((await drawingService.list(base)).items.length, 0); assert.equal((await drawingService.list({ ...base, status: 'archived' })).items.length, 1);
  const retained = await realValidator({ refs: [{ kind: 'drawing', id: drawId, version: 1 }], patientId: 1, clinicId: 72, actorId: 7 }); assert.equal(retained[0].version, 1);
  await assert.rejects(realValidator({ refs: [{ kind: 'drawing', id: drawId }], patientId: 1, clinicId: 72, actorId: 7 }), { code: 'clinical_material_not_found' });
  await drawingService.save({ ...base, id: drawId, payload: { expected_version: 3, status: 'active' } });
  const drawingVersions = await drawingService.revisions({ ...base, id: drawId, limit: 1 }); assert.equal(drawingVersions.items[0].version, 4);
  assert.equal((await drawingService.revisions({ ...base, id: drawId, limit: 1, cursor: drawingVersions.next_cursor })).items[0].version, 3);
  const photoBad = { version: 1, views: { front: { photos: [{ id: 'cpa_foreign_image' }] } } };
  await assert.rejects(drawingService.create({ ...base, payload: { ...drawingPayload, idempotency_key: 'drawing-foreign-photo', document: photoBad } }), { code: 'clinical_drawing_source_not_found' });
  await assert.rejects(drawingService.get({ ...base, clinicId: 73, id: drawId }), { code: 'clinical_drawing_forbidden' });
  const deniedDrawing = createService({ db, canAccess: async () => false }); await assert.rejects(deniedDrawing.get({ ...base, id: drawId }), { code: 'clinical_drawing_forbidden' });
  const deniedRefs = createMaterialValidator({ db, canAccess: async ({ featureKey }) => featureKey !== 'clinical.reports.view' });
  await assert.rejects(deniedRefs({ refs: [{ kind: 'drawing', id: drawId, version: 1 }], patientId: 1, clinicId: 72, actorId: 7 }), { code: 'clinical_material_forbidden' });
  for (const id of ['cpa_foreign_image', 'cpa_wrong_purpose']) await assert.rejects(realValidator({ refs: [{ kind: 'attachment', id }], patientId: 1, clinicId: 72, actorId: 7 }), { code: 'clinical_material_not_found' });
  const pdfPayload = { expected_version: 0, idempotency_key: 'drawing-owned-pdf', title: 'Prueba anotada', template_key: 'image', source_asset_id: 'cpa_owned_pdf',
    document: { version: 1, views: { 'page-2': { notes: [{ id: 'pdf-note', x: 0.1, y: 0.2, text: 'Observación en página 2' }] } } } };
  const pdfDrawing = await drawingService.create({ ...base, payload: pdfPayload }); assert.equal(pdfDrawing.item.source.id, 'cpa_owned_pdf'); assert.equal(pdfDrawing.item.template_version, 1); assert(pdfDrawing.item.source.preview_path.endsWith('/preview'));
  await assert.rejects(drawingService.create({ ...base, payload: { ...pdfPayload, idempotency_key: 'drawing-invalid-page', document: { version: 1, views: { 'page-3': {} } } } }), { code: 'clinical_drawing_source_view_invalid' });
  await assert.rejects(drawingService.create({ ...base, payload: { ...pdfPayload, idempotency_key: 'drawing-invalid-image', source_asset_id: 'cpa_owned_image' } }), { code: 'clinical_drawing_source_view_invalid' });
  const revisionCreate = db.ClinicalDrawingRevision.create;
  db.ClinicalDrawingRevision.create = async () => { throw Error('OWNED_DRAWING_REVISION_FAILURE'); };
  await assert.rejects(drawingService.save({ ...base, id: drawId, payload: { expected_version: 4, title: 'Must rollback' } }), /OWNED_DRAWING_REVISION_FAILURE/);
  db.ClinicalDrawingRevision.create = revisionCreate; assert.equal((await drawingService.get({ ...base, id: drawId })).item.version, 4);
  await assert.rejects(drawingMigration.down(sql.getQueryInterface()), /retained revisions/);
  assert.equal(hash(await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })), appointmentHash);
  report.checks.push('Drawing migration idempotent; facial/capilar/photo/PDF geometry, source and photo clinic ACL, immutable source, CAS races, archive/restore and version pagination.');
  report.checks.push('Episode pins drawing revision and attachment checksum; editing/archiving a model never upgrades a closed episode; revision failure rolls back model changes.');
  report.checks.push('Selective release verifier compares actual old/new columns, indexes, FK rules, table collations, triggers and exactly two migration receipts; no unrelated metadata change.');
  const v2Model = await drawingService.create({ ...base, payload: { ...drawingPayload, idempotency_key: 'drawing-template-v2', template_version: 2 } });
  assert.equal(v2Model.item.template_version, 2);
  const v2Saved = await drawingService.save({ ...base, id: v2Model.item.id, payload: { expected_version: 1, template_version: 2, title: 'Modelo anatómico versión 2 conservada' } });
  assert.equal(v2Saved.item.template_version, 2); assert.equal((await drawingService.get({ ...base, id: v2Model.item.id, version: 1 })).item.template_version, 2);
  await assert.rejects(drawingService.save({ ...base, id: v2Model.item.id, payload: { expected_version: 2, template_version: 1 } }), { code: 'clinical_drawing_source_immutable' });
  assert.equal((await drawingService.get({ ...base, id: drawId, version: 1 })).item.template_version, 1);
  await assert.rejects(drawingService.create({ ...base, payload: { ...drawingPayload, idempotency_key: 'drawing-template-v2', template_version: 1 } }), { code: 'clinical_drawing_idempotency_conflict' });
  report.checks.push('Anatomical template_version 1 and 2 are stored exactly in model, revision snapshots, DTO and episode pinned reference; same-version edits preserve the chosen anatomy, historical v1 never upgrades and unsupported versions/coercion/downgrades reject.');
}).catch(error => { console.error(error); process.exitCode = 1; });
