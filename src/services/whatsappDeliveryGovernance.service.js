'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const notificationService = require('./notifications.service');
const whatsappService = require('./whatsapp.service');
const whatsappAccountHealthService = require('./whatsappAccountHealth.service');

const {
  ClinicMetaAsset,
  Clinica,
  GrupoClinica,
  JobRequest,
  MarketingPatientContactEvent,
  MarketingPatientList,
  Message,
  WhatsappDeliveryEvent,
  WhatsappDeliverySnapshot,
  WhatsappTemplate,
  Notification,
  UsuarioClinica,
} = db;

const LIVE_LIST_STATUSES = ['prepared', 'queued', 'sending', 'scheduled', 'waiting_template_approval', 'paused'];
const PROVIDER_PAUSE_STATUSES = new Set(['held_meta', 'paused_template', 'paused_quality', 'paused_limit']);
const TERMINAL_TEMPLATE_STATUSES = new Set(['PAUSED', 'DISABLED', 'REJECTED']);
const HOLD_STATUS = 'held_for_quality_assessment';
const PORTFOLIO_LIMIT_FIELDS = [
  'max_daily_conversations_per_business',
  'whatsapp_business_manager_messaging_limit',
  'max_daily_conversations',
  'messaging_limit',
];

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function safeObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || {};
  } catch (_) {
    return {};
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseProviderDate(value, fallback = new Date()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const parsed = new Date(numeric > 100000000000 ? numeric : numeric * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

function parseCapacity(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const normalized = upper(value).replace(/[.,\s]/g, '');
  if (!normalized || normalized === 'UNLIMITED') return null;
  const tierMatch = normalized.match(/(?:TIER_)?(\d+)(K|M)?/);
  if (!tierMatch) return null;
  const multiplier = tierMatch[2] === 'M' ? 1000000 : tierMatch[2] === 'K' ? 1000 : 1;
  return Number(tierMatch[1]) * multiplier;
}

function getBusinessPortfolioId(additionalData = {}) {
  const data = safeObject(additionalData);
  return clean(
    data.businessPortfolioId
    || data.business_portfolio_id
    || data.businessId
    || data.business_id
    || data.portfolio_id
  ) || null;
}

function buildRouteKey({ businessPortfolioId, wabaId, phoneNumberId, metaTemplateId, templateName, language } = {}) {
  return sha256([
    clean(businessPortfolioId) || '-',
    clean(wabaId) || '-',
    clean(phoneNumberId) || '-',
    clean(metaTemplateId || templateName) || '-',
    clean(language).toLowerCase() || '-',
  ].join('|'));
}

function buildEventDedupeKey(event = {}) {
  return sha256([
    clean(event.source),
    clean(event.eventType),
    clean(event.wabaId),
    clean(event.phoneNumberId),
    clean(event.metaTemplateId || event.templateName),
    clean(event.language),
    clean(event.listId),
    clean(event.itemId),
    clean(event.messageId),
    clean(event.status),
    clean(event.reasonCode),
    parseProviderDate(event.occurredAt).toISOString(),
  ].join('|'));
}

async function resolveRouteContext({ clinicId = null, wabaId = null, phoneNumberId = null } = {}) {
  const where = {
    isActive: true,
    assetType: 'whatsapp_phone_number',
    [Op.or]: [
      ...(phoneNumberId ? [{ phoneNumberId: String(phoneNumberId) }] : []),
      ...(wabaId ? [{ wabaId: String(wabaId) }] : []),
      ...(clinicId ? [{ clinicaId: Number(clinicId) }] : []),
    ],
  };
  if (!where[Op.or].length) delete where[Op.or];
  const assets = await ClinicMetaAsset.findAll({ where, order: [['updatedAt', 'DESC']] });
  const preferred = assets.find((asset) => phoneNumberId && clean(asset.phoneNumberId) === clean(phoneNumberId))
    || assets.find((asset) => wabaId && clean(asset.wabaId) === clean(wabaId))
    || assets[0]
    || null;
  let businessPortfolioId = getBusinessPortfolioId(preferred?.additionalData || {});
  if (!businessPortfolioId && (wabaId || preferred?.wabaId)) {
    const wabaAsset = await ClinicMetaAsset.findOne({
      where: {
        isActive: true,
        assetType: 'whatsapp_business_account',
        wabaId: clean(wabaId || preferred?.wabaId),
      },
      order: [['updatedAt', 'DESC']],
    });
    businessPortfolioId = getBusinessPortfolioId(wabaAsset?.additionalData || {});
  }
  let portfolioAssets = assets;
  if (businessPortfolioId) {
    const allAssets = await ClinicMetaAsset.findAll({
      where: { isActive: true, assetType: 'whatsapp_phone_number' },
      order: [['updatedAt', 'DESC']],
    });
    portfolioAssets = allAssets.filter((asset) => getBusinessPortfolioId(asset.additionalData || {}) === businessPortfolioId);
  }
  return {
    asset: preferred,
    businessPortfolioId,
    wabaId: clean(wabaId || preferred?.wabaId) || null,
    phoneNumberId: clean(phoneNumberId || preferred?.phoneNumberId) || null,
    portfolioPhoneNumberIds: [...new Set(portfolioAssets.map((asset) => clean(asset.phoneNumberId)).filter(Boolean))],
    accountQuality: upper(preferred?.quality_rating) || null,
  };
}

async function recordEvent(input = {}) {
  if (!WhatsappDeliveryEvent) return null;
  const occurredAt = parseProviderDate(input.occurredAt, new Date());
  const payload = {
    dedupe_key: input.dedupeKey || buildEventDedupeKey({ ...input, occurredAt }),
    event_type: clean(input.eventType) || 'unknown',
    source: clean(input.source) || 'local',
    severity: clean(input.severity) || 'info',
    business_portfolio_id: clean(input.businessPortfolioId) || null,
    waba_id: clean(input.wabaId) || null,
    phone_number_id: clean(input.phoneNumberId) || null,
    meta_template_id: clean(input.metaTemplateId) || null,
    template_name: clean(input.templateName) || null,
    template_language: clean(input.language) || null,
    list_id: Number(input.listId || 0) || null,
    item_id: Number(input.itemId || 0) || null,
    message_id: Number(input.messageId || 0) || null,
    reason_code: clean(input.reasonCode) || null,
    status: clean(input.status) || null,
    payload: input.payload || null,
    occurred_at: occurredAt,
  };
  const [row] = await WhatsappDeliveryEvent.findOrCreate({
    where: { dedupe_key: payload.dedupe_key },
    defaults: payload,
  });
  return row;
}

async function upsertSnapshot(input = {}) {
  if (!WhatsappDeliverySnapshot) return null;
  const routeKey = input.routeKey || buildRouteKey(input);
  const previous = await WhatsappDeliverySnapshot.findOne({ where: { route_key: routeKey } });
  const patch = {
    route_key: routeKey,
    business_portfolio_id: clean(input.businessPortfolioId) || previous?.business_portfolio_id || null,
    waba_id: clean(input.wabaId) || previous?.waba_id || null,
    phone_number_id: clean(input.phoneNumberId) || previous?.phone_number_id || null,
    meta_template_id: clean(input.metaTemplateId) || previous?.meta_template_id || null,
    template_name: clean(input.templateName) || previous?.template_name || null,
    template_language: clean(input.language) || previous?.template_language || null,
    account_quality: input.accountQuality === undefined ? previous?.account_quality || null : upper(input.accountQuality) || null,
    template_quality: input.templateQuality === undefined ? previous?.template_quality || null : upper(input.templateQuality) || null,
    template_status: input.templateStatus === undefined ? previous?.template_status || null : upper(input.templateStatus) || null,
    capacity_limit: input.capacityLimit === undefined ? previous?.capacity_limit ?? null : parseCapacity(input.capacityLimit),
    estimated_unique_24h: input.estimatedUnique24h === undefined ? previous?.estimated_unique_24h ?? null : Number(input.estimatedUnique24h || 0),
    immediate_status: input.immediateStatus === undefined ? previous?.immediate_status || null : clean(input.immediateStatus) || null,
    hold_started_at: input.holdStartedAt === undefined ? previous?.hold_started_at || null : input.holdStartedAt,
    hold_released_at: input.holdReleasedAt === undefined ? previous?.hold_released_at || null : input.holdReleasedAt,
    next_check_at: input.nextCheckAt === undefined ? previous?.next_check_at || null : input.nextCheckAt,
    check_attempt: input.checkAttempt === undefined ? Number(previous?.check_attempt || 0) : Number(input.checkAttempt || 0),
    can_send: input.canSend === undefined ? previous?.can_send ?? null : input.canSend,
    source: clean(input.source) || previous?.source || 'local',
    payload: input.payload === undefined ? previous?.payload || null : input.payload,
    provider_event_at: input.providerEventAt === undefined ? previous?.provider_event_at || null : input.providerEventAt,
    checked_at: input.checkedAt === undefined ? previous?.checked_at || null : input.checkedAt,
  };
  if (previous) {
    await previous.update(patch);
    return previous;
  }
  return WhatsappDeliverySnapshot.create(patch);
}

function getTemplateRefFromList(list) {
  const criteria = safeObject(list?.criteria);
  const dispatch = safeObject(criteria.dispatch);
  const snapshot = safeObject(dispatch.template_snapshot || list?.template_snapshot);
  return {
    id: Number(dispatch.whatsapp_template_id || snapshot.id || criteria.whatsapp_template_id || 0) || null,
    metaTemplateId: clean(snapshot.meta_template_id || snapshot.metaTemplateId) || null,
    name: clean(snapshot.name || snapshot.template_name) || null,
    language: clean(snapshot.language || snapshot.template_language) || null,
    dispatch,
  };
}

function listMatchesTemplate(list, template = {}) {
  const ref = getTemplateRefFromList(list);
  if (template.id && ref.id && Number(template.id) === Number(ref.id)) return true;
  if (template.metaTemplateId && ref.metaTemplateId && clean(template.metaTemplateId) === ref.metaTemplateId) return true;
  return Boolean(template.name && ref.name && clean(template.name).toLowerCase() === ref.name.toLowerCase()
    && (!template.language || !ref.language || clean(template.language).toLowerCase() === ref.language.toLowerCase()));
}

async function pauseMatchingQueues({ template = {}, status, reason, severity = 'warning', providerPayload = null, occurredAt = new Date() } = {}) {
  const lists = await MarketingPatientList.findAll({
    where: { objective_id: 'mass_sends', status: { [Op.in]: LIVE_LIST_STATUSES } },
  });
  let paused = 0;
  for (const list of lists) {
    if (!listMatchesTemplate(list, template)) continue;
    const criteria = safeObject(list.criteria);
    const dispatch = safeObject(criteria.dispatch);
    if (clean(list.status).toLowerCase() === 'paused'
      && !PROVIDER_PAUSE_STATUSES.has(clean(dispatch.status).toLowerCase())) {
      continue;
    }
    if (clean(dispatch.status) === 'paused_review' || clean(dispatch.paused_reason) === 'legacy_messaging_limit_review') continue;
    if (clean(dispatch.status) === clean(status) && clean(dispatch.paused_reason) === clean(reason)) continue;
    const nextDispatch = {
      ...dispatch,
      status,
      paused_reason: reason,
      paused_at: dispatch.paused_at || occurredAt.toISOString(),
      next_allowed_at: null,
      provider_pause: true,
      resume_automatically: status === 'held_meta',
      provider_payload: providerPayload || dispatch.provider_payload || null,
    };
    await list.update({ status: 'paused', criteria: { ...criteria, dispatch: nextDispatch } });
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'mass_campaign_paused_by_whatsapp',
      channel: 'whatsapp',
      payload: { status, reason, severity, template, provider_payload: providerPayload || null },
      occurred_at: occurredAt,
    });
    await notificationService.dispatchEvent({
      event: 'whatsapp.delivery_governance_incident',
      clinicId: Number(list.clinica_id || 0) || null,
      data: {
        listId: list.id,
        templateName: clean(template.name) || null,
        status,
        reason,
        reasonLabel: reason === 'template_quality_assessment'
          ? 'Meta está evaluando la calidad inicial de la plantilla'
          : reason === 'template_quality_red'
            ? 'Meta ha reducido la calidad de la plantilla a baja'
            : reason === 'portfolio_capacity_reached'
              ? 'El portfolio ha alcanzado su capacidad de conversaciones iniciadas'
              : 'WhatsApp ha detenido la plantilla o el envío',
      },
    }).catch(() => null);
    paused += 1;
  }
  return paused;
}

async function releaseHeldQueues({ template = {}, occurredAt = new Date() } = {}) {
  const lists = await MarketingPatientList.findAll({
    where: { objective_id: 'mass_sends', status: 'paused' },
  });
  let released = 0;
  for (const list of lists) {
    if (!listMatchesTemplate(list, template)) continue;
    const criteria = safeObject(list.criteria);
    const dispatch = safeObject(criteria.dispatch);
    if (clean(dispatch.status) !== 'held_meta' || dispatch.resume_automatically !== true) continue;
    const delayMs = Math.max(120000, Number(dispatch.delay_ms || 0) || 120000);
    const nextRunAt = new Date(occurredAt.getTime() + delayMs);
    const nextDispatch = {
      ...dispatch,
      status: 'waiting_next_batch',
      paused_reason: null,
      provider_pause: false,
      resumed_at: occurredAt.toISOString(),
      next_allowed_at: nextRunAt.toISOString(),
    };
    await list.update({ status: 'sending', criteria: { ...criteria, dispatch: nextDispatch } });
    const activeJobs = JobRequest ? await JobRequest.findAll({
      where: {
        type: 'marketing_bulk_send_dispatch',
        status: { [Op.in]: ['pending', 'queued', 'running', 'waiting'] },
      },
      order: [['id', 'DESC']],
    }) : null;
    const activeMatches = Array.isArray(activeJobs)
      && activeJobs.some((job) => Number(safeObject(job.payload).list_id || 0) === Number(list.id));
    if (JobRequest && !activeMatches) {
      await JobRequest.create({
        type: 'marketing_bulk_send_dispatch',
        priority: 'normal',
        status: 'waiting',
        origin: 'whatsapp_delivery_governance',
        payload: {
          list_id: list.id,
          scope: dispatch.scope || {},
          context: dispatch.context || null,
          filter: dispatch.filter || null,
        },
        attempts: 0,
        max_attempts: 1,
        next_run_at: nextRunAt,
      });
    }
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'mass_campaign_meta_hold_released',
      channel: 'whatsapp',
      payload: { template, next_run_at: nextRunAt },
      occurred_at: occurredAt,
    });
    released += 1;
  }
  return released;
}

