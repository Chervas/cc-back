'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');

const COORDINATION_EVENT_TYPE = 'coordination_updated';
const COORDINATION_TEXT_MAX = 2000;
const COORDINATION_FIELDS = Object.freeze([
  'assigned_to_user_id',
  'next_action',
  'operational_blocker',
]);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

function coordinationError(code, message, httpStatus = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  Object.assign(error, extra);
  return error;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function strictPositiveInteger(value, field, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw coordinationError(code, `${field} debe ser un entero positivo.`);
  }
  return value;
}

function normalizeNullableText(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw coordinationError('coordination_text_invalid', `${field} debe ser texto o null.`);
  }
  const normalized = value.trim();
  if (normalized.length > COORDINATION_TEXT_MAX) {
    throw coordinationError(
      'coordination_text_too_long',
      `${field} no puede superar ${COORDINATION_TEXT_MAX} caracteres.`
    );
  }
  return normalized || null;
}

function parseCoordinationInput(input) {
  const source = plainObject(input);
  if (!source) {
    throw coordinationError('coordination_payload_invalid', 'El payload de coordinación debe ser un objeto JSON.');
  }
  const allowedFields = new Set(['expected_version', ...COORDINATION_FIELDS]);
  const unknownFields = Object.keys(source).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw coordinationError(
      'coordination_unknown_fields',
      `Campos no admitidos en coordinación: ${unknownFields.join(', ')}.`
    );
  }
  const expectedVersion = strictPositiveInteger(
    source.expected_version,
    'expected_version',
    'coordination_expected_version_invalid'
  );
  const patch = {};
  const requestedFields = [];
  for (const field of COORDINATION_FIELDS) {
    if (!hasOwn(source, field)) continue;
    requestedFields.push(field);
    if (field === 'assigned_to_user_id') {
      patch[field] = source[field] === null
        ? null
        : strictPositiveInteger(
          source[field],
          field,
          'coordination_assignee_invalid'
        );
    } else {
      patch[field] = normalizeNullableText(source[field], field);
    }
  }
  if (!requestedFields.length) {
    throw coordinationError(
      'coordination_patch_required',
      'Indica al menos un campo de coordinación para actualizar.'
    );
  }
  return { expectedVersion, patch, requestedFields };
}

function campaignOperatorIds(adminIds = [], configuredValue = '') {
  const configured = String(configuredValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return new Set([
    ...adminIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0),
    ...configured,
  ]);
}

function operatorDisplayName(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : (row || {});
  const name = [plain.nombre, plain.apellidos]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  const id = Number(plain.id_usuario);
  return name
    || String(plain.email_usuario || '').trim()
    || (Number.isSafeInteger(id) && id > 0 ? `Usuario #${id}` : 'Operador');
}

function operatorCatalogDto(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : (row || {});
  return {
    id: Number(plain.id_usuario),
    display_name: operatorDisplayName(plain),
    email: typeof plain.email_usuario === 'string' && plain.email_usuario.trim()
      ? plain.email_usuario.trim()
      : null,
    avatar: typeof plain.avatar === 'string' && plain.avatar.trim() ? plain.avatar.trim() : null,
  };
}

function operatorSummaryDto(row) {
  if (!row) return null;
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const id = Number(plain.id_usuario);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return { id, display_name: operatorDisplayName(plain) };
}

