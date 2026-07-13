'use strict';

const { Op } = require('sequelize');
const {
  assignmentBelongsToGroup,
} = require('./managedCampaignAssociationScopes.service');

const PROVIDERS = new Set(['google_ads', 'meta_ads']);
const TARGET_KINDS = new Set(['generic', 'treatment']);
const AUDIT_EVENT_TYPES = Object.freeze({
  CLINIC_ASSIGNED: 'clinic_assigned',
  REACTIVATED: 'reactivated',
  ARCHIVED: 'archived',
  TARGET_ASSIGNED: 'target_assigned',
  TARGET_CHANGED: 'target_changed',
  TARGET_CLEARED: 'target_cleared',
});

function assignmentTargetError(code, message, httpStatus = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  Object.assign(error, extra);
  return error;
}

function plain(value) {
  return typeof value?.get === 'function' ? value.get({ plain: true }) : (value || {});
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function strictPositiveInt(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw assignmentTargetError('matching_target_validation_error', `${field} debe ser un entero positivo.`);
  }
  return value;
}

function cleanText(value, max = 1024) {
  if (value === undefined || value === null) return null;
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : null;
}

function normalizeExternalAccountId(provider, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (provider === 'google_ads' || provider === 'meta_ads') {
    const digits = raw.replace(/^act_/i, '').replace(/[^0-9]/g, '');
    return digits ? digits.slice(0, 64) : null;
  }
  return null;
}

function canonicalExternalCampaignIdentity(value) {
  const source = plain(value);
  const provider = normalizeProvider(source.provider);
  const accountId = normalizeExternalAccountId(
    provider,
    source.account_id ?? source.customer_id ?? source.ad_account_id
  );
  const customerId = normalizeExternalAccountId(
    provider,
    source.customer_id ?? source.account_id ?? source.ad_account_id
  );
  const campaignId = cleanText(source.campaign_id ?? source.external_campaign_id, 128);
  if (!provider || !accountId || !customerId || !campaignId) return null;
  return {
    provider,
    account_id: accountId,
    customer_id: customerId,
    campaign_id: campaignId,
    external_campaign_id: campaignId,
  };
}

function externalCampaignIdentityKey(value) {
  const identity = canonicalExternalCampaignIdentity(value);
  return identity
    ? JSON.stringify([
        identity.provider,
        identity.account_id,
        identity.customer_id,
        identity.campaign_id,
      ])
    : null;
}

