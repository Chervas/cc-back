'use strict';

const assert = require('node:assert/strict');
const {
  CAMPAIGN_MODES,
  IMPROVEMENT_AUTHORIZATION_SCOPES,
  IMPROVEMENT_AUTHORIZATION_VERSION,
  resolveActiveModeForScope,
  resolveModeContractForScope,
} = require('../../controllers/campaignOnboarding.controller').__test;

const IN = Symbol('in');

function verifiedActivationReadiness() {
  return {
    ready: true,
    validated: true,
    validate_only: true,
    validated_at: '2026-07-18T09:00:00.000Z',
  };
}

function fullAuthorization() {
  return {
    version: IMPROVEMENT_AUTHORIZATION_VERSION,
    accepted: true,
    accepted_at: '2026-07-18T10:00:00.000Z',
    accepted_by_user_id: 7,
    scopes: [...IMPROVEMENT_AUTHORIZATION_SCOPES],
  };
}

function requestRow({
  id,
  clinicId,
  kind = 'marketing_strategy',
  status = 'active',
  mode = CAMPAIGN_MODES.MEASURE,
  assignmentScope = 'clinic',
  scopeClinicId = clinicId,
  groupId = null,
  modeContract = null,
  activationReadiness = null,
  createdAt = '2026-07-18T08:00:00.000Z',
  updatedAt = createdAt,
}) {
  return {
    id,
    clinica_id: clinicId,
    estado: ({
      draft: 'pendiente_aceptacion',
      pending_approval: 'pendiente_aceptacion',
      active: 'activa',
      paused: 'pausada',
      completed: 'finalizada',
    })[status] || 'activa',
    created_at: createdAt,
    updated_at: updatedAt,
    solicitud: {
      kind,
      status,
      ...(kind === 'campaign_onboarding' ? { mode } : { mode_snapshot: mode }),
      ...(modeContract ? { mode_contract: modeContract } : {}),
      ...(activationReadiness ? { activation_readiness: activationReadiness } : {}),
      scope: {
        assignment_scope: assignmentScope,
        clinic_id: assignmentScope === 'clinic' ? scopeClinicId : null,
        group_id: groupId,
      },
    },
  };
}

function createDependencies({ intake = {}, groupClinics = {}, requests = [] } = {}) {
  const calls = { clinicLookups: 0, requestQueries: [] };
  const dependencies = {
    operators: { in: IN },
    IntakeConfig: {
      async findOne({ where }) {
        const key = where.assignment_scope === 'group'
          ? `group:${where.group_id}`
          : `clinic:${where.clinic_id}`;
        return intake[key] || null;
      },
    },
    Clinica: {
      async findAll({ where }) {
        calls.clinicLookups += 1;
        return (groupClinics[where.grupoClinicaId] || []).map((id) => ({ id_clinica: id }));
      },
    },
    CampaignRequest: {
      async findAll(options) {
        calls.requestQueries.push(options);
        const clinicFilter = options.where.clinica_id;
        const clinicIds = clinicFilter && typeof clinicFilter === 'object'
          ? clinicFilter[IN]
          : [clinicFilter];
        const rows = requests.filter((row) => clinicIds.includes(row.clinica_id));
        const dateField = options.order[0][0];
        rows.sort((left, right) => {
          const dateDelta = String(right[dateField]).localeCompare(String(left[dateField]));
          return dateDelta || right.id - left.id;
        });
        const offset = options.offset || 0;
        return rows.slice(offset, offset + options.limit);
      },
    },
  };
  return { dependencies, calls };
}

