'use strict';
// Standalone import workers publish only lookup IDs. REST remains the source
// for message contents and checks the reader's current access on every refresh.
const positive = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function invalidation(event, payload) {
  if (!['message:created','message:updated'].includes(event)
    || !positive(payload?.id) || !positive(payload?.conversation_id)) throw Error('realtime_packet_invalid');
  return { id: payload.id, conversation_id: payload.conversation_id, realtime_refresh: true };
}
module.exports = { invalidation };
