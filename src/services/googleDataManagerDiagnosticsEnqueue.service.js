'use strict';

const jobRequestsService = require('./jobRequests.service');

const CONTROL_PLANE_DEDUPE_SCOPE = 'google_data_manager_control_plane';

async function enqueueGoogleDataManagerControlPlaneReconciliation({
  origin,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
  now = new Date(),
  dependencies = {},
} = {}) {
  const enqueueUnique = dependencies.enqueueUniqueJobRequest
    || jobRequestsService.enqueueUniqueJobRequest;
  const requestedAt = now instanceof Date ? now : new Date(now || Date.now());
  const safeRequestedAt = Number.isFinite(requestedAt.getTime()) ? requestedAt : new Date();

  return enqueueUnique({
    type: 'google_data_manager_diagnostics',
    priority: 'normal',
    origin: String(origin || 'marketing:measurement_configuration_changed').slice(0, 80),
    requestedBy,
    requestedByName,
    requestedByRole,
    maxAttempts: 3,
    dedupeScope: CONTROL_PLANE_DEDUPE_SCOPE,
    payload: {
      trigger: 'measurement_configuration_changed',
      force_control_plane: true,
      control_plane_requested_at: safeRequestedAt.toISOString(),
    },
  }, {
    // If a reconciliation is already running, preserve the new change by
    // creating one pending pass behind it. Several writes while it is pending
    // still collapse into a single durable JobRequest.
    activeStatuses: ['pending', 'queued', 'waiting'],
  });
}

module.exports = {
  CONTROL_PLANE_DEDUPE_SCOPE,
  enqueueGoogleDataManagerControlPlaneReconciliation,
};
