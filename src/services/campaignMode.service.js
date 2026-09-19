'use strict';

const { Op } = require('sequelize');

const CAMPAIGN_MODES = Object.freeze({
  MEASURE: 'connect_only',
  IMPROVE: 'guided_improvement',
  LEGACY_SELF_MANAGED: 'managed_self',
  AUTOPILOT: 'managed_service'
});
const VALID_MODES = new Set(Object.values(CAMPAIGN_MODES));
const IMPROVEMENT_AUTHORIZATION_VERSION = 1;
const IMPROVEMENT_AUTHORIZATION_SCOPES = Object.freeze([
  'landing_publish',
  'campaign_destination',
  'conversion_goal'
]);
const IMPROVEMENT_WEB_INTEGRATION_HOOK_VERSION = 1;
const IMPROVEMENT_WEB_INTEGRATION_HOOKS = Object.freeze({
  landing_publish: 'marketing_web.landing_published.v1',
  campaign_destination: 'marketing_web.destination_ready.v1'
});
const VALID_STRATEGY_STATUSES = new Set(['draft', 'pending_approval', 'active', 'paused', 'completed']);
const LEGACY_STRATEGY_STATUS_MAP = Object.freeze({
  borrador: 'draft',
  pendiente_aceptacion: 'pending_approval',
  activa: 'active',
  pausada: 'paused',
  finalizada: 'completed'
});
const STRATEGY_MODE_FALLBACK_STATUSES = new Set(['active', 'paused']);

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function usesExistingAdvertiserCampaigns(mode) {
  return mode === CAMPAIGN_MODES.MEASURE || mode === CAMPAIGN_MODES.IMPROVE;
}

function ownsCampaignOperations(mode) {
  return mode === CAMPAIGN_MODES.AUTOPILOT;
}

function buildCampaignModeContract(mode, improvementAuthorization = null) {
  const normalizedMode = VALID_MODES.has(mode) ? mode : CAMPAIGN_MODES.MEASURE;
  const base = {
    version: 1,
    mode: normalizedMode,
    measurement: true,
    attribution: true,
    consented_conversion_uploads: true,
    recommendations: true,
    mutate_campaigns: false,
    mutate_bids: false,
    mutate_budget: false,
    mutate_campaign_status: false,
    publish_landings: false,
    change_destinations: false,
    manage_conversion_goals: false,
    requires_prepayment: false
  };

  if (normalizedMode === CAMPAIGN_MODES.IMPROVE) {
    const authorization = improvementAuthorization && typeof improvementAuthorization === 'object'
      ? improvementAuthorization
      : {};
    const requestedScopes = Array.isArray(authorization.scopes)
      ? authorization.scopes.map((value) => String(value || '').trim().toLowerCase())
      : [];
    const allowedScopes = requestedScopes.filter((scope) => IMPROVEMENT_AUTHORIZATION_SCOPES.includes(scope));
    const acceptedAt = authorization.accepted_at
      && Number.isFinite(new Date(authorization.accepted_at).getTime())
      ? new Date(authorization.accepted_at).toISOString()
      : null;
    const acceptedByUserId = parseInteger(authorization.accepted_by_user_id);
    const authorized = authorization.accepted === true
      && Number(authorization.version) === IMPROVEMENT_AUTHORIZATION_VERSION
      && !!acceptedAt
      && !!acceptedByUserId;
    const landingPublishAuthorized = authorized && allowedScopes.includes('landing_publish');
    const campaignDestinationAuthorized = authorized && allowedScopes.includes('campaign_destination');
    const conversionGoalAuthorized = authorized && allowedScopes.includes('conversion_goal');
    return {
      ...base,
      // Mejora only enables the three explicitly authorised capabilities. It
      // still cannot change bids, budgets or campaign status. Landing and
      // destination writes are executed through the versioned, read-backed
      // Marketing Web hooks below.
      mutate_campaigns: campaignDestinationAuthorized || conversionGoalAuthorized,
      publish_landings: landingPublishAuthorized,
      change_destinations: campaignDestinationAuthorized,
      manage_conversion_goals: conversionGoalAuthorized,
      integration_hooks: {
        version: IMPROVEMENT_WEB_INTEGRATION_HOOK_VERSION,
        landing_publish: {
          scope_authorized: landingPublishAuthorized,
          status: landingPublishAuthorized ? 'available' : 'not_authorized',
          event: IMPROVEMENT_WEB_INTEGRATION_HOOKS.landing_publish,
          requires_https_destination: true
        },
        campaign_destination: {
          scope_authorized: campaignDestinationAuthorized,
          status: campaignDestinationAuthorized ? 'available_after_landing_published' : 'not_authorized',
          event: IMPROVEMENT_WEB_INTEGRATION_HOOKS.campaign_destination,
          requires_https_destination: true
        },
        conversion_goal: {
          scope_authorized: conversionGoalAuthorized,
          status: conversionGoalAuthorized ? 'available' : 'not_authorized'
        }
      },
      authorization: {
        version: IMPROVEMENT_AUTHORIZATION_VERSION,
        accepted: authorized,
        // Never manufacture acceptance evidence while normalising a stored
        // contract. Only the onboarding command is allowed to stamp it.
        accepted_at: authorized ? acceptedAt : null,
        accepted_by_user_id: authorized ? acceptedByUserId : null,
        scopes: allowedScopes
      }
    };
  }

  if (normalizedMode === CAMPAIGN_MODES.AUTOPILOT) {
    return {
      ...base,
      mutate_campaigns: true,
      mutate_bids: true,
      mutate_budget: true,
      mutate_campaign_status: true,
      publish_landings: true,
      change_destinations: true,
      manage_conversion_goals: true,
      requires_prepayment: true
    };
  }

  return base;
}

function normalizeCampaignConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      active_mode: null,
      mode_contract: null,
      last_onboarding_id: null,
      last_onboarding_at: null
    };
  }

  const activeMode = String(rawConfig.active_mode || rawConfig.activeMode || '').trim().toLowerCase();
  const normalizedActiveMode = VALID_MODES.has(activeMode) ? activeMode : null;
  const rawModeContract = rawConfig.mode_contract && typeof rawConfig.mode_contract === 'object'
    ? rawConfig.mode_contract
    : rawConfig.modeContract && typeof rawConfig.modeContract === 'object'
      ? rawConfig.modeContract
      : null;
  return {
    active_mode: normalizedActiveMode,
    mode_contract: normalizedActiveMode
      ? { ...buildCampaignModeContract(normalizedActiveMode, rawModeContract?.authorization),
          ...(rawModeContract?.consented_conversion_uploads === false ? { consented_conversion_uploads: false } : {}) }
      : null,
    last_onboarding_id: parseInteger(rawConfig.last_onboarding_id || rawConfig.lastOnboardingId) || null,
    last_onboarding_at: rawConfig.last_onboarding_at || rawConfig.lastOnboardingAt || null
  };
}

function normalizeStrategyStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (VALID_STRATEGY_STATUSES.has(status)) {
    return status;
  }
  return LEGACY_STRATEGY_STATUS_MAP[status] || 'draft';
}

function normalizeStoredStrategyStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (!VALID_STRATEGY_STATUSES.has(status) && !LEGACY_STRATEGY_STATUS_MAP[status]) {
    return null;
  }
  return normalizeStrategyStatus(status);
}

function strategyCanProvideModeFallback(payload, row, mode) {
  const payloadStatus = normalizeStoredStrategyStatus(payload?.status || row?.estado);
  const persistedStatus = normalizeStoredStrategyStatus(row?.estado);
  if (
    !STRATEGY_MODE_FALLBACK_STATUSES.has(payloadStatus)
    || !STRATEGY_MODE_FALLBACK_STATUSES.has(persistedStatus)
  ) {
    return false;
  }

  if (!usesExistingAdvertiserCampaigns(mode)) return true;
  const readiness = payload?.activation_readiness && typeof payload.activation_readiness === 'object'
    && !Array.isArray(payload.activation_readiness)
    ? payload.activation_readiness
    : {};
  return readiness.ready === true
    && readiness.validated === true
    && readiness.validate_only === true;
}

async function loadIntakeRecordForScope(scope, dependencies = {}) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };
  const IntakeConfigModel = dependencies.IntakeConfig || require('../../models').IntakeConfig;
  const record = await IntakeConfigModel.findOne({ where, raw: true, transaction: dependencies.transaction });
  return record || null;
}

