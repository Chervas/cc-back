'use strict';

const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EVENTS = Object.freeze({ soon: 'meta.credentials_expiring', expired: 'meta.credentials_expired', lost: 'meta.permissions_lost',
  human: 'meta.authorization_required', unknown: 'meta.supervision_unknown' });
const MANAGED = new Set(Object.values(EVENTS));
const HEALTH = new Set(['healthy', 'expired', 'permission_lost', 'temporary']);
const PERMANENT = new Set(['credential_revoked', 'permissions_lost']);
const ERRORS = new Set([...PERMANENT, 'provider_unauthorized', 'provider_timeout', 'provider_failed', 'broker_timeout',
  'broker_unavailable', 'rate_limited', 'outcome_unknown', 'secret_unavailable', 'secret_version_changed']);
const DAY = 86400000;
const SAFETY_MARGIN = 3 * DAY;
const UNKNOWN_MARGIN = 6 * 60 * 60 * 1000;
const ATTEMPTS = new Set(['idle', 'scheduled', 'running', 'retry_wait', 'succeeded', 'failed', 'human_required']);
const HUMAN_REASONS = new Set(['credential_expired', 'permissions_lost', 'authorization_required', 'automatic_renewal_failed', 'supervision_unavailable']);
const fail = () => { throw Object.assign(Error('meta_credential_notification_metadata_invalid'), { code: 'meta_credential_notification_metadata_invalid' }); };
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function expiry(value) {
  if (value === null || value === 0) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) fail();
  return value;
}
function scope(value) {
  const match = typeof value === 'string' && /^(group|clinic):([1-9][0-9]{0,9})$/.exec(value);
  if (!match || !positive(Number(match[2]))) fail();
  return { type: match[1], id: Number(match[2]), key: value };
}
function actionPath(scopeKey) {
  const value = scope(scopeKey);
  return '/ajustes?panel=connected-accounts&action=renew_meta&assignment_scope=' + value.type + '&' + value.type + '_id=' + value.id;
}
function actionUrl(scopeKey) { return 'https://crm.clinicaclick.com' + actionPath(scopeKey); }

