'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertClinicWordpressMembershipChangeSafe,
  assertClinicWebRuntimeGroupChangeSafe,
  inheritedRuntimeState,
} = require('../../services/clinicWebRuntimeMembership.service');

function groupRuntime(groupId = 7) {
  return {
    assignment_scope: 'group',
    group_id: groupId,
    hmac_key: 'group-runtime-hmac-0123456789abcdef',
    config: {
      features: { forms: true, consent_mode: true },
      locations: [{ id: 66 }],
    },
  };
}

function directConfig(config = {}) {
  return {
    assignment_scope: 'clinic',
    clinic_id: 66,
    hmac_key: null,
    config,
  };
}

function modelsFor({ direct = null, group = null } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      IntakeConfig: {
        async findOne(options) {
          calls.push(options);
          if (options.where.assignment_scope === 'clinic') return direct;
          if (options.where.assignment_scope === 'group') return group;
          return null;
        },
      },
    },
  };
}

async function main() {
  const clinicControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/clinica.controller.js'),
    'utf8'
  );
  const guardPosition = clinicControllerSource.indexOf('await assertClinicWebRuntimeGroupChangeSafe({');
  const wordpressGuardPosition = clinicControllerSource.indexOf('await assertClinicWordpressMembershipChangeSafe({');
  const updatePosition = clinicControllerSource.indexOf('await clinicaExistente.update(scalarUpdates');
  assert.ok(guardPosition > 0 && updatePosition > guardPosition, 'el preflight debe preceder al cambio de grupo');
  assert.ok(
    wordpressGuardPosition > 0 && updatePosition > wordpressGuardPosition,
    'las landings heredadas deben retirarse antes de cambiar grupo o desactivar la clínica'
  );
  assert.match(
    clinicControllerSource.slice(guardPosition, updatePosition),
    /transaction,/u,
    'el preflight debe usar la misma transacción y locks que el PATCH de clínica'
  );

  const explicit = directConfig({
    runtime_inheritance: { schema_version: 1, scope_type: 'group', scope_id: 7 },
  });
  assert.deepEqual(
    inheritedRuntimeState({
      directRecord: explicit,
      groupRecord: groupRuntime(),
      clinicId: 66,
      previousGroupId: 7,
    }),
    { inherited: true, reason: 'explicit_group_inheritance' }
  );

  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const explicitModels = modelsFor({ direct: explicit, group: groupRuntime() });
  await assert.rejects(
    () => assertClinicWebRuntimeGroupChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      models: explicitModels.models,
      transaction,
    }),
    (error) => (
      error.code === 'clinic_group_change_web_runtime_reconciliation_required'
      && error.status === 409
      && error.details.error_code === error.code
      && error.details.next_action === 'reconcile_web_runtime_before_group_change'
      && error.details.previous_group_id === 7
      && error.details.requested_group_id === 8
    )
  );
  assert.equal(explicitModels.calls.length, 2);
  assert.ok(explicitModels.calls.every((call) => (
    call.transaction === transaction && call.lock === transaction.LOCK.UPDATE
  )));

  const implicitModels = modelsFor({
    direct: directConfig({ features: { chat: false } }),
    group: groupRuntime(),
  });
  await assert.rejects(
    () => assertClinicWebRuntimeGroupChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: null,
      models: implicitModels.models,
      transaction,
    }),
    (error) => (
      error.code === 'clinic_group_change_web_runtime_reconciliation_required'
      && error.details.inheritance_reason === 'implicit_group_inheritance'
    )
  );

  const clinicRuntime = directConfig({ features: { forms: true } });
  clinicRuntime.hmac_key = 'clinic-runtime-hmac-0123456789abcdef';
  const directModels = modelsFor({ direct: clinicRuntime, group: groupRuntime() });
  assert.deepEqual(
    await assertClinicWebRuntimeGroupChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      models: directModels.models,
      transaction,
    }),
    { inherited: false, reason: 'clinic_runtime' }
  );

  const unrelatedGroup = groupRuntime();
  unrelatedGroup.config.locations = [{ id: 55 }];
  const unrelatedModels = modelsFor({ direct: null, group: unrelatedGroup });
  assert.deepEqual(
    await assertClinicWebRuntimeGroupChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      models: unrelatedModels.models,
      transaction,
    }),
    { inherited: false, reason: 'no_runtime_inheritance' }
  );

  const sameGroupModels = modelsFor({ direct: explicit, group: groupRuntime() });
  assert.deepEqual(
    await assertClinicWebRuntimeGroupChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 7,
      models: sameGroupModels.models,
      transaction,
    }),
    { inherited: false }
  );
  assert.equal(sameGroupModels.calls.length, 0);

  const wordpressCalls = [];
  const wordpressModels = {
    WebWordpressInstallation: {
      async findAll(options) {
        wordpressCalls.push({ model: 'installation', options });
        return [{ id: 'group-wp-7', status: 'connected', reportedState: {} }];
      },
    },
    WebPublication: {
      async findAll(options) {
        wordpressCalls.push({ model: 'publication', options });
        return [{
          id: 'clinic-route-66',
          status: 'published',
          wordpressInstallationId: 'group-wp-7',
          scopeType: 'clinic',
          clinicaId: 66,
          grupoClinicaId: null,
          configuration: { clinic_id: 66 },
        }];
      },
    },
  };
  await assert.rejects(
    () => assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      previousActive: true,
      requestedActive: true,
      models: wordpressModels,
      transaction,
    }),
    (error) => (
      error.code === 'clinic_membership_wordpress_publication_retirement_required'
      && error.details.next_action === 'retire_inherited_wordpress_publications_before_membership_change'
      && error.details.publication_ids[0] === 'clinic-route-66'
    )
  );
  await assert.rejects(
    () => assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 7,
      previousActive: true,
      requestedActive: false,
      models: wordpressModels,
      transaction,
    }),
    (error) => error.code === 'clinic_membership_wordpress_publication_retirement_required'
  );
  assert.ok(wordpressCalls.every(({ options }) => options.transaction === transaction));
  assert.ok(wordpressCalls.every(({ options }) => options.lock === undefined));

  const groupProjectModels = {
    ...wordpressModels,
    WebPublication: {
      findAll: async () => [{
        id: 'group-route-for-clinic-66',
        status: 'published',
        path: '/cita/clinic-66/',
        wordpressInstallationId: 'group-wp-7',
        scopeType: 'group',
        clinicaId: null,
        grupoClinicaId: 7,
        configuration: { clinic_id: 66 },
      }],
    },
  };
  await assert.rejects(
    () => assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      previousActive: true,
      requestedActive: true,
      models: groupProjectModels,
      transaction,
    }),
    (error) => (
      error.code === 'clinic_membership_wordpress_publication_retirement_required'
      && error.details.publication_ids[0] === 'group-route-for-clinic-66'
    )
  );

  const retiredPendingModels = {
    ...wordpressModels,
    WebPublication: {
      findAll: async () => [{
        id: 'clinic-route-66',
        status: 'retired',
        path: '/cita/clinic-66/',
        wordpressInstallationId: 'group-wp-7',
        scopeType: 'clinic',
        clinicaId: 66,
        grupoClinicaId: null,
        configuration: { clinic_id: 66 },
      }],
    },
  };
  await assert.rejects(
    () => assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      previousActive: true,
      requestedActive: true,
      models: retiredPendingModels,
      transaction,
    }),
    (error) => error.code === 'clinic_membership_wordpress_publication_retirement_required'
  );

  const retiredModels = {
    WebWordpressInstallation: {
      findAll: async () => [{
        id: 'group-wp-7',
        status: 'connected',
        reportedState: {
          confirmed_routes: {
            'clinic-route-66': {
              status: 'retired',
              route_prefix: '/cita/clinic-66/',
              artifact_hash: null,
            },
          },
        },
      }],
    },
    WebPublication: retiredPendingModels.WebPublication,
  };
  assert.deepEqual(
    await assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      previousActive: true,
      requestedActive: true,
      models: retiredModels,
      transaction,
    }),
    { blocked: false }
  );

  const revokedModels = {
    ...wordpressModels,
    WebWordpressInstallation: {
      findAll: async () => [{ id: 'group-wp-7', status: 'revoked', reportedState: {} }],
    },
  };
  await assert.rejects(
    () => assertClinicWordpressMembershipChangeSafe({
      clinicId: 66,
      previousGroupId: 7,
      requestedGroupId: 8,
      previousActive: true,
      requestedActive: true,
      models: revokedModels,
      transaction,
    }),
    (error) => error.code === 'clinic_membership_wordpress_publication_retirement_required'
  );

  console.log('web clinic group runtime guard: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
