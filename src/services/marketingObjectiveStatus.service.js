'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  resolveEffectiveMarketingAssetInventory,
} = require('./effectiveMarketingAssets.service');
const businessProfileLocalService = require('./businessProfileLocal.service');
const marketingBulkSendsService = require('./marketingBulkSends.service');

const SCHEMA_VERSION = 1;
const POLICY_VERSION = '2026-08-v1';

const OBJECTIVE_POLICY = Object.freeze([
  Object.freeze({
    id: 'new_patients',
    subobjectives: Object.freeze([
      Object.freeze({ id: 'paid_media', weight: 30, availability: 'available', route: '/marketing/campanas' }),
      Object.freeze({ id: 'google_maps', weight: 20, availability: 'available', route: '/marketing/perfil-google' }),
      Object.freeze({ id: 'web', weight: 20, availability: 'unknown', route: '/marketing/web' }),
      Object.freeze({ id: 'seo_ai', weight: 15, availability: 'available', route: '/marketing/mi-clinica/seo-ia' }),
      Object.freeze({ id: 'social_content_comments', weight: 15, availability: 'coming_soon', route: '/marketing/redes-sociales' }),
    ]),
  }),
  Object.freeze({
    id: 'reputation',
    subobjectives: Object.freeze([
      Object.freeze({ id: 'reviews', weight: 35, availability: 'available', route: '/marketing/campanas' }),
      Object.freeze({ id: 'followers', weight: 20, availability: 'coming_soon', route: '/marketing/redes-sociales' }),
      Object.freeze({ id: 'local_national_media', weight: 25, availability: 'coming_soon', route: null }),
      Object.freeze({ id: 'professional_report', weight: 20, availability: 'coming_soon', route: null }),
    ]),
  }),
  Object.freeze({
    id: 'profitability',
    subobjectives: Object.freeze([
      Object.freeze({ id: 'brand_protection', weight: 20, availability: 'coming_soon', route: '/marketing/campanas' }),
      Object.freeze({ id: 'reduce_no_shows', weight: 30, availability: 'unknown', route: '/marketing/automatizaciones' }),
      Object.freeze({ id: 'reactivation', weight: 25, availability: 'available', route: '/marketing/campanas' }),
      Object.freeze({ id: 'accept_budgets', weight: 25, availability: 'coming_soon', route: '/marketing/campanas' }),
    ]),
  }),
]);

const FAMILY_STATE_PRIORITY = Object.freeze([
  'managed',
  'paused',
  'attention',
  'needs_connection',
  'not_started',
  'configuring',
  'collecting_data',
  'healthy',
]);

function plain(row) {
  return row?.get ? row.get({ plain: true }) : (row || {});
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function roundPoint(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function isRecentDate(value, now, maxAgeDays) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp)
    && timestamp >= now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
}

function issue(code, message, severity = 'action') {
  return { code, message, severity };
}

function policyItem(familyId, subobjectiveId) {
  const family = OBJECTIVE_POLICY.find((item) => item.id === familyId);
  return family?.subobjectives.find((item) => item.id === subobjectiveId) || null;
}

function unavailableSubobjective(familyId, subobjectiveId, state, blocker) {
  const policy = policyItem(familyId, subobjectiveId);
  if (!policy) throw new Error(`objective_policy_missing:${familyId}:${subobjectiveId}`);
  return {
    id: policy.id,
    weight: policy.weight,
    eligible_points: 0,
    earned_points: null,
    availability: policy.availability,
    state,
    evidence: {},
    blockers: blocker ? [blocker] : [],
    route: policy.route,
  };
}

function scoredSubobjective(familyId, subobjectiveId, earnedPoints, state, evidence = {}, blockers = []) {
  const policy = policyItem(familyId, subobjectiveId);
  if (!policy) throw new Error(`objective_policy_missing:${familyId}:${subobjectiveId}`);
  const eligiblePoints = policy.availability === 'available' ? policy.weight : 0;
  return {
    id: policy.id,
    weight: policy.weight,
    eligible_points: eligiblePoints,
    earned_points: eligiblePoints ? roundPoint(Math.min(Math.max(earnedPoints, 0), eligiblePoints)) : null,
    availability: policy.availability,
    state,
    evidence,
    blockers,
    route: policy.route,
  };
}

function strategyPayload(row) {
  const payload = plain(row).solicitud;
  return isObject(payload) ? payload : {};
}

