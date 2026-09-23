'use strict';
const { eligible } = require('../lib/whatsappFreshInboundEligibility');
const broker = require('../lib/whatsappAuthorizedBrokerClient');
const { patientImportHeld } = require('../lib/whatsappAppointmentEligibility');
async function tick() {
  const config = broker.configuration();
  if (!config) throw Error('whatsapp_fresh_inbound_unconfigured');
  const bindings = config.bindings.filter(b => b.sendEnabled);
  if (!bindings.length) return { dispatched: 0 };
  const reception = require('../lib/whatsappInboxHealth');
  const snapshot = reception.read();
  if (!snapshot || snapshot.recoveryHold || Date.now()-snapshot.observedAt>90000) return { dispatched: 0, receptionHeld: true };
  const cutoff = new Date(Math.max(Date.parse(config.messageNotBefore), Date.parse(snapshot.recoveryNotBefore || '') || 0)).toISOString();
  const db = require('../../models');
  const replacements = { cutoff: new Date(cutoff) };
  const scopes = bindings.map((b, i) => {
    replacements['clinic' + i] = b.clinicId; replacements['phone' + i] = b.phoneId;
    replacements['since' + i] = new Date(Math.max(Date.parse(cutoff), b.messageNotBefore ? Date.parse(b.messageNotBefore) : 0));
    return `(c.clinic_id=:clinic${i} AND i.phone_id=:phone${i} AND m.sent_at>=:since${i})`;
  });
  const [rows] = await db.sequelize.query("SELECT m.id FROM Messages m JOIN Conversations c ON c.id=m.conversation_id JOIN WhatsappInboxMessageKeys k ON k.message_id=m.id JOIN WhatsappInboxImports i ON i.receipt=JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.inbox_receipt')) AND i.clinic_id=c.clinic_id AND i.phone_id=JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.phone_number_id')) WHERE (" + scopes.join(' OR ') + ") AND m.direction='inbound' AND ((m.message_type='text' AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.provider_type')) IN ('text','button','interactive')) OR (m.message_type='reaction' AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.provider_type'))='reaction' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.reaction.emoji')),'')<>'') OR (JSON_CONTAINS_PATH(m.metadata,'one','$.media.id') AND COALESCE(JSON_EXTRACT(m.metadata,'$.media_recovered_without_automation'),CAST('false' AS JSON))=CAST('false' AS JSON) AND (JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.provider_type'))<>'audio' OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.audio_transcription.status')) IN ('success','unavailable')))) AND m.sent_at >= :cutoff AND m.sent_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 HOUR) AND JSON_EXTRACT(m.metadata,'$.historical')=CAST('false' AS JSON) AND JSON_EXTRACT(m.metadata,'$.passive_recovery')=CAST('true' AS JSON) AND COALESCE(JSON_EXTRACT(m.metadata,'$.recovery_without_automation'),CAST('false' AS JSON))=CAST('false' AS JSON) AND JSON_EXTRACT(m.metadata,'$.fresh_inbound_dispatched_at') IS NULL ORDER BY m.id LIMIT 50", { replacements });
  let dispatched = 0, held = 0;
  for (const row of rows) {
    try {
      await db.sequelize.transaction(async transaction => {
        const message = await db.Message.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
        const conversation = message && await db.Conversation.findByPk(message.conversation_id, { transaction });
        const b = bindings.find(b => b.clinicId === Number(conversation?.clinic_id)
          && b.phoneId === message?.metadata?.phone_number_id && b.wabaId === message?.metadata?.waba_id);
        const currentHealth = reception.read();
        if (!reception.state(currentHealth, Number(conversation?.clinic_id)).healthy
          || Date.parse(currentHealth?.recoveryNotBefore || '') > Date.parse(cutoff)
          || !eligible(message, conversation, b, cutoff)) { held++; return; }
        if (conversation.patient_id && await patientImportHeld(Number(conversation.patient_id), db)) { held++; return; }
        const current = await broker.binding(b.clinicId, b.assetId);
        if (JSON.stringify(current) !== JSON.stringify(b) || JSON.stringify(broker.configuration()) !== JSON.stringify(config)) throw Error('whatsapp_fresh_inbound_scope_changed');
        await require('./automationInboundMessage.service').enqueueInboundDispatch({ inboundMessage: message,
          conversation, clinicId: b.clinicId, channel: 'whatsapp', providerMessageId: message.metadata.wamid }, { transaction });
        await message.update({ metadata: { ...message.metadata, automatic_actions_allowed: true,
          fresh_inbound_authorization_id: b.authorizationId, fresh_inbound_dispatched_at: new Date().toISOString() } }, { transaction });
        dispatched++;
      });
    } catch { held++; }
  }
  return { dispatched, held };
}
module.exports = { tick };
