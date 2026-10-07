'use strict';
// Actual guard/eligibility/runtime-stop functions with synthetic model reads.
// No application model loader, live approval registry, queue or provider.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const guard = require('../../lib/appointment-synthetic-guard');
const eligibility = require('../../lib/whatsappAppointmentEligibility');
const { Op } = require('sequelize');
const variants = [
  { qa_demo: true }, { qa_demo: { fixture: 'synthetic' } }, { synthetic_data_only: '1' },
  { __simulation: true }, { is_test: true },
  { import: { synthetic_data_only: true } },
  { cliniccloud_reconciliation: { qa_demo: 'demo-visit' } },
  { cliniccloud_source_booking: JSON.stringify({ __simulation: true }) },
];
test('explicit structured QA markers block delivery, never text or a patient name', () => {
  for (const variant of variants) for (const serialize of [false, true]) {
    const row = { import_metadata: serialize ? JSON.stringify(variant) : variant };
    assert.equal(guard.isSyntheticData(row), true);
    assert.throws(() => guard.assertNoSyntheticDispatch(row), { code: guard.CODE, retryable: false });
  }
  for (const value of [null, {}, { nombre: 'MOD TEST', nota: 'qa_demo=true' },
    { metadata: { qa_demo: false, is_test: 0, synthetic_data_only: 'false' } }]) {
    assert.equal(guard.isSyntheticData(value), false);
    assert.doesNotThrow(() => guard.assertNoSyntheticDispatch(value));
  }
  const cycle = {}; cycle.import = cycle;
  assert.equal(guard.isSyntheticData(cycle), true, 'cyclic fixture context cannot bypass a bounded read');
});
test('final WhatsApp eligibility rejects QA before manual/automation early returns and import releases', async () => {
  for (const variant of variants) {
    await assert.rejects(eligibility.assertAutomatedMessageEligibility({
      message: { metadata: variant }, conversation: {},
    }), { code: guard.CODE });
    const input = { message: { metadata: { execution_id: 1 } }, conversation: { clinic_id: 2 },
      patientHeld: async () => false,
      loadExecution: async () => ({ id: 1, clinic_id: 2, trigger_entity_type: 'appointment', trigger_entity_id: 3 }),
      loadAppointment: async () => ({ id_cita: 3, clinica_id: 2, import_metadata: variant }) };
    await assert.rejects(eligibility.assertAutomatedMessageEligibility(input), { code: guard.CODE });
    await assert.rejects(eligibility.assertAutomatedMessageEligibility({ ...input,
      loadExecution: async () => ({ id: 1, clinic_id: 2, trigger_entity_type: 'entity', context: variant }) }), { code: guard.CODE });
    assert.throws(() => eligibility.assertAppointmentEligibility({ appointment: { import_metadata: variant }, execution: {} }), { code: guard.CODE });
  }
  assert.equal(await eligibility.assertAutomatedMessageEligibility({ message: { metadata: {} }, conversation: {} }), true);
});
function stopFixture() {
  const state = { message: { id: 1, status: 'pending', metadata: { source: 'automations_v2', execution_id: 2 } },
    execution: { id: 2, status: 'running', template_version_id: 4, clinic_id: 5,
      trigger_entity_type: 'appointment', trigger_entity_id: 3, context: {} },
    appointment: { id_cita: 3, import_metadata: {} }, writes: 0, cancelled: 0, providers: 0, reads: 0, executionReads: 0 };
  const template = { id: 4, public_id: 'synthetic', template_key: 'synthetic', clinic_id: 5,
    version: 1, is_active: true, published_at: new Date() };
  const modelMessage = () => ({ ...state.message, update: async patch => { state.writes++; Object.assign(state.message, patch); } });
  const db = { CitaPaciente: { findByPk: async () => { state.reads++; return state.appointment; } },
    Message: { findByPk: async () => modelMessage() },
    FlowExecutionV2: { findByPk: async () => ++state.executionReads > 1 && state.latestExecution ? state.latestExecution : state.execution },
    AutomationFlowTemplateV2: { findByPk: async () => template, findOne: async () => template, findAll: async () => [template] },
    sequelize: { transaction: async (_options, callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
      query: async () => { state.cancelled++; } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/automation-runtime-stop'), 'utf8'), {
    module, Date, Error, require(name) {
      if (name === '../../models') return db;
      if (name === 'sequelize') return { Op };
      if (name === './appointment-template-scope') return require('../../lib/appointment-template-scope');
      if (name === './appointment-synthetic-guard') return guard;
      throw Error('Unexpected dependency: ' + name);
    },
  });
  return { state, stop: module.exports, queued: { ...state.message, reload: async () => {} } };
}
test('queue and common send gates reject simulation and freshly marked appointment before transport', async () => {
  for (const target of ['message', 'execution', 'appointment']) for (const variant of variants) {
    const f = stopFixture();
    if (target === 'message') f.state.message.metadata = { ...f.state.message.metadata, ...variant };
    if (target === 'execution') f.state.execution.context = variant;
    if (target === 'appointment') f.state.appointment.import_metadata = variant;
    await assert.rejects(async () => {
      await f.stop.assertMessageCanDispatch(1); f.state.providers++;
    }, error => error.code === guard.CODE && f.stop.isStop(error));
    await assert.rejects(async () => {
      await f.stop.assertEmailCanDispatch({ related_type: 'flow_execution_v2', related_id: 2,
        metadata: target === 'message' ? variant : {} }); f.state.providers++;
    }, { code: guard.CODE });
    await assert.rejects(f.stop.prepareMessageForDispatch(f.queued, { status: 'pending' }), { code: guard.CODE });
    assert.equal(f.state.providers, 0); assert.equal(f.state.writes, 0);
  }
});
test('normal active execution keeps existing WhatsApp/email preparation and stop semantics', async () => {
  const f = stopFixture();
  await f.stop.assertMessageCanDispatch(1);
  await f.stop.assertEmailCanDispatch({ related_type: 'flow_execution_v2', related_id: 2 });
  await f.stop.prepareMessageForDispatch(f.queued, { status: 'sending' });
  assert.equal(f.state.writes, 1); assert.equal(f.state.cancelled, 0); assert.equal(f.state.reads, 3);
  f.state.execution.status = 'cancelled';
  await assert.rejects(f.stop.assertMessageCanDispatch(1), { code: 'automation_execution_stopped' });
});
test('dispatch validates the reloaded execution, not only the execution captured before family authorization', async () => {
  for (const action of ['whatsapp', 'email', 'preparation']) {
    const f = stopFixture();
    f.state.latestExecution = { ...f.state.execution, context: { synthetic_data_only: true } };
    await assert.rejects(async () => {
      if (action === 'whatsapp') await f.stop.assertMessageCanDispatch(1);
      else if (action === 'email') await f.stop.assertEmailCanDispatch({ related_type: 'flow_execution_v2', related_id: 2 });
      else await f.stop.prepareMessageForDispatch(f.queued, { status: 'sending' });
      f.state.providers++;
    }, { code: guard.CODE });
    assert.equal(f.state.providers, 0);
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.executionReads, 2);
  }
});