async function estimatePortfolioUniqueRecipients24h(phoneNumberIds = []) {
  const phoneIds = new Set((phoneNumberIds || []).map(clean).filter(Boolean));
  if (!phoneIds.size) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Message.findAll({
    where: {
      direction: 'outbound',
      createdAt: { [Op.gte]: since },
      message_type: 'template',
    },
    attributes: ['metadata'],
    raw: true,
  });
  const recipients = new Set();
  rows.forEach((row) => {
    const metadata = safeObject(row.metadata);
    const phoneId = clean(metadata.phoneNumberId || metadata.phoneId);
    const recipient = clean(metadata.recipient).replace(/\D/g, '');
    if (phoneIds.has(phoneId) && recipient) recipients.add(recipient);
  });
  return recipients.size;
}

async function getTemplateDeliverySignals({ wabaId = null, phoneNumberId = null, template = null } = {}) {
  if (!WhatsappDeliveryEvent) return { successful: 0, failed: 0 };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await WhatsappDeliveryEvent.findAll({
    where: {
      occurred_at: { [Op.gte]: since },
      event_type: { [Op.in]: ['message_sent', 'message_delivered', 'message_read', 'message_failed'] },
      ...(wabaId ? { waba_id: clean(wabaId) } : {}),
      ...(phoneNumberId ? { phone_number_id: clean(phoneNumberId) } : {}),
      ...(template?.meta_template_id
        ? { meta_template_id: clean(template.meta_template_id) }
        : template?.name
          ? { template_name: clean(template.name), template_language: clean(template.language || 'es') }
          : {}),
    },
    attributes: ['id', 'message_id', 'event_type'],
    order: [['occurred_at', 'DESC']],
    limit: 2000,
    raw: true,
  });
  const success = new Set();
  const failed = new Set();
  rows.forEach((row) => {
    const identity = clean(row.message_id) || `event:${row.id}`;
    if (row.event_type === 'message_failed') failed.add(identity);
    else success.add(identity);
  });
  failed.forEach((identity) => success.delete(identity));
  return { successful: success.size, failed: failed.size };
}

