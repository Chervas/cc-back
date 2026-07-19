'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Op } = require('sequelize');
const {
  applyClinicMembershipSelection,
  deleteGroupSafely,
} = require('../../services/groupAssets.service');

function clinicRow(id, groupId, updates) {
  const value = {
    id_clinica: id,
    grupoClinicaId: groupId,
    estado_clinica: true,
  };
  return {
    ...value,
    get: () => ({ ...value }),
    async update(patch, options) {
      updates.push({ id, patch, options });
      Object.assign(value, patch);
      Object.assign(this, patch);
    },
  };
}

function baseModels(rows, { installations = [], publications = [], intake = null } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      Clinica: {
        async findAll(options) {
          calls.push({ model: 'Clinica', options });
          return rows;
        },
      },
      WebWordpressInstallation: {
        async findAll(options) {
          calls.push({ model: 'WebWordpressInstallation', options });
          return installations;
        },
      },
      WebPublication: {
        async findAll(options) {
          calls.push({ model: 'WebPublication', options });
          return publications;
        },
      },
      IntakeConfig: {
        async findOne(options) {
          calls.push({ model: 'IntakeConfig', options });
          return typeof intake === 'function' ? intake(options) : intake;
        },
      },
    },
  };
}

const transaction = { LOCK: { UPDATE: 'UPDATE' } };

test('el editor de grupo bloquea la baja si queda una landing WordPress heredada activa', async () => {
  const updates = [];
  const clinic = clinicRow(66, 7, updates);
  const state = baseModels([clinic], {
    installations: [{ id: 'wp-group-7', status: 'connected', reportedState: {} }],
    publications: [{
      id: 'publication-66',
      status: 'published',
      path: '/cita/clinic-66/',
      wordpressInstallationId: 'wp-group-7',
      scopeType: 'clinic',
      clinicaId: 66,
      grupoClinicaId: null,
      configuration: { clinic_id: 66 },
    }],
  });
  await assert.rejects(
    () => applyClinicMembershipSelection({
      groupId: 7,
      targetIds: [],
      models: state.models,
      transaction,
    }),
    (error) => (
      error.code === 'clinic_membership_wordpress_publication_retirement_required'
      && error.details.publication_ids[0] === 'publication-66'
    )
  );
  assert.equal(updates.length, 0);
  const clinicRead = state.calls.find((call) => call.model === 'Clinica').options;
  assert.equal(clinicRead.lock, transaction.LOCK.UPDATE);
  assert.equal(clinicRead.transaction, transaction);
  assert.deepEqual(clinicRead.order, [['id_clinica', 'ASC']]);
});

test('el editor de grupo bloquea el movimiento si la medición heredada no se ha reconciliado', async () => {
  const updates = [];
  const clinic = clinicRow(66, 7, updates);
  const state = baseModels([clinic], {
    intake: (options) => options.where.assignment_scope === 'group'
      ? {
          assignment_scope: 'group',
          group_id: 7,
          hmac_key: 'group-runtime-hmac-0123456789abcdef',
          config: { features: { forms: true }, locations: [{ id: 66 }] },
        }
      : null,
  });
  await assert.rejects(
    () => applyClinicMembershipSelection({
      groupId: 8,
      targetIds: [66],
      models: state.models,
      transaction,
    }),
    (error) => error.code === 'clinic_group_change_web_runtime_reconciliation_required'
  );
  assert.equal(updates.length, 0);
  const intakeReads = state.calls.filter((call) => call.model === 'IntakeConfig');
  assert.ok(intakeReads.every((call) => (
    call.options.transaction === transaction && call.options.lock === transaction.LOCK.UPDATE
  )));
});

test('tras superar ambos guards aplica todas las transiciones en orden estable y en la misma transacción', async () => {
  const updates = [];
  const remove = clinicRow(66, 7, updates);
  const assign = clinicRow(67, 8, updates);
  const state = baseModels([remove, assign]);
  const selected = await applyClinicMembershipSelection({
    groupId: 7,
    targetIds: [67],
    models: state.models,
    transaction,
  });
  assert.deepEqual(selected, [67]);
  assert.deepEqual(updates.map(({ id, patch }) => ({ id, patch })), [
    { id: 66, patch: { grupoClinicaId: null } },
    { id: 67, patch: { grupoClinicaId: 7 } },
  ]);
  assert.ok(updates.every((entry) => entry.options.transaction === transaction));
  const where = state.calls.find((call) => call.model === 'Clinica').options.where;
  assert.equal(Array.isArray(where[Op.or]), true);
});

test('una clínica inexistente aborta el lote completo sin cambios parciales', async () => {
  const updates = [];
  const state = baseModels([clinicRow(66, 7, updates)]);
  await assert.rejects(
    () => applyClinicMembershipSelection({
      groupId: 7,
      targetIds: [66, 999],
      models: state.models,
      transaction,
    }),
    (error) => (
      error.code === 'group_clinic_membership_clinic_not_found'
      && error.status === 404
      && error.details.clinic_ids[0] === 999
    )
  );
  assert.equal(updates.length, 0);
});

test('eliminar un grupo usa el mismo preflight y nunca confía en el SET NULL de la FK', async () => {
  const updates = [];
  let destroyed = false;
  const state = baseModels([clinicRow(66, 7, updates)], {
    installations: [{ id: 'wp-group-7', status: 'connected', reportedState: {} }],
    publications: [{
      id: 'publication-66',
      status: 'published',
      path: '/cita/clinic-66/',
      wordpressInstallationId: 'wp-group-7',
      scopeType: 'clinic',
      clinicaId: 66,
      grupoClinicaId: null,
      configuration: { clinic_id: 66 },
    }],
  });
  state.models.GrupoClinica = {
    findByPk: async (_id, options) => ({
      id_grupo: 7,
      destroy: async () => { destroyed = true; },
      options,
    }),
  };
  const sequelizeInstance = {
    transaction: async (callback) => callback(transaction),
  };
  await assert.rejects(
    () => deleteGroupSafely(7, {
      models: state.models,
      sequelizeInstance,
    }),
    (error) => error.code === 'clinic_membership_wordpress_publication_retirement_required'
  );
  assert.equal(destroyed, false);
  assert.equal(updates.length, 0);
});
