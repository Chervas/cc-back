'use strict';
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../../models');
const authMiddleware = require('./auth.middleware');
const whatsappService = require('../services/whatsapp.service');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const notificationService = require('../services/notifications.service');
const { emitNotificationUpdated } = require('../services/notificationsRealtime.service');
const {
  resolveMetaConnectionForScope,
} = require('../services/scopeConnectionResolver.service');
const {
  hasMarketingClinicScopeAccess,
} = require('../lib/marketingScopeAccess');

const router = express.Router();
const ClinicMetaAsset = db.ClinicMetaAsset;
const Notification = db.Notification;
const { Op } = db.Sequelize;
const META_API_VERSION = process.env.META_API_VERSION || 'v24.0';

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function resolveRequestedRuntimeNamespace(req) {
  const explicit = cleanString(req.body?.__runtime_namespace)
    || cleanString(req.body?.runtime_namespace)
    || cleanString(req.query?.__runtime_namespace)
    || cleanString(req.query?.runtime_namespace);
  if (explicit) {
    return explicit;
  }

  const origin = cleanString(req.get('origin')) || cleanString(req.get('referer')) || '';
  if (origin.includes('localhost:4203') || origin.includes('127.0.0.1:4203')) {
    return 'dev';
  }
  if (origin.includes('crm.clinicaclick.com')) {
    return 'staging';
  }
  if (origin.includes('app.clinicaclick.com')) {
    return 'prod';
  }

  const runtimeRole = cleanString(process.env.RUNTIME_ROLE);
  if (runtimeRole === 'gateway') {
    return cleanString(process.env.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE) || 'staging';
  }

  return cleanString(process.env.JOB_RUNTIME_NAMESPACE)
    || cleanString(process.env.RUNTIME_NAMESPACE)
    || null;
}

function withRequestedRuntimeNamespace(req, payload = {}) {
  const runtimeNamespace = resolveRequestedRuntimeNamespace(req);
  return runtimeNamespace
    ? { ...payload, __runtime_namespace: runtimeNamespace }
    : payload;
}

function parseWaError(err) {
  const base = err?.response?.data || err?.message || err;
  const nestedError = base?.error?.error || base?.error || base;
  const code = nestedError?.code || null;
  const message = nestedError?.message || String(base?.message || base || '');
  return { code, message, raw: base };
}

function generateAutoPin() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

async function ensureAutoPin(asset) {
  const additionalData = asset.additionalData || {};
  const registration = additionalData.registration || {};
  if (registration.autoPin) {
    return registration.autoPin;
  }
  const autoPin = generateAutoPin();
  additionalData.registration = {
    ...registration,
    autoPin,
  };
  asset.additionalData = additionalData;
  await asset.save();
  return autoPin;
}

async function updateRegistrationOnAsset(asset, registration) {
  const additionalData = asset.additionalData || {};
  additionalData.registration = {
    ...(additionalData.registration || {}),
    ...registration,
  };
  asset.additionalData = additionalData;
  await asset.save();
}

function markCoexistenceActive(additionalData, nowIso) {
  const current = additionalData && typeof additionalData === 'object'
    ? { ...additionalData }
    : {};
  const previousCoexistence = current.coexistence && typeof current.coexistence === 'object'
    ? { ...current.coexistence }
    : {};
  const previousDisconnectReason = previousCoexistence.disconnectReason
    || previousCoexistence.previous_disconnect_reason
    || null;
  const previousDisconnectAt = previousCoexistence.last_error_at
    || previousCoexistence.previous_disconnect_at
    || null;

  const coexistence = {
    ...previousCoexistence,
    enabled: true,
    status: 'active',
    canSendApi: true,
    requiresReconnect: false,
    connectedAt: previousCoexistence.connectedAt || nowIso,
    reconnectedAt: nowIso,
    last_success_at: nowIso,
    last_success_source: 'embedded_signup_reconnect',
    previous_disconnect_reason: previousDisconnectReason,
    previous_disconnect_at: previousDisconnectAt,
  };

  delete coexistence.disconnectReason;
  delete coexistence.last_error_code;
  delete coexistence.last_error_subcode;
  delete coexistence.last_error_message;
  delete coexistence.last_error_at;
  delete coexistence.last_message_id;
  delete coexistence.last_recipient;
  delete coexistence.last_source;

  return {
    ...current,
    whatsappConnectionMode: 'coexistence',
    connectionMode: 'coexistence',
    coexistence,
  };
}

