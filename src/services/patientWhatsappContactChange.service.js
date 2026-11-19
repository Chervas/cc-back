'use strict';

const { getPhoneIdentityCandidates, normalizePhoneE164 } = require('../lib/phone');
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

async function findCurrentConversation({ db, patient, clinicId, transaction, senderForClinic, identityService }) {
  const phone = normalizePhoneE164(patient.telefono_movil);
  if (!phone) return null;

  const { Op, fn, col, where, literal } = db.Sequelize;
  const patientId = Number(patient.id_paciente);
  const normalizedColumn = name => fn('REGEXP_REPLACE', fn('REGEXP_REPLACE', col(name), '[^0-9]', ''), '^00', '');
  const candidates = getPhoneIdentityCandidates(phone).map(number => number.replace(/^\+/, ''));
  const matchesPhone = column => where(normalizedColumn(column), { [Op.in]: [...new Set(candidates)] });
  const conflict = (message, code = 'whatsapp_contact_identity_conflict') =>
    Object.assign(new Error(message), { code });
  const conversations = await db.Conversation.findAll({
    where: { clinic_id: clinicId, channel: 'whatsapp', [Op.and]: [matchesPhone('contact_id')] },
    limit: 2, transaction,
  });
  if (!conversations.length) return null;
  const [candidate] = conversations;
  if (conversations.length !== 1 || normalizePhoneE164(candidate.contact_id) !== phone) {
    throw conflict('Hay varias conversaciones asociadas a este número o sus datos no coinciden. Revisa el contacto antes de continuar.');
  }
  if (candidate.patient_id && Number(candidate.patient_id) !== patientId) {
    throw conflict('El número actual tiene una conversación vinculada a otra ficha. Revisa ambas fichas antes de continuar.');
  }

  if (candidate.patient_id) {
    const canonical = await identityService.canonical(candidate, { transaction });
    if (Number(canonical.patient_id) !== patientId || Number(canonical.clinic_id) !== clinicId
      || canonical.channel !== 'whatsapp' || normalizePhoneE164(canonical.contact_id) !== phone) {
      throw conflict('La conversación de este número apunta a otro teléfono. Revisa el contacto antes de continuar.');
    }
    return canonical;
  }

  // An unassigned contact can only be opened in its own QuickChat category.
  // A navigation request does not use a phone match to attach or join records.
  const unverified = () => conflict('Hay una conversación con este número, pero su identidad requiere revisión antes de abrirla.',
    'quickchat_current_number_unverified');
  if (candidate.lead_id) throw unverified();
  const owners = await db.Paciente.findAll({
    where: { [Op.and]: [matchesPhone('telefono_movil'), {
      [Op.or]: [{ clinica_id: clinicId }, literal(`EXISTS (SELECT 1 FROM PacienteClinicas current_phone_scope
        WHERE current_phone_scope.paciente_id = Paciente.id_paciente AND current_phone_scope.clinica_id = ${Number(clinicId)})`)],
    }] },
    attributes: ['id_paciente'], limit: 2, raw: true, transaction,
  });
  if (owners.length !== 1 || Number(owners[0].id_paciente) !== patientId) throw unverified();
  const cluster = await identityService.cluster(candidate, { transaction });
  if (cluster.ids.length !== 1 || cluster.canonicalId !== Number(candidate.id)) throw unverified();
  const sender = await senderForClinic(clinicId);
  if (!await identityService.hasProviderPhoneProof(candidate, phone, sender, { transaction, database: db })) throw unverified();
  return candidate;
}

module.exports = { EVENT, record, findCurrentConversation };