// Consume only the current effective credential DTO. Neither renewal/candidate
// failures nor arbitrary provider messages are an input to this policy.
function status(value, now = Date.now()) {
  const keys = ['enrollmentId', 'scopeKey', 'clinicIds', 'connectionId', 'appId', 'subjectId', 'actorUserId', 'epoch', 'versionId',
    'expiresAt', 'dataAccessExpiresAt', 'expired', 'requiresRenewal', 'lastError', 'healthKind', 'observedAt', 'currentMetadata',
    'tokenType', 'clientBusinessId', 'configId', 'unknownSince', 'lastHealthyAt', 'issuerKind', 'issuerBusinessId'];
  if (!exact(value, keys) || !UUID.test(value.enrollmentId) || !UUID.test(value.versionId)
    || !positive(value.connectionId) || !positive(value.actorUserId) || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || value.epoch > 2147483647 || ![value.appId, value.subjectId].every(v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v))
    || !Array.isArray(value.clinicIds) || !value.clinicIds.length || value.clinicIds.length > 1000
    || value.clinicIds.some((id, i) => !positive(id) || i > 0 && id <= value.clinicIds[i - 1])
    || typeof value.expired !== 'boolean' || typeof value.requiresRenewal !== 'boolean' || !['USER', 'SYSTEM_USER'].includes(value.tokenType)
    || !['USER', 'BISU', 'AGENCY_SYSTEM_USER'].includes(value.issuerKind)
    || [value.clientBusinessId, value.configId, value.issuerBusinessId].some(v => v !== null && (typeof v !== 'string' || !/^[1-9][0-9]{0,29}$/.test(v)))
    || value.issuerKind === 'BISU' && (value.tokenType !== 'SYSTEM_USER' || value.clientBusinessId === null || value.configId === null || value.issuerBusinessId !== value.clientBusinessId)
    || value.issuerKind === 'AGENCY_SYSTEM_USER' && (value.tokenType !== 'SYSTEM_USER' || value.clientBusinessId !== null || value.issuerBusinessId === null)
    || value.issuerKind === 'USER' && (value.tokenType !== 'USER' || value.clientBusinessId !== null || value.configId !== null || value.issuerBusinessId !== null)
    || [value.unknownSince, value.lastHealthyAt].some(v => v !== null && (!Number.isSafeInteger(v) || v <= 0 || v > now + 5000))
    || !exact(value.currentMetadata, ['expiresAt', 'dataAccessExpiresAt', 'health', 'lastError', 'observedAt'])) fail();
  const owner = scope(value.scopeKey), metadata = value.currentMetadata;
  if (owner.type === 'clinic' && (value.clinicIds.length !== 1 || value.clinicIds[0] !== owner.id)
    || !HEALTH.has(metadata.health) || metadata.health !== value.healthKind || metadata.lastError !== value.lastError
    || metadata.lastError !== null && !ERRORS.has(metadata.lastError) || metadata.observedAt !== value.observedAt
    || typeof metadata.observedAt !== 'string' || !Number.isFinite(Date.parse(metadata.observedAt))
    || new Date(metadata.observedAt).toISOString() !== metadata.observedAt || Date.parse(metadata.observedAt) > now + 5000) fail();
  const expiresAt = expiry(metadata.expiresAt), dataAccessExpiresAt = expiry(metadata.dataAccessExpiresAt);
  if (expiresAt !== expiry(value.expiresAt) || dataAccessExpiresAt !== expiry(value.dataAccessExpiresAt)) fail();
  return { enrollmentId: value.enrollmentId, connectionId: value.connectionId, scopeKey: owner.key,
    clinicIds: value.clinicIds.slice(), epoch: value.epoch, versionId: value.versionId, expiresAt, dataAccessExpiresAt,
    health: metadata.health, lastError: metadata.lastError, observedAt: metadata.observedAt, tokenType: value.tokenType, issuerKind: value.issuerKind };
}

function maintenance(input, current, now = Date.now()) {
  const keys = ['enrollmentId', 'epoch', 'versionId', 'mechanism', 'automaticSupported', 'attemptState', 'humanReason',
    'lastAttemptAt', 'nextAttemptAt', 'unknownSince', 'lastHealthyAt'];
  if (!exact(input, keys) || input.enrollmentId !== current.enrollmentId || input.epoch !== current.epoch || input.versionId !== current.versionId
    || !['user_legacy', 'business_api', 'agency_system_user'].includes(input.mechanism) || input.automaticSupported !== (input.mechanism !== 'user_legacy')
    || input.mechanism !== (current.issuerKind === 'USER' ? 'user_legacy' : current.issuerKind === 'BISU' ? 'business_api' : 'agency_system_user')
    || input.automaticSupported !== (current.tokenType === 'SYSTEM_USER')
    || !ATTEMPTS.has(input.attemptState) || input.humanReason !== null && !HUMAN_REASONS.has(input.humanReason)) fail();
  for (const key of ['lastAttemptAt', 'nextAttemptAt', 'unknownSince', 'lastHealthyAt']) {
    if (input[key] !== null && (!Number.isSafeInteger(input[key]) || input[key] <= 0 || input[key] > 8640000000000000
      || key !== 'nextAttemptAt' && input[key] > now + 5000)) fail();
  }
  return { ...input };
}

