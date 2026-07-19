'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const googleAdapter = require('./campaignDestinationGoogleAds.service');

const LANDING_PUBLISHED_EVENT = 'marketing_web.landing_published.v1';
const DESTINATION_READY_EVENT = 'marketing_web.destination_ready.v1';
const DESTINATION_APPLY_JOB = 'marketing_campaign.destination_apply.v1';
const DESTINATION_ROLLBACK_JOB = 'marketing_campaign.destination_rollback.v1';
const DESTINATION_DRIFT_AUDIT_JOB = 'marketing_campaign.destination_drift_audit.v1';
const APPLY_AUTHORIZATION_VERSION = 1;
const GUIDED_SCOPES = Object.freeze(['landing_publish', 'campaign_destination']);
const SUPPORTED_MODES = new Set(['connect_only', 'guided_improvement', 'managed_service']);
const ACTIVE_MANAGED_STATUSES = new Set(['approved_to_launch', 'launching', 'active', 'paused']);
const GOOGLE_FAMILIES = new Set(['google_search', 'google_pmax']);
const IN_FLIGHT_ACCOUNT_STATES = new Set(['apply_queued', 'applying', 'readback_pending', 'rollback_queued', 'rolling_back']);
const APPLY_SUPERSEDED_CODE = 'campaign_destination_apply_superseded';
const STRATEGY_CONTRACT_ERROR_CODES = new Set([
  'campaign_destination_strategy_not_active',
  'campaign_destination_strategy_mode_inconsistent',
  'campaign_destination_strategy_changed',
  'campaign_destination_binding_refresh_required',
  'campaign_destination_account_not_in_strategy',
  'campaign_destination_guided_scope_not_authorized',
  'campaign_destination_measure_mode_forbidden',
  'campaign_destination_autopilot_constraint_missing',
  'campaign_destination_autopilot_not_approved',
  'campaign_destination_autopilot_authorization_invalid',
]);

class CampaignDestinationBindingError extends Error {
  constructor(code, message, httpStatus = 422, details = null) {
    super(message);
    this.name = 'CampaignDestinationBindingError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function plain(value) {
  return value?.get ? value.get({ plain: true }) : value;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value, max = 4_096) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function stableUuid(value) {
  const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableEventId(value) {
  const normalized = text(value, 80);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9:._-]{7,79}$/.test(normalized)) {
    throw new CampaignDestinationBindingError('campaign_destination_event_id_invalid', 'event_id debe ser una clave de idempotencia estable.', 422);
  }
  return normalized;
}

function targetIdentity(kind, treatmentId) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  if (normalizedKind === 'general') {
    if (treatmentId !== null && treatmentId !== undefined && treatmentId !== '') {
      throw new CampaignDestinationBindingError('campaign_destination_target_invalid', 'El target general no admite treatment_id.');
    }
    return { targetKind: 'general', treatmentId: null, treatmentIdentity: 0 };
  }
  const treatment = positiveInteger(treatmentId);
  if (normalizedKind !== 'treatment' || !treatment) {
    throw new CampaignDestinationBindingError('campaign_destination_target_invalid', 'El target treatment requiere treatment_id positivo.');
  }
  return { targetKind: 'treatment', treatmentId: treatment, treatmentIdentity: treatment };
}

function strategyTargetKind(kind) {
  return String(kind || '').trim().toLowerCase() === 'generic' ? 'general' : 'treatment';
}

function validator(dependencies = {}) {
  if (typeof dependencies.stableHttpsDestination === 'function') return dependencies.stableHttpsDestination;
  // Reuse the canonical validator exported by onboarding without importing the
  // very large controller during module startup (jobExecutor also loads us).
  return require('../controllers/campaignOnboarding.controller').stableHttpsDestination;
}

function stableDestination(raw, dependencies = {}) {
  const result = validator(dependencies)(raw);
  if (!result?.valid || !result.url) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_url_invalid',
      'El destino debe ser una URL HTTPS pública y estable.',
      422,
      { reason: result?.reason || 'invalid_url' }
    );
  }
  return result.url;
}

function publicationUrl(publication, dependencies = {}) {
  const host = String(publication?.host || '').trim().toLowerCase().replace(/\.$/, '');
  const path = String(publication?.path || '/').trim() || '/';
  if (!host || !path.startsWith('/')) {
    throw new CampaignDestinationBindingError('campaign_destination_publication_url_invalid', 'La publicación no tiene host/path canónicos.', 409);
  }
  return stableDestination(new URL(path, `https://${host}/`).toString(), dependencies);
}

function artifactPublicationUrl(artifact, dependencies = {}) {
  const baseUrl = String(artifact?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_artifact_url_invalid',
      'El artefacto no conserva una URL base canónica.',
      409
    );
  }
  // WebArtifact stores its base URL without the terminal slash so hashes stay
  // stable. Publicaciones, WordPress and Google Ads use the directory route
  // with `/`; normalize that representation before the exact readback check.
  return stableDestination(`${baseUrl}/`, dependencies);
}

function scopeFromStrategy(payload, rows) {
  const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {};
  if (String(scope.assignment_scope || '').trim().toLowerCase() === 'group') {
    const groupId = positiveInteger(scope.group_id);
    if (!groupId) throw new CampaignDestinationBindingError('campaign_destination_strategy_scope_invalid', 'La estrategia de grupo no tiene group_id.', 409);
    return { scopeType: 'group', clinicaId: null, grupoClinicaId: groupId };
  }
  const clinicId = positiveInteger(scope.clinic_id) || positiveInteger(rows?.[0]?.clinica_id);
  if (!clinicId) throw new CampaignDestinationBindingError('campaign_destination_strategy_scope_invalid', 'La estrategia no tiene clinica_id.', 409);
  return { scopeType: 'clinic', clinicaId: clinicId, grupoClinicaId: null };
}

function sameScope(scope, entity) {
  return entity?.scopeType === scope.scopeType
    && Number(entity?.clinicaId || 0) === Number(scope.clinicaId || 0)
    && Number(entity?.grupoClinicaId || 0) === Number(scope.grupoClinicaId || 0);
}

function findStrategyTarget(payload, target) {
  const targets = Array.isArray(payload?.external_targets) ? payload.external_targets : [];
  const match = targets.find((item) => (
    strategyTargetKind(item?.kind) === target.targetKind
    && Number(item?.treatment_id || 0) === Number(target.treatmentId || 0)
  ));
  if (match) return match;
  if (target.targetKind === 'general' && String(payload?.promotion_type || '').toLowerCase() === 'generic') {
    return { kind: 'generic', treatment_id: null, campaigns: [] };
  }
  const treatmentExists = target.targetKind === 'treatment'
    && (Array.isArray(payload?.treatments) ? payload.treatments : []).some((item) => Number(item?.id) === target.treatmentId);
  if (treatmentExists) return { kind: 'treatment', treatment_id: target.treatmentId, campaigns: [] };
  throw new CampaignDestinationBindingError('campaign_destination_target_not_in_strategy', 'El target no pertenece a la estrategia.', 409);
}

function guidedStrategyAuthorization(payload) {
  const authorization = payload?.mode_contract?.authorization;
  const scopes = new Set(Array.isArray(authorization?.scopes) ? authorization.scopes : []);
  const valid = authorization?.accepted === true
    && Number(authorization?.version) === 1
    && positiveInteger(authorization?.accepted_by_user_id)
    && GUIDED_SCOPES.every((scope) => scopes.has(scope));
  if (!valid) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_guided_scope_not_authorized',
      'Mejora no tiene autorizados los scopes de landing y destino.',
      409
    );
  }
  return {
    version: 1,
    accepted: true,
    accepted_at: text(authorization.accepted_at, 64),
    accepted_by_user_id: positiveInteger(authorization.accepted_by_user_id),
    scopes: GUIDED_SCOPES,
  };
}

function normalizedStrategyStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ({
    activa: 'active',
    pausada: 'paused',
    finalizada: 'completed',
    pendiente_aceptacion: 'pending_approval',
    borrador: 'draft',
  })[status] || status || 'draft';
}

function enabled(value) {
  return value === true || value === 1 || value === '1';
}

