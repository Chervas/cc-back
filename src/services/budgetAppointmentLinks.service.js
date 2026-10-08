'use strict';
const { Op } = require('sequelize');
const EVENT = 'appointment_linked';
const object = value => { if (typeof value !== 'string') return value || {}; try { return JSON.parse(value); } catch (_) { return {}; } };
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const usable = appointment => !['cancelada', 'reprogramada', 'no_asistio'].includes(appointment.estado) && !appointment.es_provisional;
function treatmentIds(line) {
  const ids = [line.treatment_id];
  const snapshot = object(line.program_snapshot);
  for (const session of snapshot.appointments || []) for (const treatment of session.treatments || []) ids.push(treatment.treatment_id || treatment.id);
  return [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
}
function allowedLine(line, appointment) {
  return line && line.accepted !== false && usable(appointment) && treatmentIds(line).includes(Number(appointment.tratamiento_id));
}
function linksFromEvents(events) {
  const byAppointment = new Map();
  for (const event of events || []) {
    if (event.event_type !== EVENT) continue;
    const metadata = object(event.metadata);
    if (Number.isSafeInteger(Number(metadata.appointment_id))) byAppointment.set(Number(metadata.appointment_id), {
      appointment_id: Number(metadata.appointment_id), line_key: metadata.line_key,
      version: Number(metadata.budget_version), association: metadata.association,
    });
  }
  return [...byAppointment.values()];
}
function createService({ db = require('../../models') } = {}) {
  async function context(publicId, transaction, lock = false) {
    const budget = await db.EconomicBudget.findOne({ where: { public_id: publicId }, transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!budget) fail('budget_not_found', 'Presupuesto no encontrado.', 404);
    if (!['accepted', 'partially_accepted'].includes(budget.status)) fail('budget_not_accepted', 'Acepta primero el presupuesto.');
    const version = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction });
    const events = await db.EconomicBudgetEvent.findAll({ where: { budget_id: budget.id }, order: [['id', 'ASC']], transaction });
    const acceptance = [...events].reverse().find(event => ['accepted', 'partially_accepted'].includes(event.event_type));
    const accepted = new Set(object(acceptance?.metadata).accepted_line_keys || []);
    const lines = object(version.lines).filter(line => line.accepted !== false
      && (budget.status === 'accepted' || accepted.has(line.key)));
    return { budget, version, lines, links: linksFromEvents(events) };
  }
  async function plan(publicId) {
    const ctx = await context(publicId);
    const appointments = await db.CitaPaciente.findAll({ where: { paciente_id: ctx.budget.patient_id, clinica_id: ctx.budget.clinic_id },
      attributes: ['id_cita', 'inicio', 'fin', 'estado', 'tratamiento_id', 'es_provisional', 'voucher_id', 'arrived_at', 'care_started_at', 'care_completed_at', 'care_schedule_start', 'care_legacy_attendance', 'updated_at'],
      order: [['inicio', 'DESC'], ['id_cita', 'DESC']], limit: 150 });
    const reports = appointments.length && db.AppointmentClinicalReport ? await db.AppointmentClinicalReport.findAll({ where: {
      appointment_id: { [Op.in]:appointments.map(row => row.id_cita) }, clinic_id:ctx.budget.clinic_id, patient_id:ctx.budget.patient_id, status:'final' }, attributes:['appointment_id'], raw:true }) : [];
    const linkedRows = ctx.links.length ? await db.CitaPaciente.findAll({ where:{ id_cita:{ [Op.in]:ctx.links.map(link => link.appointment_id) },
      clinica_id:ctx.budget.clinic_id, paciente_id:ctx.budget.patient_id }, attributes:['id_cita','estado','es_provisional'], raw:true }) : [];
    return { budget_id: publicId, version: Number(ctx.budget.current_version), lines: ctx.lines.filter(line => line.accepted !== false).map(line => ({
      key: line.key, name: line.name, treatment_ids: treatmentIds(line), program_id: line.program_id || null,
      total: Number(line.entitlement_units || line.quantity || 1),
      remaining: Math.max(0, Number(line.entitlement_units || line.quantity || 1) - ctx.links.filter(link => link.line_key === line.key
        && link.version === Number(ctx.budget.current_version) && linkedRows.some(row => Number(row.id_cita) === link.appointment_id && usable(row))).length),
    })), links: ctx.links, appointments: appointments.filter(usable).map(row => ({
      id: Number(row.id_cita), start: row.inicio, end: row.fin, status: row.estado,
      performed: reports.some(report => Number(report.appointment_id) === Number(row.id_cita)) || require('../lib/appointment-care').hasCompletedAppointmentCare(row),
      treatment_id: Number(row.tratamiento_id), already_linked: ctx.links.some(link => link.appointment_id === Number(row.id_cita)),
    })) };
  }
  async function link({ publicId, appointmentId, lineKey, expectedVersion, association = 'scheduled', actorId }) {
    if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) < 1 || !['scheduled', 'performed'].includes(association)) fail('budget_appointment_invalid', 'Selecciona una cita válida.', 400);
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(publicId, transaction, true);
      if (Number(expectedVersion) !== Number(ctx.budget.current_version)) fail('budget_version_changed', 'El presupuesto ha cambiado. Actualiza antes de vincular la cita.');
      const appointment = await db.CitaPaciente.findByPk(Number(appointmentId), { transaction, lock: transaction.LOCK.UPDATE });
      if (!appointment || Number(appointment.clinica_id) !== Number(ctx.budget.clinic_id) || String(appointment.paciente_id) !== String(ctx.budget.patient_id)) fail('budget_appointment_scope', 'La cita no pertenece al paciente y clínica de este presupuesto.', 404);
      const line = ctx.lines.find(item => item.key === lineKey);
      if (!allowedLine(line, appointment)) fail('budget_appointment_treatment', 'El tratamiento de la cita no coincide con este concepto del presupuesto.');
      if (association === 'performed') {
        const finalReport = db.AppointmentClinicalReport && await db.AppointmentClinicalReport.findOne({ where:{ appointment_id:appointment.id_cita,
          clinic_id:ctx.budget.clinic_id, patient_id:ctx.budget.patient_id, status:'final' }, attributes:['id'], transaction });
        if (!finalReport && !require('../lib/appointment-care').hasCompletedAppointmentCare(appointment)) fail('budget_appointment_not_completed', 'No hay una atención finalizada para esta cita. Vincúlala como cita existente; no se dará por realizada desde el presupuesto.');
      }
      const existing = ctx.links.find(item => item.appointment_id === Number(appointmentId));
      if (existing) {
        if (existing.line_key !== lineKey || existing.version !== Number(expectedVersion)) fail('budget_appointment_already_linked', 'Esta cita ya está vinculada a otro concepto.');
        return { linked: true, replayed: true, appointment_id: Number(appointmentId) };
      }
      // Locking the appointment also serializes competing budgets. The receipt
      // lives in the existing append-only budget audit, not client metadata.
      const other = await db.EconomicBudgetEvent.findAll({ where: { event_type: EVENT,
        metadata: { appointment_id: Number(appointmentId) } }, transaction });
      if (other.some(event => Number(event.budget_id) !== Number(ctx.budget.id))) fail('budget_appointment_other_budget', 'Esta cita ya está vinculada a otro presupuesto.');
      const rows = ctx.links.length ? await db.CitaPaciente.findAll({ where: { id_cita: { [Op.in]: ctx.links.map(item => item.appointment_id) } }, transaction }) : [];
      const count = ctx.links.filter(item => item.line_key === lineKey && item.version === Number(expectedVersion)
        && rows.some(row => Number(row.id_cita) === item.appointment_id && usable(row))).length;
      if (count >= Number(line.entitlement_units || line.quantity || 1)) fail('budget_line_fully_scheduled', 'Todas las sesiones de este concepto ya tienen cita.');
      await db.EconomicBudgetEvent.create({ budget_id: ctx.budget.id, version_number: ctx.budget.current_version,
        event_type: EVENT, from_status: ctx.budget.status, to_status: ctx.budget.status, created_at: new Date(), actor_id: actorId, metadata: { appointment_id: Number(appointmentId), line_key: lineKey,
          budget_version: Number(expectedVersion), association, no_payment_or_clinical_effect: true } }, { transaction });
      return { linked: true, replayed: false, appointment_id: Number(appointmentId) };
    });
  }
  return { plan, link };
}
module.exports = { ...createService(), createService, treatmentIds, allowedLine, linksFromEvents, EVENT };
