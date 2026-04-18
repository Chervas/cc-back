'use strict';

const db = require('../../models');
const whatsappService = require('./whatsapp.service');
const jobRequestsService = require('./jobRequests.service');

const { ClinicMetaAsset } = db;

const CONTACTS_JOB_TYPE = 'whatsapp_coexistence_sync_contacts';
const HISTORY_JOB_TYPE = 'whatsapp_coexistence_sync_history';

function nowIso() {
  return new Date().toISOString();
}

function normalizePhoneNumberId(value) {
  return String(value || '').trim();
}

function isCoexistenceAsset(asset) {
  const data = asset?.additionalData || {};
  return (
    data.whatsappConnectionMode === 'coexistence' ||
    data.connectionMode === 'coexistence' ||
    data.isOnBizApp === true ||
    data.coexistence?.enabled === true
  );
}

async function findActivePhoneAsset(phoneNumberId) {
  const normalized = normalizePhoneNumberId(phoneNumberId);
  if (!normalized) {
    throw new Error('phone_number_id_required');
  }

  return ClinicMetaAsset.findOne({
    where: {
      assetType: 'whatsapp_phone_number',
      phoneNumberId: normalized,
      isActive: true,
    },
  });
}

async function updateCoexistenceMetadata(asset, patch) {
  const additionalData = { ...(asset.additionalData || {}) };
  additionalData.coexistence = {
    ...(additionalData.coexistence || {}),
    ...patch,
    updated_at: nowIso(),
  };
  asset.additionalData = additionalData;
  await asset.save();
  return asset;
}

function buildRequestedPatch(kind, response) {
  const requestId = response?.request_id || null;
  if (kind === 'contacts') {
    return {
      contacts_sync_status: 'requested',
      contacts_sync_requested_at: nowIso(),
      contacts_sync_request_id: requestId,
      contacts_sync_error: null,
    };
  }

  return {
    history_sync_status: 'requested',
    history_sync_requested_at: nowIso(),
    history_sync_request_id: requestId,
    history_sync_error: null,
  };
}

function buildErrorPatch(kind, error) {
  const payload = {
    message: error?.response?.data?.error?.message || error?.message || 'sync_failed',
    code: error?.response?.data?.error?.code || null,
    raw: error?.response?.data || null,
    at: nowIso(),
  };

  if (kind === 'contacts') {
    return {
      contacts_sync_status: 'error',
      contacts_sync_error: payload,
    };
  }

  return {
    history_sync_status: 'error',
    history_sync_error: payload,
  };
}

async function requestSync({ phoneNumberId, kind }) {
  const asset = await findActivePhoneAsset(phoneNumberId);
  if (!asset) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'phone_not_found', phone_number_id: phoneNumberId },
    };
  }

  if (!isCoexistenceAsset(asset)) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'not_coexistence', phone_number_id: phoneNumberId },
    };
  }

  if (!asset.waAccessToken) {
    throw new Error('missing_access_token');
  }

  const syncType = kind === 'contacts' ? 'smb_app_state_sync' : 'history';

  try {
    await updateCoexistenceMetadata(asset, {
      [`${kind}_sync_status`]: 'requesting',
      [`${kind}_sync_last_attempt_at`]: nowIso(),
    });

    const response = await whatsappService.requestBusinessAppDataSync({
      phoneNumberId: asset.phoneNumberId,
      accessToken: asset.waAccessToken,
      syncType,
    });

    await updateCoexistenceMetadata(asset, buildRequestedPatch(kind, response));

    return {
      status: 'completed',
      result: {
        phone_number_id: asset.phoneNumberId,
        waba_id: asset.wabaId || null,
        kind,
        sync_type: syncType,
        request_id: response?.request_id || null,
        response,
      },
    };
  } catch (error) {
    await updateCoexistenceMetadata(asset, buildErrorPatch(kind, error));
    throw error;
  }
}

async function runContactsSyncJob(payload = {}) {
  return requestSync({
    phoneNumberId: payload.phone_number_id || payload.phoneNumberId,
    kind: 'contacts',
  });
}

async function runHistorySyncJob(payload = {}) {
  return requestSync({
    phoneNumberId: payload.phone_number_id || payload.phoneNumberId,
    kind: 'history',
  });
}

async function enqueueContactsSyncJob({ phoneNumberId, requestedBy = null, requestedByName = null, requestedByRole = null } = {}) {
  return jobRequestsService.enqueueJobRequest({
    type: CONTACTS_JOB_TYPE,
    payload: {
      phone_number_id: normalizePhoneNumberId(phoneNumberId),
    },
    priority: 'normal',
    origin: 'whatsapp_coexistence',
    requestedBy,
    requestedByName,
    requestedByRole,
  });
}

async function enqueueHistorySyncJob({ phoneNumberId, requestedBy = null, requestedByName = null, requestedByRole = null } = {}) {
  return jobRequestsService.enqueueJobRequest({
    type: HISTORY_JOB_TYPE,
    payload: {
      phone_number_id: normalizePhoneNumberId(phoneNumberId),
    },
    priority: 'normal',
    origin: 'whatsapp_coexistence',
    requestedBy,
    requestedByName,
    requestedByRole,
  });
}

async function enqueueInitialSyncJobs({ phoneNumberId, requestedBy = null, requestedByName = null, requestedByRole = null } = {}) {
  const asset = await findActivePhoneAsset(phoneNumberId);
  if (!asset) {
    const err = new Error('phone_not_found');
    err.statusCode = 404;
    throw err;
  }
  if (!isCoexistenceAsset(asset)) {
    const err = new Error('not_coexistence');
    err.statusCode = 409;
    throw err;
  }
  if (!asset.waAccessToken) {
    const err = new Error('missing_access_token');
    err.statusCode = 400;
    throw err;
  }

  await updateCoexistenceMetadata(asset, {
    initial_sync_status: 'queued',
    initial_sync_queued_at: nowIso(),
  });

  const [contactsJob, historyJob] = await Promise.all([
    enqueueContactsSyncJob({ phoneNumberId, requestedBy, requestedByName, requestedByRole }),
    enqueueHistorySyncJob({ phoneNumberId, requestedBy, requestedByName, requestedByRole }),
  ]);

  return {
    phone_number_id: asset.phoneNumberId,
    waba_id: asset.wabaId || null,
    contacts_job_id: contactsJob.id,
    history_job_id: historyJob.id,
  };
}

module.exports = {
  CONTACTS_JOB_TYPE,
  HISTORY_JOB_TYPE,
  enqueueInitialSyncJobs,
  enqueueContactsSyncJob,
  enqueueHistorySyncJob,
  runContactsSyncJob,
  runHistorySyncJob,
  isCoexistenceAsset,
};
