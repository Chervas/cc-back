'use strict';
const broker = require('../lib/whatsappAuthorizedBrokerClient');

function createRealtimeDispatcher({
  database = () => require('../../models').sequelize,
  configuration = () => broker.configuration(),
  publish = (...args) => require('./socket.service').publishConfirmed(...args),
  reconcileHumanReply = (...args) => require('./whatsappFreshPostImport.service').reconcileOutboundHumanReply(...args),
  reconcileDeliveryStatus = (...args) => require('./whatsappFreshPostImport.service').reconcileDeliveryStatus(...args),
} = {}) {
  return async function tick() {
    const config = configuration();
    if (!config) throw Error('whatsapp_fresh_realtime_unconfigured');
    const bindings = config.bindings;
    if (!bindings.length) return { notified: 0 };
    const db = database(), replacements = { cutoff: new Date(config.messageNotBefore) };
    const scopes = bindings.map((binding, i) => {
      replacements['clinic' + i] = binding.clinicId;
      replacements['phone' + i] = binding.phoneId;
      return `(c.clinic_id=:clinic${i} AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.phone_number_id')),JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.phoneNumberId')),JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.phoneId')))=:phone${i})`;
    });
    const [rows] = await db.query(`SELECT m.id,m.conversation_id,m.direction,m.message_type,m.status,m.sent_at,c.clinic_id,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fresh_realtime_status')) notified_status,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.source_event')),JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.coexistence.source_event'))) source_event,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fresh_human_reply_reconciled_at')) human_reply_reconciled_at,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fresh_delivery_reconciled_status')) delivery_reconciled_status
      FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
      WHERE c.channel='whatsapp' AND (${scopes.join(' OR ')}) AND m.createdAt >= :cutoff
      AND (
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fresh_realtime_status')),'')<>m.status
        OR (
          m.direction='outbound'
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.source_event')),JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.coexistence.source_event')))='smb_message_echoes'
          AND JSON_EXTRACT(m.metadata,'$.fresh_human_reply_reconciled_at') IS NULL
        )
        OR (
          m.direction='outbound'
          AND m.status IN ('sent','delivered','read','failed')
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fresh_delivery_reconciled_status')),'')<>m.status
        )
      )
      AND COALESCE(JSON_EXTRACT(m.metadata,'$.historical'),CAST('false' AS JSON))=CAST('false' AS JSON)
      AND COALESCE(JSON_EXTRACT(m.metadata,'$.qa_cleanup'),CAST('false' AS JSON))=CAST('false' AS JSON)
      AND COALESCE(JSON_EXTRACT(m.metadata,'$.hide_from_quickchat'),CAST('false' AS JSON))=CAST('false' AS JSON)
      ORDER BY m.id LIMIT 50`, { replacements });
    let notified = 0;
    let humanRepliesReconciled = 0;
    let deliveryStatusesReconciled = 0;
    for (const row of rows) {
      if (JSON.stringify(configuration()) !== JSON.stringify(config)) throw Error('whatsapp_fresh_realtime_scope_changed');
      const isHumanReply = row.direction === 'outbound' && row.source_event === 'smb_message_echoes';
      if (isHumanReply && !row.human_reply_reconciled_at) {
        try {
          const result = await reconcileHumanReply({
            clinicId: row.clinic_id,
            conversationId: row.conversation_id,
            messageId: row.id,
          });
          if (result?.reconciled !== true) throw Error(result?.reason || 'human_reply_reconciliation_failed');
          await db.query(`UPDATE Messages SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),
            '$.fresh_human_reply_reconciled_at',:reconciledAt,
            '$.fresh_human_reply_reconciliation',CAST(:result AS JSON))
            WHERE id=:id AND conversation_id=:conversation
            AND JSON_EXTRACT(metadata,'$.fresh_human_reply_reconciled_at') IS NULL`, {
            replacements: {
              id: row.id,
              conversation: row.conversation_id,
              reconciledAt: new Date().toISOString(),
              result: JSON.stringify(result),
            },
          });
          humanRepliesReconciled++;
        } catch (error) {
          console.warn('[whatsapp-fresh-realtime] No se pudo conciliar la respuesta enviada desde el móvil', {
            clinicId: row.clinic_id,
            conversationId: row.conversation_id,
            messageId: row.id,
            error: error?.code || error?.name || error?.message || error,
          });
        }
      }
      if (row.direction === 'outbound' && row.delivery_reconciled_status !== row.status) {
        try {
          const result = await reconcileDeliveryStatus({
            clinicId: row.clinic_id,
            messageId: row.id,
            status: row.status,
          });
          if (result?.reconciled !== true) throw Error(result?.reason || 'delivery_status_reconciliation_failed');
          await db.query(`UPDATE Messages SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),
            '$.fresh_delivery_reconciled_status',:status,
            '$.fresh_delivery_reconciled_at',:reconciledAt)
            WHERE id=:id AND conversation_id=:conversation AND status=:status`, {
            replacements: {
              id: row.id,
              conversation: row.conversation_id,
              status: row.status,
              reconciledAt: new Date().toISOString(),
            },
          });
          deliveryStatusesReconciled++;
        } catch (error) {
          console.warn('[whatsapp-fresh-realtime] No se pudo conciliar el estado de entrega', {
            clinicId: row.clinic_id,
            messageId: row.id,
            status: row.status,
            error: error?.code || error?.name || error?.message || error,
          });
        }
      }
      if (row.notified_status === row.status) continue;
      // IDs invalidate the authenticated view. No patient text or resume_text
      // enters the bus, and the legacy resume listener cannot trigger a flow.
      await publish(row.notified_status ? 'message:updated' : 'message:created', {
        id: row.id, conversation_id: row.conversation_id, direction: row.direction,
        message_type: row.message_type, status: row.status, sent_at: row.sent_at,
      }, ['clinic:' + row.clinic_id]);
      // A crash before this stamp only repeats an idempotent view invalidation.
      // A concurrent status update stays pending for the next pass.
      await db.query(`UPDATE Messages SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.fresh_realtime_status',:status)
        WHERE id=:id AND conversation_id=:conversation AND status=:status`, {
        replacements: { id: row.id, conversation: row.conversation_id, status: row.status },
      });
      notified++;
    }
    return {
      notified,
      human_replies_reconciled: humanRepliesReconciled,
      delivery_statuses_reconciled: deliveryStatusesReconciled,
    };
  };
}
module.exports = { createRealtimeDispatcher, tick: createRealtimeDispatcher() };
