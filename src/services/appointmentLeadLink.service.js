'use strict';

const { Op } = require('sequelize');
const { normalizePhoneE164, getPhoneLookupCandidates } = require('../lib/phone');
const OPEN_STATUSES = ['nuevo', 'contactado', 'esperando_info', 'info_recibida', 'cualificado', 'citado'];
const ACTIVE_APPOINTMENTS = new Set(['pendiente', 'info_enviada', 'info_confirmada',
  'recordatorio_enviado', 'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada']);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const conflict = () => { throw Object.assign(new Error('El interesado ha cambiado. Revisa la cita antes de guardarla.'),
  { status: 409, code: 'appointment_lead_link_changed' }); };

// Phone suffixes narrow the indexed clinic lookup only. Identity must match the
// complete normalized number; never select the newest of several candidates.
async function findUniqueAppointmentLead({ models, clinicId, phone, patientId = null, transaction = null }) {
  clinicId = positive(clinicId); patientId = positive(patientId);
  const normalized = normalizePhoneE164(phone);
  if (!clinicId || !normalized) return null;
  const candidates = await models.LeadIntake.findAll({ where: {
    clinica_id: clinicId, archived_at: null, status_lead: { [Op.in]: OPEN_STATUSES },
    [Op.or]: [{ telefono: { [Op.in]: getPhoneLookupCandidates(phone) } },
      { telefono: { [Op.like]: '%' + normalized.replace(/\D/g, '').slice(-9) } }],
  }, order: [['id', 'ASC']], limit: 21, transaction });
  if (candidates.length > 20) return null;
  const matches = candidates.filter(lead => normalizePhoneE164(lead.telefono) === normalized);
  if (matches.length !== 1) return null;
  const lead = matches[0];
  if (patientId) {
    const otherConversation = await models.Conversation.findOne({ where: {
      clinic_id: clinicId, lead_id: lead.id, patient_id: { [Op.ne]: patientId },
    }, attributes: ['id'], transaction });
    const otherAppointment = await models.CitaPaciente.findOne({ where: {
      clinica_id: clinicId, lead_intake_id: lead.id, paciente_id: { [Op.ne]: patientId },
    }, attributes: ['id_cita'], transaction });
    if (otherConversation || otherAppointment) return null;
  }
  return lead;
}

// Called inside the appointment transaction, before any automation can observe
// the new booking. A concurrent manual contact uses the same lead row lock.
async function recordCreatedAppointmentLead({ models, lead, appointment, transaction,
  autoLinkPhone = null, actorId = null }) {
  if (!lead) return null;
  if (!transaction) throw Error('appointment_lead_transaction_required');
  const fresh = await models.LeadIntake.findByPk(lead.id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!fresh || positive(appointment.lead_intake_id) !== positive(fresh.id)
    || fresh.clinica_id != null && positive(fresh.clinica_id) !== positive(appointment.clinica_id)
    || fresh.clinica_id == null && positive(fresh.grupo_clinica_id) !== positive(lead.grupo_clinica_id)
    || fresh.archived_at) conflict();
  if (autoLinkPhone !== null) {
    const candidate = await findUniqueAppointmentLead({ models, clinicId: appointment.clinica_id,
      patientId: appointment.paciente_id, phone: autoLinkPhone, transaction });
    if (!candidate || positive(candidate.id) !== positive(fresh.id)) conflict();
  }
  if (ACTIVE_APPOINTMENTS.has(String(appointment.estado || '').toLowerCase())
    && !['convertido', 'descartado', 'acudio_cita'].includes(String(fresh.status_lead || '').toLowerCase())) {
    await fresh.update({ status_lead: 'citado', call_outcome_appointment_id: appointment.id_cita,
      ...(fresh.call_initiated && !fresh.call_outcome ? {
        call_outcome: 'citado', call_outcome_at: new Date(),
        call_outcome_notes: fresh.call_outcome_notes || 'Lead vinculado al crear una cita con el mismo teléfono.',
      } : {}),
    }, { transaction });
  }
  if (autoLinkPhone !== null && models.LeadAttributionAudit) {
    await models.LeadAttributionAudit.create({ lead_intake_id: fresh.id,
      raw_payload: { appointment_id: appointment.id_cita, patient_id: appointment.paciente_id,
        matched_by: 'unique_phone', source: 'manual_appointment_auto_link' },
      attribution_steps: { action: 'auto_link_manual_appointment_unique_lead',
        userId: positive(actorId), clinic_id: positive(appointment.clinica_id) },
    }, { transaction });
  }
  return fresh;
}

module.exports = { findUniqueAppointmentLead, recordCreatedAppointmentLead };