function alertsFromStatus(input, now = Date.now(), maintenanceInput) {
  const value = status(input, now), upkeep = maintenance(maintenanceInput, value, now);
  const dates = [value.expiresAt, value.dataAccessExpiresAt].filter(v => v !== null);
  const at = dates.length ? Math.min(...dates) : null;
  let kind, threshold = null, episodeAt = null, eventKey, severity, title, detail;
  if (at !== null && at <= now) {
    kind = 'expired'; eventKey = EVENTS.expired; severity = 'critical'; title = 'La conexión de Meta ha caducado';
    detail = 'La validez del acceso actual ha vencido y no se ha confirmado una sustitución válida. Revisa la recuperación de esta conexión en Ajustes.';
  } else if (value.health === 'permission_lost' && PERMANENT.has(value.lastError)) {
    kind = 'permission_lost'; eventKey = EVENTS.lost; severity = 'critical'; title = 'Meta ha retirado el acceso de la conexión actual';
    detail = 'Se ha confirmado una pérdida de autorización de la versión actualmente utilizada. Revisa sus permisos y renueva la conexión.';
  } else if (upkeep.attemptState === 'human_required' && upkeep.humanReason === 'authorization_required'
    || !upkeep.automaticSupported && at !== null && at - now <= SAFETY_MARGIN) {
    kind = 'human_required'; eventKey = EVENTS.human; severity = 'warning';
    title = 'La conexión de Meta necesita una autorización';
    detail = 'Este acceso necesita la intervención de una persona con permisos en el negocio. Revisa la autorización necesaria en Ajustes; la configuración y sus asignaciones se conservan.';
  } else if (upkeep.automaticSupported && upkeep.attemptState !== 'succeeded' && at !== null && at - now <= SAFETY_MARGIN) {
    threshold = 3; kind = 'renewal_safety_margin'; eventKey = EVENTS.soon; severity = 'warning';
    title = 'No se ha confirmado a tiempo la renovación automática de Meta';
    detail = 'Quedan como máximo tres días de validez del acceso actual y no se ha confirmado su sustitución. Revisa el mantenimiento de esta conexión antes del vencimiento.';
  } else if (upkeep.unknownSince !== null && now - upkeep.unknownSince >= UNKNOWN_MARGIN
    && (upkeep.lastHealthyAt === null || upkeep.lastHealthyAt < upkeep.unknownSince)) {
    threshold = 6; episodeAt = upkeep.unknownSince; kind = 'supervision_unknown'; eventKey = EVENTS.unknown; severity = 'warning';
    title = 'No se ha podido confirmar el estado de Meta durante seis horas';
    detail = 'La supervisión de esta conexión sigue sin poder confirmar su estado. Esto no acredita una revocación. Revisa la incidencia y el próximo intento desde Ajustes.';
  } else return [];
  const identity = { enrollmentId: value.enrollmentId, connectionId: value.connectionId, epoch: value.epoch,
    versionId: value.versionId, kind, threshold, episodeAt, scopeKey: value.scopeKey };
  const owner = scope(value.scopeKey), clinics = value.clinicIds.slice(0, 20).join(', ')
    + (value.clinicIds.length > 20 ? ' y otras ' + (value.clinicIds.length - 20) : '');
  const context = 'Conexión Meta ' + value.connectionId + ', ' + (owner.type === 'group' ? 'grupo ' : 'clínica ') + owner.id
    + '; clínicas afectadas: ' + clinics + '. ';
  return [{ eventKey, payload: { severity, title, detail: context + detail, action: 'Revisar la conexión y la acción necesaria en Ajustes.', occurredAt: new Date(now).toISOString() },
    metadata: { source: 'meta_marketing_credential_lifecycle', incident_scope: 'meta:' + hash(identity),
      incident_impact: [kind, threshold === null ? 'current' : (kind === 'supervision_unknown' ? 'hours_' : 'days_') + threshold], credential: identity,
      action_scope: value.scopeKey, affected_clinic_ids: value.clinicIds.slice(), operational_summary: title } }];
}

