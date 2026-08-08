'use strict';

const { Op, fn, col } = require('sequelize');
const db = require('../../models');
const notificationService = require('./notifications.service');
const { syncPhonesForWaba } = require('./whatsappPhones.service');
const {
  buildDedupeKey,
  deriveComplianceSnapshot,
  isGroupScopedAsset,
  VIOLATION_LABELS,
} = require('../lib/whatsapp-account-compliance');

const {
  ClinicMetaAsset,
  Clinica,
  GrupoClinica,
  WhatsappAccountComplianceIncident,
  Conversation,
  Message,
} = db;

const BUSINESS_SUPPORT_HOME_URL = 'https://business.facebook.com/business-support-home/';
const COMPLIANCE_EVENTS = new Set([
  'ACCOUNT_VIOLATION',
  'ACCOUNT_RESTRICTION',
  'DISABLED_UPDATE',
  'ACCOUNT_DELETED',
]);
const OPEN_STATUSES = [
  'open',
  'clinicaclick_review_requested',
  'draft_ready',
  'submitted',
  'in_review',
];

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toPlain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function serializeProviderError(error) {
  const provider = error?.response?.data?.error || null;
  return {
    code: provider?.code || error?.code || null,
    subcode: provider?.error_subcode || null,
    type: provider?.type || null,
    message: provider?.message || error?.message || 'whatsapp_diagnostic_failed',
    details: provider?.error_data?.details || null,
    trace_id: provider?.fbtrace_id || null,
    http_status: error?.response?.status || null,
  };
}

function occurredAtFromEntry(entry) {
  const raw = Number(entry?.time || 0);
  if (Number.isFinite(raw) && raw > 0) {
    return new Date(raw < 100000000000 ? raw * 1000 : raw);
  }
  return new Date();
}

function getStoredAccountUpdate(asset) {
  const additionalData = asset?.additionalData || {};
  const coexistence = additionalData.coexistence || {};
  const stored = coexistence.last_account_update || additionalData.last_account_update || null;
  const value = stored?.raw && typeof stored.raw === 'object' ? stored.raw : null;
  const event = clean(value?.event || stored?.event).toUpperCase();
  if (!value || !COMPLIANCE_EVENTS.has(event)) return null;

  const receivedAt = coexistence.account_update_last_at
    || stored.received_at
    || stored.updated_at
    || asset?.updatedAt
    || new Date();
  const receivedAtMs = new Date(receivedAt).getTime();
  return {
    event,
    receivedAt: Number.isFinite(receivedAtMs) ? new Date(receivedAtMs) : new Date(),
    entry: {
      id: clean(asset?.wabaId) || null,
      time: Math.floor((Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now()) / 1000),
    },
    change: { field: 'account_update' },
    value,
  };
}

function summarizeCompliance(additionalData = {}) {
  const stored = additionalData?.whatsappCompliance || null;
  if (!stored) return null;
  const snapshot = stored.event
    ? deriveComplianceSnapshot({
        event: stored.event,
        violation_info: stored.violation_type ? { violation_type: stored.violation_type } : null,
        ban_info: stored.ban_state ? {
          waba_ban_state: stored.ban_state,
          waba_ban_date: stored.ban_date,
        } : null,
        restriction_info: stored.restrictions || [],
        appealable: typeof stored.appealable === 'boolean' ? stored.appealable : undefined,
      })
    : stored;
  return {
    ...stored,
    ...snapshot,
    incident_id: stored.incident_id || null,
    review_status: stored.review_status || null,
    client_requested_at: stored.client_requested_at || null,
  };
}

async function findRelevantAssets({ wabaId, phoneNumberId, clinicId }) {
  const or = [];
  if (wabaId) or.push({ wabaId: String(wabaId) });
  if (phoneNumberId) or.push({ phoneNumberId: String(phoneNumberId) });
  if (!or.length && clinicId) or.push({ clinicaId: Number(clinicId) });
  if (!or.length) return [];

  return ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
      [Op.or]: or,
    },
    order: [['assetType', 'DESC'], ['updatedAt', 'DESC']],
  });
}

async function updateAssetsCompliance(assets, snapshot) {
  await Promise.all(assets.map(async (asset) => {
    const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
      ? { ...asset.additionalData }
      : {};
    additionalData.whatsappCompliance = snapshot;
    asset.additionalData = additionalData;
    asset.changed('additionalData', true);
    await asset.save();
  }));
}