function uniqueStrategies(rows = []) {
  const selected = new Map();
  [...rows]
    .sort((left, right) => {
      const leftDate = new Date(plain(left).updated_at || 0).getTime();
      const rightDate = new Date(plain(right).updated_at || 0).getTime();
      return rightDate - leftDate || Number(plain(right).id || 0) - Number(plain(left).id || 0);
    })
    .forEach((row) => {
      const raw = plain(row);
      const payload = strategyPayload(raw);
      if (payload.kind !== 'marketing_strategy' || payload.objective_id !== 'new_patients') return;
      const identity = positiveInteger(raw.campaign_id) || `request:${raw.id}`;
      if (!selected.has(String(identity))) selected.set(String(identity), raw);
    });
  return [...selected.values()];
}

function strategyAssignment(assignments, strategy) {
  const row = plain(strategy);
  return assignments.map(plain).find((assignment) => (
    assignment.status === 'active'
    && positiveInteger(assignment.strategy_campaign_id) === positiveInteger(row.campaign_id)
    && positiveInteger(assignment.campaign_request_id) === positiveInteger(row.id)
  )) || null;
}

function hasEffectiveAdvertisingAccount(inventory) {
  const googleAccount = inventory?.google?.effective_assets?.account;
  return Boolean(
    (googleAccount?.customer_id && googleAccount.is_linked !== false)
    || inventory?.meta?.effective_assets?.ad_account?.ad_account_id
  );
}

function scorePaidMedia({ inventory, campaignRequests = [], assignments = [] }) {
  const strategies = uniqueStrategies(campaignRequests);
  const evaluatedStrategies = strategies.map((row) => {
    const payload = strategyPayload(row);
    const readiness = payload.activation_readiness;
    return {
      row,
      mapped: Boolean(strategyAssignment(assignments, row)),
      ready: readiness?.ready === true && readiness?.validated === true,
      active: payload.status === 'active' || row.estado === 'activa',
      paused: payload.status === 'paused' || row.estado === 'pausada',
    };
  });
  const connected = hasEffectiveAdvertisingAccount(inventory);
  const hasStrategy = strategies.length > 0;
  const denominator = Math.max(evaluatedStrategies.length, 1);
  const mappedCount = evaluatedStrategies.filter((item) => item.mapped).length;
  const linkedCampaignCount = assignments.map(plain).filter((assignment) => (
    assignment.status === 'active'
    && strategies.some((strategy) => (
      positiveInteger(assignment.strategy_campaign_id) === positiveInteger(strategy.campaign_id)
      && positiveInteger(assignment.campaign_request_id) === positiveInteger(strategy.id)
    ))
  )).length;
  const readyCount = evaluatedStrategies.filter((item) => item.ready).length;
  const activeCount = evaluatedStrategies.filter((item) => item.active).length;
  const paused = evaluatedStrategies.length > 0 && evaluatedStrategies.every((item) => item.paused);

  let points = 0;
  if (connected) points += 8;
  if (hasStrategy) points += 6;
  points += 6 * (mappedCount / denominator);
  points += 5 * (readyCount / denominator);
  points += 5 * (activeCount / denominator);

  const blockers = [];
  if (!connected) blockers.push(issue('paid_media_account_missing', 'Conecta una cuenta publicitaria para medir este objetivo.'));
  if (connected && !hasStrategy) blockers.push(issue('paid_media_strategy_missing', 'Configura qué campañas forman parte de este objetivo.'));
  if (hasStrategy && mappedCount < evaluatedStrategies.length) blockers.push(issue('paid_media_campaign_mapping_missing', 'Vincula las campañas externas pendientes a su estrategia.'));
  if (hasStrategy && readyCount < evaluatedStrategies.length) blockers.push(issue('paid_media_measurement_not_validated', 'Completa y valida la medición pendiente antes de considerarla preparada.'));

  let state = 'healthy';
  if (paused) state = 'paused';
  else if (!connected) state = 'needs_connection';
  else if (!hasStrategy) state = 'not_started';
  else if (mappedCount < evaluatedStrategies.length || readyCount < evaluatedStrategies.length) state = 'attention';
  else if (activeCount < evaluatedStrategies.length) state = 'configuring';

  return scoredSubobjective('new_patients', 'paid_media', points, state, {
    account_connected: connected,
    strategy_count: strategies.length,
    linked_campaign_count: linkedCampaignCount,
    measurement_ready_count: readyCount,
    active_strategy_count: activeCount,
  }, blockers);
}

