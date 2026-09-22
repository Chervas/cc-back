'use strict';
function eligible(message, conversation, binding, cutoff, now = Date.now()) {
  const m = message?.metadata;
  const sent = new Date(message?.sent_at || '').getTime(), since = Math.max(Date.parse(cutoff),
    binding?.messageNotBefore ? Date.parse(binding.messageNotBefore) : 0);
  const media=['image','video','audio','document','sticker'].includes(m?.provider_type)&&m?.media?.id
    && (m.provider_type!=='audio'||m.audio_transcription?.status==='success'||m.audio_transcription?.status==='unavailable');
  return !!(binding?.sendEnabled === true && message?.direction === 'inbound' && (message.message_type === 'text'||media)
    && conversation?.channel === 'whatsapp' && Number(conversation.clinic_id) === binding.clinicId
    && Number(message.conversation_id) === Number(conversation.id) && m?.passive_recovery === true
    && m.historical === false && !m.recovery_without_automation && !m.media_recovered_without_automation && (['text','button','interactive'].includes(m.provider_type)||media)
    && m.phone_number_id === binding.phoneId && m.waba_id === binding.wabaId
    && /^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(m.wamid || '')
    && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.inbox_receipt || '')
    && Number.isFinite(since) && Number.isFinite(sent) && sent >= since && sent <= now + 300000
    && now - sent <= 86400000 && !m.fresh_inbound_dispatched_at);
}
module.exports = { eligible };