async function testClinicFallsBackToOpenStrategyAndKeepsContractCoherent() {
  const connectOnlyContract = {
    version: 1,
    mode: CAMPAIGN_MODES.AUTOPILOT,
    mutate_campaigns: true,
  };
  const { dependencies } = createDependencies({
    groupClinics: { 5: [59, 60] },
    requests: [
      requestRow({
        id: 30,
        clinicId: 59,
        status: 'completed',
        mode: CAMPAIGN_MODES.AUTOPILOT,
        groupId: 5,
        updatedAt: '2026-07-18T12:00:00.000Z',
      }),
      requestRow({
        id: 31,
        clinicId: 59,
        status: 'unknown_legacy_state',
        mode: CAMPAIGN_MODES.AUTOPILOT,
        groupId: 5,
        updatedAt: '2026-07-18T12:30:00.000Z',
      }),
      {
        ...requestRow({
          id: 32,
          clinicId: 59,
          mode: CAMPAIGN_MODES.AUTOPILOT,
          groupId: 5,
          updatedAt: '2026-07-18T12:45:00.000Z',
        }),
        estado: 'finalizada',
      },
      requestRow({
        id: 24,
        clinicId: 59,
        mode: CAMPAIGN_MODES.MEASURE,
        groupId: 5,
        modeContract: connectOnlyContract,
        activationReadiness: verifiedActivationReadiness(),
        updatedAt: '2026-07-18T11:00:00.000Z',
      }),
      requestRow({
        id: 33,
        clinicId: 59,
        mode: CAMPAIGN_MODES.MEASURE,
        groupId: 5,
        activationReadiness: { ready: false, validated: false, validate_only: true },
        updatedAt: '2026-07-18T12:15:00.000Z',
      }),
      requestRow({
        id: 28,
        clinicId: 59,
        mode: CAMPAIGN_MODES.IMPROVE,
        assignmentScope: 'group',
        groupId: 5,
        updatedAt: '2026-07-18T10:00:00.000Z',
      }),
    ],
  });
  const scope = {
    assignment_scope: 'clinic',
    clinic_id: 59,
    group_id: 5,
  };

  assert.equal(await resolveActiveModeForScope(scope, dependencies), CAMPAIGN_MODES.MEASURE);
  const contract = await resolveModeContractForScope(scope, dependencies);
  assert.equal(contract.mode, CAMPAIGN_MODES.MEASURE);
  assert.equal(contract.mutate_campaigns, false);
  assert.equal(contract.mutate_budget, false);
}

async function testUnverifiedOrNeverActivatedStrategiesAreNotModeAuthority() {
  const { dependencies } = createDependencies({
    requests: [
      requestRow({
        id: 35,
        clinicId: 59,
        mode: CAMPAIGN_MODES.MEASURE,
        activationReadiness: { ready: false, validated: false, validate_only: true },
      }),
      requestRow({
        id: 34,
        clinicId: 59,
        status: 'draft',
        mode: CAMPAIGN_MODES.MEASURE,
        activationReadiness: verifiedActivationReadiness(),
        updatedAt: '2026-07-18T07:00:00.000Z',
      }),
    ],
  });
  const scope = { assignment_scope: 'clinic', clinic_id: 59 };

  assert.equal(await resolveActiveModeForScope(scope, dependencies), null);
  assert.equal(await resolveModeContractForScope(scope, dependencies), null);
}

async function testIntakeAndCompletedOnboardingKeepPrecedence() {
  const intakeContract = { authorization: fullAuthorization() };
  const strategy = requestRow({
    id: 40,
    clinicId: 59,
    mode: CAMPAIGN_MODES.MEASURE,
    groupId: 5,
    updatedAt: '2026-07-18T12:00:00.000Z',
  });
  const configured = createDependencies({
    intake: {
      'clinic:59': {
        config: {
          campaigns: {
            active_mode: CAMPAIGN_MODES.IMPROVE,
            mode_contract: intakeContract,
          },
        },
      },
    },
    groupClinics: { 5: [59] },
    requests: [strategy],
  }).dependencies;
  const clinicScope = { assignment_scope: 'clinic', clinic_id: 59, group_id: 5 };
  assert.equal(await resolveActiveModeForScope(clinicScope, configured), CAMPAIGN_MODES.IMPROVE);
  assert.equal((await resolveModeContractForScope(clinicScope, configured)).authorization.accepted, true);

  const onboarding = requestRow({
    id: 41,
    clinicId: 59,
    kind: 'campaign_onboarding',
    status: 'completed',
    mode: CAMPAIGN_MODES.AUTOPILOT,
    groupId: 5,
    createdAt: '2026-07-17T10:00:00.000Z',
  });
  const newerCompletedNoise = Array.from({ length: 50 }, (_, index) => requestRow({
    id: 100 + index,
    clinicId: 59,
    status: 'completed',
    mode: CAMPAIGN_MODES.MEASURE,
    groupId: 5,
    createdAt: new Date(Date.parse('2026-07-18T01:00:00.000Z') + index * 1000).toISOString(),
  }));
  const historicalState = createDependencies({
    groupClinics: { 5: [59] },
    requests: [strategy, onboarding, ...newerCompletedNoise],
  });
  const historical = historicalState.dependencies;
  assert.equal(await resolveActiveModeForScope(clinicScope, historical), CAMPAIGN_MODES.AUTOPILOT);
  const onboardingContract = await resolveModeContractForScope(clinicScope, historical);
  assert.equal(onboardingContract.mode, CAMPAIGN_MODES.AUTOPILOT);
  assert.equal(onboardingContract.mutate_budget, true);
  assert.equal(historicalState.calls.requestQueries.some((query) => query.offset === 50), true);
}

