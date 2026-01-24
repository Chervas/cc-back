'use strict';
const express = require('express');
const axios = require('axios');
const db = require('../../models');
const authMiddleware = require('./auth.middleware');

const router = express.Router();
const ClinicMetaAsset = db.ClinicMetaAsset;

router.post('/embedded-signup/callback', authMiddleware, async (req, res) => {
  try {
    const { code, clinic_id, redirect_uri, waba_id, phone_number_id } = req.body;
    if (!code || !clinic_id) {
      return res.status(400).json({ success: false, error: 'missing_code_or_clinic' });
    }
    if (!waba_id || !phone_number_id) {
      return res.status(400).json({ success: false, error: 'missing_waba_or_phone_number_id' });
    }

    const userId = req.userData?.userId;
    const metaConnection = await db.MetaConnection.findOne({ where: { userId } });
    if (!metaConnection) {
      return res.status(400).json({ success: false, error: 'meta_not_connected' });
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
      axios
        .get(`https://graph.facebook.com/v24.0/${waba_id}`, {
          params: { access_token: accessToken, fields: 'id,name' },
        })
        .then((r) => r.data)
        .catch(() => null),
      axios
        .get(`https://graph.facebook.com/v24.0/${phone_number_id}`, {
          params: {
            access_token: accessToken,
            fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit',
          },
        })
        .then((r) => r.data)
        .catch(() => null),
    ]);

    const wabaName = wabaDetails?.name || null;
    const displayPhoneNumber = phoneDetails?.display_phone_number || null;
    const verifiedName = phoneDetails?.verified_name || wabaName;
    const qualityRating = phoneDetails?.quality_rating || null;
    const messagingLimit = phoneDetails?.messaging_limit || null;

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
        clinicaId: clinic_id,
        assetType: 'whatsapp_business_account',
        metaAssetName: wabaName,
        wabaId: waba_id,
        phoneNumberId: phone_number_id,
        waVerifiedName: wabaName,
        quality_rating: qualityRating,
        messaging_limit: messagingLimit,
        waAccessToken: accessToken,
        isActive: true,
      }
    );

    // Guardar phone number
    await upsertAsset(
      { metaConnectionId: metaConnection.id, metaAssetId: phone_number_id },
      {
        clinicaId: clinic_id,
        assetType: 'whatsapp_phone_number',
        metaAssetName: displayPhoneNumber,
        wabaId: waba_id,
        phoneNumberId: phone_number_id,
        waVerifiedName: verifiedName,
        quality_rating: qualityRating,
        messaging_limit: messagingLimit,
        waAccessToken: accessToken,
        isActive: true,
      }
    );

    return res.json({
      success: true,
      wabaId: waba_id,
      phoneNumberId: phone_number_id,
      waVerifiedName: verifiedName,
    });
  } catch (err) {
    console.error('Embedded Signup callback error', err?.response?.data || err.message);
    return res.status(500).json({ success: false, error: 'callback_error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