async function updateIncidentReviewSnapshot(incident) {
  const assets = await findRelevantAssets({
    wabaId: incident.waba_id,
    phoneNumberId: incident.phone_number_id,
    clinicId: incident.clinic_id,
  });
  await Promise.all(assets.map(async (asset) => {
    const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
      ? { ...asset.additionalData }
      : {};
    const current = summarizeCompliance(additionalData) || {};
    additionalData.whatsappCompliance = {
      ...current,
      incident_id: Number(incident.id),
      review_status: incident.status,
      client_requested_at: incident.client_requested_at || current.client_requested_at || null,
      appeal_prepared_at: incident.appeal_prepared_at || null,
      appeal_submitted_at: incident.appeal_submitted_at || null,
      updated_at: new Date().toISOString(),
    };
    asset.additionalData = additionalData;
    asset.changed('additionalData', true);
    await asset.save();
  }));
}

async function resolveClinicContext({ assets, clinicId }) {
  const primary = assets.find((asset) => asset.assetType === 'whatsapp_phone_number') || assets[0] || null;
  const groupScoped = isGroupScopedAsset(primary);
  const groupId = groupScoped
    ? (Number(primary?.grupoClinicaId || 0) || null)
    : null;
  if (groupScoped) {
    const group = groupId
      ? await GrupoClinica.findByPk(groupId, {
          attributes: ['id_grupo', 'nombre_grupo'],
          raw: true,
        })
      : null;
    return {
      primary,
      clinicId: null,
      clinicName: null,
      groupId,
      groupName: group?.nombre_grupo || null,
    };
  }

  const effectiveClinicId = Number(primary?.clinicaId || clinicId || 0) || null;
  const clinic = effectiveClinicId
    ? await Clinica.findByPk(effectiveClinicId, {
        attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
        raw: true,
      })
    : null;
  return {
    primary,
    clinicId: effectiveClinicId,
    clinicName: clinic?.nombre_clinica || null,
    groupId: clinic?.grupoClinicaId || null,
    groupName: null,
  };
}

async function resolveOpenIncidents({ wabaId, providerResolution, occurredAt }) {
  if (!WhatsappAccountComplianceIncident || !wabaId) return 0;
  const [count] = await WhatsappAccountComplianceIncident.update({
    status: 'resolved',
    provider_resolution: providerResolution,
    resolved_at: occurredAt || new Date(),
  }, {
    where: {
      waba_id: String(wabaId),
      status: { [Op.in]: OPEN_STATUSES },
    },
  });
  return count;
}