async function loadStrategyContext(strategyId, target, dependencies = {}, transaction = null) {
  const models = dependencies.models || db;
  const strategy = await models.Campaign.findByPk(strategyId, { transaction });
  if (!strategy) throw new CampaignDestinationBindingError('campaign_destination_strategy_not_found', 'La estrategia no existe.', 404);
  const rows = await models.CampaignRequest.findAll({
    where: { campaign_id: strategyId },
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    transaction,
  });
  const strategyRows = rows.filter((row) => plain(row)?.solicitud?.kind === 'marketing_strategy');
  const strategyRow = strategyRows[0];
  const payload = plain(strategyRow)?.solicitud;
  if (!payload) throw new CampaignDestinationBindingError('campaign_destination_strategy_payload_missing', 'La estrategia no conserva su configuración.', 409);
  const modes = new Set(strategyRows.map((row) => {
    const current = plain(row)?.solicitud || {};
    return String(current.mode_snapshot || current.mode || '').trim().toLowerCase();
  }));
  const statuses = new Set(strategyRows.map((row) => {
    const current = plain(row) || {};
    return normalizedStrategyStatus(current.solicitud?.status || current.estado);
  }));
  if (modes.size !== 1 || statuses.size !== 1) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_strategy_mode_inconsistent',
      'Las sedes de la estrategia no conservan un único modo y estado operativo.',
      409
    );
  }
  const mode = [...modes][0];
  const status = [...statuses][0];
  if (!SUPPORTED_MODES.has(mode)) throw new CampaignDestinationBindingError('campaign_destination_mode_invalid', 'El modo de campaña no admite bindings Web.', 409);
  const targetPayload = findStrategyTarget(payload, target);
  const scope = scopeFromStrategy(payload, rows.map(plain));
  const authorization = mode === 'guided_improvement' ? guidedStrategyAuthorization(payload) : null;
  return {
    strategy: plain(strategy),
    rows: rows.map(plain),
    payload,
    mode,
    status,
    targetPayload,
    scope,
    authorization,
  };
}

function assertStrategyPublishable(strategyContext) {
  const strategy = strategyContext?.strategy || {};
  if (strategyContext?.status !== 'active' || !enabled(strategy.activa)) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_strategy_not_active',
      'La estrategia debe estar activa antes de publicar o aplicar un destino.',
      409
    );
  }
  if (strategyContext?.mode === 'managed_service') {
    if (!enabled(strategy.gestionada)) {
      throw new CampaignDestinationBindingError(
        'campaign_destination_strategy_not_active',
        'Piloto automático ya no conserva una estrategia gestionada vigente para esta landing.',
        409
      );
    }
    return;
  }
  if (enabled(strategy.gestionada)) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_strategy_not_active',
      'La estrategia debe estar activa antes de publicar o aplicar un destino.',
      409
    );
  }
}

async function verifyPublishedLanding(event, strategyContext, dependencies = {}, transaction = null) {
  const models = dependencies.models || db;
  for (const name of ['WebProject', 'WebPublication', 'WebRevision', 'WebArtifact', 'WebPublicationDeployment']) {
    if (!models[name]) throw new CampaignDestinationBindingError('campaign_destination_web_domain_unavailable', `Falta el modelo ${name}.`, 503);
  }
  const [projectModel, publicationModel, revisionModel, artifactModel] = await Promise.all([
    models.WebProject.findByPk(event.project_id, { transaction }),
    models.WebPublication.findByPk(event.publication_id, { transaction }),
    models.WebRevision.findByPk(event.revision_id, { transaction }),
    models.WebArtifact.findByPk(event.artifact_id, { transaction }),
  ]);
  const project = plain(projectModel);
  const publication = plain(publicationModel);
  const revision = plain(revisionModel);
  const artifact = plain(artifactModel);
  if (!project || !publication || !revision || !artifact) {
    throw new CampaignDestinationBindingError('campaign_destination_publication_graph_missing', 'La publicación Web no está completa.', 409);
  }
  if (project.purpose !== 'landing' || project.status === 'archived') {
    throw new CampaignDestinationBindingError('campaign_destination_project_not_landing', 'El proyecto publicado no es una landing activa.', 409);
  }
  if (!sameScope(strategyContext.scope, project) || !sameScope(strategyContext.scope, publication)) {
    throw new CampaignDestinationBindingError('campaign_destination_scope_mismatch', 'La landing y la estrategia no pertenecen al mismo scope.', 403);
  }
  const expectedUrl = publicationUrl(publication, dependencies);
  const eventUrl = stableDestination(event.destination_url, dependencies);
  const expectedDigest = sha256(expectedUrl);
  if (
    publication.status !== 'published'
    || publication.projectId !== project.id
    || publication.activeRevisionId !== revision.id
    || publication.activeArtifactId !== artifact.id
    || publication.lastGoodArtifactId !== artifact.id
    || publication.health?.status !== 'healthy'
    || !publication.lastHealthyAt
    || revision.projectId !== project.id
    || revision.status !== 'approved'
    || artifact.projectId !== project.id
    || artifact.revisionId !== revision.id
    || artifact.environment !== 'production'
    || artifact.status !== 'ready'
    || artifactPublicationUrl(artifact, dependencies) !== expectedUrl
    || eventUrl !== expectedUrl
    || event.destination_digest !== expectedDigest
  ) {
    throw new CampaignDestinationBindingError('campaign_destination_publication_not_verified', 'La publicación no coincide exactamente con su artefacto sano.', 409);
  }
  const deployment = await models.WebPublicationDeployment.findOne({
    where: { publicationId: publication.id, artifactId: artifact.id, status: 'verified' },
    order: [['sequence', 'DESC']],
    transaction,
  });
  if (!deployment) throw new CampaignDestinationBindingError('campaign_destination_deployment_not_verified', 'No existe un deployment verificado para el artefacto activo.', 409);
  return { project, publication, revision, artifact, deployment: plain(deployment), destinationUrl: expectedUrl, destinationDigest: expectedDigest };
}

function familyFromCampaign(campaign, inventory) {
  if (campaign.provider === 'meta_ads') {
    return campaign?.destination_detection?.kind === 'lead_form' ? 'meta_instant_form' : 'meta_reach';
  }
  const channel = String(inventory?.channel_type || campaign?.channel_type || '').trim().toUpperCase();
  if (channel === 'SEARCH') return 'google_search';
  if (channel === 'PERFORMANCE_MAX') return 'google_pmax';
  return 'unsupported';
}

async function resolveAccountTargets(strategyContext, target, dependencies = {}, transaction = null) {
  const models = dependencies.models || db;
  const campaigns = Array.isArray(strategyContext.targetPayload?.campaigns) ? strategyContext.targetPayload.campaigns : [];
  const inventoryRows = models.ExternalCampaignInventory && campaigns.length
    ? await models.ExternalCampaignInventory.findAll({
        where: {
          [Op.or]: campaigns.map((item) => ({
            provider: item.provider,
            customer_id: String(item.customer_id || item.account_id || ''),
            campaign_id: String(item.campaign_id || item.external_campaign_id || ''),
          })),
        },
        transaction,
      })
    : [];
  const inventory = new Map(inventoryRows.map((row) => {
    const value = plain(row);
    return [`${value.provider}:${value.customer_id}:${value.campaign_id}`, value];
  }));
  const targets = campaigns.map((item) => {
    const provider = String(item.provider || '').trim().toLowerCase();
    const customerId = String(item.customer_id || item.account_id || '').trim();
    const campaignId = String(item.campaign_id || item.external_campaign_id || '').trim();
    const currentInventory = inventory.get(`${provider}:${customerId}:${campaignId}`) || null;
    const family = familyFromCampaign(item, currentInventory);
    return { provider, customerId, campaignId, family, managedCampaignId: null };
  }).filter((item) => ['google_ads', 'meta_ads'].includes(item.provider) && item.customerId && item.campaignId);

  if (strategyContext.mode === 'managed_service' && models.ManagedCampaign) {
    const managedRows = await models.ManagedCampaign.findAll({ where: { strategy_campaign_id: strategyContext.strategy.id }, transaction });
    for (const row of managedRows.map(plain)) {
      const treatmentIds = (Array.isArray(row?.target_config?.treatments) ? row.target_config.treatments : [])
        .map((item) => positiveInteger(item?.id)).filter(Boolean);
      if (target.targetKind === 'treatment' && treatmentIds.length && !treatmentIds.includes(target.treatmentId)) continue;
      const refs = row.platform_refs && typeof row.platform_refs === 'object' ? row.platform_refs : {};
      const provider = String(row.provider || '').trim().toLowerCase();
      const customerId = String(refs.customer_id || refs.account_id || '').trim();
      const campaignId = String(refs.campaign_id || refs.external_campaign_id || '').trim();
      if (!customerId || !campaignId) continue;
      targets.push({ provider, customerId, campaignId, family: row.family || 'unsupported', managedCampaignId: row.id });
    }
  }
  return Array.from(new Map(targets.map((item) => [`${item.provider}:${item.customerId}:${item.campaignId}`, item])).values());
}

