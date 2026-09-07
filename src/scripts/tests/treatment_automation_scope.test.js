'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { createTreatmentAutomationScope } = require('../../lib/treatment-automation-scope');

function fixture() {
  const groups = new Map([[72, 4], [66, 4], [99, 9], [77, null]]);
  const template = (key, fields) => ({ id: key.length, template_key: key, version: 2, name: key,
    is_system: false, is_active: true, published_at: '2026-09-07', trigger_type: 'appointment_created',
    trigger_config: { marker: `${key}-private-config` }, ...fields });
  const state = {
    treatment: { id_tratamiento: 10, nombre: 'Sintético', disciplina: 'estetica', origen: 'clinica', clinica_id: 72,
      grupo_clinica_id: null, clinical_config: null, appointment_automation_template_key: 'own', appointment_automation_template_version: null },
    templates: [template('own', { clinic_id: 72 }), template('sibling', { clinic_id: 66 }),
      template('group', { group_id: 4 }), template('foreign', { clinic_id: 99 }), template('foreign-group', { group_id: 9 }),
      template('system', { is_system: true }), template('inactive', { clinic_id: 72, is_active: false })],
    creates: [], saves: [], templateQueries: [], clinicQueries: [],
  };
  const json = value => JSON.parse(JSON.stringify(value));
  function record(value) {
    return { ...json(value), toJSON() { return json({ ...this, toJSON: undefined, save: undefined }); }, async save() {
      state.saves.push(this.toJSON()); state.treatment = this.toJSON(); return this;
    } };
  }
  const db = {
    Sequelize,
    Clinica: { findOne: async ({ where }) => { state.clinicQueries.push(where); return groups.has(where.id_clinica) ? { grupoClinicaId: groups.get(where.id_clinica) } : null; } },
    Tratamiento: {
      findByPk: async () => record(state.treatment),
      create: async value => { state.creates.push(json(value)); return record({ id_tratamiento: 11, ...value }); },
    },
    AutomationFlowTemplateV2: { findOne: async query => {
      state.templateQueries.push(query);
      return state.templates.filter(row => row.template_key === query.where.template_key && row.published_at
        && (query.where.is_active === undefined || row.is_active === query.where.is_active)).sort((a, b) => b.version - a.version)[0] || null;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../controllers/tratamientos.controller.js'), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (name === '../../models') return db;
      if (name === 'express-async-handler') return require(name);
      if (name.startsWith('../lib/')) return require(`../../lib/${name.slice('../lib/'.length)}`);
      throw new Error(`Unexpected require: ${name}`);
    },
  });
  async function invoke(method, body = {}) {
    let response;
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { response = json(value); return this; } };
    await module.exports[method]({ params: { id: 10 }, body, query: {} }, res, error => { throw error; });
    return { status: res.statusCode, body: response };
  }
  return { state, db, scope: createTreatmentAutomationScope(db), invoke };
}

test('scope retains system, own clinic, own group and sibling clinic semantics', async () => {
  const { scope, state } = fixture();
  for (const key of ['system', 'own', 'sibling', 'group']) {
    assert.equal(await scope.canUseTemplate(state.treatment, state.templates.find(row => row.template_key === key)), true, key);
  }
  for (const key of ['foreign', 'foreign-group']) {
    assert.equal(await scope.canUseTemplate(state.treatment, state.templates.find(row => row.template_key === key)), false, key);
  }
  assert.equal(await scope.canUseTemplate({ origen: 'grupo', grupo_clinica_id: 4 }, state.templates.find(row => row.template_key === 'sibling')), true);
});

test('decorative group/clinic fields and nondecimal IDs cannot extend the declared tenant', async () => {
  const { scope, state } = fixture();
  const foreign = state.templates.find(row => row.template_key === 'foreign');
  for (const treatment of [
    { ...state.treatment, grupo_clinica_id: 9 },
    { origen: 'grupo', grupo_clinica_id: 4, clinica_id: 99 },
    { origen: 'sistema', clinica_id: 99, grupo_clinica_id: 9 },
    { origen: 'clinica', clinica_id: '0x63', grupo_clinica_id: 9 },
  ]) assert.equal(await scope.canUseTemplate(treatment, foreign), false);
});

test('generic create rejects foreign references before writing, including spoofed group', async () => {
  for (const fields of [{}, { grupo_clinica_id: 9 }]) {
    const { invoke, state } = fixture();
    await assert.rejects(invoke('createTratamiento', { nombre: 'Nuevo', disciplina: 'estetica', clinica_id: 72,
      appointment_automation_template_key: 'foreign', ...fields }), { statusCode: 403 });
    assert.equal(state.creates.length, 0);
  }
});