function resolution(original, currentInput, now = Date.now(), maintenanceInput) {
  const previous = original?.metadata?.credential;
  if (!MANAGED.has(original?.eventKey) || !previous || !UUID.test(previous.enrollmentId) || !UUID.test(previous.versionId)
    || !Number.isSafeInteger(previous.epoch) || previous.epoch < 0 || !currentInput) return null;
  const current = status(currentInput, now), upkeep = maintenance(maintenanceInput, current, now);
  const dates = [current.expiresAt, current.dataAccessExpiresAt].filter(v => v !== null);
  if (current.enrollmentId !== previous.enrollmentId || current.connectionId !== previous.connectionId || current.scopeKey !== previous.scopeKey
    || current.health !== 'healthy' || current.lastError !== null || dates.some(v => v <= now)) return null;
  const replacement = current.epoch > previous.epoch && current.versionId !== previous.versionId;
  const sameVersion = current.epoch === previous.epoch && current.versionId === previous.versionId;
  const positiveAfterIncident = upkeep.lastHealthyAt !== null && upkeep.lastHealthyAt > Date.parse(original.payload?.occurredAt);
  const recoveredUnknown = previous.kind === 'supervision_unknown' && sameVersion && positiveAfterIncident && upkeep.unknownSince === null;
  const restoredAuthorization = ['permission_lost', 'human_required'].includes(previous.kind) && sameVersion && positiveAfterIncident
    && upkeep.humanReason === null && upkeep.attemptState !== 'human_required';
  if (!replacement && !recoveredUnknown && !restoredAuthorization) return null;
  return { severity: 'info', title: 'Se ha confirmado la recuperación del acceso a Meta',
    detail: 'El estado confirmado de este ámbito permite cerrar la incidencia. La resolución queda en el registro operativo; no acredita una sincronización posterior ni reactiva campañas.',
    action: 'Revisar el estado de la conexión en Ajustes.', occurredAt: new Date(upkeep.lastHealthyAt ?? Date.parse(current.observedAt)).toISOString() };
}

function handoverResolution(original, result, now = Date.now()) {
  const previous = original?.metadata?.credential;
  if (!MANAGED.has(original?.eventKey) || !previous || !result) return null;
  if (!exact(result, ['currentStatus', 'maintenanceStatus', 'proof'])) fail();
  const proof = result.proof, keys = ['oldEnrollmentId', 'oldEpoch', 'oldVersionId', 'newEnrollmentId', 'oldConnectionId', 'newConnectionId', 'scopeKey', 'chainDigest'];
  if (!exact(proof, keys) || !UUID.test(proof.oldEnrollmentId) || !UUID.test(proof.oldVersionId) || !UUID.test(proof.newEnrollmentId)
    || !Number.isSafeInteger(proof.oldEpoch) || proof.oldEpoch < 0 || !positive(proof.oldConnectionId) || !positive(proof.newConnectionId)
    || typeof proof.chainDigest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.chainDigest)
    || proof.oldEnrollmentId !== previous.enrollmentId || proof.oldEpoch !== previous.epoch || proof.oldVersionId !== previous.versionId
    || proof.oldConnectionId !== previous.connectionId || proof.scopeKey !== previous.scopeKey || proof.newEnrollmentId === proof.oldEnrollmentId) fail();
  const current = status(result.currentStatus, now), upkeep = maintenance(result.maintenanceStatus, current, now);
  if (proof.newEnrollmentId !== current.enrollmentId || proof.newConnectionId !== current.connectionId || proof.scopeKey !== current.scopeKey
    || current.tokenType !== 'SYSTEM_USER' || current.versionId === previous.versionId) fail();
  const dates = [current.expiresAt, current.dataAccessExpiresAt].filter(v => v !== null);
  if (current.health !== 'healthy' || current.lastError !== null || dates.some(v => v <= now)
    || upkeep.lastHealthyAt === null || upkeep.lastHealthyAt <= Date.parse(original.payload?.occurredAt)) return null;
  return { severity: 'info', title: 'Se ha confirmado el acceso empresarial de Meta',
    detail: 'Un handover comprobado enlaza la autorización anterior con el acceso empresarial activo del mismo ámbito. La incidencia anterior queda resuelta sin retirar activos, historial ni WhatsApp.',
    action: 'Revisar el estado de la conexión en Ajustes.', occurredAt: new Date(upkeep.lastHealthyAt).toISOString() };
}

module.exports = { EVENTS, MANAGED, HEALTH, PERMANENT, ERRORS, ATTEMPTS, HUMAN_REASONS, DAY, SAFETY_MARGIN, UNKNOWN_MARGIN,
  expiry, scope, actionPath, actionUrl, status, maintenance, alertsFromStatus, resolution, handoverResolution };