function strategySnapshotDigest(strategyContext, target, accountTargets) {
  const cohort = (Array.isArray(accountTargets) ? accountTargets : [])
    .map((item) => ({
      provider: String(item.provider || ''),
      customer_id: String(item.customerId || ''),
      campaign_id: String(item.campaignId || ''),
      family: String(item.family || ''),
      managed_campaign_id: text(item.managedCampaignId, 36),
    }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return sha256({
    strategy_id: positiveInteger(strategyContext?.strategy?.id),
    mode: strategyContext?.mode,
    status: strategyContext?.status,
    campaign_active: enabled(strategyContext?.strategy?.activa),
    campaign_managed: enabled(strategyContext?.strategy?.gestionada),
    scope: strategyContext?.scope,
    target: {
      kind: target?.targetKind,
      treatment_id: target?.treatmentId || null,
      treatment_identity: target?.treatmentIdentity || 0,
    },
    authorization: strategyContext?.authorization || null,
    cohort,
  });
}

function bindingSnapshotDigest(binding) {
  return text(binding?.authorization?.strategy_snapshot_digest, 64);
}

function assertBindingStrategyCurrent(binding, strategyContext, target, accountTargets) {
  assertStrategyPublishable(strategyContext);
  const storedDigest = bindingSnapshotDigest(binding);
  if (!storedDigest) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_binding_refresh_required',
      'La landing debe volver a validarse contra la estrategia vigente antes de cambiar destinos.',
      409
    );
  }
  if (binding.mode !== strategyContext.mode) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_strategy_changed',
      'El nivel de gestión cambió después de preparar esta landing.',
      409
    );
  }
  const currentDigest = strategySnapshotDigest(strategyContext, target, accountTargets);
  if (storedDigest !== currentDigest) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_strategy_changed',
      'La estrategia o sus campañas cambiaron después de preparar esta landing.',
      409
    );
  }
  return currentDigest;
}

function accountTargetKey(value) {
  return `${String(value?.provider || '')}:${String(value?.customerId ?? value?.customer_id ?? '')}:${String(value?.campaignId ?? value?.campaign_id ?? '')}`;
}

function assertAccountInStrategy(account, accountTargets) {
  const allowed = new Set((Array.isArray(accountTargets) ? accountTargets : []).map(accountTargetKey));
  if (!allowed.has(accountTargetKey(account))) {
    throw new CampaignDestinationBindingError(
      'campaign_destination_account_not_in_strategy',
      'La campaña dejó de pertenecer al objetivo de esta estrategia.',
      409
    );
  }
}

function isStrategyContractError(error) {
  return STRATEGY_CONTRACT_ERROR_CODES.has(error?.code);
}

function applyExecutionIdentity(binding, account) {
  return sha256({
    binding: {
      id: text(binding?.id, 36),
      strategy_id: positiveInteger(binding?.strategyId),
      mode: String(binding?.mode || ''),
      project_id: text(binding?.projectId, 36),
      publication_id: text(binding?.publicationId, 36),
      revision_id: text(binding?.revisionId, 36),
      artifact_id: text(binding?.artifactId, 36),
      destination_url: text(binding?.destinationUrl, 4_096),
      destination_digest: text(binding?.destinationDigest, 64),
    },
    account: {
      id: text(account?.id, 36),
      managed_campaign_id: text(account?.managedCampaignId, 36),
      provider: String(account?.provider || ''),
      customer_id: String(account?.customerId || ''),
      campaign_id: String(account?.campaignId || ''),
      family: String(account?.family || ''),
      pmax_url_expansion: String(account?.pmaxUrlExpansion || ''),
      operation_digest: text(account?.operationDigest, 64),
      apply_event_id: text(account?.applyEventId, 80),
      desired_state: account?.desiredState || null,
    },
  });
}

function assertApplyExecutionCurrent(binding, account, expectedIdentity, allowedStates = ['applying']) {
  if (
    !allowedStates.includes(String(account?.state || ''))
    || !expectedIdentity
    || applyExecutionIdentity(binding, account) !== expectedIdentity
  ) {
    throw new CampaignDestinationBindingError(
      APPLY_SUPERSEDED_CODE,
      'La landing o la operación cambió mientras se validaba el destino.',
      409
    );
  }
}

function initialAccountState(mode, family) {
  if (mode === 'connect_only') return 'blocked';
  if (family === 'meta_instant_form' || family === 'meta_reach' || family === 'unsupported') return 'blocked';
  return 'ready';
}

function initialAccountAuthorization(strategyContext, family) {
  if (strategyContext.mode === 'connect_only') return { allowed: false, reason: 'measure_mode_never_changes_destinations' };
  if (family === 'meta_instant_form') return { allowed: false, reason: 'meta_instant_forms_keep_native_destination' };
  if (family === 'meta_reach' || family === 'unsupported') return { allowed: false, reason: 'provider_family_not_supported_v1' };
  return { allowed: true, strategy_authorization: strategyContext.authorization || null, operation_authorization: null };
}

async function persistEvent({ models, eventId, bindingId, accountId = null, eventType, data, jobRequestId = null, actorUserId = null, transaction }) {
  const eventDigest = sha256({ eventType, bindingId, accountId, data });
  const existing = await models.CampaignDestinationBindingEvent.findOne({ where: { eventId }, transaction });
  if (existing) {
    const value = plain(existing);
    if (value.eventDigest !== eventDigest || value.bindingId !== bindingId || value.eventType !== eventType) {
      throw new CampaignDestinationBindingError('campaign_destination_event_conflict', 'event_id ya fue usado con otro contenido.', 409);
    }
    return { event: existing, created: false };
  }
  const event = await models.CampaignDestinationBindingEvent.create({
    id: crypto.randomUUID(), eventId, bindingId, accountId, eventType, eventDigest, data,
    jobRequestId, actorUserId: positiveInteger(actorUserId),
  }, { transaction });
  return { event, created: true };
}

async function enqueueUnique({ type, payload, dedupeScope, origin, actorUserId, transaction, dependencies = {} }) {
  const jobs = dependencies.jobRequestsService || jobRequestsService;
  return jobs.enqueueUniqueJobRequest({
    type, payload, dedupeScope, priority: 'high', status: 'pending', origin,
    requestedBy: positiveInteger(actorUserId), requestedByName: 'Clinicaclick', requestedByRole: 'system', maxAttempts: 5,
  }, transaction ? { transaction } : undefined);
}

function eventPayload(input) {
  const target = targetIdentity(input.target_kind, input.treatment_id);
  const occurredAt = new Date(input.occurred_at || Date.now());
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new CampaignDestinationBindingError('campaign_destination_occurred_at_invalid', 'occurred_at no es una fecha válida.', 422);
  }
  return {
    event_id: stableEventId(input.event_id),
    occurred_at: occurredAt.toISOString(),
    strategy_id: positiveInteger(input.strategy_id),
    ...target,
    publication_id: text(input.publication_id, 36),
    project_id: text(input.project_id, 36),
    revision_id: text(input.revision_id, 36),
    artifact_id: text(input.artifact_id, 36),
    destination_url: text(input.destination_url, 4_096),
    destination_digest: text(input.destination_digest, 64),
    requested_by_user_id: positiveInteger(input.requested_by_user_id),
  };
}

function assertEventShape(event) {
  if (!event.strategy_id || !event.publication_id || !event.project_id || !event.revision_id || !event.artifact_id || !event.destination_url || !/^[a-f0-9]{64}$/.test(event.destination_digest || '')) {
    throw new CampaignDestinationBindingError('campaign_destination_landing_event_invalid', `${LANDING_PUBLISHED_EVENT} no contiene todos los identificadores canónicos.`, 422);
  }
}