async function markCoexistenceNotificationsRead({ phoneNumberId, wabaId } = {}) {
  if (!Notification || (!phoneNumberId && !wabaId)) {
    return { count: 0 };
  }

  const notifications = await Notification.findAll({
    where: {
      event: 'whatsapp.coexistence_disconnected',
      isRead: false,
    },
    order: [['createdAt', 'DESC']],
    limit: 250,
  });

  const phoneKey = cleanString(phoneNumberId);
  const wabaKey = cleanString(wabaId);
  const matched = notifications.filter((notification) => {
    const data = notification.data && typeof notification.data === 'object'
      ? notification.data
      : {};
    const link = cleanString(data.link);
    return (phoneKey && (
      String(data.phoneNumberId || '') === phoneKey
      || link?.includes(`phoneNumberId=${phoneKey}`)
      || link?.includes(`phone_number_id=${phoneKey}`)
    ))
      || (wabaKey && (
        String(data.wabaId || '') === wabaKey
        || link?.includes(`wabaId=${wabaKey}`)
        || link?.includes(`waba_id=${wabaKey}`)
      ));
  });

  await Promise.all(matched.map(async (notification) => {
    await notification.update({
      isRead: true,
      readAt: new Date(),
    });
    emitNotificationUpdated(notification);
  }));

  return { count: matched.length };
}

async function fetchPhoneStatus({ phoneNumberId, accessToken }) {
  if (!phoneNumberId || !accessToken) {
    return null;
  }
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          fields:
            'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type',
        },
      }
    );
    return resp.data;
  } catch (err) {
    return null;
  }
}

async function attemptPhoneRegistration({ asset, accessToken }) {
  const nowIso = new Date().toISOString();
  const phoneNumberId = asset.phoneNumberId;
  const autoPin = await ensureAutoPin(asset);

  if (!phoneNumberId || !accessToken) {
    return { success: false, registration: null, status: null };
  }

  try {
    const currentStatus = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    if (currentStatus?.status === 'CONNECTED') {
      const registration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: nowIso,
        phoneStatus: currentStatus.status,
        codeVerificationStatus: currentStatus.code_verification_status || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: true, registration, status: currentStatus };
    }

    try {
      await whatsappService.setTwoStepVerification({
        phoneNumberId,
        accessToken,
        pin: autoPin,
      });
    } catch (pinErr) {
      const parsed = parseWaError(pinErr);
      const registration = {
        status: 'pin_required',
        requiresPin: true,
        lastAttemptAt: nowIso,
        phoneStatus: currentStatus?.status || null,
        codeVerificationStatus: currentStatus?.code_verification_status || null,
        lastErrorCode: parsed.code,
        lastErrorMessage: parsed.message,
        lastErrorRaw: parsed.raw,
        autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: false, registration, status: currentStatus };
    }

    await whatsappService.registerPhoneNumber({ phoneNumberId, accessToken, pin: autoPin });
    const status = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    const registration = {
      status: 'registered',
      requiresPin: false,
      lastAttemptAt: nowIso,
      registeredAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: null,
      lastErrorMessage: null,
      autoPin,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: true, registration, status };
  } catch (err) {
    const { code, message, raw } = parseWaError(err);
    const lower = (message || '').toLowerCase();
    const pinRequired = code === 100 && lower.includes('pin');

    if (pinRequired) {
      try {
        await whatsappService.setTwoStepVerification({
          phoneNumberId,
          accessToken,
          pin: autoPin,
        });
        await whatsappService.registerPhoneNumber({
          phoneNumberId,
          accessToken,
          pin: autoPin,
        });
        const status = await whatsappService.getPhoneNumberStatus({
          phoneNumberId,
          accessToken,
        });
        const registration = {
          status: 'registered',
          requiresPin: false,
          lastAttemptAt: nowIso,
          registeredAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: null,
          lastErrorMessage: null,
          autoPinUsed: true,
          autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: true, registration, status };
      } catch (autoErr) {
        const parsed = parseWaError(autoErr);
        const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
        const registration = {
          status: 'pin_required',
          requiresPin: true,
          lastAttemptAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: parsed.code,
          lastErrorMessage: parsed.message,
          lastErrorRaw: parsed.raw,
          autoPinUsed: true,
          autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: false, registration, status };
      }
    }
    const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
    const registration = {
      status: pinRequired ? 'pin_required' : 'error',
      requiresPin: pinRequired,
      lastAttemptAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: code,
      lastErrorMessage: message,
      lastErrorRaw: raw,
      autoPin,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: false, registration, status };
  }
}

