'use strict';
const express = require('express');
const axios = require('axios');
const db = require('../../models');
const authMiddleware = require('./auth.middleware');

const router = express.Router();
const ClinicMetaAsset = db.ClinicMetaAsset;

router.post('/embedded-signup/callback', authMiddleware, async (req, res) => {
  try {
    const { code, clinic_id, redirect_uri } = req.body;
    if (!code || !clinic_id) {
      return res.status(400).json({ success: false, error: 'missing_code_or_clinic' });
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

    // Obtener WABA, phone_number_id y datos
    const businessesResp = await axios.get(
      `https://graph.facebook.com/v24.0/me/owned_whatsapp_business_accounts`,
      { params: { access_token: accessToken } }
    );
    const waba = businessesResp.data?.data?.[0];
    if (!waba) {
      return res.status(400).json({ success: false, error: 'waba_not_found' });
    }

    const phoneResp = await axios.get(
      `https://graph.facebook.com/v24.0/${waba.id}/phone_numbers`,
      { params: { access_token: accessToken } }
    );
    const phone = phoneResp.data?.data?.[0];

    await ClinicMetaAsset.create({
      clinicaId: clinic_id,
      metaConnectionId: null,
      assetType: phone ? 'whatsapp_phone_number' : 'whatsapp_business_account',
      metaAssetId: phone?.id || waba.id,
      metaAssetName: phone?.display_phone_number || null,
      wabaId: waba.id,
      phoneNumberId: phone?.id || null,
      waVerifiedName: waba.name || null,
      quality_rating: phone?.quality_rating || null,
      messaging_limit: phone?.messaging_limit || null,
      waAccessToken: accessToken,
      isActive: true,
    });

    return res.json({
      success: true,
      wabaId: waba.id,
      phoneNumberId: phone?.id || null,
      waVerifiedName: waba.name || null,
    });
  } catch (err) {
    console.error('Embedded Signup callback error', err?.response?.data || err.message);
    return res.status(500).json({ success: false, error: 'callback_error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