async function consumeLandingPublishedEvent(input = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const event = eventPayload(input);
  assertEventShape(event);
  return sequelize.transaction(async (transaction) => {
    const target = { targetKind: event.targetKind, treatmentId: event.treatmentId, treatmentIdentity: event.treatmentIdentity };
    const strategyContext = await loadStrategyContext(event.strategy_id, target, dependencies, transaction);
    assertStrategyPublishable(strategyContext);
    const landing = await verifyPublishedLanding({
      ...input,
      project_id: event.project_id,
      publication_id: event.publication_id,
      revision_id: event.revision_id,
      artifact_id: event.artifact_id,
      destination_url: event.destination_url,
      destination_digest: event.destination_digest,
    }, strategyContext, dependencies, transaction);
    const accountTargets = await resolveAccountTargets(strategyContext, target, dependencies, transaction);
    const strategyDigest = strategySnapshotDigest(strategyContext, target, accountTargets);
    let binding = await models.CampaignDestinationBinding.findOne({
      where: { strategyId: event.strategy_id, targetKind: target.targetKind, treatmentIdentity: target.treatmentIdentity },
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    const previousBinding = plain(binding);
    if (binding) {
      const existingAccounts = await models.CampaignDestinationBindingAccount.findAll({
        where: { bindingId: plain(binding).id },
        transaction,
        lock: transaction.LOCK?.UPDATE,
      });
      if (existingAccounts.some((row) => IN_FLIGHT_ACCOUNT_STATES.has(String(plain(row)?.state || '')))) {
        throw new CampaignDestinationBindingError(
          'campaign_destination_operation_in_flight',
          'Espera a que termine la comprobación del destino antes de republicar la landing.',
          409
        );
      }
    }
    const blocked = strategyContext.mode === 'connect_only';
    const values = {
      strategyId: event.strategy_id,
      ...target,
      mode: strategyContext.mode,
      ...strategyContext.scope,
      projectId: landing.project.id,
      publicationId: landing.publication.id,
      revisionId: landing.revision.id,
      artifactId: landing.artifact.id,
      destinationUrl: landing.destinationUrl,
      destinationDigest: landing.destinationDigest,
      landingEventId: event.event_id,
      publicationStatus: 'verified',
      destinationStatus: blocked ? 'blocked' : 'ready',
      capabilityStatus: blocked ? 'blocked' : (plain(binding)?.activeDestinationDigest ? 'active' : 'ready'),
      authorization: {
        event_contract: LANDING_PUBLISHED_EVENT,
        strategy_authorization: strategyContext.authorization,
        strategy_snapshot_digest: strategyDigest,
        destination_mutation_allowed: !blocked,
      },
      lastErrorCode: blocked ? 'measure_mode_never_changes_destinations' : null,
      lastErrorDetails: blocked ? { mode: strategyContext.mode } : null,
      version: Number(plain(binding)?.version || 0) + 1,
    };
    if (!binding) {
      binding = await models.CampaignDestinationBinding.create({ id: crypto.randomUUID(), ...values }, { transaction });
    } else {
      await binding.update(values, { transaction });
    }
    const bindingValue = plain(binding);
    await persistEvent({
      models, eventId: event.event_id, bindingId: bindingValue.id, eventType: 'landing_published',
      data: {
        contract: LANDING_PUBLISHED_EVENT,
        strategy_id: event.strategy_id,
        target_kind: target.targetKind,
        treatment_id: target.treatmentId,
        publication_id: landing.publication.id,
        project_id: landing.project.id,
        revision_id: landing.revision.id,
        artifact_id: landing.artifact.id,
        destination_url: landing.destinationUrl,
        destination_digest: landing.destinationDigest,
      },
      actorUserId: event.requested_by_user_id,
      transaction,
    });

    const accounts = [];
    for (const accountTarget of accountTargets) {
      const pmaxPolicy = accountTarget.family === 'google_pmax' ? 'pending' : 'not_applicable';
      const desiredState = {
        destination_url: landing.destinationUrl,
        destination_digest: landing.destinationDigest,
        pmax_url_expansion: pmaxPolicy,
      };
      const operationDigest = sha256({ binding_id: bindingValue.id, ...accountTarget, desiredState });
      let account = await models.CampaignDestinationBindingAccount.findOne({
        where: {
          bindingId: bindingValue.id,
          provider: accountTarget.provider,
          customerId: accountTarget.customerId,
          campaignId: accountTarget.campaignId,
        },
        transaction,
        lock: transaction.LOCK?.UPDATE,
      });
      const accountValues = {
        managedCampaignId: accountTarget.managedCampaignId,
        family: accountTarget.family,
        pmaxUrlExpansion: pmaxPolicy,
        state: initialAccountState(strategyContext.mode, accountTarget.family),
        desiredState,
        operationDigest,
        authorization: initialAccountAuthorization(strategyContext, accountTarget.family),
        observedState: null,
        lastErrorCode: initialAccountState(strategyContext.mode, accountTarget.family) === 'blocked'
          ? initialAccountAuthorization(strategyContext, accountTarget.family).reason
          : null,
        lastErrorDetails: null,
      };
      if (!account) {
        account = await models.CampaignDestinationBindingAccount.create({
          id: crypto.randomUUID(), bindingId: bindingValue.id,
          provider: accountTarget.provider, customerId: accountTarget.customerId, campaignId: accountTarget.campaignId,
          ...accountValues,
        }, { transaction });
      } else if (
        plain(account).operationDigest !== operationDigest
        || previousBinding?.mode !== strategyContext.mode
      ) {
        await account.update(accountValues, { transaction });
      }
      accounts.push(account);
    }

    const readyEventId = stableUuid(`${DESTINATION_READY_EVENT}:${bindingValue.id}:${landing.destinationDigest}`);
    const readyData = {
      contract: DESTINATION_READY_EVENT,
      binding_id: bindingValue.id,
      strategy_id: event.strategy_id,
      target_kind: target.targetKind,
      treatment_id: target.treatmentId,
      destination_url: landing.destinationUrl,
      destination_digest: landing.destinationDigest,
      account_count: accounts.length,
      mutation_allowed: !blocked,
    };
    const readyEvent = await persistEvent({
      models, eventId: readyEventId, bindingId: bindingValue.id, eventType: 'destination_ready', data: readyData,
      actorUserId: event.requested_by_user_id, transaction,
    });
    let job = null;
    if (readyEvent.created) {
      const queued = await enqueueUnique({
        type: DESTINATION_READY_EVENT,
        payload: { event_id: readyEventId, binding_id: bindingValue.id, destination_digest: landing.destinationDigest },
        dedupeScope: `campaign-destination-ready:${bindingValue.id}:${landing.destinationDigest}`,
        origin: 'marketing_web', actorUserId: event.requested_by_user_id, transaction, dependencies,
      });
      job = queued.job;
      await readyEvent.event.update({ jobRequestId: job.id }, { transaction });
    }
    await binding.update({ destinationReadyEventId: readyEventId }, { transaction });
    return {
      idempotent: !readyEvent.created,
      binding: serializeBinding(binding, accounts),
      destination_ready_event_id: readyEventId,
      job_request_id: positiveInteger(job?.id),
    };
  });
}

async function runDestinationReadyEventJob(payload = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const bindingId = text(payload.binding_id, 36);
  const eventId = stableEventId(payload.event_id);
  const event = await models.CampaignDestinationBindingEvent.findOne({ where: { eventId } });
  const binding = bindingId ? await models.CampaignDestinationBinding.findByPk(bindingId) : null;
  if (!event || !binding || plain(event).bindingId !== bindingId || plain(event).eventType !== 'destination_ready') {
    throw new CampaignDestinationBindingError('campaign_destination_ready_event_invalid', 'El evento destination_ready no pertenece al binding.', 409);
  }
  if (plain(binding).destinationDigest !== payload.destination_digest) {
    return { status: 'completed', result: { binding_id: bindingId, superseded: true } };
  }
  return {
    status: 'completed',
    result: {
      event: DESTINATION_READY_EVENT,
      binding_id: bindingId,
      destination_digest: plain(binding).destinationDigest,
      capability_status: plain(binding).capabilityStatus,
      destination_status: plain(binding).destinationStatus,
    },
  };
}

function selectedAccountKey(value) {
  return `${String(value?.provider || '')}:${String(value?.customer_id ?? value?.customerId ?? '')}:${String(value?.campaign_id ?? value?.campaignId ?? '')}`;
}

function validateOperationConfirmation(binding, input, actorUserId) {
  const eventId = stableEventId(input?.operation_id || input?.event_id);
  const digest = text(input?.destination_digest, 64);
  const scopes = new Set(Array.isArray(input?.scopes) ? input.scopes : []);
  if (
    input?.accepted !== true
    || input?.readback_required !== true
    || input?.confirm_destination_change !== true
    || digest !== binding.destinationDigest
    || !GUIDED_SCOPES.every((scope) => scopes.has(scope))
    || !positiveInteger(actorUserId)
  ) {
    throw new CampaignDestinationBindingError('campaign_destination_operation_authorization_required', 'La operación necesita autorización explícita de landing, destino y readback.', 409);
  }
  return {
    version: APPLY_AUTHORIZATION_VERSION,
    accepted: true,
    accepted_at: new Date().toISOString(),
    accepted_by_user_id: positiveInteger(actorUserId),
    scopes: GUIDED_SCOPES,
    readback_required: true,
    destination_digest: binding.destinationDigest,
    operation_id: eventId,
  };
}

function validateAutopilotOperationConfirmation(binding, input) {
  const eventId = stableEventId(input?.operation_id || input?.event_id);
  if (text(input?.destination_digest, 64) !== binding.destinationDigest) {
    throw new CampaignDestinationBindingError('campaign_destination_operation_digest_mismatch', 'La operación no corresponde al destino publicado.', 409);
  }
  return {
    version: APPLY_AUTHORIZATION_VERSION,
    automatic: true,
    accepted_at: new Date().toISOString(),
    accepted_by_user_id: null,
    scopes: ['campaign_destination'],
    readback_required: true,
    destination_digest: binding.destinationDigest,
    operation_id: eventId,
    authority: 'approved_managed_campaign_constraints',
  };
}

async function assertAutopilotConstraints(account, models, transaction) {
  if (!account.managedCampaignId || !models.ManagedCampaign) {
    throw new CampaignDestinationBindingError('campaign_destination_autopilot_constraint_missing', 'Piloto automático no tiene una campaña gestionada aprobada para este destino.', 409);
  }
  const managed = plain(await models.ManagedCampaign.findByPk(account.managedCampaignId, { transaction }));
  if (!managed || managed.operation_mode !== 'managed' || !ACTIVE_MANAGED_STATUSES.has(managed.status) || !positiveInteger(managed.approved_by_user_id)) {
    throw new CampaignDestinationBindingError('campaign_destination_autopilot_not_approved', 'La campaña gestionada todavía no está aprobada dentro de sus límites operativos.', 409);
  }
  return managed;
}

async function requestDestinationApply({ bindingId, accounts: requestedAccounts, confirmation, actorUserId }, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  return sequelize.transaction(async (transaction) => {
    const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
    if (!bindingModel) throw new CampaignDestinationBindingError('campaign_destination_binding_not_found', 'El binding no existe.', 404);
    const binding = plain(bindingModel);
    if (binding.mode === 'connect_only') {
      throw new CampaignDestinationBindingError('campaign_destination_measure_mode_forbidden', 'Mide y entiende nunca cambia destinos de campaña.', 409);
    }
    const target = {
      targetKind: binding.targetKind, treatmentId: binding.treatmentId, treatmentIdentity: binding.treatmentIdentity,
    };
    const strategyContext = await loadStrategyContext(binding.strategyId, target, dependencies, transaction);
    const currentAccountTargets = await resolveAccountTargets(strategyContext, target, dependencies, transaction);
    assertBindingStrategyCurrent(binding, strategyContext, target, currentAccountTargets);
    await verifyPublishedLanding({
      project_id: binding.projectId, publication_id: binding.publicationId, revision_id: binding.revisionId,
      artifact_id: binding.artifactId, destination_url: binding.destinationUrl, destination_digest: binding.destinationDigest,
    }, strategyContext, dependencies, transaction);
    const operationAuthorization = binding.mode === 'managed_service'
      ? validateAutopilotOperationConfirmation(binding, confirmation)
      : validateOperationConfirmation(binding, confirmation, actorUserId);
    const allAccounts = await models.CampaignDestinationBindingAccount.findAll({ where: { bindingId: binding.id }, transaction, lock: transaction.LOCK?.UPDATE });
    const requested = Array.isArray(requestedAccounts) ? requestedAccounts : [];
    if (!requested.length) throw new CampaignDestinationBindingError('campaign_destination_accounts_required', 'Selecciona al menos una cuenta/campaña.', 422);
    const requestedByKey = new Map(requested.map((item) => [selectedAccountKey(item), item]));
    const selected = allAccounts.filter((row) => requestedByKey.has(selectedAccountKey(plain(row))));
    if (selected.length !== requestedByKey.size) throw new CampaignDestinationBindingError('campaign_destination_account_not_bound', 'Alguna campaña no pertenece al binding.', 409);
    const jobs = [];
    for (const accountModel of selected) {
      const account = plain(accountModel);
      assertAccountInStrategy(account, currentAccountTargets);
      if (IN_FLIGHT_ACCOUNT_STATES.has(String(account.state || ''))) {
        throw new CampaignDestinationBindingError(
          'campaign_destination_operation_in_flight',
          'Esta campaña ya tiene una comprobación de destino en curso.',
          409
        );
      }
      if (!GOOGLE_FAMILIES.has(account.family) || account.provider !== 'google_ads') {
        const code = account.family === 'meta_instant_form'
          ? 'campaign_destination_meta_instant_form_native'
          : 'campaign_destination_provider_not_supported';
        throw new CampaignDestinationBindingError(code, account.family === 'meta_instant_form'
          ? 'Los formularios instantáneos de Meta conservan su destino nativo por defecto.'
          : 'Esta familia todavía no admite cambios de destino.', 409);
      }
      const requestedAccount = requestedByKey.get(selectedAccountKey(account));
      const pmaxPolicy = account.family === 'google_pmax'
        ? String(requestedAccount?.pmax_url_expansion || '').trim().toLowerCase()
        : 'not_applicable';
      if (account.family === 'google_pmax' && !['enabled', 'disabled'].includes(pmaxPolicy)) {
        throw new CampaignDestinationBindingError('campaign_destination_pmax_expansion_required', 'Indica explícitamente si PMax puede expandir la URL final.', 422);
      }
      if (binding.mode === 'managed_service') await assertAutopilotConstraints(account, models, transaction);
      const desiredState = { destination_url: binding.destinationUrl, destination_digest: binding.destinationDigest, pmax_url_expansion: pmaxPolicy };
      const operationDigest = sha256({ binding_id: binding.id, account: selectedAccountKey(account), desiredState, authorization: operationAuthorization });
      const applyEventId = stableUuid(`${operationAuthorization.operation_id}:${account.id}:${operationDigest}`);
      const eventData = {
        contract: DESTINATION_APPLY_JOB,
        binding_id: binding.id,
        account_id: account.id,
        operation_id: operationAuthorization.operation_id,
        operation_digest: operationDigest,
        desired_state: desiredState,
        authorization: operationAuthorization,
      };
      const persisted = await persistEvent({
        models, eventId: applyEventId, bindingId: binding.id, accountId: account.id,
        eventType: 'apply_requested', data: eventData, actorUserId, transaction,
      });
      let job = null;
      if (persisted.created) {
        const queued = await enqueueUnique({
          type: DESTINATION_APPLY_JOB,
          payload: { event_id: applyEventId, binding_id: binding.id, account_id: account.id, operation_digest: operationDigest },
          dedupeScope: `campaign-destination-apply:${account.id}:${operationDigest}`,
          origin: 'marketing:campaign_destination', actorUserId, transaction, dependencies,
        });
        job = queued.job;
        await persisted.event.update({ jobRequestId: job.id }, { transaction });
      }
      await accountModel.update({
        pmaxUrlExpansion: pmaxPolicy,
        state: 'apply_queued',
        desiredState,
        operationDigest,
        applyEventId,
        applyJobRequestId: positiveInteger(job?.id) || account.applyJobRequestId,
        authorization: { ...account.authorization, operation_authorization: operationAuthorization },
        lastErrorCode: null,
        lastErrorDetails: null,
      }, { transaction });
      jobs.push({ account_id: account.id, event_id: applyEventId, job_request_id: positiveInteger(job?.id), idempotent: !persisted.created });
    }
    await bindingModel.update({
      destinationStatus: 'apply_queued',
      capabilityStatus: binding.activeDestinationDigest ? 'active' : 'ready',
      lastErrorCode: null,
      lastErrorDetails: null,
      version: Number(binding.version || 0) + 1,
    }, { transaction });
    return { binding_id: binding.id, destination_digest: binding.destinationDigest, jobs };
  });
}

function adapterFor(account, dependencies = {}) {
  if (typeof dependencies.adapterFor === 'function') return dependencies.adapterFor(account);
  return account.provider === 'google_ads' && GOOGLE_FAMILIES.has(account.family) ? googleAdapter : null;
}

async function recomputeBindingState(bindingId, dependencies = {}, transaction = null) {
  const models = dependencies.models || db;
  const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction?.LOCK?.UPDATE });
  const accounts = await models.CampaignDestinationBindingAccount.findAll({ where: { bindingId }, transaction });
  const eligible = accounts.map(plain).filter((item) => item.provider === 'google_ads' && GOOGLE_FAMILIES.has(item.family));
  const allActive = eligible.length > 0 && eligible.every((item) => item.state === 'active');
  const anyDrift = eligible.some((item) => ['drifted', 'failed'].includes(item.state));
  const binding = plain(bindingModel);
  const patch = allActive
    ? {
        destinationStatus: 'active', capabilityStatus: 'active',
        activeDestinationUrl: binding.destinationUrl, activeDestinationDigest: binding.destinationDigest,
        activeAt: new Date(), lastErrorCode: null, lastErrorDetails: null,
      }
    : anyDrift
      ? { destinationStatus: 'drifted', capabilityStatus: binding.activeDestinationDigest ? 'active' : 'ready' }
      : { destinationStatus: binding.destinationStatus, capabilityStatus: binding.activeDestinationDigest ? 'active' : 'ready' };
  await bindingModel.update({ ...patch, version: Number(binding.version || 0) + 1 }, { transaction });
  return { binding: bindingModel, accounts };
}