async function listActiveCampaignOperators({
  allowedOperatorIds,
  userModel,
} = {}) {
  const ids = Array.from(allowedOperatorIds || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (!userModel || !ids.length) return [];
  const rows = await userModel.findAll({
    where: {
      id_usuario: { [Op.in]: ids },
      estado_cuenta: 'activo',
    },
    attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar'],
    order: [['nombre', 'ASC'], ['apellidos', 'ASC'], ['id_usuario', 'ASC']],
    raw: true,
  });
  return rows.map(operatorCatalogDto);
}

async function requireActiveCampaignOperator({
  userId,
  allowedOperatorIds,
  userModel,
  transaction = null,
} = {}) {
  const normalizedId = Number(userId);
  if (!Number.isSafeInteger(normalizedId) || !allowedOperatorIds?.has(normalizedId)) {
    throw coordinationError('campaign_operator_only', 'Acceso reservado al equipo de campañas.', 403);
  }
  const row = await userModel.findOne({
    where: { id_usuario: normalizedId, estado_cuenta: 'activo' },
    attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar'],
    raw: true,
    ...(transaction ? { transaction } : {}),
  });
  if (!row) {
    throw coordinationError(
      'campaign_operator_inactive',
      'El operador no existe o su cuenta no está activa.',
      403
    );
  }
  return row;
}

function currentCoordinationValue(campaign, field) {
  const plain = typeof campaign?.get === 'function' ? campaign.get({ plain: true }) : campaign;
  if (field === 'assigned_to_user_id') {
    const value = Number(plain?.assigned_to_user_id);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return typeof plain?.[field] === 'string' ? plain[field] : null;
}

async function updateManagedCampaignCoordination({
  campaignId,
  actorUserId,
  allowedOperatorIds,
  input,
  sequelize,
  campaignModel,
  auditModel,
  userModel,
  uuid = () => crypto.randomUUID(),
} = {}) {
  const parsed = parseCoordinationInput(input);
  const actorId = Number(actorUserId);
  if (!Number.isSafeInteger(actorId) || !allowedOperatorIds?.has(actorId)) {
    throw coordinationError('campaign_operator_only', 'Acceso reservado al equipo de campañas.', 403);
  }
  const requestedAssignee = hasOwn(parsed.patch, 'assigned_to_user_id')
    ? parsed.patch.assigned_to_user_id
    : undefined;
  if (requestedAssignee !== undefined
    && requestedAssignee !== null
    && !allowedOperatorIds.has(requestedAssignee)) {
    throw coordinationError(
      'coordination_assignee_invalid',
      'El responsable debe ser un operador activo de campañas.'
    );
  }

  return sequelize.transaction(async (transaction) => {
    const requiredUserIds = Array.from(new Set([
      actorId,
      ...(requestedAssignee ? [requestedAssignee] : []),
    ])).sort((left, right) => left - right);
    const activeUsers = await userModel.findAll({
      where: {
        id_usuario: { [Op.in]: requiredUserIds },
        estado_cuenta: 'activo',
      },
      attributes: ['id_usuario'],
      raw: true,
      transaction,
      lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE,
    });
    const activeUserIds = new Set(activeUsers.map((row) => Number(row.id_usuario)));
    if (!activeUserIds.has(actorId)) {
      throw coordinationError(
        'campaign_operator_inactive',
        'El operador no existe o su cuenta no está activa.',
        403
      );
    }
    if (requestedAssignee && !activeUserIds.has(requestedAssignee)) {
      throw coordinationError(
        'coordination_assignee_invalid',
        'El responsable debe ser un operador activo de campañas.'
      );
    }

    const campaign = await campaignModel.findByPk(campaignId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!campaign) {
      throw coordinationError('not_found', 'Campaña no encontrada.', 404);
    }
    const currentVersion = Number(campaign.version);
    if (currentVersion !== parsed.expectedVersion) {
      throw coordinationError(
        'operation_version_conflict',
        'La coordinación cambió mientras editabas. Recarga antes de guardar.',
        409,
        { currentVersion }
      );
    }
    if (TERMINAL_STATUSES.has(String(campaign.status))) {
      throw coordinationError(
        'terminal_campaign_coordination_locked',
        'Una campaña completada o cancelada no admite cambios de coordinación.',
        409
      );
    }

    const changes = {};
    const updateValues = {};
    for (const field of parsed.requestedFields) {
      const before = currentCoordinationValue(campaign, field);
      const after = parsed.patch[field];
      if (before === after) continue;
      changes[field] = { before, after };
      updateValues[field] = after;
    }
    if (!Object.keys(changes).length) {
      return {
        changed: false,
        audit: null,
        version: currentVersion,
      };
    }

    const nextVersion = currentVersion + 1;
    updateValues.updated_by_user_id = actorId;
    updateValues.version = nextVersion;
    const [updatedCount] = await campaignModel.update(updateValues, {
      where: { id: campaignId, version: currentVersion },
      transaction,
    });
    if (updatedCount !== 1) {
      throw coordinationError(
        'operation_version_conflict',
        'La coordinación cambió mientras editabas. Recarga antes de guardar.',
        409,
        { currentVersion }
      );
    }
    const audit = await auditModel.create({
      id: uuid(),
      managed_campaign_id: campaignId,
      event_type: COORDINATION_EVENT_TYPE,
      actor_user_id: actorId,
      from_version: currentVersion,
      to_version: nextVersion,
      changes,
    }, { transaction });
    return { changed: true, audit, version: nextVersion };
  });
}

function operationAuditDto(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : (row || {});
  return {
    id: String(plain.id || ''),
    event_type: plain.event_type || COORDINATION_EVENT_TYPE,
    actor_user_id: Number(plain.actor_user_id),
    actor_name: plain.actor ? operatorDisplayName(plain.actor) : `Usuario #${Number(plain.actor_user_id)}`,
    from_version: Number(plain.from_version),
    to_version: Number(plain.to_version),
    changes: plainObject(plain.changes) || {},
    created_at: plain.created_at || null,
  };
}

module.exports = {
  COORDINATION_EVENT_TYPE,
  COORDINATION_FIELDS,
  COORDINATION_TEXT_MAX,
  campaignOperatorIds,
  listActiveCampaignOperators,
  operationAuditDto,
  operatorCatalogDto,
  operatorDisplayName,
  operatorSummaryDto,
  parseCoordinationInput,
  requireActiveCampaignOperator,
  updateManagedCampaignCoordination,
};
