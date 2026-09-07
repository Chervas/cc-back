'use strict';

const crypto = require('node:crypto');
const { Op, literal } = require('sequelize');
const contract = require('../lib/treatmentPrograms.contract');
const { domainError, positiveInteger, boundedText, normalizeValues, filters, treatmentDto, summarize, payloadHash } = contract;
const plain = (row) => row?.toJSON ? row.toJSON() : row;
const decode = (value, fallback) => { if (value == null) return fallback; if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return fallback; } };

function createTreatmentProgramsService({ db, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  const { TreatmentProgram, TreatmentProgramRevision, Tratamiento, Clinica, Instalacion, DoctorClinica } = db;
  async function clinicContext(clinicId, transaction, lock = false) {
    const clinic = await Clinica.findOne({ where: { id_clinica: positiveInteger(clinicId, 'clinic_id') }, attributes: ['id_clinica', 'grupoClinicaId'], transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!clinic) throw domainError(404, 'program_clinic_not_found', 'Clínica no encontrada.');
    return clinic;
  }
  function treatmentScope(clinic) {
    const scopes = [{ origen: 'clinica', clinica_id: Number(clinic.id_clinica) }, { origen: 'sistema', clinica_id: null }];
    if (clinic.grupoClinicaId) scopes.push({ origen: 'grupo', grupo_clinica_id: Number(clinic.grupoClinicaId) });
    const id = positiveInteger(clinic.id_clinica);
    // Numeric ID already validated; SQL is static apart from that integer.
    return { [Op.or]: scopes, [Op.and]: [literal(`NOT (JSON_CONTAINS(COALESCE(eliminado_por_clinica, JSON_ARRAY()), JSON_ARRAY(${id})) OR JSON_CONTAINS(COALESCE(eliminado_por_clinica, JSON_ARRAY()), JSON_ARRAY('${id}')))`)] };
  }
  async function enrichTreatments(rows, clinicId, transaction) {
    const values = rows.map(treatmentDto);
    const installationIds = [...new Set(values.flatMap((t) => t.booking_profile?.phases.flatMap((p) => p.installation_ids) || []))];
    const professionalIds = [...new Set(values.flatMap((t) => t.booking_profile?.phases.flatMap((p) => p.professionals.ids) || []))];
    const [installations, professionals] = await Promise.all([
      installationIds.length ? Instalacion.findAll({ where: { id: { [Op.in]: installationIds }, clinica_id: clinicId, activo: true }, attributes: ['id'], transaction }) : [],
      professionalIds.length ? DoctorClinica.findAll({ where: { doctor_id: { [Op.in]: professionalIds }, clinica_id: clinicId, activo: true, recibe_citas: true }, attributes: ['doctor_id'], transaction }) : [],
    ]);
    const availableInstallations = new Set(installations.map((i) => Number(i.id)));
    const availableProfessionals = new Set(professionals.map((p) => Number(p.doctor_id)));
    for (const treatment of values) {
      const phases = treatment.booking_profile?.phases || [];
      if (phases.some((p) => p.installation_ids.some((id) => !availableInstallations.has(id)))) treatment.issues.push({ code: 'installation_unavailable', message: 'Una cabina del tratamiento no está activa o disponible en esta clínica.' });
      if (phases.some((p) => p.professionals.ids.some((id) => !availableProfessionals.has(id)))) treatment.issues.push({ code: 'professional_unavailable', message: 'Un profesional del tratamiento no recibe citas en esta clínica.' });
      treatment.booking_ready = treatment.issues.length === 0;
    }
    return values;
  }
  async function treatmentMap(rows, clinic, transaction) {
    const ids = [...new Set(rows.flatMap((r) => decode(r.appointments, []).flatMap((a) => a.treatment_ids || [])))];
    if (!ids.length) return new Map();
    const treatments = await Tratamiento.findAll({ where: { ...treatmentScope(clinic), id_tratamiento: { [Op.in]: ids } }, transaction });
    return new Map((await enrichTreatments(treatments, Number(clinic.id_clinica), transaction)).map((r) => [r.id, r]));
  }
  function serialize(row, map) {
    const value = plain(row);
    const normalized = { name: value.name, kind: value.kind, status: value.status, total_price: value.total_price == null ? null : Number(value.total_price), notes: value.notes || null, appointments: decode(value.appointments, []) };
    const resolved = summarize(normalized, map);
    return { id: value.public_id, clinic_id: Number(value.clinic_id), ...normalized, appointments: resolved.appointments, version: Number(value.version_number), price_semantics: 'gross_tax_included', currency: 'EUR', summary: resolved.summary, can_schedule: false, purchase_enabled: false, created_at: value.created_at, updated_at: value.updated_at };
  }
  async function scopedRow(id, clinicId, transaction, lock = false) {
    const row = await TreatmentProgram.findOne({ where: { public_id: boundedText(id, 'id', 36, true), clinic_id: clinicId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw domainError(404, 'program_not_found', 'Programa o bono no encontrado en esta clínica.');
    return row;
  }
  async function validateActive(values, clinic, transaction) {
    const map = await treatmentMap([values], clinic, transaction);
    const validation = summarize(values, map);
    if (values.status === 'active' && validation.summary.issues.length) throw domainError(422, 'program_not_ready', 'Completa las incidencias antes de activar el catálogo. Puedes guardarlo como borrador.', { issues: validation.summary.issues });
    return map;
  }
  async function revision(row, actorId, transaction) {
    await TreatmentProgramRevision.create({ program_id: row.id, version_number: row.version_number, snapshot: plain(row), actor_id: actorId, created_at: now() }, { transaction });
  }
  async function list({ clinicId, query = {} }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const clinic = await clinicContext(clinicId);
    const paging = filters(query);
    const where = { clinic_id: clinicId, ...(paging.kind ? { kind: paging.kind } : {}), ...(paging.status ? { status: paging.status } : {}) };
    if (paging.q) where.name = { [Op.like]: `%${paging.q.replace(/[\\%_]/g, '\\$&')}%` };
    const [rows, total] = await Promise.all([
      TreatmentProgram.findAll({ where, order: [['id', 'DESC']], offset: (paging.page - 1) * paging.pageSize, limit: paging.pageSize }),
      TreatmentProgram.count({ where }),
    ]);
    const map = await treatmentMap(rows, clinic);
    return { items: rows.map((r) => serialize(r, map)), total: Number(total), page: paging.page, page_size: paging.pageSize };
  }
  async function get({ id, clinicId }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const clinic = await clinicContext(clinicId);
    const row = await scopedRow(id, clinicId);
    return { item: serialize(row, await treatmentMap([row], clinic)) };
  }
  async function resolveForBudget({ id, clinicId, version, transaction }) {
    require('../lib/economicProgramSnapshot').assertIntegrationEnabled([{ program_id: id }]);
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const clinic = await clinicContext(clinicId, transaction);
    const row = await scopedRow(id, clinicId, transaction, !!transaction);
    if (Number(row.version_number) !== Number(version)) throw domainError(409, 'budget_program_version_conflict', 'El catálogo ha cambiado. Vuelve a seleccionar el programa.');
    return serialize(row, await treatmentMap([row], clinic, transaction));
  }
  async function options({ clinicId, query = {} }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const clinic = await clinicContext(clinicId);
    const paging = filters(query);
    const where = { ...treatmentScope(clinic), activo: true };
    where[Op.and].push(literal("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(clinical_config, '$.catalog_status')), 'active') <> 'obsolete'"));
    if (paging.q) where[Op.and].push({ [Op.or]: [{ nombre: { [Op.like]: `%${paging.q.replace(/[\\%_]/g, '\\$&')}%` } }, { codigo: { [Op.like]: `%${paging.q.replace(/[\\%_]/g, '\\$&')}%` } }] });
    const [rows, total] = await Promise.all([
      Tratamiento.findAll({ where, order: [['nombre', 'ASC'], ['id_tratamiento', 'ASC']], offset: (paging.page - 1) * paging.pageSize, limit: paging.pageSize }),
      Tratamiento.count({ where }),
    ]);
    return { items: await enrichTreatments(rows, clinicId), total: Number(total), page: paging.page, page_size: paging.pageSize };
  }
  async function create({ clinicId, actorId, payload }) {
    clinicId = positiveInteger(clinicId, 'clinic_id'); actorId = positiveInteger(actorId, 'actor_id');
    const values = normalizeValues(payload);
    const idempotency = boundedText(payload.idempotency_key, 'idempotency_key', 120);
    const requestKey = idempotency ? payloadHash([clinicId, idempotency]) : null;
    const requestHash = payloadHash(values);
    return db.sequelize.transaction(async (transaction) => {
      // A stable clinic row serializes same-clinic definition creates, including
      // retries when the idempotency row does not yet exist. No calendar locks.
      const clinic = await clinicContext(clinicId, transaction, true);
      if (requestKey) {
        const existing = await TreatmentProgram.findOne({ where: { request_key: requestKey, clinic_id: clinicId }, transaction });
        if (existing) {
          if (existing.request_payload_hash !== requestHash) throw domainError(409, 'program_idempotency_conflict', 'Esta solicitud ya creó un catálogo con otros datos.');
          return { created: false, item: serialize(existing, await treatmentMap([existing], clinic, transaction)) };
        }
      }
      const map = await validateActive(values, clinic, transaction);
      const row = await TreatmentProgram.create({ public_id: newId(), clinic_id: clinicId, ...values, version_number: 1, request_key: requestKey, request_payload_hash: requestKey ? requestHash : null, created_by: actorId, updated_by: actorId }, { transaction });
      await revision(row, actorId, transaction);
      return { created: true, item: serialize(row, map) };
    });
  }
  async function preview({ clinicId, payload }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const clinic = await clinicContext(clinicId);
    const values = normalizeValues(payload);
    const map = await treatmentMap([values], clinic);
    return { item: serialize({ public_id: null, clinic_id: clinicId, ...values, version_number: 0, created_at: null, updated_at: null }, map) };
  }
  async function update({ id, clinicId, actorId, payload }) {
    clinicId = positiveInteger(clinicId, 'clinic_id'); actorId = positiveInteger(actorId, 'actor_id');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw domainError(400, 'program_invalid_input', 'Datos de programa no válidos.');
    const expected = positiveInteger(payload.expected_version, 'expected_version');
    if (Object.hasOwn(payload, 'clinic_id') && Number(payload.clinic_id) !== clinicId) throw domainError(400, 'program_scope_immutable', 'No se puede trasladar un programa a otra clínica.');
    return db.sequelize.transaction(async (transaction) => {
      const clinic = await clinicContext(clinicId, transaction);
      const row = await scopedRow(id, clinicId, transaction, true);
      if (Number(row.version_number) !== expected) throw domainError(409, 'program_version_conflict', 'Otra persona ha modificado este catálogo. Actualiza antes de guardar.', { current_version: Number(row.version_number) });
      const values = normalizeValues(payload, { current: { ...plain(row), appointments: decode(row.appointments, []) } });
      const map = await validateActive(values, clinic, transaction);
      await row.update({ ...values, version_number: expected + 1, updated_by: actorId }, { transaction });
      await revision(row, actorId, transaction);
      return { item: serialize(row, map) };
    });
  }
  return { list, get, options, create, preview, update, serialize, resolveForBudget };
}

let defaultService;
const getDefault = () => defaultService || (defaultService = createTreatmentProgramsService({ db: require('../../models') }));
module.exports = { ...contract, createTreatmentProgramsService };
for (const method of ['list', 'get', 'options', 'create', 'preview', 'update', 'resolveForBudget']) module.exports[method] = async (...args) => {
  try { return await getDefault()[method](...args); }
  catch (error) { if (error?.original?.code === 'ER_NO_SUCH_TABLE' && /TreatmentProgram/.test(error.original.sqlMessage || '')) throw domainError(503, 'program_schema_pending', 'El catálogo de programas está pendiente de la migración del entorno.'); throw error; }
};
