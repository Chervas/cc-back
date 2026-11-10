'use strict';

const { normalizePhoneE164 } = require('../lib/phone');
const EVENT = 'patient.whatsapp_phone_changed';

// Transport identities stay immutable; QuickChat presents one linked history.
// This event is committed with the patient edit and does not send a WhatsApp.
async function record({ db, patientId, clinicId, previousPhone, nextPhone, actorId, transaction, emit }) {
  const previous = normalizePhoneE164(previousPhone), next = normalizePhoneE164(nextPhone);
  if (previous === next || !db.PatientOperationalEvent) return [];
  if (!transaction) throw new Error('patient_phone_change_requires_transaction');
  const conversations = db.Conversation ? await db.Conversation.findAll({
    where: { patient_id: patientId, channel: 'whatsapp' }, attributes: ['id', 'clinic_id'], transaction, raw: true,
  }) : [];
  const links = db.PacienteClinica ? await db.PacienteClinica.findAll({
    where: { paciente_id: patientId }, attributes: ['clinica_id'], transaction, raw: true,
  }) : [];
  const clinics = [...new Set([Number(clinicId), ...links.map(row => Number(row.clinica_id))])].filter(id => id > 0);
  const rows = [];
  for (const id of clinics) rows.push(await db.PatientOperationalEvent.create({
    patient_id: Number(patientId), clinic_id: id, actor_user_id: Number(actorId) || null,
    event_type: EVENT, source: 'patient_contact_change', channel: 'internal', occurred_at: new Date(),
    metadata: { version: 1, previous_phone: previous, current_phone: next },
  }, { transaction }));
  if(db.sequelize && db.Conversation?.sequelize===db.sequelize) {
    const identityService=require('./whatsappContactIdentity.service');
    for(const id of clinics) await identityService.reconcilePatientChange({patientId,clinicId:id,previousPhone:previous,nextPhone:next,actorId,transaction,database:db});
  }
  transaction.afterCommit(() => {
    if(emit)return emit({patientId,clinics,conversations});
    const io = require('./socket.service').getIO();
    for (const id of clinics) io?.to(`clinic:${id}`).emit('patient:contact_changed',{clinic_id:id,patient_id:Number(patientId)});
    for (const conversation of conversations) {
      if (clinics.includes(Number(conversation.clinic_id))) io?.to(`clinic:${conversation.clinic_id}`)
        .emit('conversation:updated', { id: String(conversation.id), clinic_id: Number(conversation.clinic_id), realtime_refresh: true });
    }
  });
  return rows;
}

module.exports = { EVENT, record };