async function handleAccountUpdate({ entry, change, value, clinicId }) {
  const field = clean(change?.field).toLowerCase();
  const event = clean(value?.event).toUpperCase();
  if (field !== 'account_update' || !COMPLIANCE_EVENTS.has(event)) return null;

  const wabaId = clean(entry?.id || value?.waba_id) || null;
  const phoneNumberId = clean(value?.metadata?.phone_number_id) || null;
  const phoneNumber = clean(value?.phone_number || value?.metadata?.display_phone_number) || null;
  const occurredAt = occurredAtFromEntry(entry);
  const assets = await findRelevantAssets({ wabaId, phoneNumberId, clinicId });
  const context = await resolveClinicContext({ assets, clinicId });
  const snapshot = deriveComplianceSnapshot(value);
  const isReinstatement = event === 'DISABLED_UPDATE' && snapshot.ban_state === 'REINSTATE';
  const isResolution = isReinstatement || snapshot.status === 'active';

  if (isResolution) {
    await resolveOpenIncidents({
      wabaId,
      providerResolution: isReinstatement ? 'REINSTATE' : `${event}:ACTIVE`,
      occurredAt,
    });
  }

  const dedupeKey = buildDedupeKey({ wabaId, field, entry, value });
  const incidentDefaults = {
    dedupe_key: dedupeKey,
    clinic_id: context.clinicId,
    group_id: context.groupId,
    asset_id: context.primary?.id || null,
    waba_id: wabaId,
    phone_number_id: phoneNumberId || context.primary?.phoneNumberId || null,
    phone_number: phoneNumber || context.primary?.metaAssetName || null,
    webhook_field: field,
    provider_event: event,
    severity: snapshot.severity,
    operational_status: snapshot.status,
    violation_type: snapshot.violation_type,
    ban_state: snapshot.ban_state,
    ban_date: snapshot.ban_date,
    restriction_info: snapshot.restrictions,
    remediation: snapshot.remediation,
    raw_payload: { entry, change },
    occurred_at: occurredAt,
    status: isResolution ? 'resolved' : 'open',
    appealable: snapshot.appealable,
    provider_resolution: isResolution ? (isReinstatement ? 'REINSTATE' : `${event}:ACTIVE`) : null,
    resolved_at: isResolution ? occurredAt : null,
  };
  const [incident, created] = await WhatsappAccountComplianceIncident.findOrCreate({
    where: { dedupe_key: dedupeKey },
    defaults: incidentDefaults,
  });
  if (!created && (
    Number(incident.clinic_id || 0) !== Number(context.clinicId || 0)
    || Number(incident.group_id || 0) !== Number(context.groupId || 0)
    || Number(incident.asset_id || 0) !== Number(context.primary?.id || 0)
  )) {
    await incident.update({
      clinic_id: context.clinicId,
      group_id: context.groupId,
      asset_id: context.primary?.id || null,
    });
  }

  const storedSnapshot = {
    ...snapshot,
    incident_id: Number(incident.id),
    review_status: incident.status,
    occurred_at: occurredAt.toISOString(),
    updated_at: new Date().toISOString(),
  };
  await updateAssetsCompliance(assets, storedSnapshot);

  if (created && (!isResolution || isReinstatement)) {
    await notificationService.dispatchEvent({
      event: isReinstatement
        ? 'whatsapp.account_compliance_resolved'
        : 'whatsapp.account_compliance_incident',
      clinicId: context.clinicId,
      data: {
        clinicId: context.clinicId,
        groupId: context.groupId,
        clinicName: context.groupName || context.clinicName,
        incidentId: Number(incident.id),
        wabaId,
        phoneNumber: incident.phone_number,
        operationalStatus: snapshot.status,
        violationType: snapshot.violation_type,
        violationLabel: snapshot.violation_label,
        link: '/ajustes?panel=jobs-monitoring&tab=whatsapp',
        useRouter: true,
        actionLabel: 'Revisar WhatsApp',
        actionIcon: 'heroicons_outline:shield-exclamation',
      },
    });
  }

  return { incident: toPlain(incident), snapshot: storedSnapshot, created };
}

async function reconcileStoredAccountUpdate(asset) {
  const storedUpdate = getStoredAccountUpdate(asset);
  if (!storedUpdate) return null;

  const currentSnapshot = summarizeCompliance(asset.additionalData || {});
  const currentUpdatedAt = new Date(
    currentSnapshot?.updated_at || currentSnapshot?.occurred_at || 0
  ).getTime();
  if (Number.isFinite(currentUpdatedAt) && currentUpdatedAt >= storedUpdate.receivedAt.getTime()) {
    return null;
  }

  return handleAccountUpdate({
    entry: storedUpdate.entry,
    change: storedUpdate.change,
    value: storedUpdate.value,
    clinicId: asset.clinicaId || null,
  });
}

async function handleBusinessUsernameUpdate({ entry, change, value, clinicId }) {
  const field = clean(change?.field).toLowerCase();
  if (field !== 'business_username_updates') return null;
  const wabaId = clean(entry?.id || value?.waba_id) || null;
  const phoneNumberId = clean(value?.phone_number_id || value?.metadata?.phone_number_id) || null;
  const assets = await findRelevantAssets({ wabaId, phoneNumberId, clinicId });
  const usernameSnapshot = {
    username: clean(value?.business_username || value?.username) || null,
    status: clean(value?.status || value?.event) || null,
    phone_number_id: phoneNumberId,
    received_at: new Date().toISOString(),
    raw: value || null,
  };
  await Promise.all(assets.map(async (asset) => {
    const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
      ? { ...asset.additionalData }
      : {};
    additionalData.businessUsername = usernameSnapshot;
    asset.additionalData = additionalData;
    asset.changed('additionalData', true);
    await asset.save();
  }));
  return usernameSnapshot;
}