async function findPortfolioCapacitySnapshot(route = {}) {
  if (!WhatsappDeliverySnapshot) return null;
  const identity = route.businessPortfolioId
    ? { business_portfolio_id: route.businessPortfolioId }
    : route.wabaId
      ? { waba_id: route.wabaId }
      : route.phoneNumberId
        ? { phone_number_id: route.phoneNumberId }
        : null;
  if (!identity) return null;
  return WhatsappDeliverySnapshot.findOne({
    where: { ...identity, capacity_limit: { [Op.ne]: null } },
    order: [['provider_event_at', 'DESC'], ['updated_at', 'DESC']],
  });
}

function extractCapacity(value = {}) {
  for (const field of PORTFOLIO_LIMIT_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) {
      return parseCapacity(value[field]);
    }
  }
  const capabilities = safeObject(value.capabilities || value.business_capability || {});
  for (const field of PORTFOLIO_LIMIT_FIELDS) {
    if (capabilities[field] !== undefined && capabilities[field] !== null) {
      return parseCapacity(capabilities[field]);
    }
  }
  return null;
}

function computeEffectiveDispatchPolicy({
  requestedBatchSize = 1,
  requestedDelayMs = 0,
  templateQuality = null,
  pauseCount = 0,
  successfulMessages = 0,
  failedMessages = 0,
  availableCapacity = null,
} = {}) {
  const requestedBatch = Math.max(1, Number(requestedBatchSize || 1));
  const requestedDelay = Math.max(0, Number(requestedDelayMs || 0));
  const quality = upper(templateQuality);
  const yellowDelayMs = 3 * 60 * 60 * 1000;
  const needsWarmup = !quality || ['UNKNOWN', 'YELLOW'].includes(quality) || Number(pauseCount || 0) > 0;
  const warmupBatch = quality === 'YELLOW'
    ? 5
    : Number(failedMessages || 0) > 0
      ? 5
      : Number(successfulMessages || 0) >= 100
        ? 50
        : Number(successfulMessages || 0) >= 25
          ? 20
          : Number(successfulMessages || 0) >= 5
            ? 10
            : 5;
  const capacityBatch = availableCapacity === null || availableCapacity === undefined
    ? requestedBatch
    : Math.max(0, Math.trunc(Number(availableCapacity || 0)));
  const effectiveBatchSize = Math.min(
    needsWarmup ? Math.min(requestedBatch, warmupBatch) : requestedBatch,
    capacityBatch,
  );
  return {
    needsWarmup,
    warmupBatch,
    requestedBatch,
    requestedDelay,
    effectiveBatchSize,
    effectiveDelayMs: quality === 'YELLOW'
      ? Math.max(requestedDelay, yellowDelayMs)
      : requestedDelay,
  };
}

