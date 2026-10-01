'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../services/appointmentAutomationV2Runtime.service.js'), 'utf8');
const base = { id: 1, template_key: 'system_cancel_unconfirmed_appointment_night_before',
  version: 7, is_system: true, is_active: true, published_at: new Date(),
  clinic_id: null, group_id: null, trigger_type: 'appointment_reminder_window',
  trigger_config: { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '21:00' },
  nodes: [] };

function fixture(rows, treatmentKey) {
  const queries = [];
  const db = {
    Sequelize: { Op: { ne: Symbol('ne'), or: Symbol('or'), in: Symbol('in') } },
    CitaPaciente: { findByPk: async () => ({ id_cita: 1, clinica_id: 35, estado: 'info_enviada',
      tratamiento_id: treatmentKey ? 20 : null, inicio: new Date(Date.now() + 86400000) }) },
    Clinica: { findByPk: async () => ({ id_clinica: 35, grupoClinicaId: 5, configuracion: { timezone: 'Europe/Madrid' } }) },
    Tratamiento: { findByPk: async () => ({ automation_template_bindings: {
      appointment_before: { template_key: treatmentKey },
    } }) },
    AutomationFlowTemplateV2: {
      findAll: async options => { queries.push(options); return rows; },
      findOne: () => { throw Error('an active-only lookup could bypass clinic deactivation'); },
    },
    AutomationFlowCatalog: { findAll: async () => [] },
    FlowExecutionV2: { create: () => { throw Error('must not start a disabled or foreign automation'); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, process: { env: {} }, Date,
    require(name) {
      if (name === '../../models') return db;
      if (name === './jobRequests.service' || name === './jobScheduler.service') return {};
      if (name === './socket.service') return { getIO: () => null };
      if (name.startsWith('../lib/')) return require(path.resolve(__dirname, '../../lib', name.slice('../lib/'.length)));
      throw Error('unexpected_dependency:' + name);
    },
  }, { filename: 'appointmentAutomationV2Runtime.service.js' });
  return { runtime: module.exports, queries, db };
}

test('an already queued foreign-clinic job is skipped even if its group and published key match', async () => {
  const foreign = { ...base, id: 1606, version: 1, clinic_id: 59, group_id: 5, is_system: false,
    template_key: base.template_key + '__clinic_59' };
  const f = fixture([base, foreign]);
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 1,
    trigger_type: base.trigger_type, template_key: foreign.template_key });
  assert.equal(result.reason, 'template_not_active');
  assert.equal(result.skipped, true);
  assert(f.queries.every(query => query.where.is_active === undefined));
  const scopes = f.queries[0].where[f.db.Sequelize.Op.or];
  assert(scopes.every(scope => scope.clinic_id === 35 || scope.clinic_id === null));
});

test('an inactive clinic instance also blocks a previously scheduled master job', async () => {
  const local = { ...base, id: 1600, version: 1, clinic_id: 35, group_id: 5, is_system: false,
    is_active: false, template_key: base.template_key + '__clinic_35' };
  const f = fixture([base, local]);
  for (const template_key of [base.template_key, local.template_key]) {
    const result = await f.runtime.fireScheduledTrigger({ appointment_id: 1, trigger_type: base.trigger_type, template_key });
    assert.equal(result.reason, 'template_not_active');
  }
});

test('a treatment binding cannot recover the foreign clinic instance', async () => {
  const foreign = { ...base, id: 1606, clinic_id: 59, group_id: 5, is_system: false,
    template_key: base.template_key + '__clinic_59' };
  const f = fixture([foreign], foreign.template_key);
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 1,
    trigger_type: base.trigger_type, template_key: foreign.template_key });
  assert.equal(result.reason, 'template_not_active');
});
