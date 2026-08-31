'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  applyRecoveryPolicy,
  deriveAssetSignal,
  deriveHealthCandidate,
  effectiveStoredHealth,
  extractProviderErrorCode,
  isBlockingState,
} = require('../lib/whatsapp-account-health');

const {
  ClinicMetaAsset,
  Clinica,
  GrupoClinica,
  WhatsappAccountHealthEvent,
} = db;

const STALE_MINUTES = Math.max(5, Number(process.env.WHATSAPP_HEALTH_STALE_MINUTES || 90) || 90);
const RECOVERY_OBSERVATIONS_REQUIRED = 2;

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseDate(value, fallback = new Date()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : fallback;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function summarizeAssetHealth(asset, options = {}) {
  if (!asset) {
    return {
      state: 'unknown',
      base_state: 'unknown',
      can_send: null,
      severity: 'warning',
      reason_code: 'asset_missing',
      provider_status: null,
      provider_error_code: null,
      source: 'local',
      observed_at: null,
      last_transition_at: null,
      last_healthy_at: null,
      last_blocked_at: null,
      last_blocked_send_at: null,
      blocked_send_count: 0,
      recovery_connected_observations: 0,
      is_stale: true,
    };
  }
  const plain = asset.get ? asset.get({ plain: true }) : asset;
  return effectiveStoredHealth(plain, {
    staleMinutes: options.staleMinutes || STALE_MINUTES,
    now: options.now || new Date(),
  });
}

function healthEventDetails(input = {}) {
  return {
    message_id: Number(input.messageId || 0) || null,
    job_id: clean(input.jobId) || null,
    provider_event: clean(input.providerEvent).toUpperCase() || null,
    quality_rating: clean(input.qualityRating).toUpperCase() || null,
    recovery_observation: Number(input.recoveryObservation || 0) || null,
    recovery_required: Number(input.recoveryRequired || 0) || null,
  };
}

async function createEvent({ asset, eventType, source, previousState, health, observedAt, details, dedupeIdentity }, transaction) {
  if (!WhatsappAccountHealthEvent) return { row: null, created: false };
  const dedupeKey = sha256([
    'whatsapp-health',
    asset.id,
    eventType,
    source,
    previousState || '-',
    health.state,
    health.reason_code || '-',
    dedupeIdentity || observedAt.toISOString(),
  ].join('|'));
  const [row, created] = await WhatsappAccountHealthEvent.findOrCreate({
    where: { dedupe_key: dedupeKey },
    defaults: {
      dedupe_key: dedupeKey,
      asset_id: asset.id,
      clinic_id: asset.clinicaId || null,
      group_id: asset.grupoClinicaId || null,
      waba_id: asset.wabaId || null,
      phone_number_id: asset.phoneNumberId || null,
      phone_number: asset.metaAssetName || null,
      event_type: eventType,
      source,
      previous_state: previousState || null,
      state: health.state,
      severity: health.severity || 'info',
      can_send: health.can_send,
      reason_code: health.reason_code || null,
      provider_status: health.provider_status || null,
      provider_error_code: health.provider_error_code ? String(health.provider_error_code) : null,
      details: details || null,
      observed_at: observedAt,
    },
    transaction,
  });
  return { row, created };
}

async function queueTransitionNotification({ asset, previousState, health }) {
  const wasBlocked = isBlockingState(previousState);
  const isBlocked = isBlockingState(health.state);
  if (!isBlocked && !wasBlocked) return null;
  if (isBlocked && wasBlocked) return null;

  const [clinic, group] = await Promise.all([
    asset.clinicaId
      ? Clinica.findByPk(asset.clinicaId, { attributes: ['nombre_clinica'], raw: true })
      : null,
    asset.grupoClinicaId
      ? GrupoClinica.findByPk(asset.grupoClinicaId, { attributes: ['nombre_grupo'], raw: true })
      : null,
  ]);
  const scopeName = group?.nombre_grupo || clinic?.nombre_clinica || asset.waVerifiedName || 'una cuenta';
  const blocked = isBlockingState(health.state);
  const systemNotifications = require('./systemNotifications.service');
  return systemNotifications.queueNotification({
    eventKey: blocked ? 'whatsapp.account_health_blocked' : 'whatsapp.account_health_recovered',
    payload: blocked
      ? {
          severity: 'critical',
          title: `WhatsApp bloqueado en ${scopeName}`,
          detail: 'Clinicaclick ha detenido los nuevos envíos antes de contactar con Meta.',
          action: 'Revisar el estado y el historial en Monitorización > WhatsApp.',
        }
      : {
          severity: 'info',
          title: `WhatsApp restablecido en ${scopeName}`,
          detail: 'Meta vuelve a informar de un estado operativo confirmado para el número.',
          action: 'Comprobar el historial antes de reactivar manualmente campañas pausadas.',
        },
    force: true,
    metadata: {
      source: 'whatsapp_account_health',
      asset_id: Number(asset.id),
      clinic_id: Number(asset.clinicaId || 0) || null,
      group_id: Number(asset.grupoClinicaId || 0) || null,
      health_state: health.state,
      reason_code: health.reason_code || null,
    },
  });
}

async function recordObservationForAsset({
  assetId,
  signal = {},
  source = 'local_observation',
  observedAt = new Date(),
  explicitRecovery = false,
  previousHealth = null,
  dedupeIdentity = null,
  details = {},
} = {}) {
  const parsedAssetId = Number(assetId || 0);
  if (!Number.isInteger(parsedAssetId) || parsedAssetId <= 0) return null;
  const at = parseDate(observedAt);
  let notification = null;

  const result = await db.sequelize.transaction(async (transaction) => {
    const asset = await ClinicMetaAsset.findByPk(parsedAssetId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!asset || asset.assetType !== 'whatsapp_phone_number') return null;

    const additionalData = { ...safeObject(asset.additionalData) };
    const stored = safeObject(additionalData.whatsappHealth);
    const hadProjection = Boolean(Object.keys(stored).length);
    const fallback = previousHealth || summarizeAssetHealth(asset, { now: at });
    const previousState = clean(stored.state || fallback.base_state || fallback.state).toLowerCase() || 'unknown';
    const previousReason = clean(stored.reason_code || fallback.reason_code) || null;
    const candidate = deriveHealthCandidate(deriveAssetSignal(asset, signal));
    const previousRecoveryCount = Number(stored.recovery_connected_observations || 0);
    const recovery = applyRecoveryPolicy({
      previousState,
      previousRecoveryCount,
      candidate,
      explicitRecovery,
      observationsRequired: RECOVERY_OBSERVATIONS_REQUIRED,
      previousReason: stored.blocking_reason_code || previousReason,
    });
    const recoveryCount = recovery.recovery_count;
    const recoveryPending = recovery.recovery_pending;
    const next = recovery.health;
    const transitioned = previousState !== next.state;
    const materialSignalChanged = previousReason !== next.reason_code
      && (isBlockingState(previousState) || isBlockingState(next.state));
    const eventType = recoveryPending
      ? 'recovery_observed'
      : transitioned
        ? 'state_transition'
        : !hadProjection
          ? 'state_observed'
          : materialSignalChanged
            ? 'state_signal'
            : null;
    const nowIso = at.toISOString();
    const projection = {
      ...stored,
      ...next,
      source: clean(source) || 'local_observation',
      observed_at: nowIso,
      last_transition_at: transitioned ? nowIso : (stored.last_transition_at || null),
      last_healthy_at: !isBlockingState(next.state) && next.can_send === true
        ? nowIso
        : (stored.last_healthy_at || null),
      last_blocked_at: isBlockingState(next.state)
        ? (transitioned || !stored.last_blocked_at ? nowIso : stored.last_blocked_at)
        : (stored.last_blocked_at || null),
      recovery_connected_observations: recoveryPending ? recoveryCount : 0,
      blocked_send_count: Number(stored.blocked_send_count || 0),
      last_blocked_send_at: stored.last_blocked_send_at || null,
    };
    additionalData.whatsappHealth = projection;
    asset.additionalData = additionalData;
    asset.changed('additionalData', true);
    await asset.save({ transaction });

    let eventResult = { row: null, created: false };
    if (eventType) {
      eventResult = await createEvent({
        asset,
        eventType,
        source: projection.source,
        previousState: hadProjection ? previousState : null,
        health: projection,
        observedAt: at,
        dedupeIdentity,
        details: healthEventDetails({
          ...details,
          providerEvent: signal.providerEvent,
          qualityRating: signal.qualityRating ?? asset.quality_rating,
          recoveryObservation: recoveryPending ? recoveryCount : null,
          recoveryRequired: recoveryPending ? RECOVERY_OBSERVATIONS_REQUIRED : null,
        }),
      }, transaction);
    }

    const shouldNotify = eventResult.created && (
      (!hadProjection && isBlockingState(projection.state))
      || (transitioned && isBlockingState(previousState) !== isBlockingState(projection.state))
    );
    if (shouldNotify) {
      notification = {
        asset: asset.get({ plain: true }),
        previousState: hadProjection ? previousState : 'unknown',
        health: projection,
      };
    }
    return {
      asset_id: asset.id,
      health: projection,
      event: eventResult.row?.get ? eventResult.row.get({ plain: true }) : eventResult.row,
      event_created: eventResult.created,
    };
  });

  if (notification) {
    await queueTransitionNotification(notification).catch((error) => {
      console.warn('[whatsapp health] No se pudo encolar la alerta de transición', {
        assetId: notification.asset.id,
        state: notification.health.state,
        error: error?.code || error?.message || 'notification_failed',
      });
    });
  }
  return result;
}

async function findAssetForConfig(clinicConfig = {}) {
  const assetId = Number(clinicConfig.originId || clinicConfig.assetId || 0);
  if (Number.isInteger(assetId) && assetId > 0) {
    const byId = await ClinicMetaAsset.findOne({
      where: { id: assetId, assetType: 'whatsapp_phone_number' },
    });
    if (byId) return byId;
  }
  const phoneNumberId = clean(clinicConfig.phoneNumberId || clinicConfig.phone_number_id);
  if (phoneNumberId) {
    const byPhone = await ClinicMetaAsset.findOne({
      where: { phoneNumberId, assetType: 'whatsapp_phone_number' },
      order: [['isActive', 'DESC'], ['updatedAt', 'DESC']],
    });
    if (byPhone) return byPhone;
  }
  return null;
}

function blockedError(health) {
  const error = new Error('whatsapp_sender_health_blocked');
  error.code = 'WHATSAPP_SENDER_HEALTH_BLOCKED';
  error.status = 409;
  error.retryable = false;
  error.health = {
    state: health.state,
    reason_code: health.reason_code,
    provider_status: health.provider_status,
  };
  return error;
}

async function recordBlockedSend({ asset, health, source, messageId = null, jobId = null }) {
  if (!asset || !WhatsappAccountHealthEvent) return null;
  const observedAt = new Date();
  const identity = messageId
    ? `message:${messageId}`
    : jobId
      ? `job:${jobId}`
      : `minute:${observedAt.toISOString().slice(0, 16)}`;
  return db.sequelize.transaction(async (transaction) => {
    const locked = await ClinicMetaAsset.findByPk(asset.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked) return null;
    const eventResult = await createEvent({
      asset: locked,
      eventType: 'send_blocked',
      source: clean(source) || 'send_preflight',
      previousState: health.base_state || health.state,
      health: { ...health, state: health.base_state || health.state },
      observedAt,
      dedupeIdentity: identity,
      details: healthEventDetails({ messageId, jobId }),
    }, transaction);
    if (eventResult.created) {
      const additionalData = { ...safeObject(locked.additionalData) };
      const projection = { ...safeObject(additionalData.whatsappHealth) };
      projection.blocked_send_count = Number(projection.blocked_send_count || health.blocked_send_count || 0) + 1;
      projection.last_blocked_send_at = observedAt.toISOString();
      additionalData.whatsappHealth = projection;
      locked.additionalData = additionalData;
      locked.changed('additionalData', true);
      await locked.save({ transaction });
    }
    return eventResult.row;
  });
}

async function assertCanSend({ clinicConfig = {}, source = 'send_preflight', messageId = null, jobId = null } = {}) {
  const asset = await findAssetForConfig(clinicConfig);
  const health = summarizeAssetHealth(asset || {
    additionalData: clinicConfig.additionalData || {},
    quality_rating: clinicConfig.quality_rating || null,
  });
  if (health.can_send === false || isBlockingState(health.base_state || health.state)) {
    if (asset) {
      await recordBlockedSend({ asset, health, source, messageId, jobId }).catch(() => null);
      throw blockedError(health);
    }
    throw blockedError(health);
  }
  return { allowed: true, asset_id: asset?.id || null, health };
}

async function recordProviderFailure({ clinicConfig = {}, error, source = 'provider_error', messageId = null, jobId = null } = {}) {
  const providerErrorCode = extractProviderErrorCode(error);
  if (providerErrorCode !== 131031) return { recorded: false, provider_error_code: providerErrorCode };
  const asset = await findAssetForConfig(clinicConfig);
  if (!asset) return { recorded: false, provider_error_code: providerErrorCode, reason: 'asset_not_found' };
  const result = await recordObservationForAsset({
    assetId: asset.id,
    signal: { providerErrorCode },
    source,
    dedupeIdentity: messageId ? `message:${messageId}:131031` : null,
    details: { messageId, jobId },
  });
  return { recorded: true, provider_error_code: providerErrorCode, result };
}

async function findRelevantAssets({ wabaId = null, phoneNumberId = null, clinicId = null } = {}) {
  const or = [];
  if (phoneNumberId) or.push({ phoneNumberId: clean(phoneNumberId) });
  if (wabaId) or.push({ wabaId: clean(wabaId) });
  if (!or.length && clinicId) or.push({ clinicaId: Number(clinicId) });
  if (!or.length) return [];
  return ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      [Op.or]: or,
    },
    order: [['isActive', 'DESC'], ['updatedAt', 'DESC']],
  });
}

