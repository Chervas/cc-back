'use strict';

const { Op, fn, col, where, literal } = require('sequelize');
const { normalizePhoneE164, getPhoneIdentityCandidates } = require('../lib/phone');

// Called only inside a NEW patient's registration transaction. This is an
// explicit initial link, never a repair made by a sender or error logger.
async function link({ db, patient, clinicId, transaction }) {
  if (!transaction || !patient?.id_paciente) throw Error('new_patient_contact_transaction_required');
  const clinic = Number(clinicId), patientId = Number(patient.id_paciente);
  const phone = normalizePhoneE164(patient.telefono_movil);
  if (!Number.isSafeInteger(clinic) || clinic <= 0 || !phone) return null;
  await db.Clinica.findByPk(clinic, { transaction, lock: transaction.LOCK.SHARE });
  const current = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!current || normalizePhoneE164(current.telefono_movil) !== phone) return null;
  // Booking can create the patient just before its own persistence transaction.
  // A concurrent contact edit, including A -> B -> A, cancels the initial link.
  if (await db.PatientOperationalEvent.findOne({ where: { patient_id: patientId,
    event_type: 'patient.whatsapp_phone_changed' }, attributes: ['id'], transaction })) return null;
  const candidates = [...new Set(getPhoneIdentityCandidates(phone).map(value => value.replace(/\D/g, '')))];
  const normalizedColumn = name => fn('REGEXP_REPLACE', fn('REGEXP_REPLACE', col(name), '[^0-9]', ''), '^00', '');
  // Do not attach a household/shared number or a patient's record in another
  // clinic. The registration already owns this clinic/patient transaction.
  const owners = await db.Paciente.findAll({ where: { [Op.and]: [
    where(normalizedColumn('telefono_movil'), { [Op.in]: candidates }),
    { [Op.or]: [{ clinica_id: clinic }, literal(`EXISTS (SELECT 1 FROM PacienteClinicas npc WHERE npc.paciente_id=Paciente.id_paciente AND npc.clinica_id=${clinic})`)] },
  ] }, attributes: ['id_paciente'], transaction });
  if (owners.length !== 1 || Number(owners[0].id_paciente) !== patientId) return null;
  const chats = await db.Conversation.findAll({ where: { clinic_id: clinic, channel: 'whatsapp',
    [Op.and]: [where(normalizedColumn('contact_id'), { [Op.in]: candidates })],
  }, transaction, lock: transaction.LOCK.UPDATE, order: [['id', 'ASC']] });
  if (chats.length !== 1 || chats[0].patient_id || chats[0].lead_id
    || normalizePhoneE164(chats[0].contact_id) !== phone) return null;
  await chats[0].update({ patient_id: patientId }, { transaction });
  return chats[0].id;
}

module.exports = { link };
