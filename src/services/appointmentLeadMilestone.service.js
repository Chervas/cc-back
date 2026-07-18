'use strict';

const db = require('../../models');

const PROPDENTAL_GROUP_ID = 5;
const TERMINAL_LEAD_STATUSES = new Set(['convertido', 'descartado']);
const LEAD_ACTIVE_APPOINTMENT_STATES = new Set([
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
  'reprogramada',
]);

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function plainRecord(record) {
  return record?.get ? record.get({ plain: true }) : record;
}

function isTreatmentAppointment(cita) {
  const plain = plainRecord(cita) || {};
  return positiveInt(plain.tratamiento_id) !== null
    || normalizedStatus(plain.tipo_cita) === 'primera_con_trat';
}

function reliableBasePrice(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100) / 100;
}

async function resolveAppointmentTreatmentValue(cita, dependencies = {}) {
  const plain = plainRecord(cita) || {};
  const treatmentId = positiveInt(plain.tratamiento_id);
  if (!treatmentId) return 0;

  const includedTreatment = plain.tratamiento;
  if (positiveInt(includedTreatment?.id_tratamiento) === treatmentId) {
    return reliableBasePrice(includedTreatment.precio_base);
  }

  const Tratamiento = dependencies.Tratamiento || db.Tratamiento;
  if (!Tratamiento) return 0;
  const treatment = await Tratamiento.findByPk(treatmentId, {
    attributes: ['id_tratamiento', 'precio_base'],
  });
  return reliableBasePrice(plainRecord(treatment)?.precio_base);
}

async function resolveAppointmentGroupId({ lead, cita, dependencies = {} }) {
  const leadGroupId = positiveInt(plainRecord(lead)?.grupo_clinica_id);
  if (leadGroupId) return leadGroupId;

  const clinicId = positiveInt(plainRecord(cita)?.clinica_id ?? plainRecord(lead)?.clinica_id);
  const Clinica = dependencies.Clinica || db.Clinica;
  if (!clinicId || !Clinica) return null;
  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['grupoClinicaId'],
    raw: true,
  });
  return positiveInt(clinic?.grupoClinicaId ?? clinic?.grupo_clinica_id);
}

async function syncLeadStatusFromAppointments(leadId, dependencies = {}) {
  const normalizedLeadId = positiveInt(leadId);
  const LeadIntake = dependencies.LeadIntake || db.LeadIntake;
  const CitaPaciente = dependencies.CitaPaciente || db.CitaPaciente;
  if (!normalizedLeadId || !LeadIntake || !CitaPaciente) return null;

  const lead = await LeadIntake.findByPk(normalizedLeadId);
  if (!lead) return null;

  const currentStatus = normalizedStatus(lead.status_lead) || 'nuevo';
  if (TERMINAL_LEAD_STATUSES.has(currentStatus)) return lead;

  const citas = await CitaPaciente.findAll({
    where: { lead_intake_id: normalizedLeadId },
    attributes: ['id_cita', 'estado', 'inicio', 'tratamiento_id', 'tipo_cita'],
    order: [['inicio', 'DESC'], ['id_cita', 'DESC']],
    raw: true,
  });

  const completedTreatment = citas.find((row) => (
    normalizedStatus(row?.estado) === 'completada' && isTreatmentAppointment(row)
  )) || null;
  const completedAppointment = citas.find((row) => normalizedStatus(row?.estado) === 'completada') || null;
  const activeAppointment = citas.find((row) => (
    LEAD_ACTIVE_APPOINTMENT_STATES.has(normalizedStatus(row?.estado))
  )) || null;

  let nextStatus = currentStatus;
  let nextAppointmentId = positiveInt(lead.call_outcome_appointment_id);

  if (completedTreatment) {
    nextStatus = 'convertido';
    nextAppointmentId = positiveInt(completedTreatment.id_cita) || nextAppointmentId;
  } else if (completedAppointment || currentStatus === 'acudio_cita') {
    nextStatus = 'acudio_cita';
    nextAppointmentId = positiveInt(completedAppointment?.id_cita) || nextAppointmentId;
  } else if (activeAppointment) {
    nextStatus = 'citado';
    nextAppointmentId = positiveInt(activeAppointment.id_cita);
  } else {
    if (currentStatus === 'citado') nextStatus = 'info_recibida';
    nextAppointmentId = null;
  }

  const changedStatus = nextStatus !== currentStatus;
  const changedAppointmentId = nextAppointmentId !== positiveInt(lead.call_outcome_appointment_id);
  if (!changedStatus && !changedAppointmentId) return lead;

  await lead.update({
    status_lead: nextStatus,
    call_outcome_appointment_id: nextAppointmentId,
  });
  return lead;
}

