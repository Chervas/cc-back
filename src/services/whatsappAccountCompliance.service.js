'use strict';

const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const notificationService = require('./notifications.service');
const { syncPhonesForWaba } = require('./whatsappPhones.service');
const whatsappAccountHealthService = require('./whatsappAccountHealth.service');
const { buildWhatsappProfileAlignment } = require('../lib/whatsapp-profile-alignment');
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
const TECHNICAL_EVENT_LABELS = Object.freeze({
  ACCOUNT_REVIEW_REJECTED: 'Meta ha rechazado la revisión de la cuenta WABA',
  BUSINESS_VERIFICATION_REJECTED: 'Meta ha rechazado la verificación empresarial',
  PHONE_NUMBER_BANNED: 'Meta informa que el número está baneado',
  WABA_HEALTH_BLOCKED: 'Meta informa que la salud del WABA bloquea los envíos',
  WHATSAPP_ACCOUNT_HEALTH_REVIEW: 'El estado técnico de la cuenta requiere revisión',
});
const TECHNICAL_EVENT_DESCRIPTIONS = Object.freeze({
  ACCOUNT_REVIEW_REJECTED: 'El webhook o la consulta de estado de Meta informa de una decisión REJECTED. La causa adicional solo se muestra cuando Meta la facilita.',
  BUSINESS_VERIFICATION_REJECTED: 'La empresa no ha superado la verificación de Meta. Este estado no demuestra por sí solo la causa de cualquier otro bloqueo simultáneo.',
  PHONE_NUMBER_BANNED: 'El estado operativo del número informado por Meta es BANNED.',
  WABA_HEALTH_BLOCKED: 'El objeto health_status del WABA informa can_send_message=BLOCKED. Los errores por entidad se detallan por separado.',
  WHATSAPP_ACCOUNT_HEALTH_REVIEW: 'Clinicaclick ha creado el expediente desde el último estado técnico saneado disponible.',
});
const MANUAL_REVIEW_INCIDENT_EVENTS = Object.freeze([
  ...COMPLIANCE_EVENTS,
  ...Object.keys(TECHNICAL_EVENT_LABELS),
]);

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const storedEvent = clean(stored.event).toUpperCase();
  const snapshot = storedEvent && COMPLIANCE_EVENTS.has(storedEvent)
    ? deriveComplianceSnapshot({
        event: storedEvent,
        violation_info: stored.violation_type ? { violation_type: stored.violation_type } : null,
        ban_info: stored.ban_state ? {
          waba_ban_state: stored.ban_state,
          waba_ban_date: stored.ban_date,
        } : null,
        restriction_info: stored.restrictions || [],
        appealable: typeof stored.appealable === 'boolean' ? stored.appealable : undefined,
      })
    : {};
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
      clinic: null,
      clinicId: null,
      clinicName: null,
      groupId,
      groupName: group?.nombre_grupo || null,
    };
  }

  const effectiveClinicId = Number(primary?.clinicaId || clinicId || 0) || null;
  const clinic = effectiveClinicId
    ? await Clinica.findByPk(effectiveClinicId, {
        attributes: [
          'id_clinica',
          'nombre_clinica',
          'grupoClinicaId',
          'direccion',
          'codigo_postal',
          'ciudad',
          'provincia',
          'pais',
        ],
        raw: true,
      })
    : null;
  return {
    primary,
    clinic,
    clinicId: effectiveClinicId,
    clinicName: clinic?.nombre_clinica || null,
    groupId: clinic?.grupoClinicaId || null,
    groupName: null,
  };
}