async function subscribeAppToWaba({ wabaId, accessToken }) {
  if (!wabaId) return { success: false };
  const tokenCandidates = [
    { token: accessToken, label: 'oauth_user' },
    { token: process.env.META_WHATSAPP_ACCESS_TOKEN, label: 'meta_whatsapp' },
    { token: process.env.META_GRAPH_TOKEN, label: 'meta_graph' },
  ].filter((entry) => !!entry.token);

  let lastError = null;
  for (const candidate of tokenCandidates) {
    try {
      const resp = await axios.post(
        `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/subscribed_apps`,
        null,
        {
          params: { access_token: candidate.token },
        }
      );
      return { success: true, data: resp.data, tokenSource: candidate.label };
    } catch (err) {
      lastError = err?.response?.data || err?.message || err;
      console.warn(
        `[EmbeddedSignup] No se pudo suscribir la app al WABA (token=${candidate.label})`,
        lastError
      );
    }
  }

  return { success: false, error: lastError };
}

async function fetchWabaDetailsWithBusinessId({ wabaId, accessToken }) {
  if (!wabaId || !accessToken) return null;
  const fieldCandidates = ['id,name,business_id', 'id,name'];
  let lastError = null;

  for (const fields of fieldCandidates) {
    try {
      const resp = await axios.get(`https://graph.facebook.com/v24.0/${wabaId}`, {
        params: { access_token: accessToken, fields },
      });
      return resp.data;
    } catch (err) {
      lastError = err?.response?.data || err?.message;
      // Si el campo business_id no existe en esta versión/cuenta, probamos sin él
      const message = err?.response?.data?.error?.message || '';
      if (fields.includes('business_id') && message.includes('nonexisting field')) {
        continue;
      }
      break;
    }
  }

  console.warn('[EmbeddedSignup] No se pudo obtener detalles del WABA', lastError);
  return null;
}

