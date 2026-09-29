'use strict';
const { eligible } = require('./whatsappFreshInboundEligibility');

// A reply may already be durable in CRM while its native dispatch is queued.
// Keep the wait_response owner alive; never classify or replay it here.
async function pendingReply({ clinicId, anchor, waitingMeta, bindings, snapshot, query, now = Date.now() }) {
  const conversationId = Number(anchor?.listened_output?.conversation_id || anchor?.listened_output?.chat_conversation_id);
  const started = Date.parse(waitingMeta?.wait_starts_at || anchor?.listened_output?.at || '');
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isFinite(started)) return null;
  const own = bindings.filter(b => b.sendEnabled && b.clinicId === Number(clinicId));
  if (!own.length) return null;
  const [rows] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ m.id,m.conversation_id,m.direction,m.message_type,m.sent_at,m.metadata
    FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
    JOIN WhatsappInboxMessageKeys k ON k.message_id=m.id
    JOIN WhatsappInboxImports i ON i.receipt=JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.inbox_receipt')) AND i.clinic_id=c.clinic_id
    LEFT JOIN AutomationInboundMessageClaims a ON a.message_id=m.id
    WHERE c.id=:conversationId AND c.clinic_id=:clinicId AND c.channel='whatsapp'
      AND m.direction='inbound' AND m.sent_at>=:since AND (a.message_id IS NULL OR a.status<>'completed')
      AND JSON_EXTRACT(m.metadata,'$.historical')=CAST('false' AS JSON)
      AND COALESCE(JSON_EXTRACT(m.metadata,'$.recovery_without_automation'),CAST('false' AS JSON))=CAST('false' AS JSON)
    ORDER BY m.id DESC LIMIT 50`, { replacements: { conversationId, clinicId: Number(clinicId), since: new Date(started) } });
  for (const row of rows) {
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    const binding = own.find(b => b.phoneId === metadata?.phone_number_id && b.wabaId === metadata?.waba_id);
    // Removing this marker is only for the guard, never for dispatch. A queued
    // native job still needs its chance to claim the response before timeout.
    const message = { ...row, metadata: { ...metadata, fresh_inbound_dispatched_at: undefined,
      ...(metadata?.provider_type === 'audio' ? { audio_transcription: { status: 'unavailable' } } : {}),
    } };
    const cutoff = new Date(Math.max(started, Date.parse(snapshot?.recoveryNotBefore || '') || 0)).toISOString();
    if (eligible(message, { id: conversationId, clinic_id: Number(clinicId), channel: 'whatsapp' }, binding, cutoff, now,
      { includeExpired: true })) return Number(row.id);
  }
  return rows.length === 50 ? 'review_required' : null;
}
module.exports = { pendingReply };
