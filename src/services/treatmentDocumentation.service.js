'use strict';
const { catalogState } = require('../lib/treatment-catalog-contract');
const fail = (status, code, message) => Object.assign(new Error(message), { status, statusCode: status, code });
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const plain = row => row?.toJSON ? row.toJSON() : row;
function pagination(query) {
  const page = query.page == null ? 0 : Number(query.page);
  const size = query.page_size == null ? 25 : Number(query.page_size);
  if (!Number.isSafeInteger(page) || page < 0 || page > 10000 || !Number.isSafeInteger(size) || size < 1 || size > 50) throw fail(400, 'invalid_documentation_page', 'Página de documentos no válida.');
  return { page, size };
}
function normalizeProtocol(payload, previous = null) {
  const title = String(payload.title ?? previous?.title ?? '').trim();
  const kind = payload.kind ?? previous?.kind ?? 'protocol';
  const status = payload.status ?? previous?.status ?? 'draft';
  const content = String(payload.content ?? previous?.content ?? '').trim();
  const source = String(payload.source ?? previous?.source ?? '').trim() || null;
  const rawIds = payload.treatment_ids ?? previous?.treatment_ids ?? [];
  if (!title || title.length > 200 || content.length > 100000 || (source?.length || 0) > 500) throw fail(400, 'invalid_protocol', 'Revisa título, texto y procedencia del documento.');
  if (!['protocol', 'aftercare'].includes(kind) || !['draft', 'approved', 'archived'].includes(status)) throw fail(400, 'invalid_protocol', 'Tipo o estado documental no válido.');
  if (!Array.isArray(rawIds) || rawIds.length > 500 || rawIds.some(id => !positive(id))) throw fail(400, 'invalid_treatment_ids', 'Tratamientos asociados no válidos.');
  if (status === 'approved' && (!content || !source)) throw fail(400, 'protocol_approval_incomplete', 'Para aprobar, indica contenido y procedencia/referencia clínica.');
  return { title, kind, status, content, source, treatment_ids: [...new Set(rawIds.map(Number))] };
}

