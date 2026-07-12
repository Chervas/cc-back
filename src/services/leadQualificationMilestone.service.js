'use strict';

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function plainRecord(record) {
  return record?.get ? record.get({ plain: true }) : record;
}

async function nonBlockingLifecycleUpload({
  lead,
  eventName,
  eventId,
  clinicId,
  value = 0,
  currency = 'EUR',
  occurredAt = new Date(),
  dependencies = {},
  logger = console,
}) {
  const upload = dependencies.maybeUploadLeadLifecycleConversion
    || require('./googleLeadLifecycleConversion.service').maybeUploadLeadLifecycleConversion;
  try {
    return await upload({
      lead,
      eventName,
      eventId,
      clinicId,
      value,
      currency,
      occurredAt,
      ...(dependencies.lifecycleDependencies
        ? { dependencies: dependencies.lifecycleDependencies }
        : {}),
    });
  } catch (error) {
    logger?.warn?.(
      `⚠️ No se pudo enviar el hito ${eventName} del lead:`,
      error?.code || error?.message || 'unknown_error'
    );
    return { sent: false, reason: 'conversion_upload_failed' };
  }
}

/**
 * Emite el hito CRM explícito de Lead válido. El eventId depende únicamente del
 * lead para que una cualificación manual y una cita directa converjan en la
 * misma conversión idempotente. No se incluyen motivo, tratamiento ni notas.
 */
async function ensureQualifiedLeadConversion({
  lead,
  occurredAt = new Date(),
  dependencies = {},
  logger = console,
} = {}) {
  const leadId = positiveInt(plainRecord(lead)?.id);
  if (!leadId) return { sent: false, reason: 'lead_required' };

  return nonBlockingLifecycleUpload({
    lead,
    eventName: 'qualified_lead',
    eventId: `lead-${leadId}-qualified`,
    clinicId: positiveInt(plainRecord(lead)?.clinica_id),
    value: 0,
    currency: 'EUR',
    occurredAt,
    dependencies,
    logger,
  });
}

async function maybeUploadQualifiedLeadStatusTransition({
  lead,
  previousStatus,
  nextStatus,
  occurredAt = new Date(),
  dependencies = {},
  logger = console,
} = {}) {
  const previous = String(previousStatus || '').trim().toLowerCase();
  const next = String(nextStatus || '').trim().toLowerCase();
  if (next !== 'cualificado') return { sent: false, reason: 'qualified_status_required' };
  if (previous === 'cualificado') return { sent: false, reason: 'qualified_status_already_set' };
  return ensureQualifiedLeadConversion({ lead, occurredAt, dependencies, logger });
}

/**
 * Camino canónico para Schedule al enlazar una cita que ya existía. Usa el
 * mismo eventId que createCita, por lo que reintentos o enlaces repetidos no
 * contabilizan dos veces.
 */
async function uploadScheduleForLinkedAppointment({
  lead,
  appointment,
  dependencies = {},
  logger = console,
} = {}) {
  const plainAppointment = plainRecord(appointment) || {};
  const appointmentId = positiveInt(plainAppointment.id_cita);
  const leadId = positiveInt(plainRecord(lead)?.id);
  if (!appointmentId || !leadId) return { sent: false, reason: 'linked_appointment_required' };
  if (positiveInt(plainAppointment.lead_intake_id) !== leadId) {
    return { sent: false, reason: 'appointment_lead_link_required' };
  }

  return nonBlockingLifecycleUpload({
    lead,
    eventName: 'schedule',
    eventId: `appointment-${appointmentId}`,
    clinicId: positiveInt(plainAppointment.clinica_id ?? plainRecord(lead)?.clinica_id),
    value: 0,
    currency: 'EUR',
    occurredAt: plainAppointment.created_at || plainAppointment.updated_at || new Date(),
    dependencies,
    logger,
  });
}

module.exports = {
  ensureQualifiedLeadConversion,
  maybeUploadQualifiedLeadStatusTransition,
  nonBlockingLifecycleUpload,
  uploadScheduleForLinkedAppointment,
};
