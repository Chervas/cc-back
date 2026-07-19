'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
const defineIntakeConfig = require('../../../models/intakeconfig');

function hooks() {
  let captured = null;
  const model = defineIntakeConfig({
    define(_name, _attributes, options) {
      captured = options;
      return {};
    },
  }, DataTypes);
  assert.ok(model);
  assert.ok(captured?.hooks);
  return captured.hooks;
}

test('bulk create/update/destroy no pueden omitir los hooks de reconciliación por fila', () => {
  const runtimeHooks = hooks();
  const createOptions = {};
  runtimeHooks.beforeBulkCreate([], createOptions);
  assert.equal(createOptions.individualHooks, true);

  const updateOptions = {};
  runtimeHooks.beforeBulkUpdate(updateOptions);
  assert.equal(updateOptions.individualHooks, true);

  const destroyOptions = {};
  runtimeHooks.beforeBulkDestroy(destroyOptions);
  assert.equal(destroyOptions.individualHooks, true);

  assert.throws(
    () => runtimeHooks.beforeBulkDestroy({ truncate: true }),
    (error) => error.code === 'web_intake_runtime_bulk_destroy_forbidden'
  );
});

test('Sequelize v6 proyecta beforeSave en beforeUpdate y ejecuta el gate para cada fila bulk', async () => {
  const sequelize = new Sequelize('mysql://test:test@127.0.0.1:3306/unused', {
    logging: false,
  });
  const Model = defineIntakeConfig(sequelize, DataTypes);
  const service = require('../../services/webIntakeRuntimeReconciliation.service');
  const original = service.stageIntakeConfigInstanceWrite;
  let calls = 0;
  service.stageIntakeConfigInstanceWrite = async () => { calls += 1; };
  try {
    const options = {};
    await Model.runHooks('beforeBulkUpdate', options);
    assert.equal(options.individualHooks, true);
    assert.ok(Array.isArray(Model.options.hooks.beforeUpdate));
    const first = Model.build({ id: 12 }, { isNewRecord: false });
    const second = Model.build({ id: 13 }, { isNewRecord: false });
    await Model.runHooks('beforeUpdate', first, options);
    await Model.runHooks('beforeUpdate', second, options);
    assert.equal(calls, 2);
  } finally {
    service.stageIntakeConfigInstanceWrite = original;
    await sequelize.close();
  }
});

test('los writes internos explícitos conservan su escape controlado', () => {
  const runtimeHooks = hooks();
  const createOptions = { skipWebRuntimeReconciliation: true };
  const updateOptions = { skipWebRuntimeReconciliation: true };
  const destroyOptions = { skipWebRuntimeReconciliation: true, truncate: true };
  runtimeHooks.beforeBulkCreate([], createOptions);
  runtimeHooks.beforeBulkUpdate(updateOptions);
  runtimeHooks.beforeBulkDestroy(destroyOptions);
  assert.equal(createOptions.individualHooks, undefined);
  assert.equal(updateOptions.individualHooks, undefined);
  assert.equal(destroyOptions.individualHooks, undefined);
});

test('destroy de un scope servido falla cerrado y sin publicaciones se admite', async () => {
  const runtimeHooks = hooks();
  const instance = { assignment_scope: 'clinic', clinic_id: 66 };
  const models = {
    WebPublication: {
      findAll: async () => [{ id: 'publication-live', status: 'published', activeArtifactId: 'artifact-live' }],
    },
  };
  await assert.rejects(
    () => runtimeHooks.beforeDestroy(instance, { models }),
    (error) => error.code === 'web_intake_runtime_destroy_requires_reconciliation'
  );

  models.WebPublication.findAll = async () => [];
  await assert.doesNotReject(() => runtimeHooks.beforeDestroy(instance, { models }));
});
