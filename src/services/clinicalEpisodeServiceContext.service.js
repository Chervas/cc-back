'use strict';
const { Op, literal } = require('sequelize'), C = require('../lib/clinical-episode-contract');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const area = value => ({ medicina_estetica: 'estetica', estetica_medica: 'estetica', capilar_medicina: 'capilar', nutricion_clinica: 'nutricion', dental_clinica: 'dental', odontologia: 'dental', odontologia_general: 'dental' })[value] || (C.TEMPLATE_KEYS.includes(value) ? value : 'general');
function reference(value) {
  if (value === null) return null;
  if (!C.object(value) || !['voucher', 'budget_line', 'dental_plan'].includes(value.kind) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)
    || Object.keys(value).some(key => !['kind', 'id', 'line_key'].includes(key)) || value.kind === 'budget_line' && (typeof value.line_key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.line_key))
    || value.kind !== 'budget_line' && value.line_key !== undefined) throw C.error(400, 'clinical_service_context_invalid', 'Selecciona un servicio válido del paciente.');
  return { kind: value.kind, id: value.id, ...(value.kind === 'budget_line' ? { line_key: value.line_key } : {}) };
}
const identity = value => value ? reference(Object.fromEntries(['kind', 'id', 'line_key'].filter(key => value[key] !== undefined).map(key => [key, value[key]]))) : null;
const same = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
function createService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) } = {}) {
  async function treatment(id, clinicId, transaction) {
    if (id === null) return null;
    const clinic = await db.Clinica.findByPk(clinicId, { transaction });
    const row = await require('./treatmentBookingProfile.service').loadScopedTreatment({ db, treatmentId: C.integer(id, 'treatment_id'), clinic, transaction });
    const config = json(row.clinical_config) || {};
    if (row.activo === false || row.activo === 0 || ['draft', 'obsolete'].includes(config.catalog_status) || require('../lib/historical-treatment-reference').isHistoricalTreatment(row)) throw C.error(409, 'clinical_treatment_inactive', 'Selecciona un tratamiento vigente del catálogo de esta clínica.');
    return row;
  }
  async function resolve(ref, { patientId, clinicId, actorId, transaction }) {
    ref = reference(ref); if (!ref) return null;
    const scoped = { patient_id: patientId, clinic_id: clinicId }, lock = transaction ? { lock: transaction.LOCK.SHARE } : {};
    if (ref.kind === 'voucher') {
      const row = db.PatientVoucher && await db.PatientVoucher.findOne({ where: { ...scoped, public_id: ref.id }, transaction, ...lock });
      if (!row) throw C.error(404, 'clinical_service_context_not_found', 'El bono o programa no pertenece a este paciente y clínica.');
      const snapshot = json(row.program_snapshot), catalogTreatment = row.treatment_id && db.Tratamiento ? await db.Tratamiento.findByPk(row.treatment_id, { attributes: ['disciplina'], transaction }) : null;
      const declared = snapshot?.definition?.area_key || snapshot?.area_key || snapshot?.area_code || catalogTreatment?.disciplina;
      return { ...ref, title: row.name, area_key: area(declared), ...(row.treatment_id ? { treatment_id: Number(row.treatment_id) } : {}) };
    }
    if (ref.kind === 'budget_line') {
      const budget = db.EconomicBudget && await db.EconomicBudget.findOne({ where: { ...scoped, public_id: ref.id }, transaction, ...lock });
      if (!budget || !['accepted', 'partially_accepted'].includes(budget.status)) throw C.error(409, 'clinical_service_budget_not_accepted', 'Selecciona un concepto aceptado del presupuesto de este paciente.');
      const [version, acceptance] = await Promise.all([
        db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction, ...lock }),
        db.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id, version_number: budget.current_version, event_type: budget.status === 'accepted' ? 'accepted' : 'partially_accepted' }, order: [['id', 'DESC']], transaction, ...lock }),
      ]);
      const line = (json(version?.lines) || []).find(line => line.key === ref.line_key), keys = json(acceptance?.metadata)?.accepted_line_keys || [];
      if (!acceptance || !line || line.accepted === false || budget.status === 'partially_accepted' && !keys.includes(line.key)) throw C.error(409, 'clinical_service_budget_line_not_accepted', 'Este concepto no figura entre los aceptados de la versión vigente.');
      return { ...ref, title: line.name || 'Tratamiento del presupuesto', area_key: area(line.area_code), ...(line.treatment_id ? { treatment_id: Number(line.treatment_id) } : {}) };
    }
    const row = db.DentalPlan && await db.DentalPlan.findOne({ where: { ...scoped, public_id: ref.id }, transaction, ...lock });
    if (!row) throw C.error(404, 'clinical_service_context_not_found', 'El plan dental no pertenece a este paciente y clínica.');
    await require('./dentalPlans.service').createDentalPlanService({ db, canAccess }).authorize({ clinicId, actorId }, 'clinical_manage');
    const state = json(row.state) || {};
    return { ...ref, title: state.title || 'Plan dental', area_key: 'dental' };
  }
  async function candidates(appointment, ctx) {
    if (!appointment) return [];
    const refs = [], seen = new Set(), add = ref => { const key = JSON.stringify(ref); if (!seen.has(key)) { seen.add(key); refs.push(ref); } };
    if (appointment.voucher_id) {
      const voucher = db.PatientVoucher && await db.PatientVoucher.findOne({ where: { id: appointment.voucher_id, clinic_id: ctx.clinicId, patient_id: ctx.patientId }, transaction: ctx.transaction });
      if (!voucher) throw C.error(409, 'clinical_service_context_invalid', 'El bono de esta cita necesita revisión antes de asociar el episodio.');
      add({ kind: 'voucher', id: voucher.public_id });
    }
    const metadata = json(appointment.import_metadata) || {}, claimed = metadata.dental_plan?.id;
    if (claimed) {
      const plan = db.DentalPlan && await db.DentalPlan.findOne({ where: { public_id: claimed, clinic_id: ctx.clinicId, patient_id: ctx.patientId }, transaction: ctx.transaction });
      if (!plan || !(json(plan.state)?.reservations || []).some(row => Number(row.appointment_id) === Number(appointment.id_cita))) throw C.error(409, 'clinical_service_context_invalid', 'El plan de esta cita necesita revisión antes de asociar el episodio.');
      add({ kind: 'dental_plan', id: claimed });
    }
    if (db.DentalPlan) {
      const plans = await db.DentalPlan.findAll({ where: { clinic_id: ctx.clinicId, patient_id: ctx.patientId,
        [Op.and]: [literal("JSON_CONTAINS(JSON_EXTRACT(`state`, '$.reservations'), JSON_OBJECT('appointment_id', " + C.integer(appointment.id_cita) + '))')] }, transaction: ctx.transaction, limit: 51 });
      if (plans.length > 50) throw C.error(409, 'clinical_service_context_invalid', 'Revisa los múltiples planes asociados a esta cita.');
      for (const plan of plans) add({ kind: 'dental_plan', id: plan.public_id });
    }
    if (db.EconomicBudgetEvent && db.EconomicBudget) {
      const events = await db.EconomicBudgetEvent.findAll({ where: { event_type: 'appointment_linked', metadata: { appointment_id: Number(appointment.id_cita) } }, order: [['id', 'ASC']], transaction: ctx.transaction, limit: 101 });
      if (events.length > 100) throw C.error(409, 'clinical_service_context_invalid', 'Revisa los múltiples conceptos asociados a esta cita.');
      const groups = new Map(); for (const event of events) { const key = String(event.budget_id); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event); }
      for (const [budgetId, receipts] of groups) {
        // The native economic contract has one effective line per appointment
        // and budget, selected by linksFromEvents. Earlier receipts are audit,
        // never additional current clinical origins.
        const link = require('./budgetAppointmentLinks.service').linksFromEvents(receipts).find(link => link.appointment_id === Number(appointment.id_cita));
        if (!link) continue;
        const budget = await db.EconomicBudget.findOne({ where: { id: budgetId, clinic_id: ctx.clinicId, patient_id: ctx.patientId }, transaction: ctx.transaction });
        if (!budget) throw C.error(409, 'clinical_service_context_invalid', 'Una asociación del presupuesto no corresponde a este paciente y clínica.');
        add({ kind: 'budget_line', id: budget.public_id, line_key: link.line_key });
      }
    }
    return Promise.all(refs.map(ref => resolve(ref, ctx)));
  }
  async function values({ payload, previous = {}, primary, appointments, patientId, clinicId, actorId, transaction, creating = false }) {
    const contextChanged = creating || C.has(payload, 'service_ref') || C.has(payload, 'treatment_id') || C.has(payload, 'appointment_ids');
    if (!contextChanged) return {};
    const requested = C.has(payload, 'service_ref') ? reference(payload.service_ref) : undefined;
    if (!creating && !C.has(payload, 'appointment_ids') && (!C.has(payload, 'treatment_id') || (payload.treatment_id ?? null) === (previous.treatment_id ?? null))
      && (requested === undefined || same(requested, previous.service_ref))) return { service_ref: previous.service_ref || null, treatment_id: previous.treatment_id || null };
    const ctx = { patientId, clinicId, actorId, transaction }, options = [];
    for (const appointment of appointments || (primary ? [primary] : [])) for (const candidate of await candidates(appointment, ctx)) {
      if (!options.some(item => same(item, candidate))) options.push(candidate);
    }
    let snapshot;
    if (requested) {
      if (primary && options.length && !options.some(item => same(item, requested))) throw C.error(409, 'clinical_service_context_mismatch', 'El servicio elegido no coincide con la cita seleccionada.');
      if (primary && !options.length) throw C.error(409, 'clinical_service_context_mismatch', 'La cita seleccionada no tiene esa asociación de servicio.');
      snapshot = await resolve(requested, ctx);
    } else snapshot = options.length === 1 ? options[0] : null;
    let treatmentId = primary?.tratamiento_id ? Number(primary.tratamiento_id) : snapshot?.treatment_id || null;
    if (payload.treatment_id != null) {
      const id = C.integer(payload.treatment_id, 'treatment_id');
      if (primary && treatmentId && id !== treatmentId || snapshot?.treatment_id && id !== snapshot.treatment_id) throw C.error(409, 'clinical_service_context_mismatch', 'El tratamiento elegido no coincide con el contexto de la consulta.');
      if (!primary?.tratamiento_id && !snapshot?.treatment_id) await treatment(id, clinicId, transaction);
      treatmentId = id;
    }
    return { service_ref: snapshot, treatment_id: treatmentId };
  }
  async function treatmentOptions(input) {
    if (!input.actorId) throw C.error(401, 'unauthenticated', 'Inicia sesión para continuar.');
    const actorId = C.integer(input.actorId), clinicId = C.integer(input.clinicId), raw = String(input.patientIdentifier || '');
    if ((await Promise.all(['patients.view', 'patients.sensitive.view', 'clinical.reports.manage'].map(featureKey => canAccess({ actorId, clinicId, featureKey })))).some(value => !value)) throw C.error(403, 'clinical_service_context_forbidden', 'No tienes permiso para preparar esta consulta.');
    const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(raw) ? { id_paciente: C.integer(raw) } : { public_id: raw } });
    if (!patient || Number(patient.clinica_id) !== clinicId && !await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId } })) throw C.error(404, 'clinical_episode_patient_not_found', 'Paciente no encontrado en esta clínica.');
    const clinic = await db.Clinica.findByPk(clinicId), query = input.query || {}, q = C.text(query.q || '', 'search', 160) || '', limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_treatment_limit', 'Solicita como máximo cien tratamientos.');
    const scope = C.hash([clinicId, Number(patient.id_paciente), q]), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_treatment_cursor', 'La página no corresponde a esta búsqueda.');
    if (!clinic) throw C.error(404, 'clinic_not_found', 'Clínica no encontrada.');
    const groupOwners = clinic.grupoClinicaId ? await db.Clinica.findAll({ where: { grupoClinicaId: clinic.grupoClinicaId }, attributes: ['id_clinica'] }) : [];
    const group = clinic.grupoClinicaId ? [{ origen: 'grupo', [Op.or]: [{ grupo_clinica_id: clinic.grupoClinicaId },
      { grupo_clinica_id: { [Op.or]: [null, 0] }, clinica_id: { [Op.in]: groupOwners.map(owner => Number(owner.id_clinica)) } }] }] : [];
    const where = { activo: true, [Op.or]: [{ origen: 'sistema' }, { origen: 'clinica', clinica_id: clinicId }, ...group], ...(q ? { nombre: { [Op.like]: '%' + q.replace(/[\\%_]/g, '\\$&') + '%' } } : {}) };
    let after = cursor ? C.integer(cursor.id) : 0, exhausted = false, scanned = 0; const items = [];
    while (items.length < limit + 1 && scanned < 1000) {
      const rows = await db.Tratamiento.findAll({ where: { ...where, ...(after ? { id_tratamiento: { [Op.gt]: after } } : {}) }, order: [['id_tratamiento', 'ASC']], limit: limit + 1 });
      if (!rows.length) { exhausted = true; break; }
      for (const row of rows) {
        after = Number(row.id_tratamiento); scanned++;
        try { await treatment(after, clinicId); items.push({ id: after, title: row.nombre, area_key: area(row.disciplina) }); } catch (error) { if (![404, 409].includes(error.statusCode)) throw error; }
        if (items.length > limit) break;
      }
      if (rows.length < limit + 1 && items.length <= limit) { exhausted = true; break; }
    }
    const page = items.slice(0, limit), nextId = items.length > limit ? page.at(-1).id : after;
    return { items: page, next_cursor: !exhausted || items.length > limit ? C.encodeCursor({ scope, id: nextId }) : null };
  }
  return { values, treatmentOptions, treatment, resolve, candidates };
}
module.exports = { createService, reference, identity, same, area };