function currentVersion(row) {
  const version = Number(plain(row).version);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function normalizeComparable(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function buildChanges(beforeValue, afterValue, fields) {
  const before = plain(beforeValue);
  const after = plain(afterValue);
  const changes = {};
  for (const field of fields) {
    const previous = normalizeComparable(before[field]);
    const next = normalizeComparable(after[field]);
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    changes[field] = { before: previous ?? null, after: next ?? null };
  }
  return changes;
}

async function appendAssignmentAudit({
  auditModel,
  assignmentId,
  eventType,
  actorUserId,
  fromVersion,
  toVersion,
  changes,
  reason = null,
  transaction,
}) {
  if (!auditModel) {
    throw new TypeError('auditModel es obligatorio');
  }
  return auditModel.create({
    assignment_id: assignmentId,
    event_type: eventType,
    actor_type: 'user',
    actor_user_id: actorUserId,
    from_version: fromVersion,
    to_version: toVersion,
    reason,
    changes: safeObject(changes),
  }, { transaction });
}

function assignmentDto(row) {
  const item = plain(row);
  const identity = canonicalExternalCampaignIdentity(item);
  return {
    id: String(item.id || ''),
    provider: identity?.provider || normalizeProvider(item.provider),
    account_id: identity?.account_id || null,
    customer_id: identity?.customer_id || null,
    campaign_id: identity?.campaign_id || cleanText(item.campaign_id, 128),
    campaign_name: cleanText(item.campaign_name_snapshot, 512),
    group_id: positiveInt(item.grupo_clinica_id),
    clinic_id: positiveInt(item.clinica_id),
    match_kind: item.match_kind || null,
    match_confidence: item.match_confidence === null || item.match_confidence === undefined
      ? null
      : Number(item.match_confidence),
    match_explanation: cleanText(item.match_explanation, 512),
    status: item.status || null,
    archive_reason: cleanText(item.archive_reason, 1024),
    archived_at: item.archived_at || null,
    version: currentVersion(item),
    target: item.strategy_campaign_id && item.campaign_request_id && item.target_kind
      ? {
          strategy_campaign_id: positiveInt(item.strategy_campaign_id),
          campaign_request_id: positiveInt(item.campaign_request_id),
          kind: TARGET_KINDS.has(item.target_kind) ? item.target_kind : null,
          treatment_id: positiveInt(item.target_treatment_id),
          confidence: item.target_confidence === null || item.target_confidence === undefined
            ? null
            : Number(item.target_confidence),
          explanation: cleanText(item.target_explanation, 1024),
          updated_by_user_id: positiveInt(item.target_updated_by_user_id),
          updated_at: item.target_updated_at || null,
        }
      : null,
  };
}

function auditActorName(actor, actorUserId, actorType = 'user') {
  if (actorType === 'system') return 'Sistema';
  const item = plain(actor);
  const name = [item.nombre, item.apellidos]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  return name || `Usuario #${Number(actorUserId)}`;
}

function assignmentAuditDto(row) {
  const item = plain(row);
  return {
    id: String(item.id || ''),
    event_type: cleanText(item.event_type, 64),
    actor_type: item.actor_type === 'system' ? 'system' : 'user',
    actor_user_id: positiveInt(item.actor_user_id),
    actor_name: auditActorName(item.actor, item.actor_user_id, item.actor_type),
    from_version: Number(item.from_version) || 0,
    to_version: Number(item.to_version) || 0,
    reason: cleanText(item.reason, 1024),
    changes: safeObject(item.changes),
    created_at: item.created_at || null,
  };
}

function normalizeTreatmentIds(payload) {
  return new Map((Array.isArray(payload?.treatments) ? payload.treatments : [])
    .map((item) => [positiveInt(item?.id), cleanText(item?.nombre, 255)])
    .filter(([id]) => !!id));
}

function isActiveConnectOnlyNewPatientsStrategy(request, campaign) {
  const item = plain(request);
  const strategy = safeObject(item.solicitud);
  const campaignRow = plain(campaign);
  return strategy.kind === 'marketing_strategy'
    && String(strategy.objective_id || '').trim().toLowerCase() === 'new_patients'
    && String(strategy.mode_snapshot || '').trim().toLowerCase() === 'connect_only'
    && String(strategy.status || '').trim().toLowerCase() === 'active'
    && positiveInt(item.campaign_id) === positiveInt(campaignRow.id)
    && [true, 1, '1'].includes(campaignRow.activa)
    && ![true, 1, '1'].includes(campaignRow.gestionada);
}

function treatmentValidForClinic(treatment, clinic) {
  const item = plain(treatment);
  const clinicRow = plain(clinic);
  const clinicId = positiveInt(clinicRow.id_clinica ?? clinicRow.id);
  const groupId = positiveInt(clinicRow.grupoClinicaId ?? clinicRow.grupo_clinica_id);
  if (!clinicId || ![true, 1, '1'].includes(item.activo)) return false;
  const ownerClinicId = positiveInt(item.clinica_id);
  const ownerGroupId = positiveInt(item.grupo_clinica_id);
  if (ownerClinicId && ownerClinicId !== clinicId) return false;
  if (ownerGroupId && ownerGroupId !== groupId) return false;
  const hiddenFor = Array.isArray(item.eliminado_por_clinica)
    ? item.eliminado_por_clinica.map(positiveInt).filter(Boolean)
    : [];
  return !hiddenFor.includes(clinicId);
}

function strategyTargetCatalogItem({ request, campaign, treatmentRows = [] }) {
  if (!isActiveConnectOnlyNewPatientsStrategy(request, campaign)) return null;
  const requestRow = plain(request);
  const campaignRow = plain(campaign);
  const payload = safeObject(requestRow.solicitud);
  const promotionType = String(payload.promotion_type || '').trim().toLowerCase();
  let targets;
  if (promotionType === 'generic') {
    targets = [{ kind: 'generic', treatment_id: null, treatment_name: null }];
  } else {
    const allowed = normalizeTreatmentIds(payload);
    const treatments = new Map((Array.isArray(treatmentRows) ? treatmentRows : [])
      .map((row) => [positiveInt(plain(row).id_tratamiento), plain(row)]));
    targets = Array.from(allowed.entries())
      .filter(([id]) => treatments.has(id))
      .map(([id, name]) => ({
        kind: 'treatment',
        treatment_id: id,
        treatment_name: name || cleanText(treatments.get(id)?.nombre, 255),
      }));
  }
  if (!targets.length) return null;
  return {
    strategy_campaign_id: positiveInt(campaignRow.id),
    campaign_request_id: positiveInt(requestRow.id),
    display_name: cleanText(payload?.summary?.name, 255)
      || cleanText(campaignRow.nombre, 255)
      || `Estrategia #${positiveInt(campaignRow.id)}`,
    targets,
  };
}

async function listValidStrategyTargetsForClinic({
  clinic,
  requestModel,
  campaignModel,
  treatmentModel,
  transaction = null,
  lock = false,
}) {
  const clinicRow = plain(clinic);
  const clinicId = positiveInt(clinicRow.id_clinica ?? clinicRow.id);
  if (!clinicId) return [];
  const queryLock = lock && transaction ? transaction.LOCK.UPDATE : null;
  const requests = await requestModel.findAll({
    where: { clinica_id: clinicId },
    attributes: ['id', 'clinica_id', 'campaign_id', 'estado', 'solicitud', 'created_at', 'updated_at'],
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  const candidateRequests = requests.filter((request) => {
    const payload = safeObject(request.solicitud);
    return payload.kind === 'marketing_strategy'
      && String(payload.objective_id || '').trim().toLowerCase() === 'new_patients'
      && String(payload.mode_snapshot || '').trim().toLowerCase() === 'connect_only'
      && String(payload.status || '').trim().toLowerCase() === 'active';
  });
  const campaignIds = Array.from(new Set(candidateRequests.map((row) => positiveInt(row.campaign_id)).filter(Boolean)));
  if (!campaignIds.length) return [];
  const campaigns = await campaignModel.findAll({
    where: { id: { [Op.in]: campaignIds } },
    attributes: ['id', 'nombre', 'activa', 'gestionada'],
    raw: true,
    transaction,
    ...(queryLock ? { lock: queryLock } : {}),
  });
  const campaignById = new Map(campaigns.map((row) => [positiveInt(row.id), row]));
  const treatmentIds = Array.from(new Set(candidateRequests.flatMap((request) => (
    Array.from(normalizeTreatmentIds(safeObject(request.solicitud)).keys())
  ))));
  const treatmentRows = treatmentIds.length
    ? await treatmentModel.findAll({
        where: { id_tratamiento: { [Op.in]: treatmentIds }, activo: true },
        attributes: [
          'id_tratamiento', 'nombre', 'activo', 'origen', 'clinica_id',
          'grupo_clinica_id', 'eliminado_por_clinica',
        ],
        raw: true,
        transaction,
        ...(queryLock ? { lock: queryLock } : {}),
      })
    : [];
  const validTreatments = treatmentRows.filter((row) => treatmentValidForClinic(row, clinicRow));
  return candidateRequests
    .map((request) => strategyTargetCatalogItem({
      request,
      campaign: campaignById.get(positiveInt(request.campaign_id)),
      treatmentRows: validTreatments,
    }))
    .filter(Boolean);
}

function targetCatalogContains(catalog, target) {
  const strategyCampaignId = positiveInt(target?.strategy_campaign_id);
  const requestId = positiveInt(target?.campaign_request_id);
  const kind = String(target?.kind || target?.target_kind || '').trim().toLowerCase();
  const treatmentId = positiveInt(target?.treatment_id ?? target?.target_treatment_id);
  return (Array.isArray(catalog) ? catalog : []).some((strategy) => (
    strategy.strategy_campaign_id === strategyCampaignId
    && strategy.campaign_request_id === requestId
    && strategy.targets.some((item) => item.kind === kind
      && (kind === 'generic' || item.treatment_id === treatmentId))
  ));
}

function matchingIssueForAssignment(assignment, targetOptions) {
  const item = plain(assignment);
  const hasPointers = positiveInt(item.strategy_campaign_id)
    && positiveInt(item.campaign_request_id)
    && TARGET_KINDS.has(item.target_kind);
  let code = null;
  let message = null;
  if (!hasPointers) {
    code = 'target_missing';
    message = 'La campaña revisada todavía no está vinculada a un target de estrategia.';
  } else if (!targetCatalogContains(targetOptions, {
    strategy_campaign_id: item.strategy_campaign_id,
    campaign_request_id: item.campaign_request_id,
    kind: item.target_kind,
    treatment_id: item.target_treatment_id,
  })) {
    code = 'target_invalid';
    message = 'El target guardado ya no pertenece a una estrategia activa Conecta y mejora de la misma clínica.';
  } else if (item.target_confidence === null || item.target_confidence === undefined
    || !cleanText(item.target_explanation, 1024)) {
    code = 'target_review_metadata_missing';
    message = 'El target necesita confianza y explicación de revisión.';
  }
  if (!code) return null;
  return {
    code,
    message,
    assignment: assignmentDto(item),
    target_options: Array.isArray(targetOptions) ? targetOptions : [],
  };
}

function parseTargetUpdateInput(input) {
  const source = safeObject(input);
  const allowed = new Set([
    'group_id', 'provider', 'customer_id', 'expected_version',
    'strategy_campaign_id', 'campaign_request_id', 'target_kind',
    'treatment_id', 'confidence', 'explanation',
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw assignmentTargetError(
      'matching_target_unknown_fields',
      `Campos no admitidos: ${unknown.join(', ')}.`
    );
  }
  const groupId = strictPositiveInt(source.group_id, 'group_id');
  const provider = normalizeProvider(source.provider);
  const customerId = normalizeExternalAccountId(provider, source.customer_id);
  const expectedVersion = strictPositiveInt(source.expected_version, 'expected_version');
  const strategyCampaignId = strictPositiveInt(source.strategy_campaign_id, 'strategy_campaign_id');
  const requestId = strictPositiveInt(source.campaign_request_id, 'campaign_request_id');
  const targetKind = String(source.target_kind || '').trim().toLowerCase();
  const treatmentId = targetKind === 'treatment'
    ? strictPositiveInt(source.treatment_id, 'treatment_id')
    : null;
  if (!provider || !customerId || !TARGET_KINDS.has(targetKind)) {
    throw assignmentTargetError('matching_target_validation_error', 'provider, customer_id y target_kind no son válidos.');
  }
  if (targetKind === 'generic' && source.treatment_id !== undefined && source.treatment_id !== null) {
    throw assignmentTargetError('matching_target_validation_error', 'Un target genérico no admite treatment_id.');
  }
  if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence)
    || source.confidence < 0 || source.confidence > 1) {
    throw assignmentTargetError('matching_target_validation_error', 'confidence debe ser un número entre 0 y 1.');
  }
  const explanation = cleanText(source.explanation, 1024);
  if (!explanation) {
    throw assignmentTargetError('matching_target_explanation_required', 'Explica por qué corresponde este target.');
  }
  return {
    groupId,
    provider,
    customerId,
    expectedVersion,
    strategyCampaignId,
    requestId,
    targetKind,
    treatmentId,
    confidence: Number(source.confidence.toFixed(4)),
    explanation,
  };
}

function parseTargetClearInput(input) {
  const source = safeObject(input);
  const allowed = new Set(['group_id', 'provider', 'customer_id', 'expected_version', 'reason']);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw assignmentTargetError(
      'matching_target_unknown_fields',
      `Campos no admitidos: ${unknown.join(', ')}.`
    );
  }
  const groupId = strictPositiveInt(source.group_id, 'group_id');
  const provider = normalizeProvider(source.provider);
  const customerId = normalizeExternalAccountId(provider, source.customer_id);
  const expectedVersion = strictPositiveInt(source.expected_version, 'expected_version');
  const reason = cleanText(source.reason, 1024);
  if (!provider || !customerId) {
    throw assignmentTargetError('matching_target_validation_error', 'provider y customer_id no son válidos.');
  }
  if (!reason) {
    throw assignmentTargetError('matching_target_clear_reason_required', 'Indica el motivo de la desvinculación.');
  }
  return { groupId, provider, customerId, expectedVersion, reason };
}

function targetKey(kind, treatmentId) {
  return `${kind}:${kind === 'treatment' ? positiveInt(treatmentId) : 'generic'}`;
}

function campaignReferenceFromAssignment(assignment, inventory = null) {
  const assignmentRow = plain(assignment);
  const inventoryRow = plain(inventory);
  const identity = canonicalExternalCampaignIdentity(assignmentRow);
  if (!identity) {
    throw assignmentTargetError(
      'matching_assignment_identity_invalid',
      'La asociación no tiene una identidad externa canónica completa.',
      409
    );
  }
  const metrics = safeObject(inventoryRow.latest_metrics);
  return {
    provider: identity.provider,
    account_id: identity.account_id,
    customer_id: identity.customer_id,
    campaign_id: identity.campaign_id,
    external_campaign_id: identity.external_campaign_id,
    account_name: cleanText(inventoryRow.account_name, 255),
    name: cleanText(inventoryRow.campaign_name, 512)
      || cleanText(assignmentRow.campaign_name_snapshot, 512),
    status: cleanText(inventoryRow.status, 64),
    metrics: {
      impressions: Number(metrics.impressions) || 0,
      clicks: Number(metrics.clicks) || 0,
      spend: Number(metrics.spend) || 0,
      conversions: Number(metrics.conversions) || 0,
    },
    destination_detection: Object.keys(safeObject(inventoryRow.destination_detection)).length
      ? safeObject(inventoryRow.destination_detection)
      : null,
  };
}

function syncCampaignReferenceInPayload(payloadValue, identityValue, {
  target = null,
  campaignReference = null,
} = {}) {
  const identityKey = externalCampaignIdentityKey(identityValue);
  if (!identityKey) {
    throw assignmentTargetError('matching_assignment_identity_invalid', 'Identidad externa incompleta.', 409);
  }
  const payload = { ...safeObject(payloadValue) };
  const rawTargets = Array.isArray(payload.external_targets) ? payload.external_targets : [];
  const nextTargets = [];
  const removedFrom = [];
  for (const rawTarget of rawTargets) {
    const source = safeObject(rawTarget);
    const kind = String(source.kind || '').trim().toLowerCase() === 'generic' ? 'generic' : 'treatment';
    const treatmentId = kind === 'treatment' ? positiveInt(source.treatment_id) : null;
    if (kind === 'treatment' && !treatmentId) continue;
    const campaigns = [];
    for (const campaign of Array.isArray(source.campaigns) ? source.campaigns : []) {
      if (externalCampaignIdentityKey(campaign) === identityKey) {
        removedFrom.push({ kind, treatment_id: treatmentId });
        continue;
      }
      campaigns.push(campaign);
    }
    nextTargets.push({ ...source, kind, treatment_id: treatmentId, campaigns });
  }

  let assignedTo = null;
  if (target && campaignReference) {
    const kind = String(target.kind || '').trim().toLowerCase();
    const treatmentId = kind === 'treatment' ? positiveInt(target.treatment_id) : null;
    const key = targetKey(kind, treatmentId);
    let destination = nextTargets.find((item) => targetKey(item.kind, item.treatment_id) === key);
    if (!destination) {
      destination = {
        kind,
        treatment_id: treatmentId,
        treatment_name: kind === 'treatment' ? cleanText(target.treatment_name, 255) : null,
        campaigns: [],
      };
      nextTargets.push(destination);
    }
    destination.campaigns.push(campaignReference);
    assignedTo = { kind, treatment_id: treatmentId };
  }
  const nextPayload = { ...payload, external_targets: nextTargets };
  return {
    payload: nextPayload,
    changed: JSON.stringify(safeObject(payloadValue)) !== JSON.stringify(nextPayload),
    removed_from: removedFrom,
    assigned_to: assignedTo,
  };
}

async function loadAssignmentScope({
  parsed,
  assignmentId,
  transaction,
  assignmentModel,
  clinicModel,
  accountScopeResolver,
}) {
  const clinics = await clinicModel.findAll({
    where: { grupoClinicaId: parsed.groupId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const groupClinicIds = new Set(clinics.map((clinic) => positiveInt(clinic.id_clinica)).filter(Boolean));
  if (!groupClinicIds.size) {
    throw assignmentTargetError('matching_group_scope_changed', 'El grupo ya no contiene clínicas.', 409);
  }
  const accountScope = await accountScopeResolver({
    groupId: parsed.groupId,
    provider: parsed.provider,
    accountId: parsed.customerId,
    transaction,
    lock: true,
  });
  if (!accountScope) {
    throw assignmentTargetError(
      'matching_account_scope_forbidden',
      'La autorización de la cuenta cambió. Recarga las opciones.',
      403
    );
  }
  const assignment = await assignmentModel.findByPk(assignmentId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!assignment) {
    throw assignmentTargetError('matching_assignment_not_found', 'Asociación no encontrada.', 404);
  }
  const identity = canonicalExternalCampaignIdentity(assignment);
  if (!identity || identity.provider !== parsed.provider || identity.customer_id !== parsed.customerId) {
    throw assignmentTargetError(
      'matching_assignment_identity_conflict',
      'La asociación ya no coincide con la cuenta seleccionada.',
      409
    );
  }
  if (!assignmentBelongsToGroup(assignment, parsed.groupId, groupClinicIds)) {
    throw assignmentTargetError(
      'matching_assignment_scope_conflict',
      'La asociación pertenece a otro grupo.',
      409
    );
  }
  if (String(assignment.status) !== 'active') {
    throw assignmentTargetError(
      'matching_assignment_archived',
      'Reactiva la asociación antes de revisar su target.',
      409
    );
  }
  const version = currentVersion(assignment);
  if (version !== parsed.expectedVersion) {
    throw assignmentTargetError(
      'matching_assignment_version_conflict',
      'La asociación cambió mientras editabas. Recarga antes de guardar.',
      409,
      { currentVersion: version }
    );
  }
  const clinicId = positiveInt(plain(assignment).clinica_id);
  const clinic = clinics.find((row) => positiveInt(row.id_clinica) === clinicId);
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)
    || /\btest\b/i.test(String(clinic.nombre_clinica || ''))) {
    throw assignmentTargetError(
      'matching_target_clinic_ineligible',
      'La clínica asociada ya no es elegible para una estrategia activa.',
      409
    );
  }
  return { assignment, identity, clinic };
}

async function loadRequestsLocked(requestModel, ids, transaction) {
  const requestIds = Array.from(new Set(ids.map(positiveInt).filter(Boolean))).sort((left, right) => left - right);
  if (!requestIds.length) return new Map();
  const rows = await requestModel.findAll({
    where: { id: { [Op.in]: requestIds } },
    attributes: ['id', 'clinica_id', 'campaign_id', 'estado', 'solicitud', 'created_at', 'updated_at'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return new Map(rows.map((row) => [positiveInt(plain(row).id), row]));
}

async function resolveRequestedTarget({
  parsed,
  assignment,
  clinic,
  requests,
  transaction,
  campaignModel,
  treatmentModel,
}) {
  const request = requests.get(parsed.requestId);
  if (!request || positiveInt(plain(request).clinica_id) !== positiveInt(plain(assignment).clinica_id)) {
    throw assignmentTargetError(
      'matching_target_strategy_invalid',
      'La estrategia debe pertenecer a la misma clínica que la asociación.',
      409
    );
  }
  const campaign = await campaignModel.findByPk(parsed.strategyCampaignId, {
    attributes: ['id', 'nombre', 'activa', 'gestionada'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!isActiveConnectOnlyNewPatientsStrategy(request, campaign)
    || positiveInt(plain(request).campaign_id) !== parsed.strategyCampaignId) {
    throw assignmentTargetError(
      'matching_target_strategy_invalid',
      'El target debe pertenecer a una estrategia Captar nuevos pacientes, Conecta y mejora y activa.',
      409
    );
  }
  const payload = safeObject(plain(request).solicitud);
  const promotionType = String(payload.promotion_type || '').trim().toLowerCase();
  if (parsed.targetKind === 'generic') {
    if (promotionType !== 'generic') {
      throw assignmentTargetError('matching_target_invalid', 'La estrategia no tiene un target genérico.', 409);
    }
    return { request, campaign, treatment: null, treatmentName: null };
  }
  if (promotionType === 'generic' || !normalizeTreatmentIds(payload).has(parsed.treatmentId)) {
    throw assignmentTargetError('matching_target_invalid', 'El tratamiento no pertenece a la estrategia.', 409);
  }
  const treatment = await treatmentModel.findByPk(parsed.treatmentId, {
    attributes: [
      'id_tratamiento', 'nombre', 'activo', 'origen', 'clinica_id',
      'grupo_clinica_id', 'eliminado_por_clinica',
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!treatment || !treatmentValidForClinic(treatment, clinic)) {
    throw assignmentTargetError(
      'matching_target_treatment_inactive',
      'El tratamiento ya no está activo o no es válido para la clínica.',
      409
    );
  }
  return {
    request,
    campaign,
    treatment,
    treatmentName: cleanText(plain(treatment).nombre, 255)
      || normalizeTreatmentIds(payload).get(parsed.treatmentId),
  };
}

async function updateExternalAssignmentTarget({
  assignmentId,
  actorUserId,
  input,
  sequelize,
  assignmentModel,
  auditModel,
  inventoryModel,
  clinicModel,
  requestModel,
  campaignModel,
  treatmentModel,
  accountScopeResolver,
  now = () => new Date(),
}) {
  const parsed = parseTargetUpdateInput(input);
  const actorId = strictPositiveInt(actorUserId, 'actor_user_id');
  return sequelize.transaction(async (transaction) => {
    const { assignment, identity, clinic } = await loadAssignmentScope({
      parsed,
      assignmentId,
      transaction,
      assignmentModel,
      clinicModel,
      accountScopeResolver,
    });
    const assignmentBefore = plain(assignment);
    const requests = await loadRequestsLocked(
      requestModel,
      [assignmentBefore.campaign_request_id, parsed.requestId],
      transaction
    );
    const target = await resolveRequestedTarget({
      parsed,
      assignment,
      clinic,
      requests,
      transaction,
      campaignModel,
      treatmentModel,
    });
    const inventory = assignmentBefore.inventory_id
      ? await inventoryModel.findByPk(assignmentBefore.inventory_id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : await inventoryModel.findOne({
          where: {
            provider: identity.provider,
            customer_id: identity.customer_id,
            campaign_id: identity.campaign_id,
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
    const campaignReference = campaignReferenceFromAssignment(assignment, inventory);
    const requestSync = [];
    const oldRequestId = positiveInt(assignmentBefore.campaign_request_id);
    if (oldRequestId && oldRequestId !== parsed.requestId && requests.has(oldRequestId)) {
      const oldRequest = requests.get(oldRequestId);
      requestSync.push({
        request: oldRequest,
        sync: syncCampaignReferenceInPayload(plain(oldRequest).solicitud, identity),
      });
    }
    const newRequest = target.request;
    requestSync.push({
      request: newRequest,
      sync: syncCampaignReferenceInPayload(plain(newRequest).solicitud, identity, {
        target: {
          kind: parsed.targetKind,
          treatment_id: parsed.treatmentId,
          treatment_name: target.treatmentName,
        },
        campaignReference,
      }),
    });

    const changedPayloads = requestSync.filter((item) => item.sync.changed);
    const nextValues = {
      strategy_campaign_id: parsed.strategyCampaignId,
      campaign_request_id: parsed.requestId,
      target_kind: parsed.targetKind,
      target_treatment_id: parsed.treatmentId,
      target_confidence: parsed.confidence,
      target_explanation: parsed.explanation,
      target_updated_by_user_id: actorId,
      target_updated_at: now(),
    };
    const assignmentChanges = buildChanges(assignmentBefore, nextValues, [
      'strategy_campaign_id', 'campaign_request_id', 'target_kind',
      'target_treatment_id', 'target_confidence', 'target_explanation',
    ]);
    if (!Object.keys(assignmentChanges).length && !changedPayloads.length) {
      return { changed: false, version: parsed.expectedVersion, assignment };
    }
    for (const item of changedPayloads) {
      await item.request.update({ solicitud: item.sync.payload }, { transaction });
    }
    const nextVersion = parsed.expectedVersion + 1;
    const [updated] = await assignmentModel.update({
      ...nextValues,
      version: nextVersion,
    }, {
      where: { id: assignmentBefore.id, version: parsed.expectedVersion },
      transaction,
    });
    if (updated !== 1) {
      throw assignmentTargetError(
        'matching_assignment_version_conflict',
        'La asociación cambió mientras editabas. Recarga antes de guardar.',
        409
      );
    }
    const eventType = oldRequestId && assignmentBefore.target_kind
      ? AUDIT_EVENT_TYPES.TARGET_CHANGED
      : AUDIT_EVENT_TYPES.TARGET_ASSIGNED;
    const audit = await appendAssignmentAudit({
      auditModel,
      assignmentId: assignmentBefore.id,
      eventType,
      actorUserId: actorId,
      fromVersion: parsed.expectedVersion,
      toVersion: nextVersion,
      changes: {
        ...assignmentChanges,
        strategy_external_targets: {
          before: requestSync.flatMap((item) => item.sync.removed_from),
          after: { request_id: parsed.requestId, ...requestSync.at(-1).sync.assigned_to },
        },
      },
      transaction,
    });
    const refreshed = await assignmentModel.findByPk(assignmentBefore.id, { transaction });
    return { changed: true, version: nextVersion, assignment: refreshed || { ...assignmentBefore, ...nextValues, version: nextVersion }, audit };
  });
}

async function clearExternalAssignmentTarget({
  assignmentId,
  actorUserId,
  input,
  sequelize,
  assignmentModel,
  auditModel,
  clinicModel,
  requestModel,
  accountScopeResolver,
  now = () => new Date(),
}) {
  const parsed = parseTargetClearInput(input);
  const actorId = strictPositiveInt(actorUserId, 'actor_user_id');
  return sequelize.transaction(async (transaction) => {
    const { assignment, identity } = await loadAssignmentScope({
      parsed,
      assignmentId,
      transaction,
      assignmentModel,
      clinicModel,
      accountScopeResolver,
    });
    const before = plain(assignment);
    const oldRequestId = positiveInt(before.campaign_request_id);
    const requests = await loadRequestsLocked(requestModel, [oldRequestId], transaction);
    const oldRequest = oldRequestId ? requests.get(oldRequestId) : null;
    const sync = oldRequest
      ? syncCampaignReferenceInPayload(plain(oldRequest).solicitud, identity)
      : { changed: false, removed_from: [] };
    const clearValues = {
      strategy_campaign_id: null,
      campaign_request_id: null,
      target_kind: null,
      target_treatment_id: null,
      target_confidence: null,
      target_explanation: null,
      target_updated_by_user_id: actorId,
      target_updated_at: now(),
    };
    const changes = buildChanges(before, clearValues, [
      'strategy_campaign_id', 'campaign_request_id', 'target_kind',
      'target_treatment_id', 'target_confidence', 'target_explanation',
    ]);
    if (!Object.keys(changes).length && !sync.changed) {
      return { changed: false, version: parsed.expectedVersion, assignment };
    }
    if (sync.changed) {
      await oldRequest.update({ solicitud: sync.payload }, { transaction });
    }
    const nextVersion = parsed.expectedVersion + 1;
    const [updated] = await assignmentModel.update({
      ...clearValues,
      version: nextVersion,
    }, {
      where: { id: before.id, version: parsed.expectedVersion },
      transaction,
    });
    if (updated !== 1) {
      throw assignmentTargetError(
        'matching_assignment_version_conflict',
        'La asociación cambió mientras editabas. Recarga antes de guardar.',
        409
      );
    }
    const audit = await appendAssignmentAudit({
      auditModel,
      assignmentId: before.id,
      eventType: AUDIT_EVENT_TYPES.TARGET_CLEARED,
      actorUserId: actorId,
      fromVersion: parsed.expectedVersion,
      toVersion: nextVersion,
      reason: parsed.reason,
      changes: {
        ...changes,
        strategy_external_targets: { before: sync.removed_from, after: null },
      },
      transaction,
    });
    const refreshed = await assignmentModel.findByPk(before.id, { transaction });
    return { changed: true, version: nextVersion, assignment: refreshed || { ...before, ...clearValues, version: nextVersion }, audit };
  });
}

module.exports = {
  AUDIT_EVENT_TYPES,
  appendAssignmentAudit,
  assignmentAuditDto,
  assignmentDto,
  buildChanges,
  campaignReferenceFromAssignment,
  canonicalExternalCampaignIdentity,
  clearExternalAssignmentTarget,
  externalCampaignIdentityKey,
  isActiveConnectOnlyNewPatientsStrategy,
  listValidStrategyTargetsForClinic,
  matchingIssueForAssignment,
  parseTargetClearInput,
  parseTargetUpdateInput,
  strategyTargetCatalogItem,
  syncCampaignReferenceInPayload,
  targetCatalogContains,
  treatmentValidForClinic,
  updateExternalAssignmentTarget,
};