async function recordCapabilitySnapshot({ clinicId = null, wabaId = null, phoneNumberId = null, value = {}, source = 'phone_sync' } = {}) {
  const capacityLimit = extractCapacity(value);
  if (capacityLimit === null) return { recorded: false, reason: 'capacity_missing' };
  const route = await resolveRouteContext({ clinicId, wabaId, phoneNumberId });
  const senderHealth = whatsappAccountHealthService.summarizeAssetHealth(route.asset);
  const routeKey = buildRouteKey(route);
  const snapshot = await upsertSnapshot({
    ...route,
    routeKey,
    capacityLimit,
    accountQuality: value.quality_rating,
    source,
    checkedAt: new Date(),
    payload: value,
    canSend: senderHealth.can_send === false ? false : undefined,
  });
  return { recorded: true, snapshot };
}

async function handleWebhookChange({ entry = {}, change = {}, value = {}, clinicId = null } = {}) {
  const field = clean(change.field).toLowerCase();
  if (!['message_template_quality_update', 'message_template_status_update', 'business_capability_update', 'account_alerts'].includes(field)) {
    return { handled: false };
  }
  const wabaId = clean(entry.id || value.waba_id) || null;
  const route = await resolveRouteContext({ clinicId, wabaId, phoneNumberId: value?.metadata?.phone_number_id });
  const occurredAt = parseProviderDate(entry.time || value.timestamp, new Date());
  const metaTemplateId = clean(value.message_template_id || value.template_id) || null;
  const templateName = clean(value.message_template_name || value.template_name) || null;
  const language = clean(value.message_template_language || value.language) || null;
  const templateWhere = {
    [Op.or]: [
      ...(metaTemplateId ? [{ meta_template_id: metaTemplateId }] : []),
      ...(templateName ? [{ waba_id: wabaId, name: templateName, ...(language ? { language } : {}) }] : []),
    ],
  };
  const template = templateWhere[Op.or].length ? await WhatsappTemplate.findOne({ where: templateWhere }) : null;

  if (field === 'message_template_quality_update') {
    const quality = upper(value.new_quality_score || value.quality_score);
    const previousQuality = upper(value.previous_quality_score);
    if (template) {
      await template.update({
        quality_score: quality || null,
        previous_quality_score: previousQuality || template.quality_score || null,
        quality_updated_at: occurredAt,
      });
    }
    const snapshot = await upsertSnapshot({
      ...route,
      metaTemplateId,
      templateName,
      language,
      templateQuality: quality,
      source: field,
      providerEventAt: occurredAt,
      payload: value,
      canSend: quality === 'RED' ? false : undefined,
    });
    await recordEvent({
      ...route,
      eventType: field,
      source: 'meta_webhook',
      severity: quality === 'RED' ? 'error' : quality === 'YELLOW' ? 'warning' : 'info',
      metaTemplateId,
      templateName,
      language,
      status: quality,
      reasonCode: 'template_quality_changed',
      payload: value,
      occurredAt,
    });
    if (quality === 'RED') {
      await pauseMatchingQueues({
        template: { id: template?.id, metaTemplateId, name: templateName, language },
        status: 'paused_quality',
        reason: 'template_quality_red',
        severity: 'error',
        providerPayload: value,
        occurredAt,
      });
    } else if (quality === 'GREEN') {
      await releaseHeldQueues({
        template: { id: template?.id, metaTemplateId, name: templateName, language },
        occurredAt,
      });
    }
    return { handled: true, field, snapshot };
  }

  if (field === 'message_template_status_update') {
    const status = upper(value.event || value.status);
    const wasPaused = template && TERMINAL_TEMPLATE_STATUSES.has(upper(template.status));
    if (template) {
      const patch = {
        status: status === 'ACTIVE' ? 'APPROVED' : (status || template.status),
        provider_status_updated_at: occurredAt,
      };
      if (status === 'PAUSED') {
        patch.pause_count = Number(template.pause_count || 0) + 1;
        patch.last_paused_at = occurredAt;
      }
      if (['ACTIVE', 'APPROVED'].includes(status) && wasPaused) patch.last_unpaused_at = occurredAt;
      await template.update(patch);
    }
    const snapshot = await upsertSnapshot({
      ...route,
      metaTemplateId,
      templateName,
      language,
      templateStatus: status,
      source: field,
      providerEventAt: occurredAt,
      payload: value,
      canSend: TERMINAL_TEMPLATE_STATUSES.has(status) ? false : ['ACTIVE', 'APPROVED'].includes(status) ? true : undefined,
    });
    await recordEvent({
      ...route,
      eventType: field,
      source: 'meta_webhook',
      severity: TERMINAL_TEMPLATE_STATUSES.has(status) ? 'error' : 'info',
      metaTemplateId,
      templateName,
      language,
      status,
      reasonCode: clean(value.reason || value.disable_info?.reason) || 'template_status_changed',
      payload: value,
      occurredAt,
    });
    if (TERMINAL_TEMPLATE_STATUSES.has(status)) {
      await pauseMatchingQueues({
        template: { id: template?.id, metaTemplateId, name: templateName, language },
        status: 'paused_template',
        reason: status === 'DISABLED' ? 'template_disabled_by_meta' : 'template_paused_by_meta',
        severity: 'error',
        providerPayload: value,
        occurredAt,
      });
    }
    return { handled: true, field, snapshot };
  }

  if (field === 'business_capability_update') {
    const capacityLimit = extractCapacity(value);
    const estimatedUnique24h = await estimatePortfolioUniqueRecipients24h(route.portfolioPhoneNumberIds);
    const snapshot = await upsertSnapshot({
      ...route,
      capacityLimit,
      estimatedUnique24h,
      source: field,
      providerEventAt: occurredAt,
      payload: value,
      canSend: capacityLimit === null ? undefined : estimatedUnique24h < capacityLimit,
    });
    await recordEvent({
      ...route,
      eventType: field,
      source: 'meta_webhook',
      severity: capacityLimit !== null && estimatedUnique24h >= capacityLimit ? 'error' : 'info',
      status: capacityLimit === null ? 'unknown' : 'updated',
      reasonCode: 'portfolio_capacity_changed',
      payload: { ...value, estimated_unique_24h: estimatedUnique24h },
      occurredAt,
    });
    return { handled: true, field, snapshot };
  }

  await recordEvent({
    ...route,
    eventType: field,
    source: 'meta_webhook',
    severity: 'warning',
    status: clean(value.alert_type || value.event || value.status) || 'received',
    reasonCode: clean(value.alert_type || value.type) || 'account_alert',
    payload: value,
    occurredAt,
  });
  return { handled: true, field };
}