async function enqueueRollbackForAccount({ bindingModel, accountModel, reason, actorUserId = null, dependencies = {}, transaction }) {
  const models = dependencies.models || db;
  const binding = plain(bindingModel);
  const account = plain(accountModel);
  if (!account.beforeState) return null;
  const rollbackDigest = sha256({ account_id: account.id, before_state: account.beforeState, reason });
  const rollbackEventId = stableUuid(`${DESTINATION_ROLLBACK_JOB}:${account.id}:${rollbackDigest}`);
  const persisted = await persistEvent({
    models, eventId: rollbackEventId, bindingId: binding.id, accountId: account.id,
    eventType: 'rollback_requested', data: { reason, rollback_digest: rollbackDigest }, actorUserId, transaction,
  });
  let job = null;
  if (persisted.created) {
    const queued = await enqueueUnique({
      type: DESTINATION_ROLLBACK_JOB,
      payload: { event_id: rollbackEventId, binding_id: binding.id, account_id: account.id, rollback_digest: rollbackDigest },
      dedupeScope: `campaign-destination-rollback:${account.id}:${rollbackDigest}`,
      origin: 'marketing:campaign_destination_safety', actorUserId, transaction, dependencies,
    });
    job = queued.job;
    await persisted.event.update({ jobRequestId: job.id }, { transaction });
  }
  await accountModel.update({ state: 'rollback_queued', rollbackEventId, rollbackJobRequestId: positiveInteger(job?.id) || account.rollbackJobRequestId }, { transaction });
  await bindingModel.update({ destinationStatus: 'rollback_queued' }, { transaction });
  return { event_id: rollbackEventId, job_request_id: positiveInteger(job?.id), idempotent: !persisted.created };
}

