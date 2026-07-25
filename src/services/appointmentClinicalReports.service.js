'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');

const {
  sequelize,
  AppointmentClinicalReport,
  AppointmentClinicalReportRevision,
  CitaPaciente,
  Paciente,
  Tratamiento,
  Usuario,
} = db;

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function clean(value, max = 20000) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function snapshot(report) {
  return {
    public_id: report.public_id,
    clinic_id: Number(report.clinic_id),
    patient_id: Number(report.patient_id),
    appointment_id: Number(report.appointment_id),
    treatment_id: report.treatment_id ? Number(report.treatment_id) : null,
    professional_id: report.professional_id ? Number(report.professional_id) : null,
    status: report.status,
    reason: report.reason,
    summary: report.summary,
    findings: report.findings,
    interventions: report.interventions,
    outcome: report.outcome,
    plan: report.plan,
    next_steps: report.next_steps,
    private_notes: report.private_notes,
    finalized_at: report.finalized_at,
  };
}

function serialize(report, related = {}) {
  const value = report.toJSON ? report.toJSON() : report;
  const appointment = related.appointment || {};
  const treatment = related.treatment || {};
  const professional = related.professional || {};
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    patient_id: Number(value.patient_id),
    appointment_id: Number(value.appointment_id),
    treatment_id: value.treatment_id ? Number(value.treatment_id) : null,
    professional_id: value.professional_id ? Number(value.professional_id) : null,
    professional_name: [professional.nombre, professional.apellidos].filter(Boolean).join(' ').trim() || null,
    treatment_name: treatment.nombre || appointment.titulo || null,
    appointment_start: appointment.inicio || null,
    appointment_end: appointment.fin || null,
    appointment_status: appointment.estado || null,
    status: value.status,
    version: Number(value.version_number),
    reason: value.reason || null,
    summary: value.summary || null,
    findings: value.findings || null,
    interventions: value.interventions || null,
    outcome: value.outcome || null,
    plan: value.plan || null,
    next_steps: value.next_steps || null,
    private_notes: value.private_notes || null,
    finalized_at: value.finalized_at || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function loadAppointment(appointmentId, transaction = null) {
  const id = positiveInteger(appointmentId);
  if (!id) throw domainError(400, 'appointment_id_invalid', 'La cita no es válida.');
  const appointment = await CitaPaciente.findByPk(id, { transaction });
  if (!appointment) throw domainError(404, 'appointment_not_found', 'Cita no encontrada.');
  return appointment;
}

async function relatedForReports(reports, transaction = null) {
  const appointmentIds = [...new Set(reports.map((row) => Number(row.appointment_id)).filter(Boolean))];
  const treatmentIds = [...new Set(reports.map((row) => Number(row.treatment_id)).filter(Boolean))];
  const professionalIds = [...new Set(reports.map((row) => Number(row.professional_id)).filter(Boolean))];
  const [appointments, treatments, professionals] = await Promise.all([
    appointmentIds.length ? CitaPaciente.findAll({ where: { id_cita: { [Op.in]: appointmentIds } }, transaction }) : [],
    treatmentIds.length ? Tratamiento.findAll({
      where: { id_tratamiento: { [Op.in]: treatmentIds } },
      attributes: ['id_tratamiento', 'nombre'],
      transaction,
    }) : [],
    professionalIds.length ? Usuario.findAll({
      where: { id_usuario: { [Op.in]: professionalIds } },
      attributes: ['id_usuario', 'nombre', 'apellidos'],
      transaction,
    }) : [],
  ]);
  return {
    appointments: new Map(appointments.map((row) => [Number(row.id_cita), row])),
    treatments: new Map(treatments.map((row) => [Number(row.id_tratamiento), row])),
    professionals: new Map(professionals.map((row) => [Number(row.id_usuario), row])),
  };
}

async function getByAppointment({ appointmentId }) {
  const appointment = await loadAppointment(appointmentId);
  const report = await AppointmentClinicalReport.findOne({
    where: { appointment_id: appointment.id_cita },
  });
  if (!report) {
    return {
      id: null,
      clinic_id: Number(appointment.clinica_id),
      patient_id: Number(appointment.paciente_id),
      appointment_id: Number(appointment.id_cita),
      treatment_id: appointment.tratamiento_id ? Number(appointment.tratamiento_id) : null,
      professional_id: appointment.doctor_id ? Number(appointment.doctor_id) : null,
      treatment_name: appointment.titulo || null,
      appointment_start: appointment.inicio,
      appointment_end: appointment.fin,
      appointment_status: appointment.estado,
      status: 'draft',
      version: 0,
      reason: appointment.motivo || null,
      summary: null,
      findings: null,
      interventions: null,
      outcome: null,
      plan: null,
      next_steps: null,
      private_notes: null,
      finalized_at: null,
      created_at: null,
      updated_at: null,
    };
  }
  const related = await relatedForReports([report]);
  return serialize(report, {
    appointment: related.appointments.get(Number(report.appointment_id)),
    treatment: related.treatments.get(Number(report.treatment_id)),
    professional: related.professionals.get(Number(report.professional_id)),
  });
}

async function listForPatient({ patientIdentifier, clinicId }) {
  const numericId = positiveInteger(patientIdentifier);
  const patient = numericId
    ? await Paciente.findByPk(numericId, { attributes: ['id_paciente', 'clinica_id'] })
    : await Paciente.findOne({
      where: { public_id: clean(patientIdentifier, 64) },
      attributes: ['id_paciente', 'clinica_id'],
    });
  if (!patient) throw domainError(404, 'patient_not_found', 'Paciente no encontrado.');
  const reports = await AppointmentClinicalReport.findAll({
    where: {
      clinic_id: positiveInteger(clinicId),
      patient_id: patient.id_paciente,
    },
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
  });
  const related = await relatedForReports(reports);
  return reports.map((report) => serialize(report, {
    appointment: related.appointments.get(Number(report.appointment_id)),
    treatment: related.treatments.get(Number(report.treatment_id)),
    professional: related.professionals.get(Number(report.professional_id)),
  }));
}

async function save({ appointmentId, actorId, payload, finalize = false }) {
  return sequelize.transaction(async (transaction) => {
    const appointment = await loadAppointment(appointmentId, transaction);
    let report = await AppointmentClinicalReport.findOne({
      where: { appointment_id: appointment.id_cita },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (report?.status === 'final' && !payload.reopen) {
      throw domainError(409, 'clinical_report_final', 'El informe está cerrado. Reábrelo antes de modificarlo.');
    }
    const values = {
      treatment_id: report?.treatment_id || appointment.tratamiento_id || null,
      professional_id: report?.professional_id || appointment.doctor_id || actorId,
      reason: clean(payload.reason, 500),
      summary: clean(payload.summary),
      findings: clean(payload.findings),
      interventions: clean(payload.interventions),
      outcome: clean(payload.outcome),
      plan: clean(payload.plan),
      next_steps: clean(payload.next_steps),
      private_notes: clean(payload.private_notes),
      updated_by: actorId,
    };
    if (![
      values.reason,
      values.summary,
      values.findings,
      values.interventions,
      values.outcome,
      values.plan,
      values.next_steps,
      values.private_notes,
    ].some(Boolean)) {
      throw domainError(400, 'clinical_report_empty', 'Añade al menos un dato clínico al informe.');
    }
    const changeType = !report ? 'created' : (payload.reopen ? 'reopened' : (finalize ? 'finalized' : 'edited'));
    if (!report) {
      report = await AppointmentClinicalReport.create({
        public_id: crypto.randomUUID(),
        clinic_id: appointment.clinica_id,
        patient_id: appointment.paciente_id,
        appointment_id: appointment.id_cita,
        status: finalize ? 'final' : 'draft',
        version_number: 1,
        finalized_at: finalize ? new Date() : null,
        finalized_by: finalize ? actorId : null,
        created_by: actorId,
        ...values,
      }, { transaction });
    } else {
      const nextVersion = Number(report.version_number) + 1;
      await report.update({
        ...values,
        status: finalize ? 'final' : 'draft',
        version_number: nextVersion,
        finalized_at: finalize ? new Date() : null,
        finalized_by: finalize ? actorId : null,
      }, { transaction });
    }
    await AppointmentClinicalReportRevision.create({
      report_id: report.id,
      version_number: report.version_number,
      status: report.status,
      snapshot: snapshot(report),
      change_type: changeType,
      actor_id: actorId,
    }, { transaction });
    const related = await relatedForReports([report], transaction);
    return serialize(report, {
      appointment: related.appointments.get(Number(report.appointment_id)),
      treatment: related.treatments.get(Number(report.treatment_id)),
      professional: related.professionals.get(Number(report.professional_id)),
    });
  });
}

module.exports = {
  domainError,
  getByAppointment,
  listForPatient,
  save,
};
