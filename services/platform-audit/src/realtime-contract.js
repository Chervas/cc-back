'use strict';
// Closed browser event vocabulary. Redis automation envelopes retain their own contract.
const SOCKET_EVENTS = Object.freeze([
  'message:created', 'message:updated', 'conversation:updated', 'conversation:read',
  'lead:created', 'lead:call_initiated', 'lead:call_outcome',
  'appointment:created', 'appointment:updated', 'appointment:deleted',
  'flow_execution:created', 'flow_execution:engine_start', 'flow_execution:updated',
  'flow_execution:completed', 'flow_execution:failed', 'flow_execution:dead_letter',
  'flow_execution:resumed', 'flow_execution:cancelled', 'flow_execution:log', 'notification:created', 'notification:updated',
]);
const REALTIME_ACTIONS = Object.freeze(['realtime.subscribe', 'realtime.read']);
const MAX_CLINICS = 100;
const positive = v => (typeof v === 'number' && Number.isSafeInteger(v) || typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v))
  && Number(v) > 0 && Number(v) <= 2147483647;
module.exports = { SOCKET_EVENTS, REALTIME_ACTIONS, MAX_CLINICS, positive };
