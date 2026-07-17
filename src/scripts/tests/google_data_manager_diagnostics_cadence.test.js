'use strict';

const assert = require('node:assert/strict');
const {
  buildGoogleDataManagerDiagnosticsCadence,
  reportExecutedControlPlane,
} = require('../../services/googleDataManagerDiagnosticsCadence.service');
const {
  enqueueGoogleDataManagerControlPlaneReconciliation,
} = require('../../services/googleDataManagerDiagnosticsEnqueue.service');

const NOW = new Date('2026-07-17T12:00:00.000Z');

function fullRun({
  startedAt = '2026-07-17T07:00:00.000Z',
  endedAt = '2026-07-17T07:00:03.000Z',
  status = 'completed',
  report = { cadence: { control_plane_executed: true } },
} = {}) {
  return {
    id: 10,
    status,
    start_time: startedAt,
    end_time: endedAt,
    status_report: report,
  };
}

function testEmptyHistoryRunsControlPlane() {
  const cadence = buildGoogleDataManagerDiagnosticsCadence({ now: NOW, previousRuns: [] });
  assert.equal(cadence.control_plane_executed, true);
  assert.equal(cadence.reason, 'no_previous_control_plane_run');
  assert.equal(cadence.diagnostics_poll_always_enabled, true);
}

function testSixHourCadenceDoesNotDelayDiagnosticsPolling() {
  const cadence = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [fullRun()],
  });
  assert.equal(cadence.control_plane_executed, false);
  assert.equal(cadence.reason, 'interval_not_elapsed');
  assert.equal(cadence.next_control_plane_at, '2026-07-17T13:00:00.000Z');
  assert.equal(cadence.diagnostics_poll_always_enabled, true);

  const due = buildGoogleDataManagerDiagnosticsCadence({
    now: new Date('2026-07-17T13:00:00.000Z'),
    previousRuns: [fullRun()],
  });
  assert.equal(due.control_plane_executed, true);
  assert.equal(due.reason, 'interval_elapsed');
}

function testFastPollRowsDoNotMoveTheControlPlaneClock() {
  const cadence = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [
      {
        id: 12,
        status: 'completed',
        start_time: '2026-07-17T11:30:00.000Z',
        status_report: {
          cadence: { control_plane_executed: false },
          checked: 1,
          // Fast polls still include explicit skipped phase reports. They must
          // not masquerade as legacy full passes and move the six-hour clock.
          internal_enhanced_conversion_activation: {
            status: 'skipped',
            reason: 'adaptive_cadence_not_due',
          },
        },
      },
      fullRun(),
    ],
  });
  assert.equal(cadence.last_control_plane_started_at, '2026-07-17T07:00:00.000Z');
  assert.equal(cadence.next_control_plane_at, '2026-07-17T13:00:00.000Z');
}

function testConfigurationChangeForcesOneFreshPass() {
  const requestedAt = '2026-07-17T11:15:00.000Z';
  const due = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [fullRun()],
    forceControlPlane: true,
    controlPlaneRequestedAt: requestedAt,
  });
  assert.equal(due.control_plane_executed, true);
  assert.equal(due.reason, 'configuration_changed');

  const alreadyDone = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [fullRun({ startedAt: '2026-07-17T11:20:00.000Z' })],
    forceControlPlane: true,
    controlPlaneRequestedAt: requestedAt,
  });
  assert.equal(alreadyDone.control_plane_executed, false);
  assert.equal(alreadyDone.reason, 'configuration_already_reconciled');
}

function testFailedControlPlaneRetriesWithoutWaitingSixHours() {
  const cadence = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [fullRun({ startedAt: '2026-07-17T11:30:00.000Z', status: 'failed' })],
  });
  assert.equal(cadence.control_plane_executed, true);
  assert.equal(cadence.reason, 'previous_control_plane_failed');
}

function testLegacyReportCountsAsFullPass() {
  const legacyReport = {
    internal_enhanced_conversion_activation: { status: 'already_active' },
    visitor_choice_personalization_reconciliation: { status: 'completed' },
  };
  assert.equal(reportExecutedControlPlane(legacyReport), true);
  const cadence = buildGoogleDataManagerDiagnosticsCadence({
    now: NOW,
    previousRuns: [fullRun({
      startedAt: '2026-07-17T11:30:00.000Z',
      report: legacyReport,
    })],
  });
  assert.equal(cadence.control_plane_executed, false);
}

async function testConfigurationWritesUseDurableScopedEnqueue() {
  let received = null;
  const result = await enqueueGoogleDataManagerControlPlaneReconciliation({
    origin: 'marketing:test',
    now: new Date('2026-07-17T11:15:00.000Z'),
    dependencies: {
      enqueueUniqueJobRequest: async (args, options) => {
        received = { args, options };
        return { created: true, job: { id: 99 } };
      },
    },
  });
  assert.equal(result.job.id, 99);
  assert.equal(received.args.type, 'google_data_manager_diagnostics');
  assert.equal(received.args.payload.force_control_plane, true);
  assert.equal(received.args.payload.control_plane_requested_at, '2026-07-17T11:15:00.000Z');
  assert.equal(received.args.dedupeScope, 'google_data_manager_control_plane');
  assert.deepEqual(received.options.activeStatuses, ['pending', 'queued', 'waiting']);
}

async function run() {
  testEmptyHistoryRunsControlPlane();
  testSixHourCadenceDoesNotDelayDiagnosticsPolling();
  testFastPollRowsDoNotMoveTheControlPlaneClock();
  testConfigurationChangeForcesOneFreshPass();
  testFailedControlPlaneRetriesWithoutWaitingSixHours();
  testLegacyReportCountsAsFullPass();
  await testConfigurationWritesUseDurableScopedEnqueue();
  console.log('google_data_manager_diagnostics_cadence.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