async function loadActivitySummary({ clinicId, groupId }) {
  let clinicIds = clinicId ? [Number(clinicId)] : [];
  if (groupId) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: Number(groupId) },
      attributes: ['id_clinica'],
      raw: true,
    });
    clinicIds = clinics.map((clinic) => Number(clinic.id_clinica));
  }
  if (!clinicIds.length || !Conversation || !Message) {
    return {
      last_24h: 0,
      last_7d: 0,
      failed_7d: 0,
      accepted_7d: 0,
      status_counts: {},
      recent: [],
    };
  }

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const scopedInclude = [{
      model: Conversation,
      as: 'conversation',
      required: true,
      where: { clinic_id: { [Op.in]: clinicIds } },
      attributes: ['clinic_id'],
    }];
  const baseWhere = {
    direction: 'outbound',
    createdAt: { [Op.gte]: since7d },
  };
  const [last7d, last24h, statusRows, messages, recentFailures] = await Promise.all([
    Message.count({ where: baseWhere, include: scopedInclude, distinct: true }),
    Message.count({
      where: { ...baseWhere, createdAt: { [Op.gte]: since24h } },
      include: scopedInclude,
      distinct: true,
    }),
    Message.findAll({
      attributes: ['status', [fn('COUNT', col('Message.id')), 'count']],
      where: baseWhere,
      include: scopedInclude.map((include) => ({ ...include, attributes: [] })),
      group: ['Message.status'],
      raw: true,
    }),
    Message.findAll({
      where: baseWhere,
      include: scopedInclude,
      order: [['createdAt', 'DESC']],
      limit: 500,
    }),
    Message.findAll({
      where: { ...baseWhere, status: 'failed' },
      include: scopedInclude,
      order: [['createdAt', 'DESC']],
      limit: 500,
    }),
  ]);
  const plain = messages.map(toPlain);
  const failurePlain = recentFailures.map(toPlain);
  const statusCounts = statusRows.reduce((acc, row) => {
    const status = clean(row.status).toLowerCase() || 'unknown';
    acc[status] = Number(row.count || 0);
    return acc;
  }, {});
  const sourceOf = (message) => {
    const metadata = message.metadata || {};
    if (metadata.automation_delivery_key || metadata.automation_flow_id || metadata.flow_execution_id) {
      return 'automation';
    }
    if (metadata.bulk_send_job_id || metadata.marketing_bulk_job_id || metadata.campaign_id) {
      return 'campaign';
    }
    return message.sender_id ? 'manual' : 'system';
  };
  const errorsOf = (message) => {
    const metadata = message.metadata || {};
    const providerErrors = Array.isArray(metadata.wa_error)
      ? metadata.wa_error
      : (metadata.wa_error ? [metadata.wa_error] : []);
    if (providerErrors.length) {
      return providerErrors.map((error) => ({
        code: error?.code || null,
        title: error?.title || null,
        message: error?.message || null,
        details: error?.error_data?.details || null,
        href: error?.href || null,
      }));
    }
    const localError = clean(metadata.error || metadata.enqueue_error || metadata.last_error);
    return localError ? [{ code: null, title: null, message: localError, details: null, href: null }] : [];
  };
  const serializeActivityMessage = (message) => ({
    id: message.id,
    clinic_id: message.conversation?.clinic_id || null,
    wamid: clean(message.metadata?.wamid) || null,
    sent_at: message.sent_at || message.createdAt,
    type: message.message_type,
    status: message.status,
    source: sourceOf(message),
    errors: errorsOf(message),
    status_history: Array.isArray(message.metadata?.wa_status_history)
      ? message.metadata.wa_status_history.slice(-8)
      : [],
    excerpt: clean(message.content).slice(0, 180),
  });
  const sourceCounts = plain.reduce((acc, message) => {
    const source = sourceOf(message);
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  const errorCounts = failurePlain.reduce((acc, message) => {
    errorsOf(message).forEach((error) => {
      const key = clean(error.code || error.title || error.message) || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
    });
    return acc;
  }, {});
  return {
    last_24h: Number(last24h || 0),
    last_7d: Number(last7d || 0),
    failed_7d: Number(statusCounts.failed || 0),
    accepted_7d: ['sent', 'delivered', 'read'].reduce(
      (total, status) => total + Number(statusCounts[status] || 0),
      0
    ),
    status_counts: statusCounts,
    source_counts: sourceCounts,
    source_sample_size: plain.length,
    error_counts: errorCounts,
    error_sample_size: failurePlain.length,
    recent: plain.slice(0, 20).map(serializeActivityMessage),
    recent_failures: failurePlain.slice(0, 10).map(serializeActivityMessage),
  };
}

async function loadIncidentAccount(incident) {
  let asset = incident?.asset_id
    ? await ClinicMetaAsset.findByPk(incident.asset_id)
    : null;
  if (!asset && (incident?.phone_number_id || incident?.waba_id)) {
    const scope = [];
    if (incident.phone_number_id) scope.push({ phoneNumberId: String(incident.phone_number_id) });
    if (incident.waba_id) scope.push({ wabaId: String(incident.waba_id) });
    asset = await ClinicMetaAsset.findOne({
      where: {
        isActive: true,
        assetType: 'whatsapp_phone_number',
        [Op.or]: scope,
      },
      order: [['updatedAt', 'DESC']],
    });
  }
  if (!asset) return null;
  const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
    ? asset.additionalData
    : {};
  return {
    asset_id: Number(asset.id),
    verified_name: asset.waVerifiedName || null,
    waba_id: asset.wabaId || null,
    phone_number_id: asset.phoneNumberId || null,
    phone_number: asset.metaAssetName || null,
    quality_rating: asset.quality_rating || null,
    messaging_limit: asset.messaging_limit || null,
    account_mode: additionalData.accountMode || null,
    platform_type: additionalData.platformType || null,
  };
}

async function serializeIncident(row, { includeActivity = false, includeRaw = true } = {}) {
  const incident = toPlain(row);
  const payload = {
    ...incident,
    violation_label: incident.violation_type
      ? (VIOLATION_LABELS[incident.violation_type] || incident.violation_type)
      : null,
    violation_description: deriveComplianceSnapshot({
      event: incident.provider_event,
      violation_info: incident.violation_type ? { violation_type: incident.violation_type } : null,
      restriction_info: incident.restriction_info || [],
      ban_info: incident.ban_state ? { waba_ban_state: incident.ban_state, waba_ban_date: incident.ban_date } : null,
    }).violation_description,
    business_support_url: BUSINESS_SUPPORT_HOME_URL,
  };
  if (!includeRaw) {
    delete payload.raw_payload;
    delete payload.appeal_context;
    delete payload.appeal_draft;
  }
  if (includeActivity) {
    [payload.activity, payload.account] = await Promise.all([
      loadActivitySummary({
        clinicId: incident.clinic_id,
        groupId: incident.group_id,
      }),
      loadIncidentAccount(incident),
    ]);
  }
  return payload;
}

async function listIncidents({ clinicIds = null, groupIds = null, status = null, limit = 100, includeActivity = false, includeRaw = false } = {}) {
  const where = {};
  if (Array.isArray(clinicIds) || Array.isArray(groupIds)) {
    const scope = [];
    if (Array.isArray(clinicIds) && clinicIds.length) {
      scope.push({ clinic_id: { [Op.in]: clinicIds.map(Number) } });
    }
    if (Array.isArray(groupIds) && groupIds.length) {
      scope.push({ group_id: { [Op.in]: groupIds.map(Number) } });
    }
    where[Op.or] = scope.length ? scope : [{ clinic_id: -1 }];
  }
  if (status === 'open') where.status = { [Op.in]: OPEN_STATUSES };
  if (status && status !== 'all' && status !== 'open') where.status = status;
  const rows = await WhatsappAccountComplianceIncident.findAll({
    where,
    include: [
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'], required: false },
      { model: GrupoClinica, as: 'group', attributes: ['id_grupo', 'nombre_grupo'], required: false },
    ],
    order: [['occurred_at', 'DESC'], ['id', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
  });
  return Promise.all(rows.map((row) => serializeIncident(row, { includeActivity, includeRaw })));
}

async function getIncidentById(incidentId, { includeActivity = false } = {}) {
  const row = await WhatsappAccountComplianceIncident.findByPk(Number(incidentId), {
    include: [
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'], required: false },
      { model: GrupoClinica, as: 'group', attributes: ['id_grupo', 'nombre_grupo'], required: false },
    ],
  });
  return row ? serializeIncident(row, { includeActivity }) : null;
}

async function getClinicStatus(clinicId) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  if (!clinic) return { configured: false, compliance: null, incidents: [] };
  const assets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: 'whatsapp_phone_number',
      [Op.or]: [
        { clinicaId: Number(clinicId) },
        ...(clinic.grupoClinicaId ? [{ assignmentScope: 'group', grupoClinicaId: clinic.grupoClinicaId }] : []),
      ],
    },
    order: [['updatedAt', 'DESC']],
  });
  const asset = assets.find((item) => summarizeCompliance(item.additionalData || {})) || assets[0] || null;
  const incidents = await listIncidents({
    clinicIds: [Number(clinicId)],
    groupIds: clinic.grupoClinicaId ? [Number(clinic.grupoClinicaId)] : [],
    status: 'open',
    limit: 10,
  });
  return {
    configured: !!asset,
    phone_number_id: asset?.phoneNumberId || null,
    phone_number: asset?.metaAssetName || null,
    waba_id: asset?.wabaId || null,
    compliance: asset ? summarizeCompliance(asset.additionalData || {}) : null,
    business_username: asset?.additionalData?.businessUsername || null,
    incidents,
  };
}

