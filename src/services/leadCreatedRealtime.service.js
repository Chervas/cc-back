'use strict';

// Call only after the reception transaction has committed. This is an
// invalidation, not a lead DTO: REST rechecks access and resolves attribution.
function publishLeadCreated(result, { getIO = () => require('./socket.service').getIO(), warn = () => console.warn('lead_created_realtime_unavailable') } = {}) {
  const lead = result?.lead;
  const id = Number(lead?.id), clinicId = Number(lead?.clinica_id);
  if (result?.duplicate || lead?.archived_at || !Number.isSafeInteger(id) || id <= 0
    || !Number.isSafeInteger(clinicId) || clinicId <= 0) return false;
  try {
    const io = getIO();
    if (!io) return false;
    io.to(`clinic:${clinicId}`).emit('lead:created', {
      type: 'created', lead_id: id, clinic_id: clinicId,
    });
    return true;
  } catch {
    // A UI delivery failure cannot roll back a committed lead or trigger
    // another reception/auto-reply. Reconnection reconciles through REST.
    warn();
    return false;
  }
}

module.exports = { publishLeadCreated };