function createTreatmentDocumentationService(db = require('../../models')) {
  const { Op } = db.Sequelize;
  async function scope(clinicId) {
    const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
    if (!clinic) throw fail(404, 'clinic_not_found', 'Clínica no encontrada.');
    const branches = [{ origen: 'clinica', clinica_id: clinicId }, { origen: 'sistema' }];
    if (clinic.grupoClinicaId) branches.push({ origen: 'grupo', grupo_clinica_id: clinic.grupoClinicaId });
    return { [Op.or]: branches, [Op.and]: [
      db.Sequelize.where(db.Sequelize.fn('JSON_CONTAINS', db.Sequelize.fn('COALESCE', db.Sequelize.col('eliminado_por_clinica'), '[]'), JSON.stringify(Number(clinicId))), 0),
      db.Sequelize.where(db.Sequelize.fn('JSON_CONTAINS', db.Sequelize.fn('COALESCE', db.Sequelize.col('eliminado_por_clinica'), '[]'), JSON.stringify(String(clinicId))), 0),
    ] };
  }
  async function requireSchema() {
    try { await db.TreatmentProtocol.findOne({ attributes: ['id'], raw: true }); }
    catch (error) {
      if (['ER_NO_SUCH_TABLE', '42P01'].includes(error.original?.code || error.parent?.code)) throw fail(503, 'documentation_schema_pending', 'La biblioteca está pendiente de habilitación técnica. Los consentimientos existentes siguen disponibles.');
      throw error;
    }
  }
  async function validateTreatments(clinicId, ids, transaction) {
    if (!ids.length) return;
    const rows = await db.Tratamiento.findAll({ where: { ...(await scope(clinicId)), id_tratamiento: { [Op.in]: ids } }, attributes: ['id_tratamiento', 'eliminado_por_clinica', 'clinical_config'], transaction, raw: true });
    const allowed = rows.filter(row => !(row.eliminado_por_clinica || []).map(Number).includes(clinicId) && row.clinical_config?.catalog_status !== 'obsolete');
    if (allowed.length !== ids.length) throw fail(403, 'treatment_scope_mismatch', 'Algún tratamiento está obsoleto, oculto o no pertenece al catálogo de esta clínica.');
  }
  async function hydrateProtocols(rows, clinicId) {
    const ids = [...new Set(rows.flatMap(row => plain(row).treatment_ids || []))];
    const treatments = ids.length ? await db.Tratamiento.findAll({ where: { ...(await scope(clinicId)), id_tratamiento: { [Op.in]: ids } }, attributes: ['id_tratamiento', 'nombre'], raw: true }) : [];
    const names = new Map(treatments.map(row => [Number(row.id_tratamiento), row.nombre]));
    return rows.map(row => { const item = plain(row); return { ...item, treatments: item.treatment_ids.map(id => ({ id, name: names.get(Number(id)) || 'Tratamiento no disponible' })) }; });
  }
  return {
    async forAppointment({ clinicId, appointmentId, query = {} }) {
      if (!/^[1-9]\d*$/.test(String(appointmentId)) || !positive(appointmentId) || !positive(clinicId)) throw fail(400, 'invalid_appointment_context', 'Selecciona una cita y clínica válidas.');
      clinicId = Number(clinicId);
      const appointment = await db.CitaPaciente.findOne({
        where: { id_cita: Number(appointmentId), clinica_id: clinicId },
        attributes: ['id_cita', 'paciente_id', 'tratamiento_id'], raw: true,
      });
      if (!appointment) throw fail(404, 'appointment_not_found', 'Cita no encontrada en esta clínica.');
      const patient = await db.Paciente.findByPk(appointment.paciente_id, { attributes: ['id_paciente', 'clinica_id'], raw: true });
      const patientLinked = patient && (Number(patient.clinica_id) === clinicId || await db.PacienteClinica.findOne({
        where: { paciente_id: appointment.paciente_id, clinica_id: clinicId }, attributes: ['id'], raw: true,
      }));
      if (!patientLinked) throw fail(404, 'appointment_not_found', 'Cita no encontrada en esta clínica.');
      const base = {
        appointment_id: Number(appointment.id_cita), clinic_id: clinicId,
        treatment_id: appointment.tratamiento_id ? Number(appointment.tratamiento_id) : null,
        treatment_name: null, context_source: 'current_approved_catalog', persisted_for_appointment: false,
        items: [], draft_count: 0, unavailable_count: 0, total: 0, page: 0, page_size: 5, has_more: false,
      };
      if (!appointment.tratamiento_id) return { ...base, documentation_status: 'no_treatment' };
      const treatment = await db.Tratamiento.findOne({
        where: { ...(await scope(clinicId)), id_tratamiento: appointment.tratamiento_id },
        attributes: ['id_tratamiento', 'nombre'], raw: true,
      });
      if (!treatment) return { ...base, documentation_status: 'treatment_unavailable' };
      await requireSchema();
      const page = query.page == null ? 0 : Number(query.page);
      const pageSize = query.page_size == null ? 5 : Number(query.page_size);
      if (!Number.isSafeInteger(page) || page < 0 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) throw fail(400, 'invalid_documentation_page', 'Página de documentos no válida.');
      const where = { clinic_id: clinicId, kind: { [Op.in]: ['protocol', 'aftercare'] },
        [Op.and]: [db.Sequelize.where(db.Sequelize.fn('JSON_CONTAINS', db.Sequelize.col('treatment_ids'), JSON.stringify(Number(appointment.tratamiento_id))), 1)],
      };
      const [{ rows, count }, draftCount] = await Promise.all([
        db.TreatmentProtocol.findAndCountAll({ where: { ...where, status: 'approved' }, attributes: ['id', 'version'], order: [['id', 'ASC']], limit: pageSize, offset: page * pageSize, raw: true }),
        db.TreatmentProtocol.count({ where: { ...where, status: 'draft' } }),
      ]);
      const revisions = rows.length ? await db.TreatmentProtocolRevision.findAll({
        where: { [Op.or]: rows.map(row => ({ protocol_id: row.id, version: row.version })) }, attributes: ['protocol_id', 'version', 'snapshot'], raw: true,
      }) : [];
      const indexed = new Map(revisions.map(revision => [`${revision.protocol_id}:${revision.version}`, revision.snapshot]));
      let unavailable = 0;
      const items = rows.map(row => {
        const snapshot = indexed.get(`${row.id}:${row.version}`);
        // Do not fall back to mutable/current text or a draft when the exact approval snapshot is missing.
        if (!snapshot || Number(snapshot.id) !== Number(row.id) || Number(snapshot.clinic_id) !== clinicId
          || Number(snapshot.version) !== Number(row.version) || snapshot.status !== 'approved'
          || !Array.isArray(snapshot.treatment_ids) || !snapshot.treatment_ids.map(Number).includes(Number(appointment.tratamiento_id))
          || !['protocol', 'aftercare'].includes(snapshot.kind) || typeof snapshot.content !== 'string' || !snapshot.content.trim()
          || !snapshot.approved_by || !snapshot.approved_at) {
          unavailable++;
          return null;
        }
        return { id: Number(row.id), version: Number(row.version), kind: snapshot.kind, title: snapshot.title,
          content: snapshot.content, source: snapshot.source || null, approved_at: snapshot.approved_at, status: 'approved' };
      }).filter(Boolean);
      return { ...base, documentation_status: 'available', treatment_name: treatment.nombre, items,
        draft_count: Number(draftCount), unavailable_count: unavailable, total: Number(count), page, page_size: pageSize,
        has_more: (page + 1) * pageSize < Number(count) };
    },
    async options({ clinicId, query = {} }) {
      const where = { ...(await scope(clinicId)), activo: true };
      if (query.q) where.nombre = { [Op.like]: `%${String(query.q).slice(0, 120)}%` };
      const rows = await db.Tratamiento.findAll({ where, attributes: ['id_tratamiento', 'nombre'], limit: 50, order: [['nombre', 'ASC'], ['id_tratamiento', 'ASC']], raw: true });
      return { items: rows.map(row => ({ id: row.id_tratamiento, name: row.nombre })) };
    },
    async coverage({ clinicId, query = {} }) {
      const { page, size } = pagination(query);
      const where = { ...(await scope(clinicId)), activo: true };
      if (query.q) where.nombre = { [Op.like]: `%${String(query.q).slice(0, 120)}%` };
      const { rows, count } = await db.Tratamiento.findAndCountAll({ where, attributes: ['id_tratamiento', 'nombre', 'disciplina', 'clinical_config', 'activo'], order: [['nombre', 'ASC'], ['id_tratamiento', 'ASC']], limit: size, offset: page * size, raw: true });
      const ids = rows.map(row => row.id_tratamiento);
      const requirements = ids.length ? await db.TreatmentConsentRequirement.findAll({ where: { tratamiento_id: { [Op.in]: ids }, [Op.or]: [{ clinica_id: clinicId }, { clinica_id: null }] },
        include: [
          { model: db.ClinicConsentTemplate, as: 'clinicTemplate', attributes: ['id', 'name', 'purpose', 'status', 'clinic_id'], required: false },
          { model: db.ConsentTemplateCatalog, as: 'catalogTemplate', attributes: ['id', 'name', 'purpose', 'status'], required: false },
        ], order: [['sort_order', 'ASC']] }) : [];
      let protocols = [], protocolsAvailable = true;
      try { protocols = ids.length ? await db.TreatmentProtocol.findAll({ where: { clinic_id: clinicId, status: { [Op.ne]: 'archived' },
        [Op.or]: ids.map(id => db.Sequelize.where(db.Sequelize.fn('JSON_CONTAINS', db.Sequelize.col('treatment_ids'), JSON.stringify(Number(id))), 1)),
      }, attributes: ['id', 'title', 'kind', 'status', 'version', 'treatment_ids'], raw: true }) : []; }
      catch (error) { if (['ER_NO_SUCH_TABLE', '42P01'].includes(error.original?.code || error.parent?.code)) protocolsAvailable = false; else throw error; }
      const items = rows.map(row => {
        const consents = requirements.filter(req => Number(req.tratamiento_id) === Number(row.id_tratamiento)).map(req => {
          const template = req.clinicTemplate || req.catalogTemplate;
          if (!template || (req.clinicTemplate && Number(template.clinic_id) !== clinicId)) return null;
          return { id: template.id, name: template.name, purpose: template.purpose, status: template.status, source: req.clinicTemplate ? 'clinic' : 'catalog', required: req.required, blocking_policy: req.blocking_policy };
        }).filter(Boolean);
        const linked = protocols.filter(doc => (doc.treatment_ids || []).map(Number).includes(Number(row.id_tratamiento))).map(({ treatment_ids, ...doc }) => doc);
        return { id: row.id_tratamiento, name: row.nombre, discipline: row.disciplina, ...catalogState(row), consents,
          has_active_clinical_consent: consents.some(c => c.purpose === 'clinical' && c.status === 'active'),
          protocols: linked.filter(p => p.kind === 'protocol'), aftercare: linked.filter(p => p.kind === 'aftercare') };
      });
      return { items, page, page_size: size, total: count, protocols_available: protocolsAvailable, scope_note: 'Asociaciones explícitas al tratamiento; no acredita la firma del paciente ni sustituye la evaluación de requisitos al citar.' };
    },
    async list({ clinicId, query = {} }) {
      await requireSchema();
      const { page, size } = pagination(query);
      const where = { clinic_id: clinicId };
      if (query.kind && ['protocol', 'aftercare'].includes(query.kind)) where.kind = query.kind;
      if (query.q) where.title = { [Op.like]: `%${String(query.q).slice(0, 120)}%` };
      const { rows, count } = await db.TreatmentProtocol.findAndCountAll({ where, attributes: { exclude: ['content'] }, order: [['title', 'ASC'], ['id', 'ASC']], limit: size, offset: page * size });
      return { items: await hydrateProtocols(rows, clinicId), page, page_size: size, total: count };
    },
    async get({ clinicId, id, version }) {
      await requireSchema();
      const item = await db.TreatmentProtocol.findOne({ where: { id, clinic_id: clinicId } });
      if (!item) throw fail(404, 'protocol_not_found', 'Documento no encontrado.');
      if (version != null) {
        const revision = await db.TreatmentProtocolRevision.findOne({ where: { protocol_id: item.id, version: positive(version) || -1 } });
        if (!revision) throw fail(404, 'revision_not_found', 'Versión no encontrada.');
        return { item: (await hydrateProtocols([revision.snapshot], clinicId))[0] };
      }
      return { item: (await hydrateProtocols([item], clinicId))[0] };
    },
    async save({ clinicId, actorId, id = null, payload }) {
      await requireSchema();
      return db.sequelize.transaction(async transaction => {
        const previous = id ? await db.TreatmentProtocol.findOne({ where: { id, clinic_id: clinicId }, transaction, lock: transaction.LOCK.UPDATE }) : null;
        if (id && !previous) throw fail(404, 'protocol_not_found', 'Documento no encontrado.');
        if (previous && Number(payload.expected_version) !== Number(previous.version)) throw fail(409, 'protocol_version_conflict', 'El documento ha cambiado. Recárgalo antes de guardar.');
        const normalized = normalizeProtocol(payload, previous);
        await validateTreatments(clinicId, normalized.treatment_ids, transaction);
        // Any substantive edit of an approved document becomes a new draft, never silently approved.
        const changed = previous && ['title', 'kind', 'content', 'source'].some(key => normalized[key] !== previous[key]);
        if (changed && previous.status === 'approved' && normalized.status === 'approved') normalized.status = 'draft';
        const values = { ...normalized, clinic_id: clinicId, version: previous ? previous.version + 1 : 1, updated_by: actorId,
          approved_by: normalized.status === 'approved' ? actorId : null, approved_at: normalized.status === 'approved' ? new Date() : null };
        const item = previous ? await previous.update(values, { transaction }) : await db.TreatmentProtocol.create({ ...values, created_by: actorId }, { transaction });
        await db.TreatmentProtocolRevision.create({ protocol_id: item.id, version: item.version, snapshot: plain(item), actor_id: actorId }, { transaction });
        return { item: (await hydrateProtocols([item], clinicId))[0] };
      });
    },
  };
}
module.exports = { createTreatmentDocumentationService, normalizeProtocol, pagination, fail };
