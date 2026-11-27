'use strict';

async function prepareConsent(cita, actor, triggerSource) {
  if (!cita?.id_cita) return null;
  const consentimientosService = require('./consentimientos.service');
  const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');
  const result = await consentimientosService.ensurePackageForAppointment(cita.id_cita, {
    createdBy: actor.user_id || null,
    triggerSource,
  });
  const packagePlain = result?.package?.toJSON ? result.package.toJSON() : result?.package;
  if (packagePlain?.id) {
    await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
      event_name: 'consent_required',
      window_identifier: `consent:${packagePlain.public_id || packagePlain.id}`,
      trigger_data: {
        consent_package_id: packagePlain.id,
        consent_package_public_id: packagePlain.public_id || null,
        consent_required_count: result?.summary?.required_total || packagePlain.required_count || 0,
        consent_pending_required: result?.summary?.pending_required || 0,
        consent_public_url_pending: true,
      },
      ...actor,
    });
  }
  return result;
}

function emitAppointmentSocketEvent(eventName, citaLike) {
  const io = require('./socket.service').getIO();
  if (!io || !citaLike) return;

  const clinicId = Number(citaLike.clinica_id || citaLike.clinic_id || 0);
  const appointmentId = Number(citaLike.id_cita || citaLike.id || 0);
  if (!Number.isFinite(clinicId) || clinicId <= 0 || !Number.isFinite(appointmentId) || appointmentId <= 0) {
    return;
  }

  const payload = {
    appointment_id: appointmentId,
    clinic_id: clinicId,
    patient_id: Number(citaLike.paciente_id || citaLike.patient_id || 0) || null,
    lead_intake_id: Number(citaLike.lead_intake_id || 0) || null,
    doctor_id: Number(citaLike.doctor_id || 0) || null,
    instalacion_id: Number(citaLike.instalacion_id || 0) || null,
    tratamiento_id: Number(citaLike.tratamiento_id || 0) || null,
    estado: citaLike.estado || null,
    inicio: citaLike.inicio || null,
    fin: citaLike.fin || null,
    updated_at: citaLike.updated_at || citaLike.updatedAt || new Date().toISOString(),
    created_at: citaLike.created_at || citaLike.createdAt || new Date().toISOString(),
  };

  io.to(`clinic:${clinicId}`).emit(eventName, payload);
}

module.exports = { prepareConsent, emitAppointmentSocketEvent };