test('create without explicit reference keeps inherited defaults and bindings, without template queries', async () => {
  const { invoke, state } = fixture();
  const result = await invoke('createTratamiento', { nombre: 'Nuevo', disciplina: 'estetica', clinica_id: 72,
    automation_template_bindings: { unchanged: 'binding' } });
  assert.equal(result.status, 201);
  assert.equal(state.creates[0].appointment_automation_template_key, null);
  assert.equal(state.creates[0].appointment_automation_template_version, null);
  assert.deepEqual(state.creates[0].automation_template_bindings, { unchanged: 'binding' });
  assert.equal(state.templateQueries.length, 0);
});

test('generic update validates explicit reference and tenant moves before save', async () => {
  for (const body of [{ appointment_automation_template_key: 'foreign' }, { clinica_id: 99 }]) {
    const { invoke, state } = fixture();
    await assert.rejects(invoke('updateTratamiento', body), { statusCode: 403 });
    assert.equal(state.saves.length, 0);
  }
});

test('unrelated edits do not repair or revalidate historical references; explicit clear is allowed', async () => {
  const { invoke, state } = fixture();
  state.treatment.appointment_automation_template_key = 'missing-historical-key';
  await invoke('updateTratamiento', { nombre: 'Nombre nuevo' });
  assert.equal(state.templateQueries.length, 0);
  assert.equal(state.saves[0].appointment_automation_template_key, 'missing-historical-key');
  await invoke('updateTratamiento', { appointment_automation_template_key: null });
  assert.equal(state.templateQueries.length, 0);
  assert.equal(state.saves[1].appointment_automation_template_key, null);
});

test('personalizar validates inherited reference against destination before copy or hiding original', async () => {
  const { invoke, state } = fixture();
  state.treatment = { ...state.treatment, origen: 'grupo', grupo_clinica_id: 9, clinica_id: null, appointment_automation_template_key: 'foreign' };
  await assert.rejects(invoke('personalizarTratamiento', { clinica_id: 72 }), { statusCode: 403 });
  assert.equal(state.creates.length, 0);
  assert.equal(state.saves.length, 0);
  await invoke('personalizarTratamiento', { clinica_id: 72, appointment_automation_template_key: null });
  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0].origen, 'clinica');
  assert.equal(state.creates[0].clinica_id, 72);
  assert.equal(state.creates[0].grupo_clinica_id, null);
  assert.equal(state.creates[0].appointment_automation_template_key, null);
});

test('GET suppresses contaminated historical reference and never falls back to an older same-scope version', async () => {
  const { invoke, state } = fixture();
  state.templates.push({ ...state.templates.find(row => row.template_key === 'own'), version: 3, clinic_id: 99, trigger_config: { secret: 'foreign-latest' } });
  const result = await invoke('getTratamientoAutomationTemplate');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.automation_template, null);
  assert.equal(JSON.stringify(result).includes('foreign-latest'), false);
  assert.equal(state.saves.length, 0);
});

test('GET preserves visibility of legitimate inactive published assignments', async () => {
  const { invoke, state } = fixture();
  state.treatment.appointment_automation_template_key = 'inactive';
  const result = await invoke('getTratamientoAutomationTemplate');
  assert.equal(result.body.data.automation_template.template_key, 'inactive');
  assert.equal(result.body.data.automation_template.is_active, false);
});

test('PUT keeps existing trigger restrictions and version-null assignment, with the shared tenant guard', async () => {
  const { invoke, state } = fixture();
  state.treatment.grupo_clinica_id = 9;
  assert.equal((await invoke('setTratamientoAutomationTemplate', { template_key: 'foreign' })).status, 403);
  assert.equal(state.saves.length, 0);
  const own = state.templates.find(row => row.template_key === 'own');
  own.trigger_config.appointment_scope = 'without_treatment';
  assert.equal((await invoke('setTratamientoAutomationTemplate', { template_key: 'own' })).status, 400);
  assert.equal(state.saves.length, 0);
  const result = await invoke('setTratamientoAutomationTemplate', { template_key: 'sibling' });
  assert.equal(result.status, 200);
  assert.equal(state.saves[0].appointment_automation_template_key, 'sibling');
  assert.equal(state.saves[0].appointment_automation_template_version, null);
});

test('explicit missing or unpublished reference fails closed without adding new lifecycle rules to CRUD', async () => {
  const { scope, state } = fixture();
  await assert.rejects(scope.assertReferenceScope({ ...state.treatment, appointment_automation_template_key: 'missing' }), { statusCode: 404 });
  state.templates.find(row => row.template_key === 'own').published_at = null;
  await assert.rejects(scope.assertReferenceScope(state.treatment), { statusCode: 404 });
  await scope.assertReferenceScope({ ...state.treatment, appointment_automation_template_key: 'inactive' });
});
