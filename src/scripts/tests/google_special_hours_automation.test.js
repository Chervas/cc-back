'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const service = require('../../services/googleSpecialHoursAutomation.service');
const db = require('../../../models');

function testLocalScheduleUsesClinicTimezone() {
  const summer = service.__testing.localDateTimeToUtc('2026-08-01', '00:00', 'Europe/Madrid');
  const winter = service.__testing.localDateTimeToUtc('2026-12-24', '00:00', 'Europe/Madrid');

  assert.equal(summer.toISOString(), '2026-07-31T22:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-12-23T23:00:00.000Z');
}

function testScheduleMustStartAfterClinicToday() {
  const now = new Date('2026-07-31T12:00:00.000Z');
  assert.equal(service.__testing.isFutureLocalDate('2026-08-01', 'Europe/Madrid', now), true);
  assert.equal(service.__testing.isFutureLocalDate('2026-07-31', 'Europe/Madrid', now), false);
  assert.equal(service.__testing.isFutureLocalDate('2026-07-30', 'Europe/Madrid', now), false);
}

function testManagedFlowWaitsBeforePublishingAndEnds() {
  const scheduleAt = new Date('2026-07-31T22:00:00.000Z');
  const period = {
    id: 'vacaciones-agosto',
    kind: 'closed',
    label: 'Vacaciones',
    startDate: '2026-08-01',
    endDate: '2026-08-15',
    openTime: null,
    closeTime: null,
  };
  const nodes = service.__testing.buildTemplateNodes({
    scheduleAt,
    period,
    timeZone: 'Europe/Madrid',
  });

  assert.deepEqual(nodes.map((node) => node.type), [
    'trigger/scheduled_once',
    'delay/wait_until',
    'action/update_google_special_hours',
    'control/end',
  ]);
  assert.equal(nodes[0].outputs.on_success, 'wait_until');
  assert.equal(nodes[1].config.datetime_expression, scheduleAt.toISOString());
  assert.equal(nodes[2].config.period, period);
  assert.equal(nodes[2].config.auto_deactivate_after_execution, true);
  assert.equal(nodes[2].outputs.on_success, 'flow_end');
}

function testCompletedScheduleCannotBeReactivated() {
  const template = {
    public_id: 'flw_gbp_hours_82_test',
    id: 22,
    template_key: 'google_special_hours_82_test',
    version: 1,
    name: 'Cerrar en Google',
    description: '2026-08-01 a 2026-08-15',
    is_active: false,
    trigger_config: {
      schedule_at: '2026-07-31T22:00:00.000Z',
      time_zone: 'Europe/Madrid',
      period: { kind: 'closed', startDate: '2026-08-01', endDate: '2026-08-15' },
      auto_deactivate_after_execution: true,
    },
    nodes: [],
  };
  const mapped = service.__testing.mapSchedule(template, {
    status: 'completed',
    id: 31,
    updated_at: '2026-07-31T22:00:02.000Z',
  });

  assert.equal(mapped.active, false);
  assert.equal(mapped.status, 'completed');
  assert.equal(mapped.can_toggle, false);
  assert.equal(mapped.completed_at, '2026-07-31T22:00:02.000Z');
}

function testRoutesAndRuntimeKeepWriteAuthorizationAndOneShotSemantics() {
  const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/local.routes.js'), 'utf8');
  const engine = fs.readFileSync(path.resolve(__dirname, '../../services/flowEngineV2.service.js'), 'utf8');

  assert.match(
    routes,
    /router\.post\([\s\S]*special-hours\/automations[\s\S]*requireClinicBusinessProfileWriteAccess/,
    'creating a Google schedule must retain shared-profile write authorization',
  );
  assert.match(
    routes,
    /router\.patch\([\s\S]*special-hours\/automations\/:publicId[\s\S]*requireClinicBusinessProfileWriteAccess/,
    'toggling a Google schedule must retain shared-profile write authorization',
  );
  assert.match(engine, /case 'action\/update_google_special_hours'/);
  assert.match(engine, /applyScheduledSpecialHoursPeriod/);
  assert.match(engine, /is_active:\s*false/);
  assert.match(engine, /last_executed_at/);
}

async function run() {
  testLocalScheduleUsesClinicTimezone();
  testScheduleMustStartAfterClinicToday();
  testManagedFlowWaitsBeforePublishingAndEnds();
  testCompletedScheduleCannotBeReactivated();
  testRoutesAndRuntimeKeepWriteAuthorizationAndOneShotSemantics();
  console.log('google_special_hours_automation.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
