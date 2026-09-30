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
    ORDER BY m.id DESC LIMIT 50`, { replacements: { conversationId, clinicId: Number(clinicId), since: new Date(started) } });
  let recoveredMessageId = null;
  for (const row of rows) {
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    const binding = own.find(b => b.phoneId === metadata?.phone_number_id && b.wabaId === metadata?.waba_id);
    const recovered = metadata?.recovery_without_automation === true || metadata?.media_recovered_without_automation === true;
    // These markers are removed only from the timeout guard's copy. Recovery
    // messages remain ineligible for dispatch and must be reviewed by a human.
    const message = { ...row, metadata: { ...metadata, fresh_inbound_dispatched_at: undefined,
      recovery_without_automation: false, media_recovered_without_automation: false,
      ...(metadata?.provider_type === 'audio' ? { audio_transcription: { status: 'unavailable' } } : {}),
    } };
    const cutoff = new Date(recovered ? started : Math.max(started, Date.parse(snapshot?.recoveryNotBefore || '') || 0)).toISOString();
    const guardBinding = recovered ? { ...binding, messageNotBefore: null } : binding;
    if (!eligible(message, { id: conversationId, clinic_id: Number(clinicId), channel: 'whatsapp' }, guardBinding, cutoff, now,
      { includeExpired: true })) continue;
    if (recovered) recoveredMessageId ||= Number(row.id);
    else return Number(row.id);
  }
  return recoveredMessageId ? { kind: 'recovered', messageId: recoveredMessageId }
    : rows.length === 50 ? 'review_required' : null;
}
module.exports = { pendingReply };