async function clinicCanAccessIncident(clinicId, incident) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  if (!clinic) return false;
  if (Number(incident.clinic_id) === Number(clinicId)) return true;
  if (incident.group_id && Number(incident.group_id) === Number(clinic.grupoClinicaId)) return true;

  const assets = await findRelevantAssets({
    wabaId: incident.waba_id,
    phoneNumberId: incident.phone_number_id,
    clinicId,
  });
  return assets.some((asset) => Number(asset.clinicaId) === Number(clinicId)
    || (
      isGroupScopedAsset(asset)
      && clinic.grupoClinicaId
      && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId)
    ));
}

async function requestClinicClickReview({ clinicId, incidentId, userId }) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  const where = {
    ...(incidentId ? { id: Number(incidentId) } : {}),
    status: { [Op.in]: OPEN_STATUSES },
  };
  if (!incidentId) {
    where[Op.or] = [
      { clinic_id: Number(clinicId) },
      ...(clinic?.grupoClinicaId ? [{ group_id: Number(clinic.grupoClinicaId) }] : []),
    ];
  }
  const incident = await WhatsappAccountComplianceIncident.findOne({
    where,
    order: [['occurred_at', 'DESC']],
  });
  if (!incident) {
    const error = new Error('whatsapp_compliance_incident_not_found');
    error.statusCode = 404;
    throw error;
  }
  if (!await clinicCanAccessIncident(clinicId, incident)) {
    const error = new Error('whatsapp_compliance_incident_scope_forbidden');
    error.statusCode = 403;
    throw error;
  }
  if (incident.appealable === false) {
    const error = new Error('whatsapp_compliance_incident_not_appealable');
    error.statusCode = 409;
    throw error;
  }
  incident.status = 'clinicaclick_review_requested';
  incident.client_requested_at = incident.client_requested_at || new Date();
  incident.client_requested_by = incident.client_requested_by || userId || null;
  await incident.save();
  await updateIncidentReviewSnapshot(incident);
  await notificationService.dispatchEvent({
    event: 'whatsapp.account_compliance_help_requested',
    clinicId: Number(clinicId),
    data: {
      incidentId: Number(incident.id),
      clinicId: Number(clinicId),
      phoneNumber: incident.phone_number,
      link: '/ajustes?panel=jobs-monitoring&tab=whatsapp',
      useRouter: true,
      actionLabel: 'Preparar revisión',
      actionIcon: 'heroicons_outline:document-magnifying-glass',
    },
  });
  return serializeIncident(incident);
}

