'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const db = require('../../models');
const { normalizeCustomerId } = require('../lib/googleAdsClient');
const { resolveGoogleConnectionForScope } = require('./scopeConnectionResolver.service');

const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const GOOGLE_DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasGoogleAdsScope(scopes) {
  return String(scopes || '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .includes(GOOGLE_ADS_SCOPE);
}

function normalizeRequiredScopes(requiredScopes) {
  const values = Array.isArray(requiredScopes) && requiredScopes.length
    ? requiredScopes
    : [GOOGLE_ADS_SCOPE];
  return Array.from(new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean)));
}

function missingGoogleScopes(scopes, requiredScopes) {
  const granted = new Set(String(scopes || '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean));
  return normalizeRequiredScopes(requiredScopes).filter((scope) => !granted.has(scope));
}

function runtimeError(code, message, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

async function ensureGoogleConnectionAccessToken(connection, {
  axiosClient = axios,
  requiredScopes = [GOOGLE_ADS_SCOPE]
} = {}) {
  if (!connection) throw runtimeError('NO_SCOPED_CONNECTION', 'No existe conexión Google asignada al scope', 404);
  const missingScopes = missingGoogleScopes(connection.scopes, requiredScopes);
  if (missingScopes.length) {
    const error = runtimeError(
      'INSUFFICIENT_SCOPE',
      missingScopes.includes(GOOGLE_DATA_MANAGER_SCOPE)
        ? 'La conexión Google requiere reautorización con permisos de Data Manager'
        : 'La conexión Google asignada no tiene todos los permisos requeridos',
      403
    );
    error.missingScopes = missingScopes;
    throw error;
  }
  if (!connection.accessToken) {
    throw runtimeError('NO_TOKEN', 'La conexión Google asignada no tiene access token', 409);
  }

  let accessToken = connection.accessToken;
  let expiresAt = connection.expiresAt ? new Date(connection.expiresAt) : null;
  const refreshThreshold = Date.now() + 60_000;
  const shouldRefresh = !expiresAt || expiresAt.getTime() <= refreshThreshold;

  if (!shouldRefresh) return { accessToken, expiresAt };
  if (!connection.refreshToken) {
    throw runtimeError('TOKEN_EXPIRED', 'La conexión Google asignada requiere reautorización', 409);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    throw runtimeError('OAUTH_APP_CONFIG_MISSING', 'Falta la configuración OAuth de la aplicación', 500);
  }

  try {
    const response = await axiosClient.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000
      }
    );
    if (!response?.data?.access_token) {
      throw runtimeError('REFRESH_FAILED', 'Google no devolvió un access token', 409);
    }
    accessToken = response.data.access_token;
    expiresAt = new Date(Date.now() + Number(response.data.expires_in || 3600) * 1000);
    await connection.update({ accessToken, expiresAt });
    return { accessToken, expiresAt };
  } catch (error) {
    if (error.code === 'REFRESH_FAILED') throw error;
    throw runtimeError(
      'REFRESH_FAILED',
      error.response?.data?.error_description || error.message || 'No se pudo refrescar la conexión Google asignada',
      409
    );
  }
}

function buildScopedGoogleAccountWhere({ clinicId, groupId, assignmentScope }) {
  const normalizedClinicId = parseInteger(clinicId);
  const normalizedGroupId = parseInteger(groupId);
  const normalizedAssignmentScope = String(assignmentScope || '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
  const alternatives = [];

  if (normalizedAssignmentScope === 'clinic' && normalizedClinicId) {
    alternatives.push({ clinicaId: normalizedClinicId });
  }
  if (normalizedGroupId) {
    alternatives.push({ grupoClinicaId: normalizedGroupId, assignmentScope: 'group' });
  }
  if (normalizedAssignmentScope === 'group' && normalizedClinicId) {
    alternatives.push({ clinicaId: normalizedClinicId });
  }

  if (!alternatives.length) {
    throw runtimeError('SCOPE_REQUIRED', 'clinic_id o group_id es obligatorio', 400);
  }
  return alternatives.length === 1 ? alternatives[0] : { [Op.or]: alternatives };
}

async function resolveScopedGoogleAdsRuntime({
  userId = null,
  clinicId = null,
  groupId = null,
  assignmentScope = null,
  customerId,
  resolver = resolveGoogleConnectionForScope,
  accountModel = db.ClinicGoogleAdsAccount,
  ensureAccessToken = ensureGoogleConnectionAccessToken,
  requiredScopes = [GOOGLE_ADS_SCOPE]
}) {
  const cleanCustomerId = normalizeCustomerId(customerId);
  if (!cleanCustomerId) throw runtimeError('CUSTOMER_ID_REQUIRED', 'customer_id es obligatorio', 400);

  const resolved = await resolver({
    userId,
    clinicIdRaw: clinicId,
    groupIdRaw: groupId,
    assignmentScopeRaw: assignmentScope,
    allowLegacyUserFallback: false
  });
  const connection = resolved?.connection || null;
  if (!connection) {
    throw runtimeError('NO_SCOPED_CONNECTION', 'No existe conexión Google asignada a esta clínica o grupo', 404);
  }

  const scope = resolved.scope || {
    clinicId: parseInteger(clinicId),
    groupId: parseInteger(groupId),
    assignmentScope: String(assignmentScope || '').trim().toLowerCase() === 'group' ? 'group' : 'clinic'
  };
  const account = await accountModel.findOne({
    where: {
      googleConnectionId: connection.id,
      customerId: cleanCustomerId,
      isActive: true,
      ...buildScopedGoogleAccountWhere(scope)
    },
    order: [['updated_at', 'DESC']]
  });
  if (!account) {
    throw runtimeError(
      'CUSTOMER_NOT_ASSIGNED_TO_SCOPE',
      'La cuenta de Google Ads no está asignada a esta clínica o grupo con la conexión efectiva',
      403
    );
  }

  const token = await ensureAccessToken(connection, { requiredScopes });
  return {
    accessToken: token.accessToken,
    connection,
    assignment: resolved.assignment || null,
    connectionSource: resolved.source || null,
    scope,
    account,
    customerId: cleanCustomerId,
    loginCustomerId: normalizeCustomerId(account.loginCustomerId || account.managerCustomerId || '') || null
  };
}

module.exports = {
  GOOGLE_ADS_SCOPE,
  GOOGLE_DATA_MANAGER_SCOPE,
  buildScopedGoogleAccountWhere,
  ensureGoogleConnectionAccessToken,
  hasGoogleAdsScope,
  missingGoogleScopes,
  normalizeRequiredScopes,
  resolveScopedGoogleAdsRuntime,
  runtimeError
};
