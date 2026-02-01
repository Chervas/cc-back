'use strict';
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../../models');
const authMiddleware = require('./auth.middleware');
const whatsappService = require('../services/whatsapp.service');

const router = express.Router();
const ClinicMetaAsset = db.ClinicMetaAsset;
const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';

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
  if (!wabaId || !accessToken) return { success: false };
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/subscribed_apps`,
      null,
      {
        params: { access_token: accessToken },
      }
    );
    return { success: true, data: resp.data };
  } catch (err) {
    console.warn('[EmbeddedSignup] No se pudo suscribir la app al WABA', err?.response?.data || err?.message || err);
    return { success: false, error: err?.response?.data || err?.message || err };
  }
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
    const { code, clinic_id, redirect_uri, waba_id, phone_number_id, business_id } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'missing_code' });
    }
    if (!waba_id || !phone_number_id) {
      return res.status(400).json({ success: false, error: 'missing_waba_or_phone_number_id' });
    }

    const userId = req.userData?.userId;
    const metaConnection = await db.MetaConnection.findOne({ where: { userId } });
    if (!metaConnection) {
      return res.status(400).json({ success: false, error: 'meta_not_connected' });
    }

    // Resolución de asignación: si no viene clinic_id => unassigned
    const assignmentScope = clinic_id ? 'clinic' : 'unassigned';
    const targetClinicId = clinic_id || null;
    let targetGroupId = null;
    if (clinic_id) {
      const clinic = await db.Clinica.findOne({ where: { id_clinica: clinic_id }, raw: true });
      targetGroupId = clinic?.grupoClinicaId || clinic?.id_grupo || null;
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
              'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status,status,platform_type,account_mode',
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
    const messagingLimit = phoneDetails?.messaging_limit_tier || phoneDetails?.messaging_limit || null;
    const nameStatus = phoneDetails?.name_status || null;
    const codeVerificationStatus = phoneDetails?.code_verification_status || null;
    const phoneStatus = phoneDetails?.status || null;
    const platformType = phoneDetails?.platform_type || null;
    const accountMode = phoneDetails?.account_mode || null;
    
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

    const upsertAsset = async (where, values) => {
      const existing = await ClinicMetaAsset.findOne({ where });
      if (existing) {
        await existing.update(values);
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
      }
    );

    const businessId = resolvedBusinessId || null;
    if (businessId || nameStatus || codeVerificationStatus || platformType || accountMode) {
      const applyMetaExtras = async (asset) => {
        const additionalData = { ...(asset.additionalData || {}) };
        if (businessId) {
          additionalData.businessId = businessId;
        }
        if (nameStatus) {
          additionalData.nameStatus = nameStatus;
        }
        if (platformType) {
          additionalData.platformType = platformType;
        }
        if (accountMode) {
          additionalData.accountMode = accountMode;
        }
        if (codeVerificationStatus || phoneStatus) {
          additionalData.registration = {
            ...(additionalData.registration || {}),
            codeVerificationStatus: codeVerificationStatus || additionalData.registration?.codeVerificationStatus || null,
            phoneStatus: phoneStatus || additionalData.registration?.phoneStatus || null,
          };
        }
        asset.additionalData = additionalData;
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
    try {
      registrationResult = await attemptPhoneRegistration({
        asset: phoneAsset,
        accessToken,
      });
    } catch (regErr) {
      console.warn('[EmbeddedSignup] No se pudo registrar el numero automaticamente', regErr?.message || regErr);
    }

    // Suscribir la app para recibir webhooks de mensajes y estados
    const subscriptionResult = await subscribeAppToWaba({
      wabaId: waba_id,
      accessToken,
    });

    if (assignmentScope !== 'unassigned') {
      enqueueCreateTemplatesJob({
        wabaId: waba_id,
        clinicId: targetClinicId,
        groupId: targetGroupId,
        assignmentScope,
      }).catch((err) => {
        console.error('[EmbeddedSignup] Error encolando plantillas', err?.message || err);
      });
    }

    return res.json({
      success: true,
      wabaId: waba_id,
      phoneNumberId: phone_number_id,
      waVerifiedName: verifiedName,
      registration: registrationResult?.registration || null,
      subscribed: subscriptionResult?.success || false,
    });
  } catch (err) {
    console.error('Embedded Signup callback error', err?.response?.data || err.message);
    return res.status(500).json({ success: false, error: 'callback_error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