async function revalidateApplyStrategyContract(bindingId, accountId, expectedIdentity, dependencies = {}, allowedStates = ['applying']) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  return sequelize.transaction(async (transaction) => {
    const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction });
    const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction });
    if (!bindingModel || !accountModel || plain(accountModel).bindingId !== bindingId) {
      throw new CampaignDestinationBindingError('campaign_destination_apply_event_invalid', 'El binding cambió antes de aplicar el destino.', 409);
    }
    const binding = plain(bindingModel);
    const account = plain(accountModel);
    if (binding.mode === 'connect_only') {
      throw new CampaignDestinationBindingError('campaign_destination_measure_mode_forbidden', 'Mide y entiende nunca cambia destinos.', 409);
    }
    const target = {
      targetKind: binding.targetKind,
      treatmentId: binding.treatmentId,
      treatmentIdentity: binding.treatmentIdentity,
    };
    const strategyContext = await loadStrategyContext(binding.strategyId, target, dependencies, transaction);
    const currentAccountTargets = await resolveAccountTargets(strategyContext, target, dependencies, transaction);
    assertBindingStrategyCurrent(binding, strategyContext, target, currentAccountTargets);
    assertAccountInStrategy(account, currentAccountTargets);
    if (binding.mode === 'managed_service') await assertAutopilotConstraints(account, models, transaction);
    assertApplyExecutionCurrent(binding, account, expectedIdentity, allowedStates);
    return { binding, account };
  });
}

async function runDestinationApplyJob(payload = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const accountId = text(payload.account_id, 36);
  const bindingId = text(payload.binding_id, 36);
  const eventId = stableEventId(payload.event_id);
  let prepared;
  try {
    prepared = await sequelize.transaction(async (transaction) => {
      const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      const event = await models.CampaignDestinationBindingEvent.findOne({ where: { eventId }, transaction });
      if (!bindingModel || !accountModel || !event || plain(accountModel).bindingId !== bindingId || plain(event).accountId !== accountId) {
        throw new CampaignDestinationBindingError('campaign_destination_apply_event_invalid', 'El job no pertenece al binding/account.', 409);
      }
      const binding = plain(bindingModel);
      const account = plain(accountModel);
      if (account.operationDigest !== payload.operation_digest || account.applyEventId !== eventId) {
        return { superseded: true, binding, account };
      }
      if (account.state === 'active' && account.readbackEventId) return { alreadyActive: true, binding, account };
      if (binding.mode === 'connect_only') throw new CampaignDestinationBindingError('campaign_destination_measure_mode_forbidden', 'Mide y entiende nunca cambia destinos.', 409);
      const operationAuth = account.authorization?.operation_authorization;
      if (binding.mode === 'managed_service') {
        if (
          operationAuth?.automatic !== true
          || operationAuth?.authority !== 'approved_managed_campaign_constraints'
          || operationAuth?.readback_required !== true
          || operationAuth?.destination_digest !== binding.destinationDigest
        ) {
          throw new CampaignDestinationBindingError('campaign_destination_autopilot_authorization_invalid', 'La operación automática no conserva sus límites aprobados.', 409);
        }
      } else {
        validateOperationConfirmation(binding, {
          ...operationAuth,
          operation_id: operationAuth?.operation_id,
          confirm_destination_change: true,
          accepted: true,
          scopes: operationAuth?.scopes,
        }, operationAuth?.accepted_by_user_id);
      }
      const target = {
        targetKind: binding.targetKind, treatmentId: binding.treatmentId, treatmentIdentity: binding.treatmentIdentity,
      };
      const strategyContext = await loadStrategyContext(binding.strategyId, target, dependencies, transaction);
      const currentAccountTargets = await resolveAccountTargets(strategyContext, target, dependencies, transaction);
      assertBindingStrategyCurrent(binding, strategyContext, target, currentAccountTargets);
      assertAccountInStrategy(account, currentAccountTargets);
      await verifyPublishedLanding({
        project_id: binding.projectId, publication_id: binding.publicationId, revision_id: binding.revisionId,
        artifact_id: binding.artifactId, destination_url: binding.destinationUrl, destination_digest: binding.destinationDigest,
      }, strategyContext, dependencies, transaction);
      if (binding.mode === 'managed_service') await assertAutopilotConstraints(account, models, transaction);
      await accountModel.update({ state: 'applying', lastErrorCode: null, lastErrorDetails: null }, { transaction });
      await bindingModel.update({ destinationStatus: 'applying' }, { transaction });
      await persistEvent({
        models, eventId: stableUuid(`apply-started:${eventId}`), bindingId, accountId, eventType: 'apply_started',
        data: { apply_event_id: eventId, operation_digest: account.operationDigest }, transaction,
      });
      return {
        bindingModel,
        accountModel,
        binding,
        account,
        executionIdentity: applyExecutionIdentity(binding, { ...account, state: 'applying' }),
      };
    });
  } catch (error) {
    if (!isStrategyContractError(error)) throw error;
    await sequelize.transaction(async (transaction) => {
      const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      if (!bindingModel || !accountModel) return;
      const safe = {
        code: error.code,
        message: String(error.message || 'La estrategia cambió antes de aplicar.').slice(0, 1_000),
        details: error.details || null,
      };
      await accountModel.update({ state: 'blocked', lastErrorCode: safe.code, lastErrorDetails: safe }, { transaction });
      await bindingModel.update({
        destinationStatus: 'blocked',
        capabilityStatus: plain(bindingModel).activeDestinationDigest ? 'active' : 'blocked',
        lastErrorCode: safe.code,
        lastErrorDetails: safe,
      }, { transaction });
      await persistEvent({
        models,
        eventId: stableUuid(`strategy-blocked:${eventId}:${safe.code}`),
        bindingId,
        accountId,
        eventType: 'readback_failed',
        data: { ...safe, phase: 'strategy_revalidation', provider_mutation: false },
        transaction,
      });
    });
    return {
      status: 'completed',
      result: {
        binding_id: bindingId,
        account_id: accountId,
        blocked: true,
        provider_mutation: false,
        error_code: error.code,
      },
    };
  }
  if (prepared.superseded || prepared.alreadyActive) {
    return { status: 'completed', result: { binding_id: bindingId, account_id: accountId, superseded: !!prepared.superseded, idempotent: !!prepared.alreadyActive } };
  }
  const adapter = adapterFor(prepared.account, dependencies);
  if (!adapter) throw new CampaignDestinationBindingError('campaign_destination_adapter_unavailable', 'No existe adaptador seguro para esta familia.', 409);
  let beforeState = prepared.account.beforeState;
  let mutationStarted = false;
  try {
    await revalidateApplyStrategyContract(bindingId, accountId, prepared.executionIdentity, dependencies);
    const inspected = await adapter.inspect({ account: prepared.account, binding: prepared.binding }, dependencies.adapterDependencies || {});
    if (!beforeState) {
      beforeState = inspected;
      await prepared.accountModel.update({ beforeState });
    } else if (sha256(beforeState) !== sha256(inspected)) {
      throw new CampaignDestinationBindingError('campaign_destination_provider_drift_before_apply', 'El destino cambió después de preparar la operación.', 409);
    }
    await adapter.mutate({
      account: { ...prepared.account, pmaxUrlExpansion: prepared.account.pmaxUrlExpansion },
      binding: prepared.binding,
      beforeState,
      destinationUrl: prepared.binding.destinationUrl,
      validateOnly: true,
    }, dependencies.adapterDependencies || {});
    const reread = await adapter.inspect({ account: prepared.account, binding: prepared.binding }, dependencies.adapterDependencies || {});
    if (sha256(beforeState) !== sha256(reread)) {
      throw new CampaignDestinationBindingError('campaign_destination_provider_drift_after_validation', 'El destino cambió durante la validación; no se aplicó.', 409);
    }
    await revalidateApplyStrategyContract(bindingId, accountId, prepared.executionIdentity, dependencies);
    mutationStarted = true;
    await adapter.mutate({
      account: { ...prepared.account, pmaxUrlExpansion: prepared.account.pmaxUrlExpansion },
      binding: prepared.binding,
      beforeState,
      destinationUrl: prepared.binding.destinationUrl,
      validateOnly: false,
    }, dependencies.adapterDependencies || {});
    await revalidateApplyStrategyContract(bindingId, accountId, prepared.executionIdentity, dependencies);
    await prepared.accountModel.update({ state: 'readback_pending', appliedAt: new Date() });
    await prepared.bindingModel.update({ destinationStatus: 'readback_pending' });
    const observed = await adapter.inspect({ account: prepared.account, binding: prepared.binding }, dependencies.adapterDependencies || {});
    const verification = adapter.verifyState({
      state: observed,
      account: { ...prepared.account, pmaxUrlExpansion: prepared.account.pmaxUrlExpansion },
      destinationUrl: prepared.binding.destinationUrl,
    });
    if (!verification.verified) {
      throw new CampaignDestinationBindingError('campaign_destination_readback_failed', 'Google no devolvió exactamente el destino solicitado.', 409, verification);
    }
    await revalidateApplyStrategyContract(
      bindingId,
      accountId,
      prepared.executionIdentity,
      dependencies,
      ['readback_pending']
    );
    await sequelize.transaction(async (transaction) => {
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      await accountModel.update({
        state: 'active', observedState: verification.observed,
        readbackEventId: stableUuid(`readback:${eventId}:${prepared.account.operationDigest}`),
        readbackAt: new Date(), lastErrorCode: null, lastErrorDetails: null,
      }, { transaction });
      await persistEvent({
        models, eventId: plain(accountModel).readbackEventId, bindingId, accountId,
        eventType: 'readback_verified',
        data: { apply_event_id: eventId, operation_digest: prepared.account.operationDigest, destination_digest: prepared.binding.destinationDigest },
        transaction,
      });
      await recomputeBindingState(bindingId, dependencies, transaction);
    });
    return { status: 'completed', result: { binding_id: bindingId, account_id: accountId, readback_verified: true } };
  } catch (error) {
    const superseded = !mutationStarted && error?.code === APPLY_SUPERSEDED_CODE;
    if (superseded) {
      return {
        status: 'completed',
        result: {
          binding_id: bindingId,
          account_id: accountId,
          superseded: true,
          provider_mutation: false,
          error_code: error.code,
        },
      };
    }
    const strategyBlocked = !mutationStarted && isStrategyContractError(error);
    await sequelize.transaction(async (transaction) => {
      const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      const safe = { code: error.code || 'campaign_destination_apply_failed', message: String(error.message || 'Error').slice(0, 1_000), details: error.details || null };
      await accountModel.update({ state: mutationStarted ? 'drifted' : (strategyBlocked ? 'blocked' : 'failed'), lastErrorCode: safe.code, lastErrorDetails: safe }, { transaction });
      await bindingModel.update({
        destinationStatus: mutationStarted ? 'drifted' : (strategyBlocked ? 'blocked' : 'failed'),
        capabilityStatus: strategyBlocked
          ? (plain(bindingModel).activeDestinationDigest ? 'active' : 'blocked')
          : plain(bindingModel).capabilityStatus,
        lastErrorCode: safe.code,
        lastErrorDetails: safe,
      }, { transaction });
      await persistEvent({
        models, eventId: stableUuid(`readback-failed:${eventId}:${prepared.account.operationDigest}`), bindingId, accountId,
        eventType: 'readback_failed', data: safe, transaction,
      });
      if (mutationStarted && (plain(accountModel).beforeState || beforeState)) {
        if (!plain(accountModel).beforeState && beforeState) await accountModel.update({ beforeState }, { transaction });
        await enqueueRollbackForAccount({ bindingModel, accountModel, reason: safe.code, dependencies, transaction });
      }
    });
    if (strategyBlocked) {
      return {
        status: 'completed',
        result: {
          binding_id: bindingId,
          account_id: accountId,
          blocked: true,
          provider_mutation: false,
          error_code: error.code,
        },
      };
    }
    if (mutationStarted) {
      return {
        status: 'completed',
        result: {
          binding_id: bindingId,
          account_id: accountId,
          readback_verified: false,
          rollback_queued: true,
          error_code: error.code || 'campaign_destination_apply_failed',
        },
      };
    }
    throw error;
  }
}