function buildAppealDraft({ incident, clinicName, groupName, account, activity, serviceContext, reviewNotes }) {
  const accountName = account?.verified_name || groupName || clinicName || 'la cuenta indicada';
  const violation = incident.violation_type
    ? `Motivo comunicado por WhatsApp: ${VIOLATION_LABELS[incident.violation_type] || incident.violation_type}.`
    : 'WhatsApp no ha comunicado una categoría o motivo adicional; el webhook sí informa de las restricciones detalladas a continuación.';
  const restrictions = Array.isArray(incident.restriction_info)
    ? incident.restriction_info.filter(item => item?.active !== false)
    : [];
  const restrictionLines = restrictions.length
    ? restrictions.map((restriction) => {
        const label = clean(restriction?.restriction_label || restriction?.restriction_type) || 'Restricción sin descripción';
        const technical = restriction?.restriction_label && restriction?.restriction_type
          ? ` [${restriction.restriction_type}]`
          : '';
        const expiry = restriction?.expiration
          ? `, vigente hasta ${new Date(restriction.expiration).toISOString()}`
          : '';
        return `- ${label}${technical}${expiry}`;
      }).join('\n')
    : '- WhatsApp no incluyó un detalle estructurado de restricciones.';
  const statusCounts = activity?.status_counts || {};
  const statusSummary = [
    ['enviados', statusCounts.sent],
    ['entregados', statusCounts.delivered],
    ['leídos', statusCounts.read],
    ['pendientes', statusCounts.pending],
    ['fallidos', statusCounts.failed],
  ]
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([label, value]) => `${value} ${label}`)
    .join(', ');
  const context = clean(serviceContext)
    || 'La cuenta se utiliza para comunicaciones asistenciales y administrativas de la clínica. Antes de presentar esta revisión se comprobará la base y autorización aplicables a los envíos analizados.';
  const notes = clean(reviewNotes)
    || 'Clinicaclick ha recopilado la actividad reciente y los estados técnicos disponibles para que Meta pueda revisar el caso.';
  return [
    `Solicitamos la revisión de la medida aplicada a la cuenta de WhatsApp Business ${accountName}.`,
    [
      'Identificación de la cuenta:',
      `- Alcance en Clinicaclick: ${groupName || clinicName || 'sin identificar'}`,
      `- Nombre verificado: ${account?.verified_name || 'sin dato'}`,
      `- Teléfono: ${incident.phone_number || account?.phone_number || 'sin dato'}`,
      `- WABA ID: ${incident.waba_id || account?.waba_id || 'sin dato'}`,
      `- Phone Number ID: ${incident.phone_number_id || account?.phone_number_id || 'sin dato'}`,
      `- Evento recibido: ${incident.provider_event || 'sin dato'}`,
      `- Fecha del evento: ${incident.occurred_at ? new Date(incident.occurred_at).toISOString() : 'sin dato'}`,
      `- Estado operativo: ${incident.operational_status || 'sin dato'}`,
      `- Calidad informada: ${account?.quality_rating || 'sin dato'}`,
      `- Capacidad informada: ${account?.messaging_limit || 'sin dato'}`,
    ].join('\n'),
    violation,
    `Restricciones comunicadas por WhatsApp:\n${restrictionLines}`,
    `Actividad disponible al preparar la revisión (últimos 7 días): ${Number(activity?.last_7d || 0)} mensajes registrados, ${Number(activity?.accepted_7d || 0)} aceptados por Meta y ${Number(activity?.failed_7d || 0)} fallidos${statusSummary ? ` (${statusSummary})` : ''}.`,
    `Contexto del servicio: ${context}`,
    `Revisión realizada: ${notes}`,
    'Solicitamos que se reevalúe la medida y, si corresponde, se restablezca la cuenta. Podemos aportar información adicional sobre la operativa y, cuando proceda, las bases y autorizaciones de contacto verificadas.',
  ].join('\n\n');
}

