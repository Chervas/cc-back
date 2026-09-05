'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  findHumanReplyAfterMessage,
} = require('../../services/conversationPendingReply.service');

async function run() {
  const originalQuery = db.sequelize.query;
  const originalConversationFindByPk = db.Conversation.findByPk;

  try {
    const patientMessageId = 92001;
    const humanMessageId = 92002;
    const conversationId = 8701;
    const context = {
      appointment: { id: 4401, estado: 'recordatorio_enviado' },
      conversation: { id: conversationId },
      trigger: { data: { conversation_id: conversationId, latest_inbound_message_id: patientMessageId } },
    };
    const statusResult = await flowEngine._processNode({
      id: 'N-status',
      type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'recordatorio_confirmado' },
      outputs: { on_success: 'N-reply' },
    }, context, { simulation: true });
    assert.equal(statusResult.context_patch.appointment.estado, 'recordatorio_confirmado');
    assert.equal(statusResult.next_node_id, 'N-reply');

    db.Conversation.findByPk = async (id) => {
      assert.equal(id, conversationId);
      return { id, clinic_id: 35, channel: 'whatsapp' };
    };
    db.sequelize.query = async (sql, options) => {
      assert.match(sql, /id > :responseMessageId/);
      assert.deepEqual(options.replacements, { conversationId, responseMessageId: patientMessageId });
      return [{ id: humanMessageId }];
    };

    const replyResult = await flowEngine._processNode({
      id: 'N-reply',
      type: 'action/reply_message',
      config: { message_text: 'Gracias por confirmarlo.', suppress_if_human_replied: true },
      outputs: { on_success: null },
    }, {
      ...context,
      appointment: statusResult.context_patch.appointment,
    }, {
      simulation: false,
      execution: { clinic_id: 35, trigger_entity_id: conversationId },
    });

    assert.equal(replyResult.output.status, 'suppressed_human_reply');
    assert.equal(replyResult.output.source_message_id, patientMessageId);
    assert.equal(replyResult.output.human_message_id, humanMessageId);
    assert.equal(statusResult.context_patch.appointment.estado, 'recordatorio_confirmado');

    const latestPatientMessageId = 93003;
    db.sequelize.query = async (sql, options) => {
      assert.match(sql, /id > :responseMessageId/);
      assert.deepEqual(options.replacements, {
        conversationId,
        responseMessageId: latestPatientMessageId,
      });
      return [];
    };
    assert.equal(
      await findHumanReplyAfterMessage(conversationId, latestPatientMessageId),
      null,
    );

    console.log('human_interruption_90s.test.js OK');
  } finally {
    db.sequelize.query = originalQuery;
    db.Conversation.findByPk = originalConversationFindByPk;
  }
}

run().then(async () => {
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(1);
});
