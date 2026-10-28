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
}, { GoogleConnectionModel = db.GoogleConnection, models = db,
  sequelize = GoogleConnectionModel.sequelize || models.sequelize } = {}) {
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

  const guard = require('./googleLegacyOAuthGuard.service').createGoogleLegacyOAuthGuard({ models });
  if (!sequelize?.transaction) throw Object.assign(Error('google_oauth_unavailable'), { code: 'google_oauth_unavailable', httpStatus: 503 });
  return sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, async transaction => {
    await guard.assertAllowed({ transaction });
    const existing = await GoogleConnectionModel.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (existing) {
      await existing.update({ ...payload, refreshToken: refreshToken || existing.refreshToken || null }, { transaction });
      await guard.assertAllowed({ transaction });
      return existing;
    }
    const created = await GoogleConnectionModel.create(payload, { transaction });
    await guard.assertAllowed({ transaction });
    return created;
  });
}

async function persistMetaConnection({
  userId,
  metaUserId,
  userName = null,
  userEmail = null,
  accessToken,
  expiresAt,
}, { MetaConnectionModel = db.MetaConnection } = {}) {
  require('../lib/metaQuarantineHttp').assertMetaAvailable();
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
