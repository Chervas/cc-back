'use strict';
const crypto = require('node:crypto');
const C = require('../lib/clinical-episode-contract');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
function medicationItems(value) {
  if (!Array.isArray(value) || value.length > 100) throw C.error(400, 'clinical_medication_invalid', 'Revisa la medicación.');
  const seen = new Set();
  return value.map(row => {
    if (!C.object(row) || typeof row.id !== 'string' || !UUID.test(row.id) || seen.has(row.id) || Object.keys(row).some(key => !['id', 'name', 'dose', 'frequency', 'instructions'].includes(key))) throw C.error(400, 'clinical_medication_invalid', 'Revisa la medicación.');
    seen.add(row.id); const name = C.text(row.name, 'medication_name', 200);
    if (!name) throw C.error(400, 'clinical_medication_invalid', 'Indica el nombre de cada medicamento.');
    return { id: row.id, name, dose: C.text(row.dose ?? '', 'medication_dose', 200) || '', frequency: C.text(row.frequency ?? '', 'medication_frequency', 200) || '', instructions: C.text(row.instructions ?? '', 'medication_instructions', 1000) || '' };
  });
}
function createPatientClinicalMedicationService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) }) {
  const episodes = require('./clinicalEpisodes.service').createClinicalEpisodeService({ db, canAccess,
    validateMaterialRefs: require('./clinicalEpisodeMaterials.service').createMaterialValidator({ db, canAccess }) });
  async function context(input, transaction, writing = false) {
    if (!input.actorId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    const actorId = C.integer(input.actorId), clinicId = C.integer(input.clinicId);
    async function allowed(scope) { const flags = await Promise.all(['patients.view', 'patients.sensitive.view', writing ? 'patients.edit' : 'clinical.reports.view'].map(featureKey => canAccess({ actorId, clinicId: scope, featureKey }))); if (flags.some(flag => !flag)) throw C.error(403, 'access_policy_forbidden', 'No tienes permiso para esta medicación.'); }
    await allowed(clinicId);
    const raw = String(input.patientIdentifier ?? '');
    if (!raw || raw.length > 80) throw C.error(400, 'clinical_medication_patient_invalid', 'Selecciona un paciente válido.');
    const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(raw) ? { id_paciente: C.integer(raw) } : { public_id: raw }, transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient || Number(patient.clinica_id) !== clinicId && !await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, transaction })) throw C.error(404, 'clinical_medication_patient_not_found', 'Paciente no encontrado en esta clínica.');
    if (writing && Number(patient.clinica_id) !== clinicId) await allowed(Number(patient.clinica_id));
    return { actorId, clinicId, patient };
  }
  function dto(row, ctx) {
    const items = parse(row?.items) || [];
    return { id: row?.public_id || null, patient_id: Number(ctx.patient.id_paciente), clinic_id: ctx.clinicId, version: Number(row?.version_number || 0), items,
      summary: items.map(item => [item.name, item.dose, item.frequency, item.instructions].filter(Boolean).join(' · ')).join('\n'),
      legacy_text: ctx.patient.medicacion ?? null, updated_at: row?.updated_at || null, updated_by: row?.updated_by ? Number(row.updated_by) : null };
  }
  async function read(input) {
    const ctx = await context(input), row = await db.PatientClinicalMedication.findOne({ where: { patient_id: ctx.patient.id_paciente } });
    if (input.id && (!row || row.public_id !== input.id)) throw C.error(404, 'clinical_medication_not_found', 'Medicación no encontrada para este paciente.');
    if (input.version !== undefined) {
      const version = C.integer(input.version, 'version');
      const revision = row && await db.PatientClinicalMedicationRevision.findOne({ where: { medication_id: row.id, version_number: version } });
      if (!revision) throw C.error(404, 'clinical_medication_not_found', 'La versión de medicación no está disponible.');
      return { item: { ...parse(revision.snapshot), clinic_id: ctx.clinicId }, historical: true };
    }
    return { item: dto(row, ctx), historical: false };
  }
  async function update(input) {
    const payload = input.payload;
    if (!C.object(payload) || Object.keys(payload).some(key => !['expected_version', 'idempotency_key', 'items', 'episode_id', 'expected_episode_version'].includes(key))) throw C.error(400, 'clinical_medication_invalid', 'Revisa la medicación.');
    const linking = Object.hasOwn(payload, 'episode_id') || Object.hasOwn(payload, 'expected_episode_version');
    if (linking && (typeof payload.episode_id !== 'string' || !UUID.test(payload.episode_id) || !Number.isSafeInteger(payload.expected_episode_version) || payload.expected_episode_version < 1)) throw C.error(428, 'clinical_medication_episode_version_required', 'Vuelve a cargar el episodio antes de asociar la medicación.');
    if (!Number.isSafeInteger(payload.expected_version) || payload.expected_version < 0) throw C.error(428, 'clinical_medication_version_required', 'Vuelve a cargar la medicación antes de guardar.');
    const key = C.idempotencyKey(payload.idempotency_key, true), items = medicationItems(payload.items), hash = C.hash({ items, expected_version: payload.expected_version, ...(linking ? { episode_id: payload.episode_id, expected_episode_version: payload.expected_episode_version } : {}) });
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true);
      let episode;
      if (linking) {
        if (!await canAccess({ actorId: ctx.actorId, clinicId: ctx.clinicId, featureKey: 'clinical.reports.manage' })) throw C.error(403, 'access_policy_forbidden', 'No tienes permiso para asociar medicación al episodio.');
        episode = await db.AppointmentClinicalReport.findOne({ where: { public_id: payload.episode_id, patient_id: ctx.patient.id_paciente, clinic_id: ctx.clinicId }, transaction, lock: transaction.LOCK.UPDATE });
        if (!episode) throw C.error(404, 'clinical_episode_not_found', 'Episodio no encontrado para este paciente y clínica.');
      }
      let row = await db.PatientClinicalMedication.findOne({ where: { patient_id: ctx.patient.id_paciente }, transaction, lock: transaction.LOCK.UPDATE });
      if (row) {
        const previous = await db.PatientClinicalMedicationRevision.findOne({ where: { medication_id: row.id, command_key: key }, transaction });
        if (previous) { if (previous.command_hash !== hash || Number(previous.actor_id) !== ctx.actorId || Number(previous.clinic_id) !== ctx.clinicId) throw C.error(409, 'clinical_medication_request_conflict', 'Esta solicitud ya corresponde a otro cambio.'); return { item: parse(previous.snapshot), ...(episode ? { episode: (await episodes.get({ id: episode.public_id, clinicId: ctx.clinicId, transaction })).item } : {}), replayed: true }; }
      }
      if (Number(row?.version_number || 0) !== payload.expected_version) throw C.error(409, 'clinical_medication_version_conflict', 'La medicación ha cambiado. Conserva tu edición y consulta la versión actual.');
      if (row) await row.update({ items, version_number: payload.expected_version + 1, updated_by: ctx.actorId }, { transaction });
      else row = await db.PatientClinicalMedication.create({ public_id: crypto.randomUUID(), patient_id: ctx.patient.id_paciente, items, version_number: 1, created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction });
      const item = dto(row, ctx);
      await db.PatientClinicalMedicationRevision.create({ medication_id: row.id, version_number: row.version_number, snapshot: item, command_key: key, command_hash: hash, clinic_id: ctx.clinicId, actor_id: ctx.actorId }, { transaction });
      let linkedEpisode;
      if (episode) {
        const refs = (parse(episode.material_refs) || []).filter(ref => !(ref.kind === 'medication' && ref.id === row.public_id));
        refs.push({ kind: 'medication', id: row.public_id, version: Number(row.version_number) });
        linkedEpisode = (await episodes.saveInTransaction({ id: episode.public_id, clinicId: ctx.clinicId, actorId: ctx.actorId,
          payload: { expected_version: payload.expected_episode_version, idempotency_key: `medication-link-${C.hash(key)}`, material_refs: refs }, transaction })).item;
      }
      return { item, ...(linkedEpisode ? { episode: linkedEpisode } : {}), replayed: false };
    });
  }
  return { read, update };
}
let singleton;
module.exports = { medicationItems, createPatientClinicalMedicationService, ...Object.fromEntries(['read', 'update'].map(method => [method, input => { singleton ||= createPatientClinicalMedicationService({ db: require('../../models') }); return singleton[method](input); }])) };
