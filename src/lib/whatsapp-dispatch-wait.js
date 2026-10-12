'use strict';
const CAPACITY = new Set(['rate_limited', 'whatsapp_capacity_concurrency', 'whatsapp_capacity_minute', 'whatsapp_capacity_fairness', 'whatsapp_broker_draining', 'audit_unavailable']);
function lane(message) {
  const m = message?.metadata || {};
  return m.dispatch_wait?.lane || (m.inbound_message_id || m.trigger_message_id ? 'clinical'
    : m.source === 'marketing_bulk_sends' || m.list_id || m.item_id ? 'commercial' : 'clinical');
}
function decision(error) {
  if (CAPACITY.has(error?.code) || error?.code === 'broker_unavailable' && error.beforeDispatch === true) return 'waiting';
  if (error?.delivery_unknown === true) return 'reconciling';
  return null;
}
function retryAt(messageId, now = Date.now(), reason = '') {
  const jitter = Number(messageId) % 17 * 1000;
  return new Date(reason === 'whatsapp_capacity_minute' || reason === 'rate_limited'
    ? Math.ceil((now + 1000) / 60000) * 60000 + jitter : now + 30000 + jitter);
}
function accepted(message) {
  const m = message?.metadata || {};
  return ['sent', 'delivered', 'read'].includes(message?.status) || !!m.wamid || !!m.wa_response?.messages?.[0]?.id;
}
function deferred(error) { return error?.dispatchDeferred === true; }
function acceptedTransport(execution, message) {
  const wait = execution?.waiting_meta;
  return wait?.kind === 'whatsapp_dispatch' && Number(wait.message_id) === Number(message?.id)
    && Number(message?.metadata?.execution_id) === Number(execution.id) && accepted(message);
}
function flowWait(message) {
  const w = message?.metadata?.dispatch_wait;
  if (!w || !['waiting', 'reconciling'].includes(w.state)) return null;
  return { kind: 'waiting', wait_until: retryAt(message.id),
    waiting_meta: { resume_mode: 'retry_current_node', kind: 'whatsapp_dispatch', message_id: message.id },
    output: { message_id: message.id, dispatch_status: w.state, dispatch_reason: w.reason, conversation_id: message.conversation_id } };
}
module.exports = { CAPACITY, lane, decision, retryAt, accepted, acceptedTransport, deferred, flowWait };
