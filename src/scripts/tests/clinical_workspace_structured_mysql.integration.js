'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const q = sql.getQueryInterface(), define = (name, fields, tableName) => sql.define(name, fields, { tableName, timestamps: false });
  db.Sequelize = Sequelize;
  db.Clinica = define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, configuracion: D.JSON }, 'Clinicas');
  db.Paciente = define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING, medicacion: D.TEXT }, 'Pacientes');
  db.PacienteClinica = define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, 'PacienteClinicas');
  db.PatientVoucher = define('PatientVoucher', { id: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, patient_id: D.INTEGER, clinic_id: D.INTEGER,
    name: D.STRING, treatment_id: D.INTEGER, program_snapshot: D.JSON }, 'PatientVouchers');
  db.Usuario = define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING }, 'Usuarios');
  db.CitaPaciente = define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, paciente_id: D.INTEGER, doctor_id: D.INTEGER,
    tratamiento_id: D.INTEGER, titulo: D.STRING, inicio: D.DATE, fin: D.DATE, estado: D.STRING, es_provisional: D.BOOLEAN, voucher_id: D.INTEGER, import_metadata: D.JSON,
    arrived_at: D.DATE, arrived_by: D.INTEGER, care_started_at: D.DATE, care_started_by: D.INTEGER, care_completed_at: D.DATE, care_completed_by: D.INTEGER,
    care_schedule_start: D.DATE, care_legacy_attendance: D.BOOLEAN, updated_by: D.INTEGER }, 'CitasPacientes');
  db.ClinicalPrivateAsset = define('ClinicalPrivateAsset', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, public_id: D.STRING, patient_id: D.INTEGER, clinic_id: D.INTEGER,
    scope_type: D.STRING, status: D.STRING, purpose: D.STRING, content_type: D.STRING, original_filename: D.STRING, sha256: D.STRING, created_at: D.DATE, object_key: D.STRING }, 'ClinicalPrivateAssets');
  for (const file of ['appointmentclinicalreport', 'appointmentclinicalreportrevision', 'clinicalepisodeappointment', 'appointmentcareevent', 'patientoperationalevent']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  for (const model of Object.values(db)) if (model.getAttributes) {
    const attributes = { ...model.getAttributes() }; if (model.name === 'AppointmentClinicalReport') delete attributes.diagnoses;
    await q.createTable(model.getTableName(), attributes);
  }
  await require('../../../migrations/20261024230000-clinical-workspace-structured-data').up(q, Sequelize);
  for (const file of ['patientclinicalmedication', 'patientclinicalmedicationrevision', 'appointmentattendancecorrection']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  await db.Clinica.bulkCreate([{ id_clinica: 72, configuracion: { timezone: 'Europe/Madrid' } }, { id_clinica: 73, configuracion: {} }]);
  await db.Paciente.bulkCreate([{ id_paciente: 11, public_id: 'fictitious-patient', clinica_id: 72, nombre: 'Paciente', apellidos: 'Ficticio', medicacion: 'Referencia original sin interpretar' }, { id_paciente: 12, public_id: 'foreign-patient', clinica_id: 73, medicacion: 'Foreign' }]);
  await db.PacienteClinica.create({ paciente_id: 12, clinica_id: 72 });
  await db.Usuario.create({ id_usuario: 7, nombre: 'Profesional', apellidos: 'Ficticio' });
  const canAccess = async ({ actorId, clinicId, featureKey }) => Number(clinicId) === 72 && (actorId === 7 || actorId === 8 && ['patients.view', 'patients.sensitive.view', 'clinical.reports.view'].includes(featureKey));
  const scope = { patientIdentifier: 'fictitious-patient', clinicId: 72, actorId: 7 };
  let key = 0; const command = extra => ({ idempotency_key: `owned-clinical-${++key}`, ...extra });
  const medication = require('../../services/patientClinicalMedication.service').createPatientClinicalMedicationService({ db, canAccess });
  assert.equal((await medication.read(scope)).item.version, 0);
  const item = { id: crypto.randomUUID(), name: 'Medicamento ficticio', dose: 'Dosis declarada', frequency: 'Frecuencia declarada', instructions: 'Indicación registrada por el profesional' };
  const initial = command({ expected_version: 0, items: [item] });
  const twice = await Promise.all([medication.update({ ...scope, payload: initial }), medication.update({ ...scope, payload: initial })]);
  assert.equal(twice.filter(value => value.replayed).length, 1); assert.equal(await db.PatientClinicalMedication.count(), 1); assert.equal(await db.PatientClinicalMedicationRevision.count(), 1);
  assert.equal((await db.Paciente.findByPk(11)).medicacion, 'Referencia original sin interpretar');
  assert.equal((await medication.read(scope)).item.items[0].frequency, 'Frecuencia declarada');
  await assert.rejects(medication.update({ ...scope, actorId: 8, payload: command({ expected_version: 1, items: [] }) }), { code: 'access_policy_forbidden' });
  await assert.rejects(medication.update({ ...scope, patientIdentifier: 12, payload: command({ expected_version: 0, items: [] }) }), { code: 'access_policy_forbidden' });
  await assert.rejects(medication.update({ ...scope, payload: command({ expected_version: 0, items: [] }) }), { code: 'clinical_medication_version_conflict' });
  await assert.rejects(medication.update({ ...scope, payload: { ...initial, items: [] } }), { code: 'clinical_medication_request_conflict' });
  const medicationRevision = await db.PatientClinicalMedicationRevision.findOne();
  await assert.rejects(medicationRevision.update({ command_key: 'rewritten' }), /clinical_medication_revision_immutable/);
  report.checks.push('Medication is patient-scoped, typed name/dose/frequency/instructions, exact replay once, legacy text untouched, read-only/owning-clinic permissions and CAS enforced.');

  const validator = require('../../services/clinicalEpisodeMaterials.service').createMaterialValidator({ db, canAccess });
  const episodes = require('../../services/clinicalEpisodes.service').createClinicalEpisodeService({ db, canAccess, validateMaterialRefs: validator, now: () => new Date('2026-10-30T10:00:00Z') });
  const create = extra => episodes.create({ ...scope, payload: command({ expected_version: 0, title: 'Consulta ficticia', occurred_at: '2026-10-24T22:30:00Z', template_key: 'general', ...extra }) });
  let episode = (await create({ diagnoses: [{ id: crypto.randomUUID(), label: 'Orientación manual ficticia', notes: 'Sin código inventado' }] })).item;
  assert.equal(episode.diagnoses[0].notes, 'Sin código inventado');
  const linkPayload = command({ expected_version: 1, items: [item], episode_id: episode.id, expected_episode_version: 1 });
  const linked = await medication.update({ ...scope, payload: linkPayload });
  assert.equal(linked.item.version, 2); assert.equal(linked.episode.version, 2); assert.equal(linked.episode.material_refs[0].kind, 'medication'); assert.equal(linked.episode.material_refs[0].version, 2);
  const linkedAgain = await medication.update({ ...scope, payload: linkPayload }); assert.equal(linkedAgain.replayed, true); assert.equal(await db.PatientClinicalMedicationRevision.count(), 2);
  await assert.rejects(medication.update({ ...scope, payload: command({ expected_version: 2, items: [], episode_id: episode.id, expected_episode_version: 1 }) }), { code: 'clinical_report_version_conflict' });
  assert.equal((await medication.read(scope)).item.version, 2); assert.equal((await medication.read(scope)).item.items.length, 1);
  const historical = await medication.read({ ...scope, id: linked.item.id, version: 1 }); assert.equal(historical.historical, true); assert.equal(historical.item.items[0].name, item.name);
  await assert.rejects(medication.read({ ...scope, id: crypto.randomUUID(), version: 1 }), { code: 'clinical_medication_not_found' });
  await episodes.save({ id: episode.id, clinicId: 72, actorId: 7, mode: 'finalize', payload: command({ expected_version: 2 }) });
  await assert.rejects(medication.update({ ...scope, payload: command({ expected_version: 2, items: [], episode_id: episode.id, expected_episode_version: 3 }) }), { code: 'clinical_report_final' });
  assert.equal((await medication.read(scope)).item.version, 2);
  const parentOnly = await medication.update({ ...scope, payload: command({ expected_version: 2, items: [] }) }); assert.equal(parentOnly.item.version, 3);
  const originalMedicationJournal = db.PatientClinicalMedicationRevision.create;
  db.PatientClinicalMedicationRevision.create = async () => { throw Error('owned-medication-journal-failure'); };
  await assert.rejects(medication.update({ ...scope, payload: command({ expected_version: 3, items: [item] }) }), /owned-medication-journal-failure/);
  db.PatientClinicalMedicationRevision.create = originalMedicationJournal;
  assert.equal((await medication.read(scope)).item.version, 3); assert.equal((await medication.read(scope)).item.items.length, 0);
  assert.equal((await episodes.get({ id: episode.id, clinicId: 72 })).item.material_refs[0].version, 2);
  const revisions = await episodes.revisions({ id: episode.id, clinicId: 72, query: { limit: 2 } });
  assert.equal(revisions.items[0].actor_name, 'Profesional Ficticio'); assert.equal(revisions.items[0].change_type, 'finalized'); assert(revisions.next_cursor);
  report.checks.push('Medication and explicit episode ref commit atomically; stale/final episode rolls medication back. Old medication versions and closed refs remain fixed; patient-only updates stay separate. Revisions expose real author/date/action.');

  const appointments = [
    { id_cita: 101, inicio: '2026-10-24T22:30:00Z', fin: '2026-10-24T23:00:00Z' },
    { id_cita: 102, inicio: '2026-10-25T00:30:00Z', fin: '2026-10-25T01:00:00Z' },
    { id_cita: 103, inicio: '2026-10-25T23:30:00Z', fin: '2026-10-26T00:00:00Z' },
    { id_cita: 104, inicio: '2026-10-26T23:30:00Z', fin: '2026-10-27T00:00:00Z' },
  ];
  await db.CitaPaciente.bulkCreate(appointments.map(row => ({ ...row, clinica_id: 72, paciente_id: 11, doctor_id: 7, estado: 'pendiente' })));
  await assert.rejects(create({ appointment_ids: [101, 103] }), { code: 'clinical_episode_appointment_day_mismatch' });
  let shared = (await create({ appointment_ids: [101, 102] })).item; assert.equal(shared.appointment_ids.length, 2);
  const raw = await db.AppointmentClinicalReport.findOne({ where: { public_id: shared.id } });
  await db.ClinicalEpisodeAppointment.create({ appointment_id: 103, report_id: raw.id, clinic_id: 72, patient_id: 11, created_by: 7 });
  shared = (await episodes.save({ id: shared.id, clinicId: 72, actorId: 7, payload: command({ expected_version: 1, appointment_ids: [101, 102, 103], summary: 'Se conservan vínculos heredados' }) })).item;
  assert.equal(shared.appointment_ids.length, 3);
  assert.equal(shared.appointment_link_review.required, true); assert.deepEqual(shared.appointment_link_review.appointment_ids, [103]);
  await assert.rejects(episodes.save({ id: shared.id, clinicId: 72, actorId: 7, payload: command({ expected_version: 2, appointment_ids: [101, 102, 103, 104] }) }), { code: 'clinical_episode_appointment_day_mismatch' });
  report.checks.push('New appointment links use clinic civil day across UTC midnight and DST, reject cross-day additions, and preserve existing cross-day links during ordinary edits.');

  const photo = await db.ClinicalPrivateAsset.create({ public_id: crypto.randomUUID(), patient_id: 11, clinic_id: 72, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment', content_type: 'image/png', original_filename: 'Foto ficticia.png', sha256: 'a'.repeat(64), created_at: new Date(), object_key: 'PRIVATE_INTERNAL_PATH' });
  const pdf = await db.ClinicalPrivateAsset.create({ public_id: crypto.randomUUID(), patient_id: 11, clinic_id: 72, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment', content_type: 'application/pdf', original_filename: 'Documento.pdf', sha256: 'b'.repeat(64), created_at: new Date() });
  let photographic = (await create({ material_refs: [{ kind: 'attachment', id: photo.public_id, phase: 'before' }] })).item;
  assert.equal(photographic.material_refs[0].phase, 'before');
  await assert.rejects(create({ material_refs: [{ kind: 'attachment', id: pdf.public_id, phase: 'before' }] }), { code: 'clinical_material_phase_invalid' });
  const gallery = require('../../services/clinicalMaterialGallery.service').createClinicalMaterialGalleryService({ db, canAccess });
  const view = await gallery.read({ ...scope, episodeIds: photographic.id + ',' + shared.id });
  assert.equal(view.items[0].phase, 'before'); assert.equal(view.items[0].episode_status, 'draft'); assert.equal(view.episodes.length, 2); assert(!JSON.stringify(view).includes('PRIVATE_INTERNAL_PATH'));
  await assert.rejects(gallery.read({ ...scope, episodeIds: photographic.id + ',' + crypto.randomUUID() }), { code: 'clinical_gallery_episode_not_found' });
  await assert.rejects(gallery.read({ ...scope, clinicId: 73, episodeIds: photographic.id }), { code: 'access_policy_forbidden' });
  await assert.rejects(gallery.read({ ...scope, episodeIds: Array.from({ length: 101 }, () => crypto.randomUUID()).join(',') }), { code: 'clinical_gallery_scope_invalid' });
  const nutritionPhoto = await db.ClinicalPrivateAsset.create({ public_id: crypto.randomUUID(), patient_id: 11, clinic_id: 72, scope_type: 'clinic', status: 'active', purpose: 'nutrition_clinical_photo', content_type: 'image/png', original_filename: 'Foto nutrición ficticia.png', sha256: 'c'.repeat(64), created_at: new Date() });
  const nutritionEpisode = (await create({ material_refs: [{ kind: 'attachment', id: nutritionPhoto.public_id, phase: 'other' }] })).item;
  const purposeRestricted = require('../../services/clinicalMaterialGallery.service').createClinicalMaterialGalleryService({ db, canAccess: async input => input.featureKey !== 'nutrition.workspace.view' && await canAccess(input) });
  assert.equal((await purposeRestricted.read({ ...scope, episodeIds: nutritionEpisode.id })).items.length, 0);
  photographic = (await episodes.save({ id: photographic.id, clinicId: 72, actorId: 7, payload: command({ expected_version: 1, material_refs: [{ kind: 'attachment', id: photo.public_id, phase: 'after' }] }) })).item;
  assert.equal((await gallery.read({ ...scope, episodeIds: photographic.id })).items[0].phase, 'after');
  assert.equal((await episodes.revisions({ id: photographic.id, clinicId: 72 })).items.find(row => row.version === 1).snapshot.material_refs[0].phase, 'before');
  report.checks.push('Gallery unions only explicitly scoped episode image refs; before/after roles survive revision and are never inferred from chronology. Foreign episode, PDF roles and internal storage disclosure are rejected.');

  const careRows = [{ id_cita: 201, estado: 'no_asistio' }, { id_cita: 202, estado: 'reprogramada' }, { id_cita: 203, estado: 'no_asistio' }, { id_cita: 204, estado: 'no_asistio', inicio: '2026-11-01T10:00:00Z', fin: '2026-11-01T10:30:00Z' }, { id_cita: 205, estado: 'pendiente' }, { id_cita: 206, estado: 'no_asistio', arrived_at: '2026-10-20T10:00:00Z', care_schedule_start: '2026-10-20T10:00:00Z' }];
  await db.PatientVoucher.create({ id: 99, public_id: 'owned-care-voucher', patient_id: 11, clinic_id: 72, name: 'Bono ficticio de atención' });
  await db.CitaPaciente.bulkCreate(careRows.map(row => ({ clinica_id: 72, paciente_id: 11, doctor_id: 7, inicio: '2026-10-20T10:00:00Z', fin: '2026-10-20T10:30:00Z', voucher_id: 99, ...row })));
  const corrections = require('../../services/clinicalAttendanceCorrection.service').createClinicalAttendanceCorrectionService({ db, canAccess, now: () => new Date('2026-10-30T10:00:00Z') });
  const correction = (id, extra = {}) => ({ appointmentId: id, clinicId: 72, actorId: 7, payload: command({ confirmed: true, expected_status: 'no_asistio', expected_start: '2026-10-20T10:00:00Z', expected_end: '2026-10-20T10:30:00Z', reason: 'Corrección explícita ficticia por el profesional', ...extra }) });
  await assert.rejects(create({ appointment_ids: [201], occurred_at: '2026-10-20T10:00:00Z' }), { code: 'clinical_episode_attendance_confirmation_required' });
  const attend = correction(201), results = await Promise.all([corrections.correct(attend), corrections.correct(attend)]);
  assert.equal(results.filter(value => value.replayed).length, 1); assert.equal(await db.AppointmentAttendanceCorrection.count(), 1); assert.equal(await db.AppointmentCareEvent.count(), 1); assert.equal(await db.PatientOperationalEvent.count(), 1);
  const corrected = await db.CitaPaciente.findByPk(201); assert.equal(corrected.estado, 'ha_acudido'); assert.equal(corrected.inicio.toISOString(), '2026-10-20T10:00:00.000Z'); assert.equal(corrected.arrived_at.toISOString(), '2026-10-30T10:00:00.000Z'); assert.equal(corrected.care_started_at, null); assert.equal(corrected.care_completed_at, null); assert.equal(corrected.voucher_id, 99);
  await corrections.correct(correction(202, { expected_status: 'reprogramada' }));
  await assert.rejects(corrections.correct({ ...correction(203), actorId: 8 }), { code: 'access_policy_forbidden' });
  await assert.rejects(corrections.correct({ ...attend, payload: { ...attend.payload, reason: 'Otro motivo para la misma clave' } }), { code: 'clinical_attendance_request_conflict' });
  const preservedEpisode = await create({ appointment_ids: [205], occurred_at: '2026-10-20T10:00:00Z', summary: 'Historia que se conserva' });
  await db.CitaPaciente.update({ estado: 'no_asistio' }, { where: { id_cita: 205 } });
  await assert.rejects(corrections.correct(correction(205)), { code: 'clinical_attendance_history_preserved' });
  assert.equal((await episodes.get({ id: preservedEpisode.item.id, clinicId: 72 })).item.summary, 'Historia que se conserva');
  await assert.rejects(corrections.correct(correction(206)), { code: 'clinical_attendance_history_preserved' });
  await assert.rejects(corrections.correct(correction(203, { confirmed: false })), { code: 'clinical_attendance_confirmation_required' });
  await assert.rejects(corrections.correct(correction(203, { expected_start: '2026-10-21T10:00:00Z' })), { code: 'clinical_attendance_schedule_changed' });
  await assert.rejects(corrections.correct(correction(204, { expected_start: '2026-11-01T10:00:00Z', expected_end: '2026-11-01T10:30:00Z' })), { code: 'clinical_attendance_rescheduled_future' });
  const originalReceipt = db.AppointmentAttendanceCorrection.create.bind(db.AppointmentAttendanceCorrection);
  db.AppointmentAttendanceCorrection.create = async () => { throw Error('owned-attendance-receipt-failure'); };
  await assert.rejects(corrections.correct(correction(203)), /owned-attendance-receipt-failure/); db.AppointmentAttendanceCorrection.create = originalReceipt;
  assert.equal((await db.CitaPaciente.findByPk(203)).estado, 'no_asistio'); assert.equal(await db.AppointmentCareEvent.count(), 2); assert.equal(await db.PatientOperationalEvent.count(), 2);
  report.checks.push('Confirmed attendance correction uses trusted actor, status/schedule CAS, unchanged reservation, real correction time and append-only history; concurrent replay once. Future rescheduled reservations and unconfirmed/stale inputs stay intact; receipt failure rolls status/care/audit back. No starts/completions/vouchers/messages/providers.');
}).catch(error => { console.error(error); process.exitCode = 1; });