async function prepareAppeal({ incidentId, userId, serviceContext, reviewNotes }) {
  const incident = await WhatsappAccountComplianceIncident.findByPk(incidentId, {
    include: [
      { model: Clinica, as: 'clinic', attributes: ['nombre_clinica'], required: false },
      { model: GrupoClinica, as: 'group', attributes: ['nombre_grupo'], required: false },
    ],
  });
  if (!incident) {
    const error = new Error('whatsapp_compliance_incident_not_found');
    error.statusCode = 404;
    throw error;
  }
  if (incident.appealable === false) {
    const error = new Error('whatsapp_compliance_incident_not_appealable');
    error.statusCode = 409;
    throw error;
  }
  const [activity, account] = await Promise.all([
    loadActivitySummary({ clinicId: incident.clinic_id, groupId: incident.group_id }),
    loadIncidentAccount(incident),
  ]);
  incident.appeal_draft = buildAppealDraft({
    incident,
    clinicName: incident.clinic?.nombre_clinica,
    groupName: incident.group?.nombre_grupo,
    account,
    activity,
    serviceContext,
    reviewNotes,
  });
  incident.appeal_context = {
    service_context: clean(serviceContext) || null,
    review_notes: clean(reviewNotes) || null,
    activity,
    account,
    prepared_from_provider_payload: true,
  };
  incident.appeal_prepared_at = new Date();
  incident.appeal_prepared_by = userId || null;
  incident.status = 'draft_ready';
  await incident.save();
  await updateIncidentReviewSnapshot(incident);
  return serializeIncident(incident, { includeActivity: true });
}