async function requestDestinationRollback({ bindingId, accountIds, reason = 'manual', actorUserId }, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const ids = Array.from(new Set((Array.isArray(accountIds) ? accountIds : []).map((item) => text(item, 36)).filter(Boolean)));
  if (!ids.length) throw new CampaignDestinationBindingError('campaign_destination_rollback_accounts_required', 'Selecciona al menos una operación para revertir.', 422);
  return sequelize.transaction(async (transaction) => {
    const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
    if (!bindingModel) throw new CampaignDestinationBindingError('campaign_destination_binding_not_found', 'El binding no existe.', 404);
    const accounts = await models.CampaignDestinationBindingAccount.findAll({ where: { bindingId, id: { [Op.in]: ids } }, transaction, lock: transaction.LOCK?.UPDATE });
    if (accounts.length !== ids.length) throw new CampaignDestinationBindingError('campaign_destination_account_not_bound', 'Alguna operación no pertenece al binding.', 409);
    const jobs = [];
    for (const accountModel of accounts) {
      if (!plain(accountModel).beforeState) throw new CampaignDestinationBindingError('campaign_destination_rollback_snapshot_missing', 'No existe snapshot previo para revertir.', 409);
      jobs.push(await enqueueRollbackForAccount({ bindingModel, accountModel, reason, actorUserId, dependencies, transaction }));
    }
    return { binding_id: bindingId, jobs };
  });
}