function businessProfileAssets(inventory) {
  const available = inventory?.google?.available_assets?.business_profile;
  return Array.isArray(available) ? available.filter(Boolean) : [];
}

function serializeBusinessLocations(assets, locations, serializeLocation) {
  const assetById = new Map(assets.map((asset) => [String(asset.mapping_id), asset]));
  return locations.map((location) => {
    const raw = plain(location);
    const asset = assetById.get(String(raw.id)) || {};
    return serializeLocation(raw, { assignmentOrigin: asset.assignment_origin || null });
  });
}

function locationCompleteness(location) {
  return [
    Boolean(location?.websiteUri),
    Boolean(location?.phone),
    Boolean(location?.address?.formatted),
    Boolean(location?.primaryCategory),
  ].filter(Boolean).length;
}

function scoreGoogleMaps({ assets = [], locations = [], serializeLocation, now = new Date() }) {
  if (!assets.length) {
    return scoredSubobjective('new_patients', 'google_maps', 0, 'needs_connection', {
      location_count: 0,
    }, [issue('business_profile_missing', 'Conecta una ficha de Perfil de Empresa de Google.')]);
  }

  const serialized = serializeBusinessLocations(assets, locations, serializeLocation);
  const fallbacks = serialized.length ? serialized : assets.map((asset) => ({
    verified: asset.verified === true,
    suspended: asset.suspended === true,
    syncStatus: asset.sync_status,
    lastSyncedAt: asset.last_synced_at,
  }));
  const rowScores = fallbacks.map((location) => {
    let points = 6;
    if (location.verified === true && location.suspended !== true) points += 6;
    if (location.syncStatus === 'synced' && isRecentDate(location.lastSyncedAt, now, 30)) points += 4;
    points += locationCompleteness(location);
    return points;
  });
  const points = rowScores.reduce((sum, value) => sum + value, 0) / rowScores.length;
  const suspended = fallbacks.filter((location) => location.suspended === true).length;
  const verified = fallbacks.filter((location) => location.verified === true && location.suspended !== true).length;
  const synced = fallbacks.filter((location) => (
    location.syncStatus === 'synced' && isRecentDate(location.lastSyncedAt, now, 30)
  )).length;
  const incomplete = fallbacks.filter((location) => locationCompleteness(location) < 4).length;
  const blockers = [];
  if (suspended) blockers.push(issue('business_profile_suspended', 'Hay una ficha suspendida o desactivada que requiere atención.'));
  if (verified < fallbacks.length) blockers.push(issue('business_profile_verification_pending', 'Completa la verificación de las fichas pendientes.'));
  if (synced < fallbacks.length) blockers.push(issue('business_profile_sync_pending', 'Todavía faltan datos sincronizados de alguna ficha.'));
  if (incomplete) blockers.push(issue('business_profile_incomplete', 'Completa web, teléfono, dirección y categoría principal de las fichas pendientes.'));

  let state = 'healthy';
  if (suspended) state = 'attention';
  else if (!verified) state = 'configuring';
  else if (synced < fallbacks.length) state = 'collecting_data';
  else if (points < 20) state = 'attention';

  return scoredSubobjective('new_patients', 'google_maps', points, state, {
    location_count: fallbacks.length,
    verified_count: verified,
    suspended_count: suspended,
    synced_count: synced,
    incomplete_count: incomplete,
  }, blockers);
}

function aiRunHasUsableResult(run) {
  const value = plain(run);
  if (value.status === 'completed') return true;
  if (value.status !== 'completed_with_errors') return false;
  const providerStatus = isObject(value.provider_status) ? value.provider_status : {};
  return Object.values(providerStatus).some((provider) => provider?.status === 'completed');
}