async function markAppealSubmitted({ incidentId, userId }) {
  const incident = await WhatsappAccountComplianceIncident.findByPk(incidentId);
  if (!incident) {
    const error = new Error('whatsapp_compliance_incident_not_found');
    error.statusCode = 404;
    throw error;
  }
  if (!clean(incident.appeal_draft)) {
    const error = new Error('whatsapp_compliance_appeal_draft_required');
    error.statusCode = 409;
    throw error;
  }
  incident.status = 'submitted';
  incident.appeal_submitted_at = new Date();
  incident.appeal_submitted_by = userId || null;
  await incident.save();
  await updateIncidentReviewSnapshot(incident);
  return serializeIncident(incident, { includeActivity: true });
}

async function diagnoseAccount({ assetId, userId }) {
  const asset = await ClinicMetaAsset.findByPk(assetId);
  if (!asset || asset.assetType !== 'whatsapp_phone_number') {
    const error = new Error('whatsapp_compliance_asset_not_found');
    error.statusCode = 404;
    throw error;
  }

  const checkedAt = new Date();
  let providerCheck = null;
  let providerError = null;
  try {
    providerCheck = await syncPhonesForWaba({
      wabaId: asset.wabaId,
      accessToken: asset.waAccessToken,
      ensureTemplates: false,
    });
  } catch (error) {
    providerError = serializeProviderError(error);
  }

  let current = await ClinicMetaAsset.findByPk(asset.id);
  if (current) {
    await reconcileStoredAccountUpdate(current);
    current = await ClinicMetaAsset.findByPk(asset.id);
  }
  const context = await resolveClinicContext({ assets: current ? [current] : [asset], clinicId: asset.clinicaId });
  const activity = await loadActivitySummary({
    clinicId: context.clinicId,
    groupId: context.groupId,
  });
  const additionalData = current?.additionalData && typeof current.additionalData === 'object'
    ? { ...current.additionalData }
    : {};
  const registration = additionalData.registration || {};
  const coexistence = additionalData.coexistence || {};
  const diagnostic = {
    checked_at: checkedAt.toISOString(),
    checked_by: userId || null,
    api_accessible: !providerError,
    provider_check: providerCheck,
    provider_error: providerError,
    phone_status: registration.phoneStatus || null,
    registration_status: registration.status || null,
    code_verification_status: registration.codeVerificationStatus || null,
    connection_mode: additionalData.whatsappConnectionMode || additionalData.connectionMode || null,
    coexistence_status: coexistence.status || additionalData.coexistenceStatus || null,
    platform_type: additionalData.platformType || null,
    account_mode: additionalData.accountMode || null,
    is_on_biz_app: additionalData.isOnBizApp ?? null,
    name_status: additionalData.nameStatus || null,
    quality_rating: current?.quality_rating || asset.quality_rating || null,
    messaging_limit: current?.messaging_limit || asset.messaging_limit || null,
    compliance: summarizeCompliance(additionalData),
    compliance_source: 'account_update_webhook',
    recent_delivery: activity.recent[0] || null,
    recent_failures: activity.recent_failures || [],
    delivery_summary_7d: {
      total: activity.last_7d,
      accepted: activity.accepted_7d,
      failed: activity.failed_7d,
      status_counts: activity.status_counts,
      source_counts: activity.source_counts,
      source_sample_size: activity.source_sample_size,
      error_counts: activity.error_counts,
      error_sample_size: activity.error_sample_size,
    },
  };

  if (current) {
    additionalData.whatsappDiagnostics = diagnostic;
    current.additionalData = additionalData;
    current.changed('additionalData', true);
    await current.save();
  }

  return {
    account: {
      id: current?.id || asset.id,
      clinic_id: current?.clinicaId || asset.clinicaId || null,
      group_id: current?.grupoClinicaId || asset.grupoClinicaId || null,
      phone_number_id: current?.phoneNumberId || asset.phoneNumberId || null,
      phone_number: current?.metaAssetName || asset.metaAssetName || null,
      verified_name: current?.waVerifiedName || asset.waVerifiedName || null,
    },
    diagnostic,
    activity,
  };
}

module.exports = {
  BUSINESS_SUPPORT_HOME_URL,
  COMPLIANCE_EVENTS,
  OPEN_STATUSES,
  buildAppealDraft,
  diagnoseAccount,
  getClinicStatus,
  getIncidentById,
  handleAccountUpdate,
  handleBusinessUsernameUpdate,
  getStoredAccountUpdate,
  listIncidents,
  markAppealSubmitted,
  prepareAppeal,
  requestClinicClickReview,
  serializeIncident,
  summarizeCompliance,
};
