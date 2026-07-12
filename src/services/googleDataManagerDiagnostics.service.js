'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  GOOGLE_DATA_MANAGER_SCOPE,
  retrieveRequestStatus
} = require('./googleDataManagerConversion.service');
const { ensureGoogleConnectionAccessToken } = require('./googleAdsScopedRuntime.service');

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function truncate(value, maxLength = 2000) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function statusEntries(payload) {
  return Array.isArray(payload?.requestStatusPerDestination)
    ? payload.requestStatusPerDestination
    : Array.isArray(payload?.request_status_per_destination)
      ? payload.request_status_per_destination
      : [];
}

function normalizedDestinationStatus(entry) {
  return String(entry?.requestStatus || entry?.request_status || '').trim().toUpperCase();
}

function summarizeDestination(entry) {
  const destination = entry?.destination || {};
  const operatingAccount = destination.operatingAccount || destination.operating_account || {};
  const errors = entry?.errorInfo?.errorCounts
    || entry?.error_info?.error_counts
    || [];
  const warnings = entry?.warningInfo?.warningCounts
    || entry?.warning_info?.warning_counts
    || [];
  const ingestion = entry?.eventsIngestionStatus || entry?.events_ingestion_status || {};
  return {
    status: normalizedDestinationStatus(entry) || null,
    customer_id: cleanString(operatingAccount.accountId || operatingAccount.account_id),
    conversion_action_id: cleanString(destination.productDestinationId || destination.product_destination_id),
    record_count: Number(ingestion.recordCount || ingestion.record_count || 0),
    errors: errors.slice(0, 20).map((item) => ({
      reason: cleanString(item.reason),
      record_count: Number(item.recordCount || item.record_count || 0)
    })),
    warnings: warnings.slice(0, 20).map((item) => ({
      reason: cleanString(item.reason),
      record_count: Number(item.recordCount || item.record_count || 0)
    }))
  };
}

function classifyDiagnostics(payload) {
  const destinations = statusEntries(payload).map(summarizeDestination);
  const statuses = destinations.map((entry) => entry.status).filter(Boolean);
  const nonTerminal = new Set(['PROCESSING', 'REQUEST_STATUS_UNKNOWN', 'REQUEST_STATUS_UNSPECIFIED', 'UNKNOWN']);
  if (!statuses.length || statuses.some((status) => nonTerminal.has(status))) {
    return { terminal: false, status: 'accepted', reason: 'provider_processing', destinations };
  }
  if (statuses.every((status) => status === 'SUCCESS')) {
    return { terminal: true, status: 'succeeded', reason: null, destinations };
  }
  if (statuses.every((status) => status === 'FAILURE' || status === 'FAILED')) {
    return { terminal: true, status: 'failed', reason: 'provider_processing_failed', destinations };
  }
  return { terminal: true, status: 'partial_success', reason: 'provider_partial_success', destinations };
}

function summarizeRetrieveError(error) {
  const provider = error?.response?.data?.error || null;
  return {
    checked_at: new Date().toISOString(),
    http_status: Number(error?.response?.status) || null,
    code: truncate(provider?.status || provider?.code || error?.code, 128),
    message: truncate(provider?.message || error?.message || 'No se pudo recuperar Diagnostics')
  };
}

function appendHistory(row) {
  const history = Array.isArray(row?.history) ? [...row.history] : [];
  history.push({
    status: row?.status || null,
    reason: row?.reason || null,
    attempted_at: row?.attemptedAt || null,
    completed_at: row?.completedAt || null,
    error_code: row?.lastErrorCode || null,
    error_message: row?.lastErrorMessage || null
  });
  return history.slice(-20);
}

async function reconcileGoogleDataManagerDiagnostics({
  limit = 100,
  minAgeMinutes = 30,
  attemptModel = db.GoogleAdsConversionUploadAttempt,
  connectionModel = db.GoogleConnection,
  ensureAccessToken = ensureGoogleConnectionAccessToken,
  retrieveStatus = retrieveRequestStatus,
  now = new Date()
} = {}) {
  const cutoff = new Date(now.getTime() - Math.max(1, Number(minAgeMinutes) || 30) * 60 * 1000);
  const attempts = await attemptModel.findAll({
    where: {
      status: 'accepted',
      providerRequestId: { [Op.ne]: null },
      updated_at: { [Op.lte]: cutoff }
    },
    order: [['updated_at', 'ASC']],
    limit: Math.min(500, Math.max(1, Number(limit) || 100))
  });

  const summary = { checked: 0, processing: 0, succeeded: 0, partial_success: 0, failed: 0, errors: 0 };
  const tokenCache = new Map();

  for (const attempt of attempts) {
    summary.checked += 1;
    try {
      const connectionId = Number(attempt.googleConnectionId || 0) || null;
      if (!connectionId) throw Object.assign(new Error('El intento no conserva google_connection_id'), { code: 'CONNECTION_REQUIRED' });
      let accessToken = tokenCache.get(connectionId);
      if (!accessToken) {
        const connection = await connectionModel.findByPk(connectionId);
        const token = await ensureAccessToken(connection, { requiredScopes: [GOOGLE_DATA_MANAGER_SCOPE] });
        accessToken = token.accessToken;
        tokenCache.set(connectionId, accessToken);
      }
      const payload = await retrieveStatus({
        accessToken,
        requestId: attempt.providerRequestId
      });
      const classified = classifyDiagnostics(payload);
      const previousMetadata = attempt.responseMetadata && typeof attempt.responseMetadata === 'object'
        ? attempt.responseMetadata
        : {};
      await attempt.update({
        status: classified.status,
        reason: classified.reason,
        responseMetadata: {
          ...previousMetadata,
          transport: 'google_data_manager',
          processing_status: classified.terminal ? classified.status.toUpperCase() : 'PROCESSING',
          diagnostics_checked_at: now.toISOString(),
          destinations: classified.destinations
        },
        history: classified.terminal ? appendHistory(attempt) : attempt.history,
        lastErrorCode: classified.status === 'failed' ? 'DATA_MANAGER_PROCESSING_FAILED' : null,
        lastErrorMessage: classified.status === 'failed'
          ? 'Google Data Manager rechazó todos los registros durante el procesamiento asíncrono'
          : null,
        completedAt: classified.terminal ? now : null
      });
      summary[classified.status === 'accepted' ? 'processing' : classified.status] += 1;
    } catch (error) {
      summary.errors += 1;
      const previousMetadata = attempt.responseMetadata && typeof attempt.responseMetadata === 'object'
        ? attempt.responseMetadata
        : {};
      await attempt.update({
        responseMetadata: {
          ...previousMetadata,
          transport: 'google_data_manager',
          diagnostics_error: summarizeRetrieveError(error)
        }
      });
    }
  }

  return summary;
}

module.exports = {
  classifyDiagnostics,
  reconcileGoogleDataManagerDiagnostics,
  summarizeDestination,
  summarizeRetrieveError
};
