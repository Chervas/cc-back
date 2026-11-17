'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const file = require.resolve('../../controllers/citas.controller'), source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('exports.recordAppointmentCare ='), end = source.indexOf('\n// Short-lived inverse', start);
assert(start >= 0 && end > start);
function fixture({ replayed = false, leadEffect = async () => {}, failCancel = false } = {}) {
  const trace = [], events = [], result = { appointment: { id_cita: 901, clinica_id: 100, lead_intake_id: 701, estado: 'ha_acudido' },
    previousStatus: 'info_enviada', care: { arrived_at: '2026-11-17T10:00:00Z' }, replayed };
  const bindings = {
    CitaPaciente: { findByPk: async () => ({ id_cita: 901, clinica_id: 100 }) },
    denyAppointmentManageAccessIfNeeded: async () => false, canUserAccessFeature: async () => true,
    processAppointmentLeadMilestones: async () => { trace.push('lead:start'); await leadEffect(); trace.push('lead:done'); },
    appointmentAutomationV2Runtime: { cancelActiveExecutionsForCita: async () => { trace.push('cancel'); if (failCancel) throw Error('OWNED_CANCEL_FAILURE'); },
      syncScheduledTriggersForCita: async () => { trace.push('timers'); } },
    patientDirectionService: { handleAppointmentChange: async () => { trace.push('direction'); } },
    appointmentNotificationCleanup: { markAutomationNotificationsReadForAppointment: async () => { trace.push('notifications'); } },
    emitAppointmentSocketEvent: (...args) => { trace.push('event'); events.push(args); },
    protectAppointmentsForRequest: async (_req, row) => row,
    console: { warn() {} },
  };
  const controller = {};
  new Function(...Object.keys(bindings), 'exports', 'asyncHandler', 'require', source.slice(start, end))(...Object.values(bindings), controller, fn => fn,
    name => { assert.equal(name, '../services/appointmentCare.service'); return { record: async () => { trace.push('record'); return result; } }; });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { trace.push('http'); this.body = body; return this; } };
  const run = () => controller.recordAppointmentCare({ params: { id: '901', action: 'arrive' }, userData: { userId: 1 } }, res);
  return { trace, events, res, run };
}
test('the single native refresh waits for the lead projection and precedes the HTTP response', async () => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ leadEffect: async () => { entered(); await pending; } });
  const action = f.run(); await started;
  assert.equal(f.events.length, 0); assert.equal(f.res.body, undefined);
  release(); await action;
  assert.deepEqual(f.trace, ['record', 'cancel', 'timers', 'lead:start', 'lead:done', 'direction', 'notifications', 'event', 'http']);
  assert.equal(f.events.length, 1); assert.equal(f.events[0][0], 'appointment:updated'); assert.equal(f.events[0][1].lead_intake_id, 701);
});
test('an isolated consumer failure still runs remaining effects and emits one current-state refresh', async () => {
  const f = fixture({ failCancel: true, leadEffect: async () => { throw Error('OWNED_LEAD_FAILURE'); } }); await f.run();
  assert.deepEqual(f.trace, ['record', 'cancel', 'timers', 'lead:start', 'direction', 'notifications', 'event', 'http']);
  assert.equal(f.events.length, 1); assert.equal(f.res.body.estado, 'ha_acudido');
});
test('an idempotent care replay does not repeat lead effects or emit another refresh event', async () => {
  const f = fixture({ replayed: true }); await f.run();
  assert.deepEqual(f.trace, ['record', 'http']); assert.equal(f.events.length, 0); assert.equal(f.res.body.replayed, true);
});