router.post('/embedded-signup/callback', authMiddleware, async (req, res) => {
  try {
    const { code, clinic_id, redirect_uri, waba_id, phone_number_id, business_id, assignment_scope, group_id, connection_mode } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'missing_code' });
    }
    if (!waba_id || !phone_number_id) {
      return res.status(400).json({ success: false, error: 'missing_waba_or_phone_number_id' });
    }
    const connectionMode = connection_mode === 'coexistence' ? 'coexistence' : 'cloud_api';

    const userId = req.userData?.userId;

    // Resolución de asignación (preasignación opcional)
    let assignmentScope = 'unassigned';
    let targetClinicId = null;
    let targetGroupId = null;

    if (assignment_scope === 'group') {
      assignmentScope = 'group';
      if (group_id) {
        targetGroupId = group_id;
      }
    } else if (assignment_scope === 'clinic' && clinic_id) {
      assignmentScope = 'clinic';
      targetClinicId = clinic_id;
    } else if (clinic_id) {
      // compatibilidad hacia atrás
      assignmentScope = 'clinic';
      targetClinicId = clinic_id;
    }

    if (targetClinicId) {
      const clinic = await db.Clinica.findOne({ where: { id_clinica: targetClinicId }, raw: true });
      targetGroupId = targetGroupId || clinic?.grupoClinicaId || clinic?.id_grupo || null;
    }

    if (assignmentScope === 'group' && !targetGroupId) {
      assignmentScope = 'unassigned';
    }

    if (assignmentScope === 'unassigned') {
      return res.status(400).json({
        success: false,
        error: 'embedded_signup_scope_required',
      });
    }

    const targetClinicIds = assignmentScope === 'clinic'
      ? [Number(targetClinicId)]
      : (await db.Clinica.findAll({
        where: { grupoClinicaId: targetGroupId },
        attributes: ['id_clinica'],
        raw: true,
      })).map((clinic) => Number(clinic.id_clinica)).filter(Number.isInteger);
    if (!targetClinicIds.length) {
      return res.status(400).json({ success: false, error: 'embedded_signup_scope_invalid' });
    }
    const canManageTarget = await hasMarketingClinicScopeAccess({
      userId,
      clinicIds: targetClinicIds,
      access: 'write',
    });
    if (!canManageTarget) {
      return res.status(403).json({ success: false, error: 'embedded_signup_scope_forbidden' });
    }

    const { connection: metaConnection, source: metaConnectionSource } = await resolveMetaConnectionForScope({
      userId,
      clinicIdRaw: targetClinicId,
      groupIdRaw: targetGroupId,
      assignmentScopeRaw: assignmentScope === 'unassigned' ? null : assignmentScope,
      allowLegacyUserFallback: true,
    });
    if (!metaConnection) {
      return res.status(400).json({
        success: false,
        error: metaConnectionSource === 'legacy_user_ambiguous'
          ? 'meta_connection_scope_required'
          : 'meta_not_connected',
      });
    }

    // Intercambiar code por token largo
    const clientId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '1807844546609897';
    const clientSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
    if (!clientSecret) {
      return res.status(500).json({ success: false, error: 'missing_client_secret' });
    }

    // Meta exige que redirect_uri coincida exactamente con la usada por FB.login.
    // Probamos con la URI recibida y variaciones sin/con slash final para evitar
    // errores por diferencias mínimas.
    // Meta exige que redirect_uri coincida exactamente con la usada por el dialogo OAuth.
    // En algunos flujos (JS SDK) Meta puede aceptar el canje sin enviar redirect_uri.
    // Probamos primero sin redirect_uri y luego con un set de candidatos comunes.
    const baseCandidates = [];
    if (redirect_uri) {
      baseCandidates.push(redirect_uri, redirect_uri.endsWith('/') ? redirect_uri.slice(0, -1) : `${redirect_uri}/`);
    }
    baseCandidates.push(
      'https://app.clinicaclick.com',
      'https://app.clinicaclick.com/',
      'https://autenticacion.clinicaclick.com',
      'https://autenticacion.clinicaclick.com/',
      'https://autenticacion.clinicaclick.com/oauth/meta/callback',
      'https://autenticacion.clinicaclick.com/oauth/meta/callback/',
      // JS SDK (FB.login) suele usar esta redirect_uri interna para devolver el code
      // al opener. Si ese fue el caso, el code SOLO se puede canjear usando exactamente
      // esta misma URI.
      'https://www.facebook.com/connect/login_success.html',
      'https://www.facebook.com/connect/login_success.html/',
      'https://web.facebook.com/connect/login_success.html',
      'https://web.facebook.com/connect/login_success.html/'
    );
    const candidates = [null, ...Array.from(new Set(baseCandidates))];

    let accessToken = null;
    let lastErr = null;

    for (const candidate of candidates) {
      try {
        const params = {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
        };
        if (candidate) {
          params.redirect_uri = candidate;
        }

        const tokenResp = await axios.get(`https://graph.facebook.com/v24.0/oauth/access_token`, { params });
        accessToken = tokenResp.data.access_token;
        break;
      } catch (err) {
        lastErr = err?.response?.data || err.message;
        console.warn('[EmbeddedSignup] Token exchange failed for redirect_uri', candidate || '(none)', lastErr);
      }
    }

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'oauth_code_exchange_failed',
        details: lastErr,
      });
    }

    // Obtener detalles del WABA y del número (usamos IDs proporcionados por WA_EMBEDDED_SIGNUP)
    const [wabaDetails, phoneDetails] = await Promise.all([
      fetchWabaDetailsWithBusinessId({ wabaId: waba_id, accessToken }),
      axios
        .get(`https://graph.facebook.com/v24.0/${phone_number_id}`, {
          params: {
            access_token: accessToken,
            fields:
              'id,display_phone_number,verified_name,quality_rating,whatsapp_business_manager_messaging_limit,name_status,new_display_name,new_name_status,code_verification_status,status,platform_type,account_mode,is_on_biz_app',
          },
        })
        .then((r) => r.data)
        .catch(() => null),
    ]);

    const wabaName = wabaDetails?.name || null;
    const resolvedBusinessId = business_id || wabaDetails?.business_id || null;
    // Fallback: si no hay display_phone_number, usar phone_number_id como identificador temporal
    const displayPhoneNumber = phoneDetails?.display_phone_number || `+00 ${phone_number_id.slice(-6)}`;
    const verifiedName = phoneDetails?.verified_name || wabaName || 'WhatsApp Business';
    const qualityRating = phoneDetails?.quality_rating || null;
    const messagingLimit = phoneDetails?.whatsapp_business_manager_messaging_limit || phoneDetails?.messaging_limit || null;
    const nameStatus = phoneDetails?.name_status || null;
    const newDisplayName = phoneDetails?.new_display_name || null;
    const newNameStatus = phoneDetails?.new_name_status || null;
    const codeVerificationStatus = phoneDetails?.code_verification_status || null;
    const phoneStatus = phoneDetails?.status || null;
    const platformType = phoneDetails?.platform_type || null;
    const accountMode = phoneDetails?.account_mode || null;
    const isOnBizApp = phoneDetails?.is_on_biz_app ?? null;
    
    console.log('📱 WhatsApp Embedded Signup - Detalles obtenidos:', {
      wabaId: waba_id,
      phoneNumberId: phone_number_id,
      displayPhoneNumber,
      verifiedName,
      qualityRating,
      messagingLimit,
      wabaDetailsRaw: wabaDetails,
        phoneDetailsRaw: phoneDetails
    });

    const upsertAsset = async (where, values, options = {}) => {
      const lookupWhere = options.lookupWhere || where;
      const existing = await ClinicMetaAsset.findOne({ where: lookupWhere });
      if (existing) {
        await existing.update({ ...where, ...values });
        return existing;
      }
      return ClinicMetaAsset.create({ ...where, ...values });
    };

    // Guardar WABA
    await upsertAsset(
      { metaConnectionId: metaConnection.id, metaAssetId: waba_id },
      {
        clinicaId: targetClinicId,
        grupoClinicaId: targetGroupId,
        assetType: 'whatsapp_business_account',
        metaAssetName: wabaName,
        wabaId: waba_id,
        phoneNumberId: phone_number_id,
        waVerifiedName: wabaName,
        quality_rating: qualityRating,
        messaging_limit: messagingLimit,
        waAccessToken: accessToken,
        assignmentScope,
        isActive: true,
      }
    );

    // Guardar phone number
    const phoneAsset = await upsertAsset(
      { metaConnectionId: metaConnection.id, metaAssetId: phone_number_id },
      {
        clinicaId: targetClinicId,
        grupoClinicaId: targetGroupId,
        assetType: 'whatsapp_phone_number',
        metaAssetName: displayPhoneNumber,
        wabaId: waba_id,
        phoneNumberId: phone_number_id,
        waVerifiedName: verifiedName,
        quality_rating: qualityRating,
        messaging_limit: messagingLimit,
        waAccessToken: accessToken,
        assignmentScope,
        isActive: true,
      },
      {
        // En reconexiones puede cambiar la MetaConnection. El numero fisico debe
        // seguir siendo un unico origen operativo; si buscamos por connection_id
        // dejamos filas antiguas activas que siguen mostrando alerta en QuickChat.
        lookupWhere: {
          assetType: 'whatsapp_phone_number',
          phoneNumberId: phone_number_id,
        },
      }
    );
    const [duplicatePhoneCleanupCount] = await ClinicMetaAsset.update(
      {
        isActive: false,
        assignmentScope: 'unassigned',
        clinicaId: null,
        grupoClinicaId: null,
      },
      {
        where: {
          assetType: 'whatsapp_phone_number',
          phoneNumberId: phone_number_id,
          id: { [Op.ne]: phoneAsset.id },
        },
      }
    );
    const hadCoexistenceDisconnect =
      phoneAsset.additionalData?.coexistence?.status === 'disconnected'
      || phoneAsset.additionalData?.coexistence?.requiresReconnect === true;
    let coexistenceNotificationCleanup = { count: 0 };

    const businessId = resolvedBusinessId || null;
    const connectedNowIso = new Date().toISOString();
    if (businessId || nameStatus || newDisplayName || newNameStatus || codeVerificationStatus || platformType || accountMode || connectionMode || isOnBizApp !== null) {
      const applyMetaExtras = async (asset) => {
        const additionalData = { ...(asset.additionalData || {}) };
        additionalData.whatsappConnectionMode = connectionMode;
        additionalData.connectionMode = connectionMode;
        if (connectionMode === 'coexistence') {
          Object.assign(additionalData, markCoexistenceActive(additionalData, connectedNowIso));
        } else {
          additionalData.coexistence = {
            ...(additionalData.coexistence || {}),
            enabled: false,
            status: additionalData.coexistence?.status || null,
            canSendApi: additionalData.coexistence?.canSendApi,
            connectedAt: additionalData.coexistence?.connectedAt,
          };
        }
        if (businessId) {
          additionalData.businessId = businessId;
        }
        if (nameStatus) {
          additionalData.nameStatus = nameStatus;
        }
        if (newDisplayName !== null) {
          additionalData.newDisplayName = newDisplayName;
        }
        if (newNameStatus !== null) {
          additionalData.newNameStatus = newNameStatus;
        }
        if (platformType) {
          additionalData.platformType = platformType;
        }
        if (accountMode) {
          additionalData.accountMode = accountMode;
        }
        if (isOnBizApp !== null) {
          additionalData.isOnBizApp = isOnBizApp;
        }
        if (codeVerificationStatus || phoneStatus) {
          additionalData.registration = {
            ...(additionalData.registration || {}),
            codeVerificationStatus: codeVerificationStatus || additionalData.registration?.codeVerificationStatus || null,
            phoneStatus: phoneStatus || additionalData.registration?.phoneStatus || null,
          };
        }
        asset.additionalData = { ...additionalData };
        asset.changed('additionalData', true);
        await asset.save();
      };

      const wabaAsset = await ClinicMetaAsset.findOne({
        where: { metaConnectionId: metaConnection.id, metaAssetId: waba_id },
      });
      if (wabaAsset) {
        await applyMetaExtras(wabaAsset);
      }
      await applyMetaExtras(phoneAsset);
    }

    // Intentar registrar automaticamente el numero (sin PIN). Si requiere PIN,
    // devolvemos el estado para que el frontend lo solicite.
    let registrationResult = null;
    if (connectionMode === 'coexistence') {
      const nowIso = new Date().toISOString();
      const coexistenceRegistration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: phoneAsset.additionalData?.registration?.registeredAt || nowIso,
        phoneStatus: phoneStatus || 'CONNECTED',
        codeVerificationStatus: codeVerificationStatus || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        skipRegisterReason: 'whatsapp_business_app_coexistence',
      };
      await updateRegistrationOnAsset(phoneAsset, coexistenceRegistration);
      coexistenceNotificationCleanup = await markCoexistenceNotificationsRead({
        phoneNumberId: phone_number_id,
        wabaId: waba_id,
      });
      if (hadCoexistenceDisconnect || coexistenceNotificationCleanup.count > 0 || duplicatePhoneCleanupCount > 0) {
        await notificationService.dispatchEvent({
          event: 'whatsapp.coexistence_reconnected',
          clinicId: targetClinicId || null,
          data: {
            clinicId: targetClinicId || null,
            clinicName: null,
            phoneNumberId: phone_number_id,
            wabaId: waba_id,
            phoneNumber: displayPhoneNumber,
            source: 'embedded_signup_reconnect',
            link: `/ajustes?tab=whatsapp&phoneNumberId=${encodeURIComponent(phone_number_id)}&wabaId=${encodeURIComponent(waba_id)}`,
            useRouter: true,
          },
        });
      }
      registrationResult = { success: true, registration: coexistenceRegistration, status: null };
    } else {
      try {
        registrationResult = await attemptPhoneRegistration({
          asset: phoneAsset,
          accessToken,
        });
      } catch (regErr) {
        console.warn('[EmbeddedSignup] No se pudo registrar el numero automaticamente', regErr?.message || regErr);
      }
    }

    // Suscribir la app para recibir webhooks de mensajes y estados
    const subscriptionResult = await subscribeAppToWaba({
      wabaId: waba_id,
      accessToken,
    });

    if (assignmentScope !== 'unassigned') {
      try {
        const templateJobPayload = withRequestedRuntimeNamespace(req, {
          wabaId: waba_id,
          clinicId: targetClinicId,
          groupId: targetGroupId,
          assignmentScope,
          connectionMode,
        });
        const templateJob = await jobRequestsService.enqueueJobRequest({
          type: 'whatsapp_template_create',
          payload: templateJobPayload,
          priority: 'high',
          origin: `whatsapp:embedded-signup:${connectionMode}`,
          requestedBy: userId,
        });
        jobScheduler.triggerImmediate(templateJob.id).catch((err) => {
          console.error('[EmbeddedSignup] Error lanzando job de plantillas', err?.message || err);
        });
      } catch (err) {
        console.error('[EmbeddedSignup] Error encolando plantillas', err?.message || err);
      }
    }

    return res.json({
      success: true,
      wabaId: waba_id,
      phoneNumberId: phone_number_id,
      waVerifiedName: verifiedName,
      connectionMode,
      coexistenceReconnected: connectionMode === 'coexistence',
      reconnectCleanup: connectionMode === 'coexistence'
        ? {
            notifications_read: coexistenceNotificationCleanup.count,
            duplicated_phone_assets_disabled: duplicatePhoneCleanupCount,
          }
        : null,
      registration: registrationResult?.registration || null,
      subscribed: subscriptionResult?.success || false,
    });
  } catch (err) {
    console.error('Embedded Signup callback error', err?.response?.data || err.message);
    return res.status(500).json({ success: false, error: 'callback_error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
