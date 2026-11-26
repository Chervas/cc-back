'use strict';

// Call only after the reception transaction has committed. This is an
// invalidation, not a lead DTO: REST rechecks access and resolves attribution.
function leadCreatedPayload(lead) {
  const leadId = Number(lead?.id), clinicId = Number(lead?.clinica_id);
  if (lead?.archived_at || !Number.isSafeInteger(leadId) || leadId <= 0
    || !Number.isSafeInteger(clinicId) || clinicId <= 0) return null;
  return { type: 'created', lead_id: leadId, clinic_id: clinicId };
}

async function publishLeadDirectorAlert(lead, {
  io,
  directorFor = row => require('./leadPatientAttention.service')
    .createLeadPatientAttentionService(require('../../models')).directorFor(row),
  warn = () => console.warn('lead_director_alert_unavailable'),
} = {}) {
  const payload = leadCreatedPayload(lead);
  if (!payload) return false;
  try {
    if (io === undefined) io = require('./socket.service').getIO();
    if (!io) return false;
    const director = await directorFor(lead);
    if (!Number.isSafeInteger(director?.id) || director.id <= 0) return false;
    io.to(`user:${director.id}`).emit('lead:created', { ...payload, director_alert: true });
    return true;
  } catch {
    // The lead has already committed. A toast failure must not replay intake.
    warn();
    return false;
  }
}

function publishLeadCreated(result, {
  getIO = () => require('./socket.service').getIO(),
  warn = () => console.warn('lead_created_realtime_unavailable'),
  alertDirector = true,
  publishDirector = publishLeadDirectorAlert,
} = {}) {
  const lead = result?.lead;
  const payload = leadCreatedPayload(lead);
  if (result?.duplicate || !payload) return false;
  try {
    const io = getIO();
    if (!io) return false;
    io.to(`clinic:${payload.clinic_id}`).emit('lead:created', payload);
    if (alertDirector) void Promise.resolve(publishDirector(lead, { io })).catch(warn);
    return true;
  } catch {
    // A UI delivery failure cannot roll back a committed lead or trigger
    // another reception/auto-reply. Reconnection reconciles through REST.
    warn();
    return false;
  }
}

module.exports = { publishLeadCreated, publishLeadDirectorAlert };