async function testGroupUsesNewestOpenStrategyOnlyFromItsOwnScope() {
  const authorizedImprovement = { authorization: fullAuthorization() };
  const { dependencies } = createDependencies({
    groupClinics: { 5: [59, 60] },
    requests: [
      requestRow({
        id: 53,
        clinicId: 59,
        status: 'completed',
        mode: CAMPAIGN_MODES.AUTOPILOT,
        assignmentScope: 'group',
        groupId: 5,
        updatedAt: '2026-07-18T13:00:00.000Z',
      }),
      requestRow({
        id: 52,
        clinicId: 59,
        mode: CAMPAIGN_MODES.AUTOPILOT,
        assignmentScope: 'group',
        groupId: 9,
        updatedAt: '2026-07-18T12:00:00.000Z',
      }),
      requestRow({
        id: 51,
        clinicId: 60,
        status: 'paused',
        mode: CAMPAIGN_MODES.IMPROVE,
        assignmentScope: 'group',
        groupId: 5,
        modeContract: authorizedImprovement,
        activationReadiness: verifiedActivationReadiness(),
        updatedAt: '2026-07-18T11:00:00.000Z',
      }),
      requestRow({
        id: 50,
        clinicId: 59,
        mode: CAMPAIGN_MODES.MEASURE,
        assignmentScope: 'clinic',
        groupId: 5,
        updatedAt: '2026-07-18T10:00:00.000Z',
      }),
    ],
  });
  const scope = { assignment_scope: 'group', group_id: 5, clinic_ids: [59, 60] };

  assert.equal(await resolveActiveModeForScope(scope, dependencies), CAMPAIGN_MODES.IMPROVE);
  const contract = await resolveModeContractForScope(scope, dependencies);
  assert.equal(contract.mode, CAMPAIGN_MODES.IMPROVE);
  assert.equal(contract.authorization.accepted, true);
  assert.equal(contract.manage_conversion_goals, true);
}

async function testClinicCanInheritAGroupStrategyFallback() {
  const { dependencies, calls } = createDependencies({
    groupClinics: { 5: [59, 60] },
    requests: [
      requestRow({
        id: 60,
        clinicId: 60,
        mode: CAMPAIGN_MODES.MEASURE,
        assignmentScope: 'group',
        groupId: 5,
        activationReadiness: verifiedActivationReadiness(),
      }),
    ],
  });

  const mode = await resolveActiveModeForScope({
    assignment_scope: 'clinic',
    clinic_id: 59,
    group_id: 5,
  }, dependencies);
  assert.equal(mode, CAMPAIGN_MODES.MEASURE);
  assert.equal(calls.clinicLookups, 1);
}

async function run() {
  await testClinicFallsBackToOpenStrategyAndKeepsContractCoherent();
  await testUnverifiedOrNeverActivatedStrategiesAreNotModeAuthority();
  await testIntakeAndCompletedOnboardingKeepPrecedence();
  await testGroupUsesNewestOpenStrategyOnlyFromItsOwnScope();
  await testClinicCanInheritAGroupStrategyFallback();
  console.log('campaign_active_mode_strategy_fallback.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