async function listClinicIdsForGroup(groupId, dependencies = {}) {
  if (!groupId) return [];
  const ClinicaModel = dependencies.Clinica || require('../../models').Clinica;
  const clinics = await ClinicaModel.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true,
      transaction: dependencies.transaction
  });
  return clinics
    .map((clinic) => parseInteger(clinic.id_clinica))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function normalizeResolvedCampaignMode(modeValue, rawModeContract = null) {
  const mode = String(modeValue || '').trim().toLowerCase();
  if (!VALID_MODES.has(mode)) return null;
  const modeContract = rawModeContract && typeof rawModeContract === 'object'
    && !Array.isArray(rawModeContract)
    ? rawModeContract
    : null;
  return {
    mode,
    mode_contract: { ...buildCampaignModeContract(mode, modeContract?.authorization || null),
      ...(modeContract?.consented_conversion_uploads === false ? { consented_conversion_uploads: false } : {}) }
  };
}

async function findLatestCampaignOnboardingMode(where, matcher, dependencies = {}) {
  const CampaignRequestModel = dependencies.CampaignRequest || require('../../models').CampaignRequest;
  const pageSize = 50;

  // Keep onboarding ahead of the strategy fallback even for scopes with a
  // long CampaignRequest history. A fixed first page could otherwise hide the
  // completed onboarding that established the scope's mode.
  for (let offset = 0; ; offset += pageSize) {
    const rows = await CampaignRequestModel.findAll({
      where,
      attributes: ['id', 'clinica_id', 'solicitud', 'created_at'],
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit: pageSize,
      offset,
      raw: true,
      transaction: dependencies.transaction
    });

    for (const row of rows) {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      if (payload.kind !== 'campaign_onboarding' || payload.status !== 'completed') {
        continue;
      }

      if (matcher(payload)) {
        const resolved = normalizeResolvedCampaignMode(payload.mode, payload.mode_contract);
        if (resolved) return resolved;
      }
    }

    if (rows.length < pageSize) return null;
  }
}

