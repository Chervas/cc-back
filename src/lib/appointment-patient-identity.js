'use strict';

const { createHash } = require('node:crypto');
const { normalizePhoneDigits } = require('./phone');
const { normalizeHumanName } = require('./name');
const { lockPatientHistoryCounter } = require('../services/patientHistoryNumber.service');

function normalizeAppointmentClinicId(value) {
  const id = !['string', 'number'].includes(typeof value)
    || typeof value === 'string' && !/^\d+$/.test(value.trim()) ? NaN : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('La clínica de la cita no es válida.'),
    { code: 'booking_patient_identity_invalid', statusCode: 400 });
  return id;
}

// A new patient does not have a durable SQL id until the appointment commits.
// Bind an exceptional-reservation receipt to its server-resolved contact instead
// of the transient AUTO_INCREMENT id consumed by a rolled-back attempt. Never
// accept this identity from an HTTP field or use it for an existing patient.
function prospectiveAppointmentPatientIdentity({ clinicId, leadId = null, patient }) {
  return createHash('sha256').update(JSON.stringify({ schema: 'prospective-appointment-patient/1',
    clinic: normalizeAppointmentClinicId(clinicId), lead: leadId == null ? null : Number(leadId),
    phone: normalizePhoneDigits(patient?.telefono) || '',
    email: String(patient?.email || '').trim().toLowerCase(),
    name: normalizeHumanName(patient?.nombre || 'Sin nombre'),
    surname: normalizeHumanName(patient?.apellidos || ''),
    language: patient?.idioma_preferido ?? null,
    title: String(patient?.titulo || '').trim(),
  })).digest('hex');
}

async function withAppointmentPatientIdentity({ db, clinic, patient, leadId = null, resolve, work }) {
  const clinicId = normalizeAppointmentClinicId(clinic?.id_clinica);
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    if (!(patient?.id_paciente || patient?.id)) {
      // Serialize against both another booking and ordinary patient creation
      // using the allocator's existing group/clinic counter, without consuming
      // an NHC. Keep its counter -> Pacientes/clinic-FK lock order everywhere.
      // READ COMMITTED then sees a preceding registration before the lookup.
      await lockPatientHistoryCounter(db.sequelize, clinicId, transaction);
    }
    const resolved = await resolve(transaction);
    if (!Number.isSafeInteger(Number(resolved?.patient?.id_paciente)) || Number(resolved.patient.id_paciente) <= 0
      || typeof resolved.created !== 'boolean') throw new Error('appointment_patient_resolution_invalid');
    return work({ ...resolved, transaction,
      prospectivePatientIdentity: resolved.created
        ? prospectiveAppointmentPatientIdentity({ clinicId, leadId, patient }) : null });
  });
}

module.exports = { normalizeAppointmentClinicId, prospectiveAppointmentPatientIdentity, withAppointmentPatientIdentity };
