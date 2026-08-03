'use strict';

const db = require('../../models');

const { PatientOperationalEvent } = db;

const APPOINTMENT_STATUS_EVENT_TYPE = 'appointment.status_changed';

const APPOINTMENT_STATUS_LABELS = Object.freeze({
  pendiente: 'Pendiente',
  info_enviada: 'Datos de la cita enviados',
  info_confirmada: 'Datos de la cita confirmados',
  recordatorio_enviado: 'Recordatorio enviado',
  recordatorio_confirmado: 'Asistencia confirmada',
  completada: 'Cita completada',
  cancelada: 'Cita cancelada',
  no_asistio: 'Paciente no acude',
  reprogramada: 'Cita reprogramada',
});

const APPOINTMENT_STATUS_TITLES = Object.freeze({
  info_enviada: 'Datos de la cita enviados',
  info_confirmada: 'Datos de la cita confirmados',
  recordatorio_enviado: 'Recordatorio enviado',
  recordatorio_confirmado: 'Asistencia confirmada por el paciente',
  completada: 'Cita completada',
  cancelada: 'Cita cancelada',
  no_asistio: 'Paciente no acude',
  reprogramada: 'Cita reprogramada',
});

const APPOINTMENT_STATUS_ICONS = Object.freeze({
  info_enviada: 'heroicons_outline:paper-airplane',
  info_confirmada: 'heroicons_outline:check-badge',
  recordatorio_enviado: 'heroicons_outline:bell-alert',
  recordatorio_confirmado: 'heroicons_outline:hand-thumb-up',
  completada: 'heroicons_outline:check',
  cancelada: 'heroicons_outline:x-circle',
  no_asistio: 'heroicons_outline:hand-thumb-down',
  reprogramada: 'heroicons_outline:arrow-path-rounded-square',
});

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function appointmentStatusLabel(status) {
  const normalized = cleanString(status)?.toLowerCase() || null;
  if (!normalized) return null;
  return APPOINTMENT_STATUS_LABELS[normalized] || normalized.replace(/_/g, ' ');
}

function appointmentStatusTitle(status) {
  const normalized = cleanString(status)?.toLowerCase() || null;
  return (normalized && APPOINTMENT_STATUS_TITLES[normalized]) || 'Estado de cita actualizado';
}

function appointmentStatusIcon(status) {
  const normalized = cleanString(status)?.toLowerCase() || null;
  return (normalized && APPOINTMENT_STATUS_ICONS[normalized]) || 'heroicons_outline:check-badge';
}

function appointmentStatusColor(status) {
  const normalized = cleanString(status)?.toLowerCase() || null;
  if (['cancelada', 'no_asistio'].includes(normalized)) return 'warning';
  if (['info_enviada', 'recordatorio_enviado', 'reprogramada'].includes(normalized)) return 'info';
  return 'success';
}

function appointmentStatusSourceLabel(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const source = cleanString(event?.source)?.toLowerCase() || 'clinicaclick';
  const flowName = cleanString(metadata.flow_name);
  if (source === 'automation_v2') {
    return flowName ? `Automatización «${flowName}»` : 'Automatización de Clinicaclick';
  }
  if (source === 'agenda') return 'Agenda';
  return 'Clinicaclick';
}

function buildAppointmentStatusDescription(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const previousLabel = appointmentStatusLabel(metadata.previous_status);
  const nextLabel = appointmentStatusLabel(metadata.new_status);
  const transition = previousLabel && nextLabel
    ? `${previousLabel} → ${nextLabel}`
    : (nextLabel || 'Estado actualizado');
  return `${appointmentStatusSourceLabel(event)} · ${transition}.`;
}

function serializeAppointmentStatusActivity(event, { patientId = null, leadId = null, actorName = 'Sistema' } = {}) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const newStatus = cleanString(metadata.new_status)?.toLowerCase() || null;
  const appointmentId = toPositiveInt(metadata.appointment_id);
  const typeByStatus = {
    info_enviada: 'appointment_info_sent',
    info_confirmada: 'appointment_confirmed',
    recordatorio_enviado: 'appointment_reminder_sent',
    recordatorio_confirmado: 'appointment_confirmed',
    completada: 'appointment_completed',
    cancelada: 'appointment_cancelled',
    no_asistio: 'appointment_no_show',
    reprogramada: 'appointment_rescheduled',
  };
  return {
    id: `appointment-status-event-${event.id}`,
    ...(patientId !== null ? { pacienteId: String(patientId) } : {}),
    ...(leadId !== null ? { leadId: String(leadId) } : {}),
    fecha: event.occurred_at || event.created_at,
    tipo: typeByStatus[newStatus] || 'appointment_status_changed',
    titulo: appointmentStatusTitle(newStatus),
    descripcion: buildAppointmentStatusDescription(event),
    icono: appointmentStatusIcon(newStatus),
    color: appointmentStatusColor(newStatus),
    ...(appointmentId ? { citaId: String(appointmentId) } : {}),
    usuarioId: event.actor_user_id ? String(event.actor_user_id) : 'system',
    usuarioNombre: actorName || 'Sistema',
    detalles: {
      ...metadata,
      estado: newStatus,
      source: event.source || null,
      sourceLabel: appointmentStatusSourceLabel(event),
    },
  };
}

async function recordAppointmentStatusChange({
  appointment,
  previousStatus,
  newStatus,
  actorUserId = null,
  source = 'agenda',
  metadata = {},
  occurredAt = new Date(),
  transaction = null,
}) {
  if (!PatientOperationalEvent || !appointment) return null;
  const appointmentId = toPositiveInt(appointment.id_cita || appointment.id);
  const patientId = toPositiveInt(appointment.paciente_id || appointment.patient_id);
  const clinicId = toPositiveInt(appointment.clinica_id || appointment.clinic_id);
  const previous = cleanString(previousStatus)?.toLowerCase() || null;
  const next = cleanString(newStatus)?.toLowerCase() || null;
  if (!appointmentId || !clinicId || !next || previous === next) return null;

  return PatientOperationalEvent.create({
    patient_id: patientId,
    clinic_id: clinicId,
    actor_user_id: toPositiveInt(actorUserId),
    event_type: APPOINTMENT_STATUS_EVENT_TYPE,
    source: cleanString(source) || 'clinicaclick',
    channel: null,
    metadata: {
      ...metadata,
      appointment_id: appointmentId,
      previous_status: previous,
      new_status: next,
    },
    occurred_at: occurredAt,
  }, { transaction });
}

module.exports = {
  APPOINTMENT_STATUS_EVENT_TYPE,
  appointmentStatusLabel,
  serializeAppointmentStatusActivity,
  recordAppointmentStatusChange,
};