async function runDestinationRollbackJob(payload = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const bindingId = text(payload.binding_id, 36);
  const accountId = text(payload.account_id, 36);
  const eventId = stableEventId(payload.event_id);
  const prepared = await sequelize.transaction(async (transaction) => {
    const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
    const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
    const event = await models.CampaignDestinationBindingEvent.findOne({ where: { eventId }, transaction });
    if (!bindingModel || !accountModel || !event || plain(accountModel).rollbackEventId !== eventId || !plain(accountModel).beforeState) {
      throw new CampaignDestinationBindingError('campaign_destination_rollback_event_invalid', 'El rollback no pertenece a una operación reversible.', 409);
    }
    if (plain(accountModel).state === 'rolled_back') return { idempotent: true };
    await accountModel.update({ state: 'rolling_back' }, { transaction });
    await bindingModel.update({ destinationStatus: 'rolling_back' }, { transaction });
    await persistEvent({
      models, eventId: stableUuid(`rollback-started:${eventId}`), bindingId, accountId,
      eventType: 'rollback_started', data: { rollback_event_id: eventId }, transaction,
    });
    return { bindingModel, accountModel, binding: plain(bindingModel), account: plain(accountModel) };
  });
  if (prepared.idempotent) return { status: 'completed', result: { binding_id: bindingId, account_id: accountId, idempotent: true } };
  const adapter = adapterFor(prepared.account, dependencies);
  if (!adapter) throw new CampaignDestinationBindingError('campaign_destination_adapter_unavailable', 'No existe adaptador de rollback para esta familia.', 409);
  try {
    await adapter.rollback({ account: prepared.account, binding: prepared.binding, beforeState: prepared.account.beforeState, validateOnly: true }, dependencies.adapterDependencies || {});
    await adapter.rollback({ account: prepared.account, binding: prepared.binding, beforeState: prepared.account.beforeState, validateOnly: false }, dependencies.adapterDependencies || {});
    const observed = await adapter.inspect({ account: prepared.account, binding: prepared.binding }, dependencies.adapterDependencies || {});
    const verification = adapter.verifyRollback({ state: observed, beforeState: prepared.account.beforeState });
    if (!verification.verified) throw new CampaignDestinationBindingError('campaign_destination_rollback_readback_failed', 'El proveedor no confirmó el estado anterior.', 409, verification);
    await sequelize.transaction(async (transaction) => {
      const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      await accountModel.update({ state: 'rolled_back', observedState: observed, rolledBackAt: new Date(), lastErrorCode: null, lastErrorDetails: null }, { transaction });
      await persistEvent({
        models, eventId: stableUuid(`rollback-verified:${eventId}`), bindingId, accountId,
        eventType: 'rollback_verified', data: { rollback_event_id: eventId }, transaction,
      });
      const remaining = await models.CampaignDestinationBindingAccount.findAll({ where: { bindingId }, transaction });
      const eligible = remaining.map(plain).filter((item) => item.provider === 'google_ads' && GOOGLE_FAMILIES.has(item.family));
      const allRolledBack = eligible.length > 0 && eligible.every((item) => item.state === 'rolled_back');
      const binding = plain(bindingModel);
      await bindingModel.update({
        destinationStatus: allRolledBack ? 'rolled_back' : binding.destinationStatus,
        capabilityStatus: binding.activeDestinationDigest ? 'active' : 'ready',
        lastErrorCode: null,
        lastErrorDetails: null,
        version: Number(binding.version || 0) + 1,
      }, { transaction });
    });
    return { status: 'completed', result: { binding_id: bindingId, account_id: accountId, rollback_verified: true } };
  } catch (error) {
    await sequelize.transaction(async (transaction) => {
      const bindingModel = await models.CampaignDestinationBinding.findByPk(bindingId, { transaction, lock: transaction.LOCK?.UPDATE });
      const accountModel = await models.CampaignDestinationBindingAccount.findByPk(accountId, { transaction, lock: transaction.LOCK?.UPDATE });
      const safe = { code: error.code || 'campaign_destination_rollback_failed', message: String(error.message || 'Error').slice(0, 1_000), details: error.details || null };
      await accountModel.update({ state: 'failed', lastErrorCode: safe.code, lastErrorDetails: safe }, { transaction });
      await bindingModel.update({ destinationStatus: 'failed', lastErrorCode: safe.code, lastErrorDetails: safe }, { transaction });
      await persistEvent({
        models, eventId: stableUuid(`rollback-failed:${eventId}`), bindingId, accountId,
        eventType: 'rollback_failed', data: safe, transaction,
      });
    });
    throw error;
  }
}

function serializeBinding(bindingModel, accountModels = []) {
  const binding = plain(bindingModel);
  return {
    id: binding.id,
    strategy_id: binding.strategyId,
    target_kind: binding.targetKind,
    treatment_id: binding.treatmentId,
    mode: binding.mode,
    scope_type: binding.scopeType,
    clinica_id: binding.clinicaId,
    grupo_clinica_id: binding.grupoClinicaId,
    project_id: binding.projectId,
    publication_id: binding.publicationId,
    revision_id: binding.revisionId,
    artifact_id: binding.artifactId,
    destination_url: binding.destinationUrl,
    destination_digest: binding.destinationDigest,
    active_destination_url: binding.activeDestinationUrl,
    active_destination_digest: binding.activeDestinationDigest,
    publication_status: binding.publicationStatus,
    destination_status: binding.destinationStatus,
    capability_status: binding.capabilityStatus,
    last_error_code: binding.lastErrorCode,
    active_at: binding.activeAt,
    accounts: (Array.isArray(accountModels) ? accountModels : []).map((row) => {
      const account = plain(row);
      return {
        id: account.id,
        provider: account.provider,
        customer_id: account.customerId,
        campaign_id: account.campaignId,
        family: account.family,
        pmax_url_expansion: account.pmaxUrlExpansion,
        state: account.state,
        desired_state: account.desiredState,
        observed_state: account.observedState,
        operation_digest: account.operationDigest,
        last_error_code: account.lastErrorCode,
      };
    }),
  };
}

async function getBinding(bindingId, dependencies = {}) {
  const models = dependencies.models || db;
  const binding = await models.CampaignDestinationBinding.findByPk(bindingId);
  if (!binding) throw new CampaignDestinationBindingError('campaign_destination_binding_not_found', 'El binding no existe.', 404);
  const accounts = await models.CampaignDestinationBindingAccount.findAll({ where: { bindingId }, order: [['provider', 'ASC'], ['customerId', 'ASC'], ['campaignId', 'ASC']] });
  return serializeBinding(binding, accounts);
}

async function auditActiveDestinations(options = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const limit = Math.min(Math.max(positiveInteger(options.limit) || 250, 1), 1000);
  const accounts = await models.CampaignDestinationBindingAccount.findAll({
    where: { provider: 'google_ads', family: { [Op.in]: [...GOOGLE_FAMILIES] }, state: 'active' },
    order: [['readbackAt', 'ASC'], ['id', 'ASC']],
    limit,
  });
  const report = { checked: 0, healthy: 0, drifted: 0, failed: 0, skipped: 0, limit };
  for (const accountModel of accounts) {
    const account = plain(accountModel);
    const bindingModel = await models.CampaignDestinationBinding.findByPk(account.bindingId);
    const binding = plain(bindingModel);
    if (!bindingModel || binding.publicationStatus !== 'verified' || binding.destinationStatus !== 'active') {
      report.skipped += 1;
      continue;
    }
    const adapter = adapterFor(account, dependencies);
    if (!adapter) { report.skipped += 1; continue; }
    report.checked += 1;
    try {
      const observed = await adapter.inspect({ account, binding }, dependencies.adapterDependencies || {});
      const verification = adapter.verifyState({
        state: observed,
        account,
        destinationUrl: binding.destinationUrl,
      });
      if (verification.verified) {
        await accountModel.update({
          observedState: verification.observed,
          readbackAt: new Date(),
          lastErrorCode: null,
          lastErrorDetails: null,
        });
        report.healthy += 1;
        continue;
      }
      const safe = {
        code: 'campaign_destination_periodic_drift_detected',
        message: 'El destino observado ya no coincide con la landing aprobada.',
        details: verification,
      };
      await sequelize.transaction(async (transaction) => {
        const lockedBinding = await models.CampaignDestinationBinding.findByPk(binding.id, { transaction, lock: transaction.LOCK?.UPDATE });
        const lockedAccount = await models.CampaignDestinationBindingAccount.findByPk(account.id, { transaction, lock: transaction.LOCK?.UPDATE });
        if (!lockedBinding || !lockedAccount || plain(lockedAccount).state !== 'active') return;
        await lockedAccount.update({
          state: 'drifted',
          observedState: verification.observed || observed,
          readbackAt: new Date(),
          lastErrorCode: safe.code,
          lastErrorDetails: safe,
        }, { transaction });
        await lockedBinding.update({
          destinationStatus: 'drifted',
          lastErrorCode: safe.code,
          lastErrorDetails: safe,
          version: Number(plain(lockedBinding).version || 0) + 1,
        }, { transaction });
        await persistEvent({
          models,
          eventId: stableUuid(`periodic-drift:${account.id}:${sha256(verification.observed || observed)}`),
          bindingId: binding.id,
          accountId: account.id,
          eventType: 'drift_detected',
          data: safe,
          transaction,
        });
      });
      report.drifted += 1;
    } catch (error) {
      report.failed += 1;
      const safe = {
        code: error.code || 'campaign_destination_drift_audit_failed',
        message: String(error.message || 'No se pudo releer el destino.').slice(0, 1000),
      };
      await accountModel.update({ lastErrorCode: safe.code, lastErrorDetails: safe });
    }
  }
  return {
    status: report.failed > 0 && report.checked === report.failed ? 'failed' : 'completed',
    processed: report.checked,
    report,
    provider_mutation: null,
  };
}

module.exports = {
  APPLY_AUTHORIZATION_VERSION,
  CampaignDestinationBindingError,
  DESTINATION_APPLY_JOB,
  DESTINATION_READY_EVENT,
  DESTINATION_ROLLBACK_JOB,
  DESTINATION_DRIFT_AUDIT_JOB,
  LANDING_PUBLISHED_EVENT,
  consumeLandingPublishedEvent,
  auditActiveDestinations,
  getBinding,
  requestDestinationApply,
  requestDestinationRollback,
  runDestinationApplyJob,
  runDestinationReadyEventJob,
  runDestinationRollbackJob,
  serializeBinding,
  sha256,
  stableUuid,
  _eventPayload: eventPayload,
  _artifactPublicationUrl: artifactPublicationUrl,
  _publicationUrl: publicationUrl,
  _targetIdentity: targetIdentity,
  _verifyPublishedLanding: verifyPublishedLanding,
};