function scoreSeoAi({ inventory, latestSearchConsoleAggregate, latestSearchConsoleQuery, latestAiRun, now = new Date() }) {
  const searchConsoleAssets = inventory?.google?.available_assets?.search_console;
  const assets = Array.isArray(searchConsoleAssets) ? searchConsoleAssets : [];
  const verifiedAsset = assets.find((asset) => asset?.verified === true) || null;
  const latestSearchDate = plain(latestSearchConsoleAggregate).date || plain(latestSearchConsoleQuery).date || null;
  const hasSearchData = Boolean(latestSearchDate) && isRecentDate(latestSearchDate, now, 35);
  const hasAiRun = aiRunHasUsableResult(latestAiRun);
  let points = 0;
  if (verifiedAsset) points += 5;
  if (hasSearchData) points += 5;
  if (hasAiRun) points += 5;
  const blockers = [];
  if (!verifiedAsset) blockers.push(issue('search_console_missing', 'Conecta una propiedad verificada de Search Console.'));
  if (verifiedAsset && !hasSearchData) blockers.push(issue('search_console_data_pending', 'Search Console está conectada, pero todavía no hay datos importados.', 'info'));
  if (!hasAiRun) blockers.push(issue('ai_visibility_baseline_missing', 'Todavía no hay una medición vigente de visibilidad en asistentes de IA.', 'info'));
  blockers.push(issue('on_page_audit_not_available', 'La auditoría completa de metadatos y datos estructurados estará disponible próximamente.', 'upcoming'));

  let state = 'healthy';
  if (!verifiedAsset) state = 'needs_connection';
  else if (!hasSearchData) state = 'collecting_data';
  else if (!hasAiRun) state = 'configuring';

  return scoredSubobjective('new_patients', 'seo_ai', points, state, {
    search_console_connected: Boolean(verifiedAsset),
    search_console_mapping_id: verifiedAsset?.mapping_id || null,
    latest_search_console_date: latestSearchDate,
    ai_baseline_completed_at: plain(latestAiRun).completed_at || null,
    ai_baseline_expires_at: plain(latestAiRun).expires_at || null,
  }, blockers);
}

async function scoreReviews({ clinicIds, assets, locations, serializeLocation, getReviewAutomationStatus }) {
  const serialized = serializeBusinessLocations(assets, locations, serializeLocation);
  const hasLocation = assets.length > 0;
  const hasReviewUrl = serialized.some((location) => Boolean(location?.newReviewUri));
  const statuses = await Promise.all(clinicIds.map(async (clinicId) => {
    try {
      return await getReviewAutomationStatus({
        scope: 'clinic',
        clinicIds: [clinicId],
        groupId: null,
        original: String(clinicId),
        isAll: false,
        isValid: true,
      });
    } catch (error) {
      return {
        clinic_id: clinicId,
        automation_enabled: false,
        automation_configured: false,
        configuration_errors: [error?.code || 'review_status_unavailable'],
      };
    }
  }));
  const denominator = Math.max(statuses.length, 1);
  const configured = statuses.filter((status) => status?.automation_configured === true).length;
  const enabled = statuses.filter((status) => status?.automation_enabled === true).length;
  const configurationErrors = statuses.flatMap((status) => (
    Array.isArray(status?.configuration_errors) ? status.configuration_errors : []
  ));
  let points = 0;
  if (hasLocation) points += 8;
  if (hasReviewUrl) points += 7;
  points += 10 * (configured / denominator);
  points += 10 * (enabled / denominator);

  const blockers = [];
  if (!hasLocation) blockers.push(issue('review_business_profile_missing', 'Conecta la ficha de Google desde la que se pedirán reseñas.'));
  if (hasLocation && !hasReviewUrl) blockers.push(issue('review_url_missing', 'La ficha conectada todavía no ofrece una URL para solicitar reseñas.'));
  if (configured < statuses.length) blockers.push(issue('review_automation_not_configured', 'Configura la automatización de solicitud de reseñas.'));
  if (configured && enabled < statuses.length) blockers.push(issue('review_automation_disabled', 'Activa la automatización de solicitud de reseñas.'));
  if (configurationErrors.length) blockers.push(issue('review_automation_invalid', 'Hay errores en la configuración de la automatización de reseñas.'));

  let state = 'healthy';
  if (!hasLocation) state = 'needs_connection';
  else if (!hasReviewUrl || configurationErrors.length) state = 'attention';
  else if (!configured || enabled < statuses.length) state = 'configuring';

  return scoredSubobjective('reputation', 'reviews', points, state, {
    business_profile_connected: hasLocation,
    review_url_available: hasReviewUrl,
    clinic_count: statuses.length,
    configured_clinics: configured,
    enabled_clinics: enabled,
    configuration_errors: configurationErrors,
  }, blockers);
}