async function recordImmediateSendResponse({ response, clinicId = null, wabaId = null, phoneNumberId = null, template = null, listId = null, itemId = null, messageId = null } = {}) {
  const immediateStatus = clean(response?.messages?.[0]?.message_status || 'accepted').toLowerCase();
  const providerMessageId = clean(response?.messages?.[0]?.id) || null;
  const route = await resolveRouteContext({ clinicId, wabaId, phoneNumberId });
  const occurredAt = new Date();
  const templateRef = {
    id: Number(template?.id || 0) || null,
    metaTemplateId: clean(template?.meta_template_id) || null,
    name: clean(template?.name) || null,
    language: clean(template?.language) || 'es',
  };
  const routeKey = buildRouteKey({ ...route, ...templateRef, templateName: templateRef.name });
  const existing = await WhatsappDeliverySnapshot.findOne({ where: { route_key: routeKey } });
  const held = immediateStatus === HOLD_STATUS;
  const nextCheckAt = held ? new Date(Date.now() + 15 * 60 * 1000) : undefined;
  const snapshot = await upsertSnapshot({
    ...route,
    routeKey,
    metaTemplateId: templateRef.metaTemplateId,
    templateName: templateRef.name,
    language: templateRef.language,
    immediateStatus: held ? HOLD_STATUS : (existing?.immediate_status === HOLD_STATUS ? undefined : immediateStatus),
    holdStartedAt: held ? (existing?.hold_started_at || occurredAt) : undefined,
    nextCheckAt,
    checkAttempt: held ? Number(existing?.check_attempt || 0) : undefined,
    canSend: held ? false : undefined,
    source: 'messages_api_response',
    providerEventAt: occurredAt,
    payload: response,
  });
  await recordEvent({
    ...route,
    eventType: held ? 'message_held_for_quality_assessment' : 'message_accepted_by_meta',
    source: 'messages_api_response',
    severity: held ? 'warning' : 'info',
    metaTemplateId: templateRef.metaTemplateId,
    templateName: templateRef.name,
    language: templateRef.language,
    listId,
    itemId,
    messageId,
    status: immediateStatus,
    reasonCode: held ? 'template_quality_assessment' : 'accepted_pending_delivery',
    payload: { response, provider_message_id: providerMessageId },
    occurredAt,
  });
  if (held) {
    await pauseMatchingQueues({
      template: templateRef,
      status: 'held_meta',
      reason: 'template_quality_assessment',
      providerPayload: response,
      occurredAt,
    });
  }
  return { status: immediateStatus, held, providerMessageId, snapshot };
}

async function materializeFinalMessageStatus({ message, status, mappedStatus, clinicId = null } = {}) {
  const metadata = safeObject(message?.metadata);
  const template = {
    metaTemplateId: clean(metadata.meta_template_id) || null,
    name: clean(metadata.template_name) || null,
    language: clean(metadata.template_language) || 'es',
  };
  const route = await resolveRouteContext({
    clinicId: clinicId || message?.conversation?.clinic_id || null,
    wabaId: metadata.wabaId,
    phoneNumberId: metadata.phoneNumberId || metadata.phoneId,
  });
  const occurredAt = parseProviderDate(status?.timestamp, new Date());
  const routeKey = buildRouteKey({ ...route, ...template, templateName: template.name });
  const snapshot = await WhatsappDeliverySnapshot.findOne({ where: { route_key: routeKey } });
  const wasHeld = snapshot?.immediate_status === HOLD_STATUS;
  if (wasHeld && ['sent', 'delivered', 'read'].includes(mappedStatus)) {
    await upsertSnapshot({
      ...route,
      routeKey,
      ...template,
      templateName: template.name,
      immediateStatus: 'released',
      holdReleasedAt: occurredAt,
      nextCheckAt: null,
      canSend: true,
      source: 'message_status_webhook',
      providerEventAt: occurredAt,
      payload: status,
    });
    await releaseHeldQueues({ template, occurredAt });
  }
  if (mappedStatus === 'failed') {
    const error = Array.isArray(status?.errors) ? status.errors[0] : null;
    const code = clean(error?.code || error?.error_subcode);
    if (code === '132015') {
      await pauseMatchingQueues({
        template,
        status: 'paused_template',
        reason: 'template_pacing_dropped_132015',
        severity: 'error',
        providerPayload: status,
        occurredAt,
      });
    }
  }
  await recordEvent({
    ...route,
    eventType: `message_${mappedStatus}`,
    source: 'message_status_webhook',
    severity: mappedStatus === 'failed' ? 'error' : 'info',
    ...template,
    templateName: template.name,
    listId: metadata.list_id,
    itemId: metadata.item_id,
    messageId: message?.id,
    status: mappedStatus,
    reasonCode: clean(status?.errors?.[0]?.code) || null,
    payload: status,
    occurredAt,
  });
  return { applied: true, wasHeld };
}

