'use strict';

const db = require('../../models');

function positiveInteger(value, field) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${field} inválido`);
    error.code = 'oauth_connection_identity_invalid';
    throw error;
  }
  return parsed;
}

function providerIdentity(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    const error = new Error(`${field} ausente en la respuesta del proveedor`);
    error.code = 'oauth_connection_identity_invalid';
    throw error;
  }
  return normalized;
}

async function createOrUpdateByIdentity(Model, where, payload, mergeExisting) {
  let existing = await Model.findOne({ where });
  if (existing) {
    await existing.update(mergeExisting(existing, payload));
    return existing;
  }

  try {
    return await Model.create(payload);
  } catch (error) {
    // Dos callbacks concurrentes pueden competir por el mismo índice compuesto.
    // Solo absorbemos el conflicto si la fila canónica ya existe; cualquier otro
    // error de persistencia conserva su semántica original.
    existing = await Model.findOne({ where });
    if (!existing) throw error;
    await existing.update(mergeExisting(existing, payload));
    return existing;
  }
}

async function persistGoogleConnection({
  userId,
  googleUserId,
  userEmail = null,
  userName = null,
  accessToken,
  refreshToken = null,
  scopes = null,
  expiresAt,
}, { GoogleConnectionModel = db.GoogleConnection } = {}) {
  const normalizedUserId = positiveInteger(userId, 'userId');
  const normalizedProviderId = providerIdentity(googleUserId, 'googleUserId');
  const where = {
    userId: normalizedUserId,
    googleUserId: normalizedProviderId,
  };
  const payload = {
    ...where,
    userEmail,
    userName,
    accessToken,
    refreshToken,
    scopes,
    expiresAt,
  };

  return createOrUpdateByIdentity(
    GoogleConnectionModel,
    where,
    payload,
    (existing, next) => ({
      ...next,
      refreshToken: next.refreshToken || existing.refreshToken || null,
    })
  );
}

async function persistMetaConnection({
  userId,
  metaUserId,
  userName = null,
  userEmail = null,
  accessToken,
  expiresAt,
}, { MetaConnectionModel = db.MetaConnection } = {}) {
  const normalizedUserId = positiveInteger(userId, 'userId');
  const normalizedProviderId = providerIdentity(metaUserId, 'metaUserId');
  const where = {
    userId: normalizedUserId,
    metaUserId: normalizedProviderId,
  };
  const payload = {
    ...where,
    userName,
    userEmail,
    accessToken,
    expiresAt,
  };

  return createOrUpdateByIdentity(
    MetaConnectionModel,
    where,
    payload,
    (_existing, next) => next
  );
}

module.exports = {
  persistGoogleConnection,
  persistMetaConnection,
  providerIdentity,
};