function configuredObject(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function scoreReactivation(reactivationResult) {
  const lists = Array.isArray(reactivationResult?.items) ? reactivationResult.items : [];
  if (!lists.length) {
    return scoredSubobjective('profitability', 'reactivation', 0, 'not_started', {
      list_count: 0,
    }, [issue('reactivation_list_missing', 'Prepara una audiencia de pacientes para reactivar.')]);
  }
  const selected = [...lists].sort((left, right) => {
    const usable = (item) => (
      item?.automation?.active === true
      && Boolean(item?.prepared_at)
      && ['prepared', 'scheduled', 'sending', 'sent', 'active'].includes(String(item?.status || '').toLowerCase())
    );
    const usableDelta = Number(usable(right)) - Number(usable(left));
    if (usableDelta) return usableDelta;
    return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime();
  })[0];
  const hasCriteria = configuredObject(selected.criteria);
  const hasDelivery = Boolean(selected.action_mode && selected.channel && (
    selected.action_mode !== 'whatsapp_template' || selected.template_id
  ));
  const gates = isObject(selected.safety_gates) ? selected.safety_gates : {};
  const preparationGatesReady = gates.frozen_audience === true
    && gates.approved_template === true
    && gates.audit === true;
  const selectedStatus = String(selected.status || '').toLowerCase();
  const prepared = Boolean(selected.prepared_at) && ['prepared', 'scheduled', 'sending', 'sent', 'active'].includes(selectedStatus);
  const automationActive = selected.automation?.active === true;
  let points = 5;
  if (hasCriteria) points += 5;
  if (hasDelivery) points += 5;
  if (preparationGatesReady && selected.prepared_at) points += 5;
  if (prepared && automationActive) points += 5;
  const blockers = [];
  if (!hasCriteria) blockers.push(issue('reactivation_criteria_missing', 'Define qué pacientes deben entrar en la audiencia.'));
  if (!hasDelivery) blockers.push(issue('reactivation_delivery_missing', 'Elige canal, acción y plantilla para el seguimiento.'));
  if (!preparationGatesReady || !selected.prepared_at) blockers.push(issue('reactivation_not_prepared', 'Revisa la audiencia y prepara la automatización.'));
  if (prepared && !automationActive) blockers.push(issue('reactivation_automation_disabled', 'Activa la automatización si quieres mantener la reactivación de forma continua.'));

  let state = 'healthy';
  if (selectedStatus === 'paused') state = 'paused';
  else if (!hasCriteria || !hasDelivery) state = 'attention';
  else if (!prepared || !automationActive) state = 'configuring';

  return scoredSubobjective('profitability', 'reactivation', points, state, {
    list_count: lists.length,
    selected_list_id: selected.id,
    selected_list_status: selected.status,
    audience_size: Number(selected.counters?.total || 0),
    prepared,
    automation_active: automationActive,
  }, blockers);
}

function actionBlockerCount(subobjective) {
  return (subobjective.blockers || []).filter((blocker) => blocker.severity === 'action').length;
}

function aggregateFamily(familyId, subobjectives) {
  const policy = OBJECTIVE_POLICY.find((item) => item.id === familyId);
  const eligiblePoints = subobjectives.reduce((sum, item) => sum + Number(item.eligible_points || 0), 0);
  const earnedPoints = subobjectives.reduce((sum, item) => sum + Number(item.earned_points || 0), 0);
  const eligibleStates = subobjectives.filter((item) => item.eligible_points > 0).map((item) => item.state);
  const state = FAMILY_STATE_PRIORITY.find((candidate) => eligibleStates.includes(candidate))
    || (eligibleStates.length ? 'healthy' : 'unknown');
  return {
    id: familyId,
    max_points: policy.subobjectives.reduce((sum, item) => sum + item.weight, 0),
    eligible_points: roundPoint(eligiblePoints),
    earned_points: roundPoint(earnedPoints),
    score: eligiblePoints > 0 ? Math.round((earnedPoints / eligiblePoints) * 100) : null,
    status: state,
    attention_count: subobjectives.reduce((sum, item) => sum + actionBlockerCount(item), 0),
    subobjectives,
  };
}

function defaultDependencies() {
  return {
    resolveInventory: resolveEffectiveMarketingAssetInventory,
    CampaignRequest: db.CampaignRequest,
    ExternalCampaignAssignment: db.ExternalCampaignAssignment,
    ClinicBusinessLocation: db.ClinicBusinessLocation,
    WebScDailyAgg: db.WebScDailyAgg,
    WebScQueryDaily: db.WebScQueryDaily,
    MarketingAiVisibilityRun: db.MarketingAiVisibilityRun,
    MarketingPatientList: db.MarketingPatientList,
    serializeLocation: businessProfileLocalService.serializeLocation,
    getReviewAutomationStatus: marketingBulkSendsService.getReviewRequestAutomationStatus,
  };
}

function serializeReactivationList(row) {
  const value = plain(row);
  return {
    id: value.id,
    status: value.status,
    criteria: value.criteria || {},
    action_mode: value.action_mode,
    channel: value.channel,
    template_id: value.template_id,
    counters: value.counters || {},
    automation: value.automation || null,
    safety_gates: value.safety_gates || {},
    prepared_at: value.prepared_at,
    updated_at: value.updated_at,
  };
}

async function loadReactivationLists(deps, clinicIds) {
  const rows = await deps.MarketingPatientList.findAll({
    where: {
      objective_id: 'reactivate_patients',
      status: { [Op.ne]: 'archived' },
      clinica_id: { [Op.in]: clinicIds },
    },
    attributes: [
      'id', 'status', 'criteria', 'action_mode', 'channel', 'template_id', 'counters',
      'automation', 'safety_gates', 'prepared_at', 'updated_at',
    ],
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    limit: 20,
    raw: true,
  });
  return { success: true, items: rows.map(serializeReactivationList) };
}

async function getMarketingObjectiveStatus(scope, dependencies = {}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const clinicIds = Array.isArray(scope?.clinicIds)
    ? scope.clinicIds.map(positiveInteger).filter(Boolean)
    : [];
  if (!['clinic', 'group'].includes(scope?.scopeType) || !positiveInteger(scope?.scopeId) || !clinicIds.length) {
    const error = new Error('marketing_objective_scope_invalid');
    error.status = 400;
    throw error;
  }
  const now = dependencies.now instanceof Date ? dependencies.now : new Date();
  if (scope.scopeType === 'group') {
    const selectClinic = issue(
      'objective_status_clinic_required',
      'Selecciona una clínica concreta para calcular su optimización sin mezclar datos de distintas sedes.',
      'unknown'
    );
    const families = OBJECTIVE_POLICY.map((family) => aggregateFamily(
      family.id,
      family.subobjectives.map((item) => unavailableSubobjective(
        family.id,
        item.id,
        item.availability === 'coming_soon' ? 'coming_soon' : 'unknown',
        item.availability === 'coming_soon' ? null : selectClinic
      ))
    ));
    return {
      success: true,
      read_only: true,
      schema_version: SCHEMA_VERSION,
      policy_version: POLICY_VERSION,
      generated_at: now.toISOString(),
      scope: { type: scope.scopeType, id: scope.scopeId, clinic_ids: clinicIds },
      families,
    };
  }
  const inventoryPromise = deps.resolveInventory({
    clinicIdRaw: scope.scopeType === 'clinic' ? scope.scopeId : null,
    groupIdRaw: scope.scopeType === 'group' ? scope.scopeId : null,
    assignmentScopeRaw: scope.scopeType,
  });
  const requestsPromise = deps.CampaignRequest.findAll({
    where: { clinica_id: { [Op.in]: clinicIds } },
    attributes: ['id', 'clinica_id', 'campaign_id', 'estado', 'solicitud', 'updated_at'],
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    limit: 200,
    raw: true,
  });
  const assignmentsPromise = deps.ExternalCampaignAssignment.findAll({
    where: { clinica_id: { [Op.in]: clinicIds }, status: 'active' },
    attributes: [
      'id', 'provider', 'customer_id', 'campaign_id', 'clinica_id', 'strategy_campaign_id',
      'campaign_request_id', 'target_kind', 'target_treatment_id', 'approved_at', 'status', 'updated_at',
    ],
    limit: 1000,
    raw: true,
  });
  const scAggregatePromise = deps.WebScDailyAgg.findOne({
    where: { clinica_id: { [Op.in]: clinicIds } },
    attributes: ['clinica_id', 'date', 'queries_top10', 'queries_top3'],
    order: [['date', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const scQueryPromise = deps.WebScQueryDaily.findOne({
    where: { clinica_id: { [Op.in]: clinicIds } },
    attributes: ['clinica_id', 'site_url', 'date', 'query', 'clicks', 'impressions', 'ctr', 'position'],
    order: [['date', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const aiRunPromise = deps.MarketingAiVisibilityRun.findOne({
    where: {
      clinica_id: { [Op.in]: clinicIds },
      status: { [Op.in]: ['completed', 'completed_with_errors'] },
      expires_at: { [Op.gt]: now },
    },
    attributes: ['id', 'clinica_id', 'status', 'provider_status', 'completed_at', 'expires_at'],
    order: [['completed_at', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const reactivationPromise = dependencies.getReactivationLists
    ? dependencies.getReactivationLists({
      scope: scope.scopeType,
      clinicIds,
      groupId: null,
      original: `${scope.scopeType}:${scope.scopeId}`,
      isAll: false,
      isValid: true,
    })
    : loadReactivationLists(deps, clinicIds);

  const [
    inventory,
    campaignRequests,
    assignments,
    latestSearchConsoleAggregate,
    latestSearchConsoleQuery,
    latestAiRun,
    reactivationResult,
  ] = await Promise.all([
    inventoryPromise,
    requestsPromise,
    assignmentsPromise,
    scAggregatePromise,
    scQueryPromise,
    aiRunPromise,
    reactivationPromise,
  ]);

  const profileAssets = businessProfileAssets(inventory);
  const profileIds = profileAssets.map((asset) => positiveInteger(asset.mapping_id)).filter(Boolean);
  const profileLocations = profileIds.length
    ? await deps.ClinicBusinessLocation.findAll({
      where: { id: { [Op.in]: profileIds }, is_active: true },
      attributes: [
        'id', 'clinica_id', 'google_connection_id', 'location_name', 'location_id', 'store_code',
        'primary_category', 'sync_status', 'is_verified', 'is_suspended', 'raw_payload',
        'is_active', 'last_synced_at',
      ],
      raw: true,
    })
    : [];

  const paidMedia = scorePaidMedia({ inventory, campaignRequests, assignments });
  const googleMaps = scoreGoogleMaps({
    assets: profileAssets,
    locations: profileLocations,
    serializeLocation: deps.serializeLocation,
    now,
  });
  const seoAi = scoreSeoAi({
    inventory,
    latestSearchConsoleAggregate,
    latestSearchConsoleQuery,
    latestAiRun,
    now,
  });
  const reviews = await scoreReviews({
    clinicIds,
    assets: profileAssets,
    locations: profileLocations,
    serializeLocation: deps.serializeLocation,
    getReviewAutomationStatus: deps.getReviewAutomationStatus,
  });
  const reactivation = scoreReactivation(reactivationResult);

  const families = [
    aggregateFamily('new_patients', [
      paidMedia,
      googleMaps,
      unavailableSubobjective(
        'new_patients',
        'web',
        'unknown',
        issue(
          'web_attestation_status_unknown',
          'La verificación criptográfica web todavía no comparte un contrato de lectura reutilizable.',
          'unknown'
        )
      ),
      seoAi,
      unavailableSubobjective('new_patients', 'social_content_comments', 'coming_soon'),
    ]),
    aggregateFamily('reputation', [
      reviews,
      unavailableSubobjective('reputation', 'followers', 'coming_soon'),
      unavailableSubobjective('reputation', 'local_national_media', 'coming_soon'),
      unavailableSubobjective('reputation', 'professional_report', 'coming_soon'),
    ]),
    aggregateFamily('profitability', [
      unavailableSubobjective('profitability', 'brand_protection', 'coming_soon'),
      unavailableSubobjective(
        'profitability',
        'reduce_no_shows',
        'unknown',
        issue(
          'no_show_objective_binding_unknown',
          'Los flujos V2 todavía no declaran qué automatizaciones pertenecen a este objetivo.',
          'unknown'
        )
      ),
      reactivation,
      unavailableSubobjective('profitability', 'accept_budgets', 'coming_soon'),
    ]),
  ];

  return {
    success: true,
    read_only: true,
    schema_version: SCHEMA_VERSION,
    policy_version: POLICY_VERSION,
    generated_at: now.toISOString(),
    scope: {
      type: scope.scopeType,
      id: scope.scopeId,
      clinic_ids: clinicIds,
    },
    families,
  };
}

module.exports = {
  OBJECTIVE_POLICY,
  POLICY_VERSION,
  SCHEMA_VERSION,
  aggregateFamily,
  getMarketingObjectiveStatus,
  scoreGoogleMaps,
  scorePaidMedia,
  scoreReactivation,
  scoreSeoAi,
};