async function getDispatchGate({ clinicId, wabaId, phoneNumberId, template, requestedBatchSize, requestedDelayMs } = {}) {
  const route = await resolveRouteContext({ clinicId, wabaId, phoneNumberId });
  const senderHealth = whatsappAccountHealthService.summarizeAssetHealth(route.asset);
  const routeKey = buildRouteKey({
    ...route,
    metaTemplateId: template?.meta_template_id,
    templateName: template?.name,
    language: template?.language,
  });
  const [snapshot, portfolioSnapshot, estimatedUnique24h, deliverySignals] = await Promise.all([
    WhatsappDeliverySnapshot.findOne({ where: { route_key: routeKey } }),
    findPortfolioCapacitySnapshot(route),
    estimatePortfolioUniqueRecipients24h(route.portfolioPhoneNumberIds),
    getTemplateDeliverySignals({
      wabaId: route.wabaId,
      phoneNumberId: route.phoneNumberId,
      template,
    }),
  ]);
  const templateStatus = upper(template?.status || snapshot?.template_status);
  const templateQuality = upper(template?.quality_score || snapshot?.template_quality);
  const capacityLimit = portfolioSnapshot?.capacity_limit ?? snapshot?.capacity_limit ?? null;
  const availableCapacity = capacityLimit === null
    ? null
    : Math.max(0, Number(capacityLimit) - estimatedUnique24h);
  const blockedByCapacity = availableCapacity !== null && availableCapacity <= 0;
  const blockedReason = senderHealth.can_send === false
    ? `sender_${senderHealth.reason_code || senderHealth.state || 'blocked'}`
    : TERMINAL_TEMPLATE_STATUSES.has(templateStatus)
      ? (templateStatus === 'DISABLED' ? 'template_disabled_by_meta' : 'template_paused_by_meta')
    : templateQuality === 'RED'
      ? 'template_quality_red'
      : snapshot?.immediate_status === HOLD_STATUS
        ? 'template_quality_assessment'
        : blockedByCapacity
          ? 'portfolio_capacity_reached'
          : null;
  const policy = computeEffectiveDispatchPolicy({
    requestedBatchSize,
    requestedDelayMs,
    templateQuality,
    pauseCount: template?.pause_count,
    successfulMessages: deliverySignals.successful,
    failedMessages: deliverySignals.failed,
    availableCapacity,
  });
  await upsertSnapshot({
    ...route,
    routeKey,
    metaTemplateId: template?.meta_template_id,
    templateName: template?.name,
    language: template?.language,
    templateStatus,
    templateQuality,
    accountQuality: route.accountQuality,
    estimatedUnique24h,
    canSend: !blockedReason,
    source: 'local_regulator',
    checkedAt: new Date(),
  });
  return {
    allowed: !blockedReason,
    reason: blockedReason,
    route_key: routeKey,
    business_portfolio_id: route.businessPortfolioId,
    capacity_limit: capacityLimit,
    available_capacity: availableCapacity,
    estimated_unique_24h: estimatedUnique24h,
    template_status: templateStatus || null,
    template_quality: templateQuality || null,
    warmup: policy.needsWarmup,
    warmup_successful_messages: deliverySignals.successful,
    warmup_failed_messages: deliverySignals.failed,
    sender_health_state: senderHealth.state,
    sender_health_reason: senderHealth.reason_code,
    requested_batch_size: policy.requestedBatch,
    effective_batch_size: policy.effectiveBatchSize,
    requested_delay_ms: policy.requestedDelay,
    effective_delay_ms: policy.effectiveDelayMs,
  };
}

function serializeQueueSender(asset, { source = 'unknown', phoneNumberId = null } = {}) {
  if (!asset && !phoneNumberId) return null;
  const additionalData = safeObject(asset?.additionalData);
  const displayPhone = clean(
    additionalData.display_phone_number
    || additionalData.displayPhoneNumber
    || additionalData.phone_number
    || asset?.metaAssetName,
  ) || null;
  return {
    asset_id: Number(asset?.id || 0) || null,
    phone_number_id: clean(phoneNumberId || asset?.phoneNumberId) || null,
    phone: displayPhone,
    name: clean(asset?.waVerifiedName || asset?.metaAssetName) || displayPhone,
    source,
  };
}

async function cachedLookup(cache, key, loader) {
  if (!cache || !key) return loader();
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(loader));
  return cache.get(key);
}

