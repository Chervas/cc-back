'use strict';

const PROTECTED = new Set(['cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado']);

// Serialize a manual attempt with appointment/lead updates. Reading before the
// lock could otherwise write a stale "contactado" after a booking has committed.
async function registerLeadWhatsappContactAttempt({ models, leadId, userId, isTemplate, body }) {
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return models.sequelize.transaction(async transaction => {
    const lead = await models.LeadIntake.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!lead) return null;
    const now = new Date();
    const motivo = isTemplate ? 'whatsapp_template_sent' : 'whatsapp_message_sent';
    const notas = isTemplate ? 'Plantilla WhatsApp enviada' : 'WhatsApp enviado';
    const historial = Array.isArray(lead.historial_contactos) ? [...lead.historial_contactos] : [];
    historial.push({ fecha: now.toISOString(), motivo, notas, canal: 'whatsapp', usuario_id: userId || null });
    await lead.update({ historial_contactos: historial, num_contactos: (Number(lead.num_contactos) || 0) + 1,
      ultimo_contacto: now, status_lead: PROTECTED.has(String(lead.status_lead || '').trim().toLowerCase())
        ? lead.status_lead : 'contactado',
    }, { transaction });
    if (models.LeadContactAttempt) {
      await models.LeadContactAttempt.create({ lead_intake_id: lead.id, usuario_id: userId || null,
        canal: 'whatsapp', motivo, notas: String(body || '').trim().slice(0, 500) || notas }, { transaction });
    }
    return lead;
  });
}

module.exports = { registerLeadWhatsappContactAttempt };
