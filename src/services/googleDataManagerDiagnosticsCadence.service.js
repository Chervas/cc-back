'use strict';

const DEFAULT_CONTROL_PLANE_INTERVAL_MINUTES = 6 * 60;
const MAX_HISTORY_ROWS = 96;

function parseDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : (row || {});
}

function reportExecutedControlPlane(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (
    report.cadence
    && typeof report.cadence === 'object'
    && Object.prototype.hasOwnProperty.call(report.cadence, 'control_plane_executed')
  ) {
    return report.cadence.control_plane_executed === true;
  }

  // Every diagnostics report written before the adaptive cadence contained
  // these phases because they ran unconditionally. Treat it as a full pass so
  // deploying the cadence does not immediately duplicate the latest provider
  // reads.
  return Boolean(
    report.visitor_choice_personalization_reconciliation
      || report.internal_enhanced_conversion_activation
      || report.connect_only_strategy_readiness_reconciliation
  );
}

function findLatestControlPlaneRun(rows = []) {
  const ordered = [...(Array.isArray(rows) ? rows : [])]
    .map(plain)
    .filter((row) => reportExecutedControlPlane(row.status_report))
    .sort((left, right) => {
      const leftTime = parseDate(left.start_time || left.created_at)?.getTime() || 0;
      const rightTime = parseDate(right.start_time || right.created_at)?.getTime() || 0;
      return rightTime - leftTime;
    });
  return ordered[0] || null;
}

function buildGoogleDataManagerDiagnosticsCadence({
  now = new Date(),
  previousRuns = [],
  forceControlPlane = false,
  controlPlaneRequestedAt = null,
  intervalMinutes = DEFAULT_CONTROL_PLANE_INTERVAL_MINUTES,
} = {}) {
  const checkedAt = parseDate(now) || new Date();
  const safeIntervalMinutes = positiveInteger(intervalMinutes, DEFAULT_CONTROL_PLANE_INTERVAL_MINUTES);
  const latest = findLatestControlPlaneRun(previousRuns);
  const latestStartedAt = parseDate(latest?.start_time || latest?.created_at);
  const latestCompletedAt = parseDate(latest?.end_time || latest?.updated_at || latest?.start_time || latest?.created_at);
  const requestedAt = parseDate(controlPlaneRequestedAt);
  const latestFailed = String(latest?.status || '').trim().toLowerCase() === 'failed';

  let due = false;
  let reason = 'interval_not_elapsed';
  if (!latestStartedAt) {
    due = true;
    reason = 'no_previous_control_plane_run';
  } else if (latestFailed) {
    due = true;
    reason = 'previous_control_plane_failed';
  } else if (forceControlPlane && (!requestedAt || latestStartedAt < requestedAt)) {
    due = true;
    reason = 'configuration_changed';
  } else if (forceControlPlane && requestedAt && latestStartedAt >= requestedAt) {
    reason = 'configuration_already_reconciled';
  } else {
    const elapsedMs = checkedAt.getTime() - latestStartedAt.getTime();
    if (elapsedMs >= safeIntervalMinutes * 60 * 1000) {
      due = true;
      reason = 'interval_elapsed';
    }
  }

  const nextDueAt = due || !latestStartedAt
    ? null
    : new Date(latestStartedAt.getTime() + safeIntervalMinutes * 60 * 1000);

  return {
    control_plane_executed: due,
    reason,
    interval_minutes: safeIntervalMinutes,
    requested_at: requestedAt?.toISOString() || null,
    last_control_plane_started_at: latestStartedAt?.toISOString() || null,
    last_control_plane_completed_at: latestCompletedAt?.toISOString() || null,
    next_control_plane_at: nextDueAt?.toISOString() || null,
    diagnostics_poll_always_enabled: true,
  };
}

async function resolveGoogleDataManagerDiagnosticsCadence({
  syncLogId,
  SyncLogModel,
  now = new Date(),
  forceControlPlane = false,
  controlPlaneRequestedAt = null,
  intervalMinutes = process.env.GOOGLE_DATA_MANAGER_CONTROL_PLANE_INTERVAL_MINUTES,
} = {}) {
  if (!SyncLogModel?.findAll) {
    return buildGoogleDataManagerDiagnosticsCadence({
      now,
      forceControlPlane,
      controlPlaneRequestedAt,
      intervalMinutes,
    });
  }

  const where = { job_type: 'google_data_manager_diagnostics' };
  if (Number.isInteger(Number(syncLogId)) && Number(syncLogId) > 0) {
    const { Op } = require('sequelize');
    where.id = { [Op.lt]: Number(syncLogId) };
  }
  const previousRuns = await SyncLogModel.findAll({
    where,
    attributes: ['id', 'status', 'start_time', 'end_time', 'created_at', 'updated_at', 'status_report'],
    order: [['id', 'DESC']],
    limit: MAX_HISTORY_ROWS,
  });

  return buildGoogleDataManagerDiagnosticsCadence({
    now,
    previousRuns,
    forceControlPlane,
    controlPlaneRequestedAt,
    intervalMinutes,
  });
}

module.exports = {
  DEFAULT_CONTROL_PLANE_INTERVAL_MINUTES,
  MAX_HISTORY_ROWS,
  buildGoogleDataManagerDiagnosticsCadence,
  findLatestControlPlaneRun,
  reportExecutedControlPlane,
  resolveGoogleDataManagerDiagnosticsCadence,
};
