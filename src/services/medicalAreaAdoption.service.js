'use strict';
const { Op } = require('sequelize');
const { compareAreaContracts } = require('../lib/medical-area-adoption-review');
const { normalizeClinicConfigurationForRead } = require('../lib/clinic-configuration');
function problem(code, statusCode = 409) { return Object.assign(Error(code), { code, statusCode }); }
function id(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw problem('medical_area_id_invalid', 400);
  return Number(value);
}
function createMedicalAreaAdoptionService(models, { exposeRevision, contractHash }) {
  const { Clinica, MedicalAreaContract: Head, ClinicMedicalAreaContract: Pin,
    MedicalAreaContractRevision: Revision, MedicalAreaAdoption: Journal, sequelize } = models;
  async function load(clinicId, code, targetId, transaction, lock = false) {
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(code)) throw problem('medical_area_code_invalid', 400);
    const query = { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) };
    const clinic = await Clinica.findByPk(id(clinicId), query);
    if (!clinic) throw problem('medical_area_clinic_not_found', 404);
    const head = await Head.findOne({ where: { code, active: true }, ...query });
    if (!head) throw problem('medical_area_not_configured', 404);
    const pin = await Pin.findOne({ where: { clinic_id: clinic.id_clinica, code }, ...query });
    const target = await Revision.findByPk(targetId == null ? head.revision_id : id(targetId), { transaction });
    if (!target || target.code !== code) throw problem('medical_area_revision_scope_mismatch', 422);
    const current = pin ? await Revision.findByPk(pin.revision_id, { transaction }) : null;
    if (pin && (!current || current.code !== code)) throw problem('medical_area_revision_corrupt', 503);
    const currentContract = current ? exposeRevision(current) : null;
    const targetContract = exposeRevision(target);
    const assessment = compareAreaContracts(currentContract, targetContract);
    const reviewHash = contractHash({ clinic: Number(clinic.id_clinica), code,
      current: current?.content_hash || null, target: target.content_hash,
      current_id: current?.id || null, target_id: target.id, latest_id: head.revision_id,
      local_config: clinic.configuracion || null, policy: assessment.policy_version });
    const config = normalizeClinicConfigurationForRead(clinic.configuracion);
    const enabled = config.disciplinas.includes(code);
    return { clinic, pin, head, current, target, review: {
      clinic: { id: Number(clinic.id_clinica), name: clinic.nombre_clinica }, code,
      area_label: targetContract.profile.label, enabled_in_clinic: enabled,
      current_revision: currentContract?.revision || null, target_revision: targetContract.revision,
      latest_revision_id: Number(head.revision_id), review_hash: reviewHash,
      ...assessment, can_apply: assessment.compatible && Number(pin?.revision_id) !== Number(target.id),
      direction: !current ? 'initial' : target.revision_number < current.revision_number ? 'previous' : 'update',
      ...(!enabled ? { inactive_notice: 'Esta base no activa el área ni cambia las especialidades de la clínica.' } : {}),
    } };
  }
  async function review(clinicId, code, revisionId) {
    return sequelize.transaction(async transaction => (await load(clinicId, code, revisionId, transaction)).review);
  }
  async function adopt(clinicId, code, { revisionId, expectedRevisionId, actorId, reviewHash, acknowledged, reason }) {
    const actor = id(actorId), targetId = id(revisionId);
    if (expectedRevisionId === undefined) throw problem('medical_area_revision_required', 428);
    const expected = expectedRevisionId === null ? null : id(expectedRevisionId);
    if (acknowledged !== true || !/^[a-f0-9]{64}$/.test(reviewHash || '')) throw problem('medical_area_review_required', 428);
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) throw problem('medical_area_reason_required', 422);
    return sequelize.transaction(async transaction => {
      const state = await load(clinicId, code, targetId, transaction, true);
      if ((state.pin ? Number(state.pin.revision_id) : null) !== expected) throw problem('medical_area_revision_conflict');
      if (state.review.review_hash !== reviewHash) throw problem('medical_area_review_stale');
      if (!state.review.compatible) throw problem('medical_area_update_incompatible', 422);
      if (!state.review.can_apply) return exposeRevision(state.target);
      const update = { revision_id: targetId, previous_revision_id: expected, updated_by: actor };
      if (state.pin) await state.pin.update(update, { transaction });
      else await Pin.create({ clinic_id: id(clinicId), code, ...update }, { transaction });
      // Failure to record the review rolls back the clinic assignment too.
      await Journal.create({ clinic_id: id(clinicId), code, previous_revision_id: expected,
        revision_id: targetId, actor_id: actor, review_hash: reviewHash,
        review_json: state.review, reason: reason.trim() }, { transaction });
      return exposeRevision(state.target);
    });
  }
  async function list({ search = '', page = 0, pageSize = 20, clinicId = null } = {}) {
    const index = Number(page), size = Number(pageSize);
    if (!Number.isInteger(index) || index < 0 || index > 100000 || !Number.isInteger(size) || size < 1 || size > 50
      || typeof search !== 'string' || search.length > 100) throw problem('medical_area_pagination_invalid', 400);
    return sequelize.transaction(async transaction => {
      const where = clinicId != null ? { id_clinica: id(clinicId) } : search.trim() ? { nombre_clinica: { [Op.like]: '%' + search.trim() + '%' } } : {};
      const { count, rows } = await Clinica.findAndCountAll({ where, attributes: ['id_clinica', 'nombre_clinica', 'configuracion'],
        order: [['nombre_clinica', 'ASC'], ['id_clinica', 'ASC']], limit: size, offset: index * size, transaction });
      const include = [{ model: Revision, as: 'revision', required: true }];
      const heads = await Head.findAll({ where: { active: true }, include, order: [['code', 'ASC']], transaction });
      const pins = rows.length ? await Pin.findAll({ where: { clinic_id: { [Op.in]: rows.map(c => c.id_clinica) } }, include, transaction }) : [];
      const latest = new Map(heads.map(h => [h.code, exposeRevision(h.revision)]));
      const byClinic = new Map();
      for (const pin of pins) {
        if (pin.revision.code !== pin.code) throw problem('medical_area_revision_corrupt', 503);
        if (!byClinic.has(pin.clinic_id)) byClinic.set(pin.clinic_id, new Map());
        byClinic.get(pin.clinic_id).set(pin.code, exposeRevision(pin.revision));
      }
      return { total: count, page: index, page_size: size, items: rows.map(clinic => {
        const configured = normalizeClinicConfigurationForRead(clinic.configuracion).disciplinas;
        const assigned = byClinic.get(clinic.id_clinica) || new Map();
        const areas = [...new Set([...latest.keys(), ...assigned.keys(), ...configured])].map(code => {
          const current = assigned.get(code), next = latest.get(code);
          return { code, label: next?.profile.label || current?.profile.label || code,
            enabled_in_clinic: configured.includes(code), current_revision: current?.revision || null,
            latest_revision: next?.revision || null,
            status: !next ? 'unavailable' : !current ? 'not_assigned' : current.revision.id === next.revision.id ? 'current' : 'update_available' };
        });
        return { id: Number(clinic.id_clinica), name: clinic.nombre_clinica, areas,
          updates_available: areas.filter(a => a.enabled_in_clinic && a.status === 'update_available').length,
          missing_assignments: areas.filter(a => a.enabled_in_clinic && ['not_assigned', 'unavailable'].includes(a.status)).length };
      }) };
    });
  }
  async function history(clinicId, code) {
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(code)) throw problem('medical_area_code_invalid', 400);
    const clinic = id(clinicId);
    if (!await Clinica.findByPk(clinic, { attributes: ['id_clinica'] })) throw problem('medical_area_clinic_not_found', 404);
    const rows = await Journal.findAll({ where: { clinic_id: clinic, code }, order: [['id', 'DESC']], limit: 50,
      attributes: ['id', 'previous_revision_id', 'revision_id', 'actor_id', 'createdAt', 'reason'], raw: true });
    const versions = await Revision.findAll({ where: { code }, order: [['revision_number', 'DESC']], limit: 50,
      attributes: ['id', 'revision_number', 'createdAt'], raw: true });
    return { items: rows, versions };
  }
  return { review, adopt, list, history };
}
module.exports = { createMedicalAreaAdoptionService };