async function maybeUploadCompletedTreatmentConversion({
  cita,
  previousStatus,
  dependencies = {},
} = {}) {
  const plain = plainRecord(cita) || {};
  const appointmentId = positiveInt(plain.id_cita);
  const leadId = positiveInt(plain.lead_intake_id);
  const nextStatus = normalizedStatus(plain.estado);

  if (!appointmentId || !leadId) return { sent: false, reason: 'linked_appointment_required' };
  if (nextStatus !== 'completada' || normalizedStatus(previousStatus) === 'completada') {
    return { sent: false, reason: 'first_completed_transition_required' };
  }
  if (!isTreatmentAppointment(plain)) {
    return { sent: false, reason: 'completed_treatment_required' };
  }

  const LeadIntake = dependencies.LeadIntake || db.LeadIntake;
  if (!LeadIntake) return { sent: false, reason: 'lead_model_unavailable' };
  const lead = await LeadIntake.findByPk(leadId);
  if (!lead) return { sent: false, reason: 'lead_not_found' };

  const groupId = await resolveAppointmentGroupId({ lead, cita: plain, dependencies });
  if (groupId !== PROPDENTAL_GROUP_ID) {
    return { sent: false, reason: 'outside_propdental_scope' };
  }

  const value = await resolveAppointmentTreatmentValue(plain, dependencies);
  const upload = dependencies.maybeUploadLeadLifecycleConversion
    || require('./googleLeadLifecycleConversion.service').maybeUploadLeadLifecycleConversion;

  return upload({
    lead,
    eventName: 'purchase',
    eventId: `appointment-${appointmentId}-treatment-completed`,
    clinicId: positiveInt(plain.clinica_id ?? lead.clinica_id),
    value,
    // Tratamientos.precio_base is a useful fallback weight, not proof of an
    // amount accepted, invoiced or paid by the patient.
    valueProvenance: 'treatment_base_price',
    valueIsFallback: true,
    currency: 'EUR',
    occurredAt: plain.updated_at || plain.created_at || new Date(),
  });
}

async function processAppointmentLeadMilestones({
  cita,
  previousStatus,
  dependencies = {},
} = {}) {
  const plain = plainRecord(cita) || {};
  const lead = await syncLeadStatusFromAppointments(plain.lead_intake_id, dependencies);
  let conversion;
  try {
    conversion = await maybeUploadCompletedTreatmentConversion({ cita, previousStatus, dependencies });
  } catch (error) {
    const logger = dependencies.logger || console;
    logger.warn?.(
      '⚠️ No se pudo enviar el hito Purchase de la cita completada:',
      error?.code || error?.message || 'unknown_error'
    );
    conversion = { sent: false, reason: 'conversion_upload_failed' };
  }
  return { lead, conversion };
}

module.exports = {
  PROPDENTAL_GROUP_ID,
  isTreatmentAppointment,
  maybeUploadCompletedTreatmentConversion,
  processAppointmentLeadMilestones,
  reliableBasePrice,
  resolveAppointmentTreatmentValue,
  syncLeadStatusFromAppointments,
};