function complianceStatusForEvent(value = {}) {
  const event = clean(value.event).toUpperCase();
  if (event === 'ACCOUNT_RESTRICTION') return 'restricted';
  if (event === 'ACCOUNT_DELETED') return 'deleted';
  if (event === 'ACCOUNT_VIOLATION') return 'warning';
  if (event !== 'DISABLED_UPDATE') return undefined;
  const banState = clean(value?.ban_info?.waba_ban_state).toUpperCase();
  if (banState === 'REINSTATE') return 'active';
  if (banState === 'SCHEDULE_FOR_DISABLE') return 'scheduled_for_disable';
  return 'suspended';
}

async function recordAccountUpdate({ entry = {}, change = {}, value = {}, clinicId = null } = {}) {
  if (clean(change.field).toLowerCase() !== 'account_update') return [];
  const providerEvent = clean(value.event).toUpperCase();
  if (!providerEvent) return [];
  const phoneNumberId = clean(value?.metadata?.phone_number_id) || null;
  const wabaId = clean(entry.id || value.waba_id) || null;
  const assets = await findRelevantAssets({ wabaId, phoneNumberId, clinicId });
  const observedAt = parseDate(entry.time || value.timestamp);
  const explicitRecovery = providerEvent === 'ACCOUNT_RECONNECTED'
    || (providerEvent === 'DISABLED_UPDATE' && complianceStatusForEvent(value) === 'active');
  return Promise.all(assets.map((asset) => recordObservationForAsset({
    assetId: asset.id,
    signal: {
      providerEvent,
      complianceStatus: complianceStatusForEvent(value),
      providerStatus: explicitRecovery ? 'CONNECTED' : undefined,
    },
    source: 'account_update_webhook',
    observedAt,
    explicitRecovery,
    dedupeIdentity: `${clean(entry.id)}:${clean(entry.time || value.timestamp)}:${providerEvent}`,
  })));
}

