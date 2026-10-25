'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const C = require('../lib/clinical-episode-contract');
const Context = require('./clinicalEpisodeServiceContext.service');
const clone = value => JSON.parse(JSON.stringify(value));
function createService({ db = require('../../models'), canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) } = {}) {
  const Head = db.ClinicalTreatmentTemplateDefault, Revision = db.ClinicalTreatmentTemplateDefaultRevision;
  const templates = require('./clinicalEpisodeTemplates.service').createClinicalEpisodeTemplateService({ db });
  const contexts = Context.createService({ db, canAccess });
  async function authorize(input, writing = false, patient = false) {
    const actorId = C.integer(input.actorId, 'actor_id'), clinicId = C.integer(input.clinicId, 'clinic_id');
    const features = ['clinical.reports.view', ...(writing ? ['clinic.settings.edit'] : []), ...(patient ? ['patients.view','patients.sensitive.view'] : [])];
    if ((await Promise.all(features.map(featureKey => canAccess({ actorId, clinicId, featureKey })))).some(value => !value)) throw C.error(403, 'access_policy_forbidden', 'No tienes permiso para estas preferencias clínicas.');
    return { actorId, clinicId };
  }
  const dto = row => ({ id: row.public_id, clinic_id: Number(row.clinic_id), treatment_id: Number(row.treatment_id),
    treatment_title: row.treatment_title, version: Number(row.version_number), enabled: !!row.enabled,
    template_ref: row.template_ref || null, template_title: row.template_title || null, updated_at: row.updated_at, updated_by: Number(row.updated_by) });
  async function available(row, transaction) {
    if (!row.enabled) return { ...dto(row), available: false, reason: 'disabled' };
    try {
      await contexts.treatment(Number(row.treatment_id), Number(row.clinic_id), transaction);
      await templates.resolveReference(row.template_ref, Number(row.clinic_id), transaction);
      return { ...dto(row), available: true };
    } catch (error) {
      if (![404,409].includes(error.statusCode)) throw error;
      return { ...dto(row), available: false, reason: String(error.code).includes('treatment') ? 'treatment_unavailable'
        : error.code === 'clinical_template_archived' ? 'template_archived' : 'template_unavailable' };
    }
  }
  function reference(value) {
    if (value === null) return null;
    if (!C.object(value) || Object.keys(value).some(key => !['id','version'].includes(key)) || typeof value.id !== 'string'
      || !/^(?:builtin:)?[A-Za-z0-9_-]{1,80}$/.test(value.id)) throw C.error(400, 'clinical_template_reference_invalid', 'Selecciona una versión válida de la plantilla.');
    return { id: value.id, version: C.integer(value.version, 'version') };
  }
  async function save(input) {
    const { actorId, clinicId } = await authorize(input, true), treatmentId = C.integer(input.treatmentId, 'treatment_id'), p = input.payload;
    if (!C.object(p) || Object.keys(p).some(key => !['expected_version','idempotency_key','enabled','template_ref'].includes(key))
      || typeof p.enabled !== 'boolean') throw C.error(400, 'clinical_template_default_invalid', 'Revisa la preferencia de primera consulta.');
    if (!Number.isSafeInteger(p.expected_version) || p.expected_version < 0) throw C.error(428, 'clinical_template_default_version_required', 'Actualiza la preferencia antes de guardar.');
    const key = C.idempotencyKey(p.idempotency_key, true), ref = C.has(p,'template_ref') ? reference(p.template_ref) : undefined;
    const hash = C.hash({ clinicId, treatmentId, actorId, expected_version: p.expected_version, enabled: p.enabled, template_ref: ref });
    return db.sequelize.transaction(async transaction => {
      // The clinic mutex also serializes a previously absent preference and its
      // globally scoped command key. Never gap-lock a missing receipt.
      const clinic = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!clinic) throw C.error(404, 'clinic_not_found', 'Clínica no encontrada.');
      const prior = await Revision.findOne({ where: { clinic_id: clinicId, actor_id: actorId, command_key: key }, transaction, lock: transaction.LOCK.SHARE });
      if (prior) {
        if (prior.command_hash !== hash) throw C.error(409, 'clinical_template_default_request_conflict', 'Esta solicitud ya guardó otra preferencia.', { applied: false });
        return { item: prior.snapshot, replayed: true };
      }
      let row = await Head.findOne({ where: { clinic_id: clinicId, treatment_id: treatmentId }, transaction, lock: transaction.LOCK.UPDATE });
      const version = Number(row?.version_number || 0);
      if (version !== p.expected_version) throw C.error(409, 'clinical_template_default_version_conflict', 'La preferencia ha cambiado. Actualiza antes de guardar.', { applied: false, current_version: version });
      const treatment = !row || p.enabled ? await contexts.treatment(treatmentId, clinicId, transaction) : null;
      const selected = ref === undefined ? row?.template_ref || null : ref;
      if (p.enabled && !selected) throw C.error(400, 'clinical_template_default_template_required', 'Selecciona la plantilla de primera consulta.');
      let template;
      if (selected && (p.enabled || JSON.stringify(selected) !== JSON.stringify(row?.template_ref))) template = await templates.resolveReference(selected, clinicId, transaction);
      const values = { enabled: p.enabled, template_ref: selected, treatment_title: treatment?.nombre || row.treatment_title,
        template_title: template?.title || (selected ? row?.template_title : null), version_number: version + 1, updated_by: actorId };
      if (row) await row.update(values, { transaction });
      else row = await Head.create({ ...values, public_id: crypto.randomUUID(), clinic_id: clinicId, treatment_id: treatmentId, created_by: actorId }, { transaction });
      const snapshot = clone({ ...dto(row), available: p.enabled, ...(!p.enabled ? { reason: 'disabled' } : {}) });
      await Revision.create({ preference_id: row.id, clinic_id: clinicId, version_number: version + 1, snapshot,
        actor_id: actorId, command_key: key, command_hash: hash }, { transaction });
      return { item: snapshot, replayed: false };
    });
  }
  async function list(input) {
    const { clinicId } = await authorize(input), query = input.query || {}, limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_template_default_limit', 'Solicita como máximo cien preferencias.');
    const templateId = query.template_id == null ? null : String(query.template_id);
    if (templateId !== null) reference({ id: templateId, version: 1 });
    const scope = C.hash([clinicId,templateId]), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_template_default_cursor', 'La página no corresponde a esta búsqueda.');
    const rows = await Head.findAll({ where: { clinic_id: clinicId, ...(templateId ? { template_ref: { id: templateId } } : {}),
      ...(cursor ? { id: { [Op.gt]: C.integer(cursor.id) } } : {}) }, order: [['id','ASC']], limit: limit + 1 });
    const page = rows.slice(0,limit);
    return { items: await Promise.all(page.map(row => available(row))), next_cursor: rows.length > limit ? C.encodeCursor({ scope, id: Number(page.at(-1).id) }) : null };
  }
  async function treatments(input) {
    const { clinicId } = await authorize(input), query = input.query || {}, q = C.text(query.q || '', 'search', 160) || '';
    const limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_template_default_limit', 'Solicita como máximo cien tratamientos.');
    const scope = C.hash([clinicId,q]), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_template_default_cursor', 'La página no corresponde a esta búsqueda.');
    const clinic = await db.Clinica.findByPk(clinicId); if (!clinic) throw C.error(404, 'clinic_not_found', 'Clínica no encontrada.');
    const groupClinics = clinic.grupoClinicaId ? await db.Clinica.findAll({ where: { grupoClinicaId: clinic.grupoClinicaId }, attributes: ['id_clinica'] }) : [];
    const group = clinic.grupoClinicaId ? [{ origen: 'grupo', [Op.or]: [{ grupo_clinica_id: clinic.grupoClinicaId },
      { grupo_clinica_id: { [Op.or]: [null,0] }, clinica_id: { [Op.in]: groupClinics.map(row => Number(row.id_clinica)) } }] }] : [];
    const base = { activo: true, [Op.or]: [{ origen:'sistema' },{ origen:'clinica',clinica_id:clinicId },...group],
      ...(q ? { nombre: { [Op.like]: '%' + q.replace(/[\\%_]/g,'\\$&') + '%' } } : {}) };
    let after = cursor ? C.integer(cursor.id) : 0, exhausted = false, scanned = 0; const items = [];
    while (items.length <= limit && scanned < 1000) {
      const rows = await db.Tratamiento.findAll({ where: { ...base, ...(after ? { id_tratamiento: { [Op.gt]: after } } : {}) }, order: [['id_tratamiento','ASC']], limit: limit + 1 });
      if (!rows.length) { exhausted = true; break; }
      for (const row of rows) {
        after = Number(row.id_tratamiento); scanned++;
        try { await contexts.treatment(after, clinicId); items.push({ id: after, title: row.nombre, area_key: Context.area(row.disciplina) }); }
        catch (error) { if (![404,409].includes(error.statusCode)) throw error; }
        if (items.length > limit) break;
      }
      if (rows.length < limit + 1 && items.length <= limit) { exhausted = true; break; }
    }
    const page = items.slice(0,limit), ids = page.map(row => row.id);
    const heads = ids.length ? await Head.findAll({ where: { clinic_id: clinicId, treatment_id: { [Op.in]: ids } } }) : [];
    const defaults = new Map(await Promise.all(heads.map(async row => [Number(row.treatment_id),await available(row)])));
    return { items: page.map(row => ({ ...row, current_default: defaults.get(row.id) || null })), next_cursor: !exhausted || items.length > limit
      ? C.encodeCursor({ scope, id: items.length > limit ? page.at(-1).id : after }) : null };
  }
  async function patient(identifier, clinicId, transaction) {
    const value = String(identifier || '');
    if (!value || value.length > 80) throw C.error(400,'clinical_episode_invalid_patient','Selecciona un paciente válido.');
    const row = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(value) ? { id_paciente:C.integer(value) } : { public_id:value }, transaction });
    if (!row || Number(row.clinica_id) !== clinicId && !await db.PacienteClinica.findOne({ where:{ paciente_id:row.id_paciente,clinica_id:clinicId },transaction })) throw C.error(404,'clinical_episode_patient_not_found','Paciente no encontrado en esta clínica.');
    return row;
  }
  async function resolveInitial({ clinicId, patientId, actorId, payload, appointments = [], serviceContext, transaction }) {
    // A selected canonical origin wins; an unresolved multi-service visit must
    // never fall through to a treatment-wide default based on the first row.
    const selected = Context.identity(serviceContext?.service_ref), candidates = [];
    if (!selected) for (const appointment of appointments) for (const item of await contexts.candidates(appointment, { clinicId,patientId,actorId,transaction })) {
      if (!candidates.some(existing => Context.same(existing,item))) candidates.push(item);
    }
    if (candidates.length > 1) return { item:null,reason:'ambiguous_context' };
    const pinnedTreatment = selected && serviceContext?.service_ref?.treatment_id;
    const ids = [...new Set((pinnedTreatment ? [pinnedTreatment] : [serviceContext?.treatment_id,...appointments.map(row => row.tratamiento_id)]).filter(Boolean).map(Number))];
    if (ids.length > 1) return { item:null,reason:'ambiguous_context' };
    const treatmentId = ids[0];
    if (!treatmentId) return { item:null,reason:'treatment_required' };
    // Catalog scope/lifecycle is checked again; a contracted historic treatment
    // remains documentable manually but is never silently assigned new text.
    try { await contexts.treatment(treatmentId,clinicId,transaction); }
    catch (error) { if ([404,409].includes(error.statusCode)) return { item:null,reason:'treatment_unavailable' }; throw error; }
    const where = { clinic_id:clinicId,patient_id:patientId,...(selected ? { service_ref:selected } : { treatment_id:treatmentId }) };
    const existing = await db.AppointmentClinicalReport.findOne({ where, attributes:['id'], transaction,
      ...(transaction ? { lock:transaction.LOCK.SHARE } : {}) });
    if (existing) return { item:null,reason:'not_first' };
    const row = await Head.findOne({ where:{clinic_id:clinicId,treatment_id:treatmentId},transaction,...(transaction ? {lock:transaction.LOCK.SHARE}: {}) });
    if (!row || !row.enabled) return { item:null,reason:row ? 'disabled' : 'not_configured' };
    const state = await available(row,transaction); if (!state.available) return { item:null,reason:state.reason };
    const definition = await templates.resolveReference(row.template_ref,clinicId,transaction);
    return { item:{ preference_id:row.public_id,preference_version:Number(row.version_number),treatment_id:treatmentId,
      template_ref:clone(row.template_ref),template:definition,scope:selected ? 'service' : 'treatment',service_ref:selected } };
  }
  async function resolve(input) {
    const {clinicId,actorId}=await authorize(input,false,true), p=input.payload || {};
    if (!C.object(p) || Object.keys(p).some(key => !['appointment_ids','treatment_id','service_ref'].includes(key))) throw C.error(400,'clinical_template_default_invalid','Revisa el contexto de la consulta.');
    const row=await patient(input.patientIdentifier,clinicId), ids=C.appointmentIds(p.appointment_ids || []), appointments=[];
    for (const id of ids) {
      const appointment=await db.CitaPaciente.findByPk(id);
      if (!appointment || Number(appointment.clinica_id)!==clinicId || Number(appointment.paciente_id)!==Number(row.id_paciente)) throw C.error(404,'clinical_episode_appointment_not_found','Una cita no pertenece a este paciente y clínica.');
      appointments.push(appointment);
    }
    const serviceContext=await contexts.values({payload:p,primary:appointments[0],appointments,patientId:Number(row.id_paciente),clinicId,actorId,creating:true});
    return resolveInitial({clinicId,patientId:Number(row.id_paciente),actorId,payload:p,appointments,serviceContext});
  }
  return { list,treatments,save,resolve,resolveInitial };
}
module.exports = {createService,...Object.fromEntries(['list','treatments','save','resolve'].map(method => [method,input => createService()[method](input)]))};
