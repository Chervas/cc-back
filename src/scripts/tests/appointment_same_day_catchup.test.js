'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const Module = require('node:module');
function fixture(t, options = {}) {
  const original = Module._load; const queued = new Map(), executions = [];
  const appointment = { id_cita: 91, clinica_id: 2, paciente_id: 3, inicio: new Date(Date.now() + 3600000) };
  const template = { id: 8, clinic_id: 2, is_active: true, published_at: new Date(),
    trigger_type: 'appointment_reminder_window', trigger_config: { schedule_moment: 'same_day', schedule_time_mode: 'custom', custom_time: '08:00' },
    nodes: [{ type: 'action/send_whatsapp', config: { catalog_template_id: 10 } }] };
  const db = { Sequelize: { Op: { in: Symbol('in'), gt: Symbol('gt'), lt: Symbol('lt') } },
    CitaPaciente: { findAll: async () => [appointment], findByPk: async () => appointment },
    AutomationFlowTemplateV2: { findByPk: async () => template },
    WhatsappTemplate: { findAll: async () => [{ id: 50 }] },
    sequelize: { query: async sql => sql.includes('FROM FlowExecutionsV2')
      ? [options.priorExecution ? [{ context: { trigger: { schedule_moment: 'same_day' }, appointment: { inicio: appointment.inicio } } }] : []]
      : [options.priorMessage ? [{ createdAt: new Date(), metadata: { template_id: 50 } }] : []] } };
  const runtime = { getTemplateTriggerConfig: value => value.trigger_config,
    catchUpEligible: (a, row) => row.is_active && a.inicio.getTime() > Date.now() ? new Date(Date.now() - 3600000) : false,
    buildScheduledWindowIdentifier: () => 'same_day:08:00',
    enqueueExecutionForTemplate: async (...args) => { executions.push(args); return { enqueued: true }; } };
  const dependencies = new Map([
    [require.resolve('../../../models'), db],
    [require.resolve('../../services/appointmentAutomationV2Runtime.service'), runtime],
    [require.resolve('../../lib/whatsappAppointmentEligibility'), { day: d => new Date(d).toISOString().slice(0, 10), patientImportHeld: async () => !!options.held }],
    [require.resolve('../../services/appointmentPatientLinks.service'), { follower: async () => options.linked }],
    [require.resolve('../../services/appointmentVisitManaged.service'), { current: () => ({ managedVisit: async () => options.managed }) }],
    [require.resolve('../../services/jobRequests.service'), { enqueueUniqueJobRequest: async row => queued.set(row.dedupeScope, row) }],
  ]);
  Module._load = function(request, parent) { const key = Module._resolveFilename(request, parent);
    return dependencies.has(key) ? dependencies.get(key) : original.apply(this, arguments); };
  const file = require.resolve('../../services/appointmentSameDayCatchup.service'); delete require.cache[file];
  const service = require(file);
  t.after(() => { delete require.cache[file]; Module._load = original; });
  return { service, appointment, template, queued, executions };
}
test('late activation previews without sending and explicit approval queues one stable native job', async t => {
  const f = fixture(t); assert.equal((await f.service.prepare(f.template)).count, 1); assert.equal(f.queued.size, 0);
  await f.service.prepare(f.template, { enqueue: true, userId: 7 });
  await f.service.prepare(f.template, { enqueue: true, userId: 7 }); assert.equal(f.queued.size, 1);
  assert.equal(f.executions.length, 0);
  await f.service.run([...f.queued.values()][0].payload); assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0][2].window_identifier, 'same_day:08:00');
});
test('existing execution, manual template, import HOLD, linked follower and managed visit all exclude catchup', async t => {
  for (const options of [{ priorExecution: true }, { priorMessage: true }, { held: true }, { linked: true }, { managed: true }]) {
    await t.test(JSON.stringify(options), async sub => {
      const f = fixture(sub, options); assert.equal((await f.service.prepare(f.template, { enqueue: true })).count, 0);
      assert.equal(f.queued.size, 0); assert.equal(f.executions.length, 0);
    });
  }
});
test('disablement or rescheduling between approval and execution prevents materialization', async t => {
  const f = fixture(t); await f.service.prepare(f.template, { enqueue: true }); const payload = [...f.queued.values()][0].payload;
  f.template.is_active = false; assert.equal((await f.service.run(payload)).skipped, true);
  f.template.is_active = true; f.appointment.inicio = new Date(f.appointment.inicio.getTime() + 60000);
  assert.equal((await f.service.run(payload)).skipped, true); assert.equal(f.executions.length, 0);
});
test('catalog-only selections identify a manual reminder in the current clinic without requiring a stale template ID', async t => {
  const f = fixture(t, { priorMessage: true }); assert.equal(await f.service.alreadyMaterialized(f.appointment, f.template), true);
});
test('the explicit batch does not support consents, reviews, global catalog or other schedules', async t => {
  const f = fixture(t);
  for (const patch of [{ clinic_id: null }, { trigger_type: 'consent_required' },
    { trigger_config: { ...f.template.trigger_config, custom_time: '09:00' } },
    { nodes: [{ type: 'action/review_request' }] }]) assert.equal(f.service.supported({ ...f.template, ...patch }), false);
});
