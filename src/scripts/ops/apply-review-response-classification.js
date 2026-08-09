'use strict';

const db = require('../../../models');
const marketingOptOutService = require('../../services/marketingOptOut.service');

const ALLOWED_INTENTS = new Set(['marketing_opt_out', 'wrong_recipient', 'review_refusal', 'ambiguous']);

function readArg(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() : '';
}

function positiveInt(value) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function main() {
  const conversationId = positiveInt(readArg('conversation'));
  const inboundMessageId = positiveInt(readArg('message'));
  const intent = readArg('intent');
  const apply = process.argv.includes('--apply');
  if (!conversationId || !inboundMessageId || !ALLOWED_INTENTS.has(intent)) {
    throw new Error('Uso: --conversation=<id> --message=<id> --intent=<intent> [--apply]');
  }

  const conversation = await db.Conversation.findByPk(conversationId);
  const inboundMessage = await db.Message.findOne({
    where: { id: inboundMessageId, conversation_id: conversationId, direction: 'inbound' },
  });
  if (!conversation || !inboundMessage) throw new Error('Conversación o mensaje inbound no encontrado');

  const summary = {
    apply,
    conversation_id: conversation.id,
    clinic_id: conversation.clinic_id,
    patient_id: conversation.patient_id,
    inbound_message_id: inboundMessage.id,
    content: inboundMessage.content,
    intent,
  };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, result: 'dry_run' }, null, 2));
    return;
  }

  const result = await marketingOptOutService.applyInboundContactClassification({
    clinicId: conversation.clinic_id,
    conversation,
    inboundMessage,
    patientId: conversation.patient_id,
    classification: { intent, confidence: 1, source: 'admin_review' },
  });
  if (result?.applied) {
    await inboundMessage.update({
      metadata: {
        ...(inboundMessage.metadata || {}),
        marketing_opt_out: result,
      },
    });
  }
  console.log(JSON.stringify({ ...summary, result }, null, 2));
}

main()
  .then(() => db.sequelize.close())
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_) {}
    process.exit(1);
  });