async function resolveQueueSender(list, dispatch, cache = {}) {
  const senderSnapshot = safeObject(dispatch.sender_snapshot);
  if (clean(senderSnapshot.phone_number_id || senderSnapshot.phoneNumberId || senderSnapshot.phone)) {
    return {
      asset_id: Number(senderSnapshot.asset_id || senderSnapshot.assetId || 0) || null,
      phone_number_id: clean(senderSnapshot.phone_number_id || senderSnapshot.phoneNumberId) || null,
      phone: clean(senderSnapshot.phone || senderSnapshot.display_phone_number) || null,
      name: clean(senderSnapshot.name || senderSnapshot.verified_name) || null,
      source: 'dispatch_snapshot',
    };
  }

  const deliveryGovernance = safeObject(dispatch.delivery_governance);
  const dispatchedPhoneNumberId = clean(
    deliveryGovernance.phone_number_id
    || deliveryGovernance.phoneNumberId,
  );
  if (dispatchedPhoneNumberId) {
    const asset = await cachedLookup(
      cache.assetsByPhone,
      dispatchedPhoneNumberId,
      () => ClinicMetaAsset.findOne({
        where: {
          assetType: 'whatsapp_phone_number',
          phoneNumberId: dispatchedPhoneNumberId,
        },
        order: [['isActive', 'DESC'], ['updatedAt', 'DESC']],
      }),
    );
    return serializeQueueSender(asset, {
      source: 'dispatch_route',
      phoneNumberId: dispatchedPhoneNumberId,
    });
  }

  const clinicId = Number(list.clinica_id || 0) || null;
  if (clinicId) {
    const clinicConfig = await cachedLookup(
      cache.clinicConfigs,
      clinicId,
      () => whatsappService.getClinicConfig(clinicId).catch(() => null),
    );
    if (clinicConfig?.phoneNumberId) {
      const asset = clinicConfig.originId
        ? await cachedLookup(
            cache.assetsById,
            Number(clinicConfig.originId),
            () => ClinicMetaAsset.findByPk(clinicConfig.originId),
          )
        : await cachedLookup(
            cache.assetsByPhone,
            clean(clinicConfig.phoneNumberId),
            () => ClinicMetaAsset.findOne({
              where: {
                assetType: 'whatsapp_phone_number',
                phoneNumberId: clean(clinicConfig.phoneNumberId),
              },
              order: [['isActive', 'DESC'], ['updatedAt', 'DESC']],
            }),
          );
      return serializeQueueSender(asset, {
        source: 'current_clinic_route',
        phoneNumberId: clinicConfig.phoneNumberId,
      });
    }
  }

  const groupId = Number(list.grupo_clinica_id || 0) || null;
  if (groupId) {
    const asset = await cachedLookup(
      cache.groupAssets,
      groupId,
      () => ClinicMetaAsset.findOne({
        where: {
          assetType: 'whatsapp_phone_number',
          isActive: true,
          grupoClinicaId: groupId,
          assignmentScope: 'group',
        },
        order: [['updatedAt', 'DESC']],
      }),
    );
    return serializeQueueSender(asset, { source: 'current_group_route' });
  }
  return null;
}

async function getAdminOverview({ limit = 100 } = {}) {
  const [snapshots, events, pausedLists] = await Promise.all([
    WhatsappDeliverySnapshot.findAll({ order: [['updated_at', 'DESC']], limit: Math.min(Number(limit) || 100, 500), raw: true }),
    WhatsappDeliveryEvent.findAll({ order: [['occurred_at', 'DESC']], limit: Math.min(Number(limit) || 100, 500), raw: true }),
    MarketingPatientList.findAll({
      where: { objective_id: 'mass_sends', status: 'paused' },
      order: [['updated_at', 'DESC']],
      limit: 100,
      raw: true,
    }),
  ]);
  const clinicIds = [...new Set(pausedLists.map((list) => Number(list.clinica_id || 0)).filter(Boolean))];
  const groupIds = [...new Set(pausedLists.map((list) => Number(list.grupo_clinica_id || 0)).filter(Boolean))];
  const [clinics, groups] = await Promise.all([
    clinicIds.length ? Clinica.findAll({ where: { id_clinica: { [Op.in]: clinicIds } }, attributes: ['id_clinica', 'nombre_clinica'], raw: true }) : [],
    groupIds.length ? GrupoClinica.findAll({ where: { id_grupo: { [Op.in]: groupIds } }, attributes: ['id_grupo', 'nombre_grupo'], raw: true }) : [],
  ]);
  const clinicNames = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic.nombre_clinica]));
  const groupNames = new Map(groups.map((group) => [Number(group.id_grupo), group.nombre_grupo]));
  const allPausedQueueRows = pausedLists
    .map((list) => {
      const criteria = safeObject(list.criteria);
      const dispatch = safeObject(criteria.dispatch);
      return { list, dispatch };
    });
  const pausedQueueRows = allPausedQueueRows
    .filter(({ dispatch }) => !clean(safeObject(dispatch.admin_resolution).decision) && (
      PROVIDER_PAUSE_STATUSES.has(clean(dispatch.status).toLowerCase())
      || clean(dispatch.status).toLowerCase() === 'paused_review'
      || dispatch.requires_admin_review === true
    ));
  const reviewedQueueRows = allPausedQueueRows
    .filter(({ dispatch }) => clean(safeObject(dispatch.admin_resolution).decision))
    .slice(0, 25);
  const senderCache = {
    clinicConfigs: new Map(),
    assetsById: new Map(),
    assetsByPhone: new Map(),
    groupAssets: new Map(),
  };
  const serializeQueue = async ({ list, dispatch }) => ({
      id: list.id,
      name: list.name,
      clinic_id: list.clinica_id,
      group_id: list.grupo_clinica_id,
      clinic_name: clinicNames.get(Number(list.clinica_id)) || null,
      group_name: groupNames.get(Number(list.grupo_clinica_id)) || null,
      status: dispatch.status || list.status,
      reason: dispatch.paused_reason || null,
      paused_at: dispatch.paused_at || list.updated_at,
      requires_admin_review: dispatch.requires_admin_review === true,
      next_action: dispatch.requires_admin_review === true
        ? 'Revisión administrativa antes de reanudar'
        : dispatch.status === 'held_meta'
          ? 'Esperar la decisión de WhatsApp'
          : 'Revisar la causa antes de reanudar',
      counters: safeObject(list.counters),
      template: safeObject(dispatch.template_snapshot),
      sender: await resolveQueueSender(list, dispatch, senderCache),
      audience: safeObject(safeObject(list.criteria).audience || safeObject(list.criteria).selection),
      schedule: safeObject(dispatch.business_hours),
      admin_resolution: safeObject(dispatch.admin_resolution),
      what_happens_now: clean(safeObject(dispatch.admin_resolution).decision) === 'changes_required'
        ? 'Clinicaclick la marcó como pendiente de cambios. No se podrá reanudar hasta corregir la plantilla, la audiencia o el motivo de pausa indicado.'
        : clean(safeObject(dispatch.admin_resolution).decision) === 'cancelled'
          ? 'Clinicaclick canceló esta cola. No se enviarán los mensajes pendientes.'
          : clean(safeObject(dispatch.admin_resolution).decision) === 'authorized'
            ? 'Clinicaclick autorizó la continuación. La campaña puede retomarse desde su flujo operativo.'
            : dispatch.requires_admin_review === true
        ? 'La cola seguirá detenida y no se enviarán más mensajes. Un administrador de Clinicaclick revisará la plantilla, los destinatarios y el motivo de la pausa. Te avisaremos si puede continuar o debe cancelarse.'
        : dispatch.status === 'held_meta'
          ? 'WhatsApp está comprobando señales iniciales de calidad. Los mensajes retenidos no se reintentan: se enviarán o fallarán cuando Meta termine la evaluación.'
          : 'La cola permanecerá detenida hasta que desaparezca la causa indicada.',
    });
  const [queues, reviewedQueues] = await Promise.all([
    Promise.all(pausedQueueRows.map(serializeQueue)),
    Promise.all(reviewedQueueRows.map(serializeQueue)),
  ]);
  return { snapshots, events, queues, reviewed_queues: reviewedQueues };
}

