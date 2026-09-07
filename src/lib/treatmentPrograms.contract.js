'use strict';

const crypto = require('node:crypto');
const { normalizeBookingProfile, requiresMultiResourceBooking } = require('./booking-profile');
function domainError(statusCode, code, message, details = null) { return Object.assign(new Error(message), { statusCode, code, details }); }
function positiveInteger(value, field = 'id') {
  const number = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isSafeInteger(number) || number <= 0) throw domainError(400, 'program_invalid_input', `${field} no es válido.`, { field });
  return number;
}
function boundedText(value, field, limit, required = false) {
  if (value != null && typeof value !== 'string') throw domainError(400, 'program_invalid_input', `${field} debe ser texto.`, { field });
  const result = String(value || '').trim();
  if (result.length > limit || (required && !result)) throw domainError(400, 'program_invalid_input', `Revisa ${field}.`, { field });
  return result || null;
}
function money(value) {
  if (value == null || value === '') return null;
  if (!['number', 'string'].includes(typeof value) || !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value))) throw domainError(400, 'program_invalid_price', 'El precio debe ser positivo y tener como máximo dos decimales.');
  return Number(Number(value).toFixed(2));
}
function normalizeValues(input, { current = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw domainError(400, 'program_invalid_input', 'Datos de programa no válidos.');
  const value = (field, fallback) => Object.hasOwn(input, field) ? input[field] : current?.[field] ?? fallback;
  const kind = value('kind', 'program'), status = value('status', 'draft');
  if (!['program', 'voucher'].includes(kind) || !['draft', 'active', 'archived'].includes(status)) throw domainError(400, 'program_invalid_input', 'Tipo o estado no válido.');
  const appointments = value('appointments', []);
  if (!Array.isArray(appointments) || appointments.length > 120) throw domainError(400, 'program_invalid_appointments', 'Define como máximo 120 citas.');
  const keys = new Set();
  const normalized = appointments.map((appointment, index) => {
    if (!appointment || typeof appointment !== 'object' || Array.isArray(appointment)) throw domainError(400, 'program_invalid_appointment', 'Cita del programa no válida.');
    const key = boundedText(appointment.key ?? `appointment_${index + 1}`, 'key', 64, true);
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || keys.has(key)) throw domainError(400, 'program_duplicate_appointment_key', 'Cada cita necesita una clave diferente.');
    keys.add(key);
    if (!Array.isArray(appointment.treatment_ids) || appointment.treatment_ids.length > 8) throw domainError(400, 'program_invalid_treatments', 'Selecciona como máximo ocho tratamientos por cita.');
    const ids = appointment.treatment_ids.map((id) => positiveInteger(id, 'treatment_id'));
    if (new Set(ids).size !== ids.length) throw domainError(400, 'program_duplicate_treatment', 'Un tratamiento no se puede repetir en la misma cita; añade otra cita.');
    const offset = appointment.offset_days == null || appointment.offset_days === '' ? null : Number(appointment.offset_days);
    if (offset !== null && (!['number', 'string'].includes(typeof appointment.offset_days) || !Number.isSafeInteger(offset) || offset < 0 || offset > 3650)) throw domainError(400, 'program_invalid_offset', 'Los días desde la primera cita deben estar entre 0 y 3650.');
    return { key, label: boundedText(appointment.label, 'label', 120) || `Cita ${index + 1}`, treatment_ids: ids, offset_days: offset };
  });
  return { name: boundedText(value('name', ''), 'name', 255, true), kind, status, total_price: money(value('total_price', null)), notes: boundedText(value('notes', null), 'notes', 10000), appointments: normalized };
}
function filters(query = {}) {
  const page = query.page == null ? 1 : positiveInteger(query.page, 'page');
  const pageSize = query.page_size == null ? 25 : positiveInteger(query.page_size, 'page_size');
  if (page > 10000 || pageSize > 50) throw domainError(400, 'program_invalid_page', 'Página fuera de rango.');
  if (query.kind && !['program', 'voucher'].includes(query.kind)) throw domainError(400, 'program_invalid_kind', 'Tipo de catálogo no válido.');
  if (query.status && !['draft', 'active', 'archived'].includes(query.status)) throw domainError(400, 'program_invalid_status', 'Estado no válido.');
  return { page, pageSize, q: boundedText(query.q, 'q', 120), kind: query.kind || null, status: query.status || null };
}
function treatmentDto(raw) {
  const value = raw?.toJSON ? raw.toJSON() : raw;
  let config = value.clinical_config || {};
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = {}; } }
  const issues = [];
  if (Number(value.sesiones_defecto || 1) > 1) issues.push({ code: 'legacy_voucher_requires_unit_mapping', message: 'Esta oferta antigua contiene varias sesiones. Vincula su tratamiento individual antes de reutilizarla.' });
  const status = config.catalog_status || (value.activo ? 'active' : 'inactive');
  if (!value.activo || status === 'obsolete' || status === 'draft') issues.push({ code: 'treatment_not_active', message: 'El tratamiento no está activo en el catálogo.' });
  let profile = null;
  try { profile = normalizeBookingProfile(config.booking_profile); } catch { issues.push({ code: 'invalid_booking_profile', message: 'Completa el perfil de agenda del tratamiento.' }); }
  if (!profile) issues.push({ code: 'missing_booking_profile', message: 'Falta configurar cabina, duración y profesionales.' });
  if (profile && requiresMultiResourceBooking(profile)) issues.push({ code: 'multi_resource_writer_pending', message: 'La reserva conjunta de fases o equipos todavía necesita el comando de agenda compatible.' });
  const duration = profile ? profile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0) : Number(value.duracion_min) > 0 ? Number(value.duracion_min) : null;
  if (!duration) issues.push({ code: 'missing_duration', message: 'El tratamiento no tiene una duración definida.' });
  return { id: Number(value.id_tratamiento), name: value.nombre, code: value.codigo || null, clinic_id: value.clinica_id ? Number(value.clinica_id) : null, catalog_status: status, duration_minutes: duration, stored_catalog_price: value.precio_base == null ? null : Number(value.precio_base), stored_price_semantics: 'existing_catalog_field_unclassified', default_sessions: Number(value.sesiones_defecto || 1), legacy_voucher_offer: Number(value.sesiones_defecto || 1) > 1, booking_profile: profile, issues, booking_ready: issues.length === 0 };
}
function summarize(values, treatmentsById) {
  const issues = [];
  if (!values.appointments.length) issues.push({ code: 'appointments_required', message: 'Añade al menos una cita.' });
  if (values.total_price == null) issues.push({ code: 'price_required', message: 'Indica el precio total, impuestos incluidos.' });
  let lastOffset = -1;
  const appointments = values.appointments.map((appointment, appointmentIndex) => {
    const appointmentIssues = [];
    if (!appointment.treatment_ids.length) appointmentIssues.push({ code: 'treatment_required', message: 'Selecciona un tratamiento para esta cita.' });
    if (values.kind === 'program' && appointment.offset_days == null) appointmentIssues.push({ code: 'cadence_required', message: 'Indica cuándo corresponde esta cita desde el inicio del programa.' });
    if (values.kind === 'program' && appointmentIndex === 0 && appointment.offset_days != null && appointment.offset_days !== 0) appointmentIssues.push({ code: 'first_appointment_starts_program', message: 'La primera cita debe corresponder al día 0 del programa.' });
    if (appointment.offset_days != null && appointment.offset_days < lastOffset) appointmentIssues.push({ code: 'cadence_not_ordered', message: 'Las citas deben mantener el orden del programa.' });
    if (appointment.offset_days != null) lastOffset = appointment.offset_days;
    const treatments = appointment.treatment_ids.map((id) => {
      const treatment = treatmentsById.get(id);
      if (!treatment) { appointmentIssues.push({ code: 'treatment_unavailable', treatment_id: id, message: 'Tratamiento no disponible en esta clínica.' }); return { id, name: null, unavailable: true }; }
      for (const issue of treatment.issues) appointmentIssues.push({ ...issue, treatment_id: id });
      return treatment;
    });
    if (appointment.treatment_ids.length > 1) appointmentIssues.push({ code: 'combined_appointment_writer_pending', message: 'La reserva de varios tratamientos en una cita requiere el comando de agenda conjunto.' });
    issues.push(...appointmentIssues.map((issue) => ({ ...issue, appointment_key: appointment.key })));
    const duration = treatments.every((t) => t.duration_minutes) ? treatments.reduce((sum, t) => sum + t.duration_minutes, 0) : null;
    return { ...appointment, treatments, duration_minutes: duration, issues: appointmentIssues };
  });
  if (values.kind === 'voucher') {
    const sets = appointments.map((a) => a.treatment_ids.join(','));
    if (new Set(sets).size > 1 || appointments.some((a) => a.treatment_ids.length !== 1)) issues.push({ code: 'voucher_homogeneous_treatment_required', message: 'Un bono repite un único tratamiento. Usa Programa para combinar tratamientos.' });
  }
  return { appointments, summary: { appointment_count: appointments.length, duration_minutes: appointments.length && appointments.every((a) => a.duration_minutes) ? appointments.reduce((sum, a) => sum + a.duration_minutes, 0) : null, issues, ready_for_scheduling: issues.length === 0 } };
}
const payloadHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
module.exports = { domainError, positiveInteger, boundedText, normalizeValues, filters, treatmentDto, summarize, payloadHash };