async function findLatestMarketingStrategyMode(where, matcher, dependencies = {}) {
  const CampaignRequestModel = dependencies.CampaignRequest || require('../../models').CampaignRequest;
  const pageSize = 50;

  // CampaignRequests stores both onboarding commands and strategies. Paginate
  // through the scoped rows so a long history of completed requests cannot hide
  // the newest still-open strategy behind an arbitrary fixed limit.
  for (let offset = 0; ; offset += pageSize) {
    const rows = await CampaignRequestModel.findAll({
      where,
      attributes: ['id', 'clinica_id', 'solicitud', 'estado', 'created_at', 'updated_at'],
      order: [['updated_at', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
      limit: pageSize,
      offset,
      raw: true,
      transaction: dependencies.transaction
    });

    for (const row of rows) {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      if (payload.kind !== 'marketing_strategy') continue;
      if (!matcher(payload, row)) continue;

      const resolved = normalizeResolvedCampaignMode(
        payload.mode_snapshot || payload.mode,
        payload.mode_contract
      );
      if (!resolved || !strategyCanProvideModeFallback(payload, row, resolved.mode)) continue;

      // The readiness evidence only authorizes the snapshot as a source for the
      // tier. Existing consent and provider gates still decide whether the
      // strategy can run; this resolver never promotes or activates it.
      return resolved;
    }

    if (rows.length < pageSize) return null;
  }
}

async function resolveModeStateForScope(scope, dependencies = {}) {
  if (!scope || typeof scope !== 'object') return null;

  if (scope.assignment_scope === 'clinic' && scope.clinic_id) {
    const clinicRecord = await loadIntakeRecordForScope({
      assignment_scope: 'clinic',
      clinic_id: scope.clinic_id
    }, dependencies);
    const clinicConfig = normalizeCampaignConfig(clinicRecord?.config?.campaigns || {});
    if (clinicConfig.active_mode) {
      return {
        mode: clinicConfig.active_mode,
        mode_contract: clinicConfig.mode_contract
      };
    }

    if (scope.group_id) {
      const groupRecord = await loadIntakeRecordForScope({
        assignment_scope: 'group',
        group_id: scope.group_id
      }, dependencies);
      const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
      if (groupConfig.active_mode) {
        return {
          mode: groupConfig.active_mode,
          mode_contract: groupConfig.mode_contract
        };
      }
    }

    const clinicMode = await findLatestCampaignOnboardingMode(
      { clinica_id: scope.clinic_id },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'clinic'
          && parseInteger(payloadScope.clinic_id) === scope.clinic_id;
      },
      dependencies
    );

    if (clinicMode) {
      return clinicMode;
    }

    let groupClinicIds = [];
    if (scope.group_id) {
      groupClinicIds = await listClinicIdsForGroup(scope.group_id, dependencies);
      if (groupClinicIds.length > 0) {
        const operators = dependencies.operators || Op;
        const groupMode = await findLatestCampaignOnboardingMode(
          { clinica_id: { [operators.in]: groupClinicIds } },
          (payload) => {
            const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
            return payloadScope.assignment_scope === 'group'
              && parseInteger(payloadScope.group_id) === scope.group_id;
          },
          dependencies
        );
        if (groupMode) return groupMode;
      }
    }

    const clinicStrategyMode = await findLatestMarketingStrategyMode(
      { clinica_id: scope.clinic_id },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'clinic'
          && parseInteger(payloadScope.clinic_id) === scope.clinic_id;
      },
      dependencies
    );
    if (clinicStrategyMode) return clinicStrategyMode;

    if (scope.group_id && groupClinicIds.length > 0) {
      const operators = dependencies.operators || Op;
      return findLatestMarketingStrategyMode(
        { clinica_id: { [operators.in]: groupClinicIds } },
        (payload) => {
          const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
          return payloadScope.assignment_scope === 'group'
            && parseInteger(payloadScope.group_id) === scope.group_id;
        },
        dependencies
      );
    }

    return null;
  }

  if (scope.assignment_scope === 'group' && scope.group_id) {
    const groupRecord = await loadIntakeRecordForScope({
      assignment_scope: 'group',
      group_id: scope.group_id
    }, dependencies);
    const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
    if (groupConfig.active_mode) {
      return {
        mode: groupConfig.active_mode,
        mode_contract: groupConfig.mode_contract
      };
    }

    const groupClinicIds = Array.isArray(scope.clinic_ids) && scope.clinic_ids.length > 0
      ? scope.clinic_ids
      : await listClinicIdsForGroup(scope.group_id, dependencies);

    if (groupClinicIds.length === 0) {
      return null;
    }

    const operators = dependencies.operators || Op;
    const onboardingMode = await findLatestCampaignOnboardingMode(
      { clinica_id: { [operators.in]: groupClinicIds } },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'group'
          && parseInteger(payloadScope.group_id) === scope.group_id;
      },
      dependencies
    );
    if (onboardingMode) return onboardingMode;

    return findLatestMarketingStrategyMode(
      { clinica_id: { [operators.in]: groupClinicIds } },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'group'
          && parseInteger(payloadScope.group_id) === scope.group_id;
      },
      dependencies
    );
  }

  return null;
}

async function resolveActiveModeForScope(scope, dependencies = {}) {
  const resolved = await resolveModeStateForScope(scope, dependencies);
  return resolved?.mode || null;
}

async function resolveModeContractForScope(scope, dependencies = {}) {
  const resolved = await resolveModeStateForScope(scope, dependencies);
  return resolved?.mode_contract || null;
}

module.exports = {
  CAMPAIGN_MODES,
  VALID_MODES,
  IMPROVEMENT_AUTHORIZATION_VERSION,
  IMPROVEMENT_AUTHORIZATION_SCOPES,
  IMPROVEMENT_WEB_INTEGRATION_HOOK_VERSION,
  IMPROVEMENT_WEB_INTEGRATION_HOOKS,
  VALID_STRATEGY_STATUSES,
  LEGACY_STRATEGY_STATUS_MAP,
  STRATEGY_MODE_FALLBACK_STATUSES,
  usesExistingAdvertiserCampaigns,
  ownsCampaignOperations,
  buildCampaignModeContract,
  normalizeCampaignConfig,
  normalizeStrategyStatus,
  normalizeStoredStrategyStatus,
  strategyCanProvideModeFallback,
  loadIntakeRecordForScope,
  listClinicIdsForGroup,
  normalizeResolvedCampaignMode,
  findLatestCampaignOnboardingMode,
  findLatestMarketingStrategyMode,
  resolveModeStateForScope,
  resolveActiveModeForScope,
  resolveModeContractForScope,
};