async function listEventsForAssets(assetIds = [], { limit = 500, perAsset = 20 } = {}) {
  const ids = [...new Set(assetIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length || !WhatsappAccountHealthEvent) return new Map();
  const rows = await WhatsappAccountHealthEvent.findAll({
    where: { asset_id: { [Op.in]: ids } },
    order: [['observed_at', 'DESC'], ['id', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 500, ids.length * perAsset), 2000),
    raw: true,
  });
  const byAsset = new Map(ids.map((id) => [id, []]));
  rows.forEach((row) => {
    const bucket = byAsset.get(Number(row.asset_id));
    if (bucket && bucket.length < perAsset) bucket.push(row);
  });
  return byAsset;
}

async function getRouteHealth({ assetId = null, phoneNumberId = null, wabaId = null, clinicId = null } = {}) {
  const asset = assetId
    ? await ClinicMetaAsset.findByPk(Number(assetId))
    : (await findRelevantAssets({ phoneNumberId, wabaId, clinicId }))[0] || null;
  return { asset, health: summarizeAssetHealth(asset) };
}

async function reconcileStoredHealth({ activeOnly = true } = {}) {
  const assets = await ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      ...(activeOnly ? { isActive: true } : {}),
    },
    order: [['id', 'ASC']],
  });
  const results = [];
  for (const asset of assets) {
    results.push(await recordObservationForAsset({
      assetId: asset.id,
      source: 'stored_state_reconciliation',
      dedupeIdentity: `stored:${asset.id}:${clean(asset.updatedAt)}`,
    }));
  }
  return { processed: results.length, results };
}

module.exports = {
  RECOVERY_OBSERVATIONS_REQUIRED,
  STALE_MINUTES,
  assertCanSend,
  findRelevantAssets,
  getRouteHealth,
  listEventsForAssets,
  recordAccountUpdate,
  recordObservationForAsset,
  recordProviderFailure,
  reconcileStoredHealth,
  summarizeAssetHealth,
  __testing: {
    blockedError,
    complianceStatusForEvent,
    healthEventDetails,
    parseDate,
  },
};