async function resolveOpenIncidents({ wabaId, providerResolution, occurredAt, providerEvents = null }) {
  if (!WhatsappAccountComplianceIncident || !wabaId) return 0;
  const [count] = await WhatsappAccountComplianceIncident.update({
    status: 'resolved',
    provider_resolution: providerResolution,
    resolved_at: occurredAt || new Date(),
  }, {
    where: {
      waba_id: String(wabaId),
      status: { [Op.in]: OPEN_STATUSES },
      ...(Array.isArray(providerEvents) && providerEvents.length
        ? { provider_event: { [Op.in]: providerEvents } }
        : {}),
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

function buildAccountReviewSnapshot(value = {}) {
  const decision = clean(value.decision).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) return null;
  const rejectionReason = clean(value.rejection_reason).slice(0, 500) || null;
  const rejected = decision === 'REJECTED';
  return {
    event: `ACCOUNT_REVIEW_${decision}`,
    status: rejected ? 'restricted' : 'active',
    severity: rejected ? 'error' : 'info',
    violation_type: null,
    violation_label: rejected
      ? (rejectionReason || TECHNICAL_EVENT_LABELS.ACCOUNT_REVIEW_REJECTED)
      : null,
    violation_description: rejected
      ? TECHNICAL_EVENT_DESCRIPTIONS.ACCOUNT_REVIEW_REJECTED
      : null,
    ban_state: null,
    ban_date: null,
    restrictions: rejected && rejectionReason
      ? [{
          restriction_type: 'ACCOUNT_REVIEW_REJECTED',
          restriction_label: rejectionReason,
          expiration: null,
          remediation: 'Revisar el caso en Meta Business Support Home y aportar la documentación solicitada.',
          active: true,
        }]
      : [],
    remediation: rejected
      ? 'Revisar el caso en Meta Business Support Home y aportar la documentación solicitada.'
      : null,
    appealable: rejected ? null : false,
    blocks_all_sending: rejected,
    blocks_business_initiated: rejected,
    blocks_customer_replies: rejected,
    blocks_phone_changes: false,
    blocks_calling: false,
    review_decision: decision,
    rejection_reason: rejectionReason,
  };
}

async function handleAccountReviewUpdate({ entry, change, value, clinicId }) {
  const field = clean(change?.field).toLowerCase();
  if (field !== 'account_review_update') return null;
  const snapshot = buildAccountReviewSnapshot(value);
  if (!snapshot) return null;

  const wabaId = clean(entry?.id || value?.waba_id) || null;
  const phoneNumberId = clean(value?.metadata?.phone_number_id) || null;
  const phoneNumber = clean(value?.display_phone_number || value?.metadata?.display_phone_number) || null;
  const occurredAt = occurredAtFromEntry(entry);
  const assets = await findRelevantAssets({ wabaId, phoneNumberId, clinicId });
  const context = await resolveClinicContext({ assets, clinicId });
  const isResolution = snapshot.review_decision === 'APPROVED';

  if (isResolution) {
    await resolveOpenIncidents({
      wabaId,
      providerResolution: 'ACCOUNT_REVIEW_APPROVED',
      occurredAt,
      providerEvents: ['ACCOUNT_REVIEW_REJECTED'],
    });
  }

  const dedupeKey = buildDedupeKey({ wabaId, field, entry, value });
  const [incident, created] = await WhatsappAccountComplianceIncident.findOrCreate({
    where: { dedupe_key: dedupeKey },
    defaults: {
      dedupe_key: dedupeKey,
      clinic_id: context.clinicId,
      group_id: context.groupId,
      asset_id: context.primary?.id || null,
      waba_id: wabaId,
      phone_number_id: phoneNumberId || context.primary?.phoneNumberId || null,
      phone_number: phoneNumber || context.primary?.metaAssetName || null,
      webhook_field: field,
      provider_event: snapshot.event,
      severity: snapshot.severity,
      operational_status: snapshot.status,
      violation_type: null,
      ban_state: null,
      ban_date: null,
      restriction_info: snapshot.restrictions,
      remediation: snapshot.remediation,
      raw_payload: { entry, change },
      occurred_at: occurredAt,
      status: isResolution ? 'resolved' : 'open',
      appealable: snapshot.appealable,
      provider_resolution: isResolution ? 'ACCOUNT_REVIEW_APPROVED' : null,
      resolved_at: isResolution ? occurredAt : null,
    },
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

  const currentReviewEvent = clean(context.primary?.additionalData?.whatsappCompliance?.event).toUpperCase();
  if (!isResolution || currentReviewEvent === 'ACCOUNT_REVIEW_REJECTED') {
    const storedSnapshot = {
      ...snapshot,
      incident_id: Number(incident.id),
      review_status: incident.status,
      occurred_at: occurredAt.toISOString(),
      updated_at: new Date().toISOString(),
    };
    await updateAssetsCompliance(assets, storedSnapshot);
  }

  if (created) {
    await notificationService.dispatchEvent({
      event: isResolution
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
        violationLabel: snapshot.violation_label,
        link: `/ajustes?panel=jobs-monitoring&tab=whatsapp&whatsapp_section=incidents&incident_id=${Number(incident.id)}`,
        useRouter: true,
        actionLabel: 'Revisar WhatsApp',
        actionIcon: 'heroicons_outline:shield-exclamation',
      },
    });
  }

  return { incident: toPlain(incident), snapshot, created };
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

function messagePhoneRouteExpression() {
  return [
    "NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`Message`.`metadata`, '$.phoneNumberId')), '')",
    "NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`Message`.`metadata`, '$.phoneId')), '')",
    "NULLIF(JSON_UNQUOTE(JSON_EXTRACT(`Message`.`metadata`, '$.phone_number_id')), '')",
  ].join(', ');
}

function buildActivityRouteWhere({ phoneNumberId, mode }) {
  const target = clean(phoneNumberId);
  if (!target) return null;
  const route = `COALESCE(${messagePhoneRouteExpression()})`;
  return literal(mode === 'missing'
    ? `${route} IS NULL`
    : `${route} = ${db.sequelize.escape(target)}`);
}

async function resolveActivityScope({ clinicId, groupId, account }) {
  const resolvedGroupId = Number(account?.group_id || groupId || 0) || null;
  const resolvedClinicId = Number(account?.clinic_id || clinicId || 0) || null;
  let clinicIds = resolvedClinicId ? [resolvedClinicId] : [];
  if (resolvedGroupId) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: resolvedGroupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    clinicIds = clinics.map((clinic) => Number(clinic.id_clinica));
  }

  const phoneNumberId = clean(account?.phone_number_id);
  if (!phoneNumberId || !clinicIds.length) {
    return {
      phoneNumberId: phoneNumberId || null,
      clinicIds,
      inferredClinicIds: clinicIds,
      scopedByRoute: false,
    };
  }

  let inferredClinicIds = clinicIds;
  if (resolvedGroupId) {
    const directAssets = await ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        assetType: 'whatsapp_phone_number',
        clinicaId: { [Op.in]: clinicIds },
      },
      attributes: ['clinicaId', 'phoneNumberId'],
      raw: true,
    });
    const directByClinic = new Map();
    directAssets.forEach((asset) => {
      const key = Number(asset.clinicaId);
      if (!directByClinic.has(key)) directByClinic.set(key, []);
      directByClinic.get(key).push(clean(asset.phoneNumberId));
    });
    inferredClinicIds = clinicIds.filter((id) => {
      const directPhoneIds = directByClinic.get(Number(id)) || [];
      return directPhoneIds.length === 0 || directPhoneIds.includes(phoneNumberId);
    });
  }

  return {
    phoneNumberId,
    clinicIds,
    inferredClinicIds,
    scopedByRoute: true,
  };
}

async function loadActivitySummary({ clinicId, groupId, account = null }) {
  const activityScope = await resolveActivityScope({ clinicId, groupId, account });
  const clinicIds = activityScope.clinicIds;
  if (!clinicIds.length || !Conversation || !Message) {
    return {
      last_24h: 0,
      last_7d: 0,
      failed_7d: 0,
      accepted_7d: 0,
      confirmed_7d: 0,
      without_confirmation_7d: 0,
      pending_7d: 0,
      status_counts: {},
      attribution: {
        phone_number_id: activityScope.phoneNumberId,
        exact_7d: 0,
        inferred_7d: 0,
        unattributed_7d: 0,
        scoped_by_route: activityScope.scopedByRoute,
      },
      recent: [],
    };
  }

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const scopedInclude = (scopeClinicIds, includeAttributes = true) => [{
      model: Conversation,
      as: 'conversation',
      required: true,
      where: { clinic_id: { [Op.in]: scopeClinicIds } },
      attributes: includeAttributes ? ['clinic_id'] : [],
    }];
  const baseWhere = {
    direction: 'outbound',
    createdAt: { [Op.gte]: since7d },
  };
  const routeScopes = activityScope.scopedByRoute
    ? [{
        kind: 'exact',
        clinicIds,
        routeWhere: buildActivityRouteWhere({ phoneNumberId: activityScope.phoneNumberId, mode: 'exact' }),
      }]
    : [{ kind: 'legacy', clinicIds, routeWhere: null }];
  const queryScope = async (scope) => {
    const routeWhere = scope.routeWhere ? { [Op.and]: [scope.routeWhere] } : {};
    const where7d = { ...baseWhere, ...routeWhere };
    const [last7d, last24h, statusRows, messages, recentFailures] = await Promise.all([
      Message.count({
        where: where7d,
        include: scopedInclude(scope.clinicIds),
        distinct: true,
      }),
      Message.count({
        where: { ...where7d, createdAt: { [Op.gte]: since24h } },
        include: scopedInclude(scope.clinicIds),
        distinct: true,
      }),
      Message.findAll({
        attributes: ['status', [fn('COUNT', col('Message.id')), 'count']],
        where: where7d,
        include: scopedInclude(scope.clinicIds, false),
        group: ['Message.status'],
        raw: true,
      }),
      Message.findAll({
        where: where7d,
        include: scopedInclude(scope.clinicIds),
        order: [['createdAt', 'DESC']],
        limit: 500,
      }),
      Message.findAll({
        where: { ...where7d, status: 'failed' },
        include: scopedInclude(scope.clinicIds),
        order: [['createdAt', 'DESC']],
        limit: 500,
      }),
    ]);
    return { kind: scope.kind, last7d, last24h, statusRows, messages, recentFailures };
  };
  const [results, unattributed7d] = await Promise.all([
    Promise.all(routeScopes.map(queryScope)),
    activityScope.scopedByRoute
      ? Message.count({
        where: {
          ...baseWhere,
          [Op.and]: [buildActivityRouteWhere({ phoneNumberId: activityScope.phoneNumberId, mode: 'missing' })],
        },
        include: scopedInclude(clinicIds),
        distinct: true,
      })
      : 0,
  ]);
  const last7d = results.reduce((total, result) => total + Number(result.last7d || 0), 0);
  const last24h = results.reduce((total, result) => total + Number(result.last24h || 0), 0);
  const plain = results
    .flatMap((result) => result.messages.map(toPlain))
    .sort((left, right) => new Date(right.createdAt || right.sent_at || 0) - new Date(left.createdAt || left.sent_at || 0))
    .slice(0, 500);
  const failurePlain = results
    .flatMap((result) => result.recentFailures.map(toPlain))
    .sort((left, right) => new Date(right.createdAt || right.sent_at || 0) - new Date(left.createdAt || left.sent_at || 0))
    .slice(0, 500);
  const statusCounts = results.flatMap((result) => result.statusRows).reduce((acc, row) => {
      const status = clean(row.status).toLowerCase() || 'unknown';
      acc[status] = (acc[status] || 0) + Number(row.count || 0);
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
    confirmed_7d: ['delivered', 'read'].reduce(
      (total, status) => total + Number(statusCounts[status] || 0),
      0
    ),
    without_confirmation_7d: Number(statusCounts.sent || 0),
    pending_7d: Number(statusCounts.pending || 0) + Number(statusCounts.sending || 0),
    status_counts: statusCounts,
    attribution: {
      phone_number_id: activityScope.phoneNumberId,
      exact_7d: Number(results.find((result) => result.kind === 'exact')?.last7d || 0),
      inferred_7d: 0,
      unattributed_7d: Number(unattributed7d || 0),
      scoped_by_route: activityScope.scopedByRoute,
    },
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
    assignment_scope: asset.assignmentScope || null,
    clinic_id: asset.clinicaId || null,
    group_id: asset.grupoClinicaId || null,
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
  const technicalEvent = clean(incident.provider_event).toUpperCase();
  const payload = {
    ...incident,
    violation_label: incident.violation_type
      ? (VIOLATION_LABELS[incident.violation_type] || incident.violation_type)
      : (TECHNICAL_EVENT_LABELS[technicalEvent] || null),
    violation_description: deriveComplianceSnapshot({
      event: incident.provider_event,
      violation_info: incident.violation_type ? { violation_type: incident.violation_type } : null,
      restriction_info: incident.restriction_info || [],
      ban_info: incident.ban_state ? { waba_ban_state: incident.ban_state, waba_ban_date: incident.ban_date } : null,
    }).violation_description || TECHNICAL_EVENT_DESCRIPTIONS[technicalEvent] || null,
    business_support_url: BUSINESS_SUPPORT_HOME_URL,
    source_type: incident.webhook_field === 'manual_health_review' ? 'manual_health_review' : 'meta_webhook',
  };
  if (!includeRaw) {
    delete payload.raw_payload;
    delete payload.appeal_context;
    delete payload.appeal_draft;
  }
  if (includeActivity) {
    payload.account = await loadIncidentAccount(incident);
    payload.activity = await loadActivitySummary({
      clinicId: incident.clinic_id,
      groupId: incident.group_id,
      account: payload.account,
    });
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

function buildTechnicalRestrictions(businessHealth = {}) {
  const rows = [];
  for (const entity of Array.isArray(businessHealth.entities) ? businessHealth.entities : []) {
    const entityType = clean(entity?.entity_type).toUpperCase() || 'ACCOUNT';
    for (const error of Array.isArray(entity?.errors) ? entity.errors : []) {
      const code = Number(error?.error_code || 0) || null;
      const description = clean(error?.error_description).slice(0, 500) || 'Meta ha comunicado un error técnico sin descripción.';
      rows.push({
        restriction_type: code ? `META_${entityType}_ERROR_${code}` : `META_${entityType}_ERROR`,
        restriction_label: description,
        expiration: null,
        remediation: clean(error?.possible_solution).slice(0, 500) || null,
        active: true,
        entity_type: entityType,
        entity_id: clean(entity?.id).slice(0, 255) || null,
        error_code: code,
      });
    }
  }

  const accountReviewStatus = clean(businessHealth.account_review_status).toUpperCase();
  const reviewReason = clean(businessHealth.account_review_rejection_reason).slice(0, 500);
  if (accountReviewStatus === 'REJECTED' && !rows.some((row) => row.restriction_type === 'ACCOUNT_REVIEW_REJECTED')) {
    rows.push({
      restriction_type: 'ACCOUNT_REVIEW_REJECTED',
      restriction_label: reviewReason || TECHNICAL_EVENT_LABELS.ACCOUNT_REVIEW_REJECTED,
      expiration: null,
      remediation: 'Abrir Meta Business Support Home y revisar el expediente de la cuenta WABA.',
      active: true,
      entity_type: 'WABA',
      entity_id: null,
      error_code: null,
    });
  }

  const verificationStatus = clean(businessHealth.business_verification_status).toLowerCase();
  if (['rejected', 'failed', 'revoked'].includes(verificationStatus)
    && !rows.some((row) => Number(row.error_code) === 141010)) {
    rows.push({
      restriction_type: 'BUSINESS_VERIFICATION_REJECTED',
      restriction_label: TECHNICAL_EVENT_LABELS.BUSINESS_VERIFICATION_REJECTED,
      expiration: null,
      remediation: 'Abrir la configuración del portfolio empresarial y resolver la verificación solicitada por Meta.',
      active: true,
      entity_type: 'BUSINESS',
      entity_id: clean(businessHealth.business_id).slice(0, 255) || null,
      error_code: null,
    });
  }
  return rows;
}

function buildManualReviewIncidentSpec({ asset, context, health, now = new Date(), userId = null }) {
  const additionalData = safeObject(asset?.additionalData);
  const businessHealth = safeObject(additionalData.whatsappBusinessHealth);
  const webhookSubscription = safeObject(additionalData.whatsappWebhookSubscription);
  const reasonCode = clean(health?.reason_code).toLowerCase();
  const accountReviewStatus = clean(businessHealth.account_review_status).toUpperCase();
  const businessVerificationStatus = clean(businessHealth.business_verification_status).toLowerCase();
  const hasReviewableState = health?.can_send === false
    || accountReviewStatus === 'REJECTED'
    || ['rejected', 'failed', 'revoked'].includes(businessVerificationStatus);
  if (!hasReviewableState) return null;

  let providerEvent = 'WHATSAPP_ACCOUNT_HEALTH_REVIEW';
  if (reasonCode === 'waba_health_blocked') providerEvent = 'WABA_HEALTH_BLOCKED';
  else if (reasonCode === 'waba_account_review_rejected' || accountReviewStatus === 'REJECTED') providerEvent = 'ACCOUNT_REVIEW_REJECTED';
  else if (reasonCode === 'provider_status_banned') providerEvent = 'PHONE_NUMBER_BANNED';
  else if (['rejected', 'failed', 'revoked'].includes(businessVerificationStatus)) providerEvent = 'BUSINESS_VERIFICATION_REJECTED';

  const occurredAt = new Date(
    health?.last_blocked_at
    || health?.last_transition_at
    || health?.observed_at
    || businessHealth.observed_at
    || now
  );
  const safeOccurredAt = Number.isNaN(occurredAt.getTime()) ? now : occurredAt;
  const restrictions = buildTechnicalRestrictions(businessHealth);
  const remediation = restrictions.map((item) => item.remediation).filter(Boolean).join('\n') || null;
  const rawPayload = {
    source: 'clinicaclick_manual_health_review',
    generated_at: now.toISOString(),
    health: {
      state: health?.state || null,
      can_send: health?.can_send ?? null,
      reason_code: health?.reason_code || null,
      provider_status: health?.provider_status || null,
      provider_error_code: health?.provider_error_code || null,
      observed_at: health?.observed_at || null,
      last_transition_at: health?.last_transition_at || null,
      last_blocked_at: health?.last_blocked_at || null,
    },
    waba_health: {
      can_send_message: businessHealth.can_send_message || null,
      account_review_status: businessHealth.account_review_status || null,
      account_review_rejection_reason: businessHealth.account_review_rejection_reason || null,
      business_verification_status: businessHealth.business_verification_status || null,
      business_id: businessHealth.business_id || null,
      entities: Array.isArray(businessHealth.entities) ? businessHealth.entities : [],
      observed_at: businessHealth.observed_at || null,
    },
    webhook_subscription: {
      status: webhookSubscription.status || null,
      callback_host: webhookSubscription.callback_host || null,
      missing_fields: Array.isArray(webhookSubscription.missing_fields)
        ? webhookSubscription.missing_fields
        : [],
      checked_at: webhookSubscription.checked_at || null,
    },
  };
  const dedupeKey = buildDedupeKey({
    wabaId: asset.wabaId,
    field: 'manual_health_review',
    entry: { time: safeOccurredAt.toISOString() },
    value: { asset_id: Number(asset.id), provider_event: providerEvent, reason_code: reasonCode },
  });

  return {
    dedupe_key: dedupeKey,
    clinic_id: context.clinicId,
    group_id: context.groupId,
    asset_id: Number(asset.id),
    waba_id: asset.wabaId || null,
    phone_number_id: asset.phoneNumberId || null,
    phone_number: asset.metaAssetName || null,
    webhook_field: 'manual_health_review',
    provider_event: providerEvent,
    severity: health?.can_send === false ? 'error' : 'warning',
    operational_status: health?.can_send === false ? 'restricted' : 'warning',
    violation_type: null,
    ban_state: null,
    ban_date: null,
    restriction_info: restrictions,
    remediation,
    raw_payload: rawPayload,
    occurred_at: safeOccurredAt,
    status: 'open',
    appealable: null,
    client_requested_at: now,
    client_requested_by: userId || null,
  };
}

async function prepareManualAccountReview({ assetId, userId }) {
  const asset = await ClinicMetaAsset.findByPk(Number(assetId));
  if (!asset || asset.assetType !== 'whatsapp_phone_number') {
    const error = new Error('whatsapp_compliance_asset_not_found');
    error.statusCode = 404;
    throw error;
  }
  const context = await resolveClinicContext({ assets: [asset], clinicId: asset.clinicaId });
  const health = whatsappAccountHealthService.summarizeAssetHealth(asset);
  const spec = buildManualReviewIncidentSpec({ asset, context, health, userId });
  if (!spec) {
    const error = new Error('whatsapp_manual_review_not_required');
    error.statusCode = 409;
    throw error;
  }

  let incident = await WhatsappAccountComplianceIncident.findOne({
    where: {
      status: { [Op.in]: OPEN_STATUSES },
      provider_event: { [Op.in]: MANUAL_REVIEW_INCIDENT_EVENTS },
      [Op.or]: [
        { asset_id: Number(asset.id) },
        {
          waba_id: String(asset.wabaId || ''),
          phone_number_id: String(asset.phoneNumberId || ''),
        },
      ],
    },
    order: [['occurred_at', 'DESC'], ['id', 'DESC']],
  });
  if (incident?.appealable === false) incident = null;
  if (!incident) {
    [incident] = await WhatsappAccountComplianceIncident.findOrCreate({
      where: { dedupe_key: spec.dedupe_key },
      defaults: spec,
    });
  }
  if (!incident.client_requested_at || !incident.client_requested_by) {
    await incident.update({
      client_requested_at: incident.client_requested_at || new Date(),
      client_requested_by: incident.client_requested_by || userId || null,
    });
  }

  return prepareAppeal({
    incidentId: Number(incident.id),
    userId,
    serviceContext: null,
    reviewNotes: 'Expediente iniciado manualmente desde Clinicaclick con el último estado técnico saneado de Meta.',
  });
}

function buildAppealDraft({ incident, clinicName, groupName, account, activity, serviceContext, reviewNotes }) {
  const accountName = account?.verified_name || groupName || clinicName || 'la cuenta indicada';
  const technicalLabel = TECHNICAL_EVENT_LABELS[clean(incident.provider_event).toUpperCase()] || null;
  const violation = incident.violation_type
    ? `Motivo comunicado por WhatsApp: ${VIOLATION_LABELS[incident.violation_type] || incident.violation_type}.`
    : technicalLabel
      ? `Motivo técnico disponible: ${technicalLabel}. Meta no ha facilitado una categoría de infracción adicional.`
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
    ['sin confirmación posterior', statusCounts.sent],
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
    `Actividad atribuida al número afectado al preparar la revisión (últimos 7 días): ${Number(activity?.last_7d || 0)} mensajes registrados, ${Number(activity?.confirmed_7d || 0)} con entrega confirmada, ${Number(activity?.without_confirmation_7d || 0)} sin confirmación posterior y ${Number(activity?.failed_7d || 0)} fallidos${statusSummary ? ` (${statusSummary})` : ''}.`,
    `Contexto del servicio: ${context}`,
    `Revisión realizada: ${notes}`,
    'Solicitamos que se reevalúe la medida y, si corresponde, se restablezca la cuenta. Podemos aportar información adicional sobre la operativa y, cuando proceda, las bases y autorizaciones de contacto verificadas.',
  ].join('\n\n');
}

function sanitizeAppealActivity(activity = {}) {
  const numericMap = (value) => Object.fromEntries(
    Object.entries(safeObject(value))
      .map(([key, count]) => [clean(key).slice(0, 120), Number(count || 0)])
      .filter(([key, count]) => key && Number.isFinite(count))
  );
  const attribution = safeObject(activity.attribution);
  return {
    last_24h: Number(activity.last_24h || 0),
    last_7d: Number(activity.last_7d || 0),
    failed_7d: Number(activity.failed_7d || 0),
    accepted_7d: Number(activity.accepted_7d || 0),
    confirmed_7d: Number(activity.confirmed_7d || 0),
    without_confirmation_7d: Number(activity.without_confirmation_7d || 0),
    pending_7d: Number(activity.pending_7d || 0),
    status_counts: numericMap(activity.status_counts),
    source_counts: numericMap(activity.source_counts),
    source_sample_size: Number(activity.source_sample_size || 0),
    error_counts: numericMap(activity.error_counts),
    error_sample_size: Number(activity.error_sample_size || 0),
    attribution: {
      phone_number_id: clean(attribution.phone_number_id) || null,
      exact_7d: Number(attribution.exact_7d || 0),
      inferred_7d: Number(attribution.inferred_7d || 0),
      unattributed_7d: Number(attribution.unattributed_7d || 0),
      scoped_by_route: attribution.scoped_by_route === true,
    },
  };
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
  const account = await loadIncidentAccount(incident);
  const activity = await loadActivitySummary({
    clinicId: incident.clinic_id,
    groupId: incident.group_id,
    account,
  });
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
    activity: sanitizeAppealActivity(activity),
    account,
    prepared_from_provider_payload: incident.webhook_field !== 'manual_health_review',
    source_type: incident.webhook_field === 'manual_health_review'
      ? 'manual_health_review'
      : 'meta_webhook',
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
      mode: 'full',
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
  const activityAccount = current || asset;
  const activity = await loadActivitySummary({
    clinicId: context.clinicId,
    groupId: context.groupId,
    account: {
      clinic_id: activityAccount.clinicaId || context.clinicId || null,
      group_id: activityAccount.grupoClinicaId || context.groupId || null,
      phone_number_id: activityAccount.phoneNumberId || null,
    },
  });
  const additionalData = current?.additionalData && typeof current.additionalData === 'object'
    ? { ...current.additionalData }
    : {};
  const registration = additionalData.registration || {};
  const coexistence = additionalData.coexistence || {};
  const businessHealth = additionalData.whatsappBusinessHealth || {};
  const webhookSubscription = additionalData.whatsappWebhookSubscription || {};
  const health = whatsappAccountHealthService.summarizeAssetHealth(current || asset);
  const profileAlignment = buildWhatsappProfileAlignment({
    clinic: context.clinic,
    verifiedName: current?.waVerifiedName || asset.waVerifiedName,
    additionalData,
  });
  const healthHistory = current
    ? (await whatsappAccountHealthService.listEventsForAssets([current.id], { perAsset: 20 })).get(Number(current.id)) || []
    : [];
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
    new_name_status: additionalData.newNameStatus || additionalData.new_name_status || null,
    requested_display_name: additionalData.newDisplayName
      || additionalData.new_display_name
      || additionalData.requestedDisplayName
      || null,
    business_id: businessHealth.business_id || additionalData.businessId || null,
    business_verification_status: businessHealth.business_verification_status
      || additionalData.businessVerificationStatus
      || null,
    waba_account_review_status: businessHealth.account_review_status || null,
    waba_account_review_rejection_reason: businessHealth.account_review_rejection_reason || null,
    waba_health_can_send_message: businessHealth.can_send_message || null,
    waba_health_observed_at: businessHealth.observed_at || null,
    waba_health_entities: Array.isArray(businessHealth.entities) ? businessHealth.entities : [],
    webhook_subscription: {
      status: webhookSubscription.status || null,
      waba_subscribed: webhookSubscription.waba_subscribed ?? null,
      app_configuration_active: webhookSubscription.app_configuration_active ?? null,
      callback_host: webhookSubscription.callback_host || null,
      required_fields: Array.isArray(webhookSubscription.required_fields) ? webhookSubscription.required_fields : [],
      missing_fields: Array.isArray(webhookSubscription.missing_fields) ? webhookSubscription.missing_fields : [],
      checked_at: webhookSubscription.checked_at || null,
      error: webhookSubscription.error || null,
    },
    quality_rating: current?.quality_rating || asset.quality_rating || null,
    messaging_limit: current?.messaging_limit || asset.messaging_limit || null,
    compliance: summarizeCompliance(additionalData),
    compliance_source: 'account_update_webhook',
    health,
    health_history: healthHistory,
    recent_delivery: activity.recent[0] || null,
    recent_failures: activity.recent_failures || [],
    delivery_summary_7d: {
      total: activity.last_7d,
      accepted: activity.accepted_7d,
      confirmed: activity.confirmed_7d,
      without_confirmation: activity.without_confirmation_7d,
      pending: activity.pending_7d,
      failed: activity.failed_7d,
      status_counts: activity.status_counts,
      attribution: activity.attribution,
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
      profile_alignment: profileAlignment,
      health,
      health_history: healthHistory,
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
  handleAccountReviewUpdate,
  handleBusinessUsernameUpdate,
  getStoredAccountUpdate,
  listIncidents,
  markAppealSubmitted,
  prepareAppeal,
  prepareManualAccountReview,
  requestClinicClickReview,
  serializeIncident,
  summarizeCompliance,
  __testing: {
    buildAccountReviewSnapshot,
    buildActivityRouteWhere,
    buildManualReviewIncidentSpec,
    sanitizeAppealActivity,
    buildTechnicalRestrictions,
    loadActivitySummary,
    resolveActivityScope,
  },
};