async function notifyQueueResolution(list, decision, note, adminUserId) {
  if (!Notification || !UsuarioClinica) return 0;
  let clinicIds = Number(list.clinica_id || 0) > 0
    ? [Number(list.clinica_id)]
    : [];
  if (!clinicIds.length && Number(list.grupo_clinica_id || 0) > 0) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: Number(list.grupo_clinica_id) },
      attributes: ['id_clinica'],
      raw: true,
    });
    clinicIds = clinics.map((clinic) => Number(clinic.id_clinica)).filter((clinicId) => clinicId > 0);
  }
  if (!clinicIds.length) return 0;
  const memberships = await UsuarioClinica.findAll({
    where: {
      id_clinica: { [Op.in]: clinicIds },
      estado_invitacion: 'aceptada',
      rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
    },
    raw: true,
  });
  let created = 0;
  const notifiedUsers = new Set();
  for (const membership of memberships) {
    const userId = Number(membership.id_usuario || 0);
    if (!userId || notifiedUsers.has(userId)) continue;
    notifiedUsers.add(userId);
    const notification = await Notification.create({
      userId,
      role: membership.rol_clinica || '',
      subrole: membership.subrol_clinica || '',
      category: 'general',
      event: 'whatsapp.delivery_governance_incident',
      title: decision === 'authorized'
        ? 'Envío revisado: puede continuar'
        : decision === 'cancelled'
          ? 'Envío cancelado tras la revisión'
          : 'El envío necesita cambios',
      message: note || (decision === 'authorized'
        ? 'Clinicaclick ha revisado la cola. Ya puede retomarse desde la campaña.'
        : decision === 'cancelled'
          ? 'Clinicaclick ha cancelado la cola y no se enviarán los mensajes pendientes.'
          : 'Clinicaclick ha revisado la cola y debe corregirse antes de continuar.'),
      icon: 'heroicons_outline:exclamation-triangle',
      level: decision === 'authorized' ? 'success' : decision === 'cancelled' ? 'error' : 'warning',
      data: {
        source: 'whatsapp_delivery_governance',
        listId: list.id,
        decision,
        adminUserId: Number(adminUserId || 0) || null,
        link: '/marketing/campanas',
        useRouter: true,
      },
      clinicaId: Number(list.clinica_id || membership.id_clinica || 0) || null,
    });
    created += 1;
    try {
      const { emitNotificationCreated } = require('./notificationsRealtime.service');
      emitNotificationCreated(notification);
    } catch (_) {}
  }
  return created;
}

async function resolvePausedQueue({ listId, decision, note = '', adminUserId = null } = {}) {
  const normalizedDecision = clean(decision).toLowerCase();
  if (!['authorized', 'cancelled', 'changes_required'].includes(normalizedDecision)) {
    const error = new Error('invalid_delivery_queue_resolution');
    error.status = 400;
    throw error;
  }
  const list = await MarketingPatientList.findByPk(Number(listId));
  if (!list) {
    const error = new Error('delivery_queue_not_found');
    error.status = 404;
    throw error;
  }
  const criteria = safeObject(list.criteria);
  const dispatch = safeObject(criteria.dispatch);
  if (clean(safeObject(dispatch.admin_resolution).decision)) {
    const error = new Error('delivery_queue_already_resolved');
    error.status = 409;
    throw error;
  }
  const resolvedAt = new Date();
  const adminResolution = {
    decision: normalizedDecision,
    note: clean(note) || null,
    resolved_at: resolvedAt.toISOString(),
    resolved_by: Number(adminUserId || 0) || null,
  };
  const nextDispatch = {
    ...dispatch,
    status: normalizedDecision === 'cancelled' ? 'cancelled' : 'paused',
    requires_admin_review: false,
    resume_automatically: false,
    cancel_requested: normalizedDecision === 'cancelled',
    cancelled_at: normalizedDecision === 'cancelled' ? resolvedAt.toISOString() : dispatch.cancelled_at || null,
    admin_resolution: adminResolution,
  };
  await list.update({
    status: 'paused',
    criteria: { ...criteria, dispatch: nextDispatch },
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_admin_resolution',
    channel: 'whatsapp',
    payload: adminResolution,
    occurred_at: resolvedAt,
  });
  const notified = await notifyQueueResolution(list, normalizedDecision, note, adminUserId);
  return { success: true, queue_id: list.id, decision: normalizedDecision, notified };
}

module.exports = {
  HOLD_STATUS,
  buildRouteKey,
  getAdminOverview,
  getDispatchGate,
  resolvePausedQueue,
  handleWebhookChange,
  materializeFinalMessageStatus,
  parseCapacity,
  recordCapabilitySnapshot,
  recordImmediateSendResponse,
  resolveRouteContext,
  __testing: {
    computeEffectiveDispatchPolicy,
    extractCapacity,
    getBusinessPortfolioId,
    listMatchesTemplate,
  },
};
