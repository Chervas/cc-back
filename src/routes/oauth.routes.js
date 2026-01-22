// backendclinicaclick/src/routes/oauth.routes.js
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');  // Para decodificar el token JWT
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../../models'); // <-- Importa el objeto db de models/index.js
const MetaConnection = db.MetaConnection; // <-- Accede al modelo MetaConnection
const GoogleConnection = db.GoogleConnection; // <-- Modelo GoogleConnection
const ClinicWebAsset = db.ClinicWebAsset; // <-- Modelo de mapeo de sitios web
const ClinicAnalyticsProperty = db.ClinicAnalyticsProperty;
const Clinica = db.Clinica;
const ClinicMetaAsset = db.ClinicMetaAsset; // <-- Accede al modelo ClinicMetaAsset
const ClinicBusinessLocation = db.ClinicBusinessLocation;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const GroupAssetClinicAssignment = db.GroupAssetClinicAssignment;
const SocialStatsDaily = db.SocialStatsDaily;
const SocialPosts = db.SocialPosts;
const SocialPostStatsDaily = db.SocialPostStatsDaily;
const SocialAdsInsightsDaily = db.SocialAdsInsightsDaily;
const SocialAdsActionsDaily = db.SocialAdsActionsDaily;
const GrupoClinica = db.GrupoClinica;
const {
    googleAdsRequest,
    normalizeCustomerId,
    formatCustomerId,
    ensureGoogleAdsConfig,
    getGoogleAdsUsageStatus,
    resumeGoogleAdsUsage
} = require('../lib/googleAdsClient');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const { triggerHistoricalSync } = require('../controllers/metasync.controller');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');

// Configuración de la App de Meta
const META_APP_ID = '1807844546609897'; // <-- App ID correcto
const META_APP_SECRET = 'bfcfedd6447dce4c3eb280067300e141'; // <-- App Secret correcto
const REDIRECT_URI = 'https://autenticacion.clinicaclick.com/oauth/meta/callback';
const FRONTEND_URL = 'https://app.clinicaclick.com';
const FRONTEND_DEV_URL = 'http://localhost:4200'; // Para desarrollo local
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v24.0';
const META_BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.META_BM_ID || null;

// Configuración Google OAuth (variables de entorno)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://autenticacion.clinicaclick.com/oauth/google/callback';
const DEFAULT_GOOGLE_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/business.manage',
    'https://www.googleapis.com/auth/adwords'
].join(' ');

const GOOGLE_SCOPES = (process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_GOOGLE_SCOPES).split(/\s+/).join(' ');
const GOOGLE_BUSINESS_INFORMATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GOOGLE_BUSINESS_ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';

/**
 * Suscribir una página a leadgen con el page token proporcionado.
 * No bloquea el flujo de guardado: loguea y continúa en caso de error.
 */
async function subscribeLeadgenToPage(pageId, pageAccessToken) {
    if (!pageId || !pageAccessToken) return;
    try {
        const url = `${META_API_BASE_URL}/${pageId}/subscribed_apps`;
        const params = { access_token: pageAccessToken };
        if (META_BUSINESS_ID) params.business = META_BUSINESS_ID;
        const data = { subscribed_fields: 'leadgen' };
        const resp = await axios.post(url, data, { params });
        console.log(`✅ Subscrita la página ${pageId} a leadgen (${resp.data?.success ? 'success' : 'no success flag'})`);

        // Verificación rápida opcional: comprobar que la app aparece en subscribed_apps
        try {
            const verify = await axios.get(`${META_API_BASE_URL}/${pageId}/subscribed_apps`, { params });
            const apps = Array.isArray(verify.data?.data) ? verify.data.data : [];
            const found = apps.find((a) => String(a.id || a.app_id) === META_APP_ID.toString());
            if (!found) {
                console.warn(`⚠️ La app no figura en subscribed_apps para la página ${pageId}. Requiere revisión manual en Lead Access Manager.`);
            }
        } catch (verErr) {
            console.warn(`⚠️ No se pudo verificar subscribed_apps para la página ${pageId}:`, verErr.response?.data || verErr.message || verErr);
        }
    } catch (err) {
        console.warn(`⚠️ No se pudo subscribir leadgen para la página ${pageId}:`, err.response?.data || err.message || err);
    }
}

const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

function googleTokenError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

async function ensureGoogleAccessToken(conn, { allowExpired = false } = {}) {
    if (!conn) {
        throw googleTokenError('NO_CONNECTION', 'No existe conexión Google para este usuario');
    }
    if (!conn.accessToken) {
        throw googleTokenError('NO_TOKEN', 'No existe access token de Google almacenado');
    }

    let accessToken = conn.accessToken;
    let expiresAt = conn.expiresAt ? new Date(conn.expiresAt) : null;
    const now = Date.now();
    const threshold = now + 60_000;

    const shouldRefresh = conn.refreshToken && (!expiresAt || expiresAt.getTime() <= threshold);
    if (shouldRefresh) {
        try {
            const tr = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: conn.refreshToken
            }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            const newToken = tr.data?.access_token;
            const expiresIn = tr.data?.expires_in || 3600;
            if (newToken) {
                accessToken = newToken;
                expiresAt = new Date(Date.now() + expiresIn * 1000);
                await conn.update({ accessToken, expiresAt });
            }
        } catch (refreshErr) {
            if (!allowExpired) {
                throw googleTokenError('REFRESH_FAILED', refreshErr.response?.data?.error_description || refreshErr.message || 'No se pudo refrescar el token');
            }
        }
    }

    const isExpired = expiresAt ? expiresAt.getTime() <= now : false;
    if (isExpired && !allowExpired) {
        throw googleTokenError('TOKEN_EXPIRED', 'El token de Google ha expirado');
    }

    return { accessToken, expiresAt, expired: isExpired };
}

function hasScopeText(scopesText, scope) {
    if (!scopesText || !scope) {
        return false;
    }
    return scopesText.split(/\s+/).includes(scope);
}

function getGoogleManagerId() {
    return ensureGoogleAdsConfig().managerId;
}

async function ensureGoogleAdsAccess(conn) {
    if (!hasScopeText(conn?.scopes || '', GOOGLE_ADS_SCOPE)) {
        const err = googleTokenError('INSUFFICIENT_SCOPE', 'La conexión Google no tiene permisos de Google Ads');
        throw err;
    }
    const tokenInfo = await ensureGoogleAccessToken(conn);
    ensureGoogleAdsConfig();
    return tokenInfo;
}

async function listAccessibleAdsCustomers(accessToken) {
    const resp = await googleAdsRequest('GET', 'customers:listAccessibleCustomers', { accessToken });
    const resourceNames = resp?.resourceNames || [];
    return resourceNames.map((name) => normalizeCustomerId(name.split('/').pop()));
}

async function fetchAdsCustomerSummary(accessToken, customerId, { loginCustomerId } = {}) {
    if (!customerId) {
        return null;
    }
    const cleanId = normalizeCustomerId(customerId);
    const query = [
        'SELECT',
        '  customer.id,',
        '  customer.descriptive_name,',
        '  customer.currency_code,',
        '  customer.time_zone,',
        '  customer.manager,',
        '  customer.status',
        'FROM customer'
    ].join('\n');
    const requestOptions = {
        accessToken,
        data: { query }
    };
    if (loginCustomerId) {
        requestOptions.loginCustomerId = normalizeCustomerId(loginCustomerId);
    }
    const result = await googleAdsRequest('POST', `customers/${cleanId}/googleAds:search`, requestOptions);
    const row = Array.isArray(result?.results) ? result.results[0] : null;
    if (!row?.customer) {
        return { customerId: cleanId };
    }
    return {
        customerId: cleanId,
        descriptiveName: row.customer.descriptiveName || null,
        currencyCode: row.customer.currencyCode || null,
        timeZone: row.customer.timeZone || null,
        accountStatus: row.customer.status || null,
        isManager: row.customer.manager || false
    };
}

async function fetchAdsCustomerClients(accessToken, managerCustomerId) {
    const manager = normalizeCustomerId(managerCustomerId);
    if (!manager) {
        return [];
    }

    const query = [
        'SELECT',
        '  customer_client.client_customer,',
        '  customer_client.descriptive_name,',
        '  customer_client.currency_code,',
        '  customer_client.time_zone,',
        '  customer_client.status,',
        '  customer_client.level,',
        '  customer_client.manager,',
        '  customer_client.hidden',
        'FROM customer_client',
        'WHERE customer_client.hidden = FALSE'
    ].join('\n');

    const clients = [];
    let pageToken = null;
    do {
        const resp = await googleAdsRequest('POST', `customers/${manager}/googleAds:search`, {
            accessToken,
            loginCustomerId: manager,
            data: { query, pageToken }
        });
        const rows = Array.isArray(resp?.results) ? resp.results : [];
        for (const row of rows) {
            const client = row.customerClient || row.customer_client;
            if (!client) {
                continue;
            }
            const resourceName = client.clientCustomer || client.client_customer;
            const customerId = resourceName ? normalizeCustomerId(String(resourceName).split('/').pop()) : null;
            if (!customerId) {
                continue;
            }
            clients.push({
                customerId,
                descriptiveName: client.descriptiveName || null,
                currencyCode: client.currencyCode || null,
                timeZone: client.timeZone || null,
                status: client.status || null,
                level: client.level || 0,
                isManager: !!client.manager,
                hidden: !!client.hidden
            });
        }
        pageToken = resp?.nextPageToken || resp?.next_page_token || null;
    } while (pageToken);

    return clients;
}

async function fetchManagerLinkForCustomer(accessToken, customerId, managerId, { loginCustomerId } = {}) {
    const manager = normalizeCustomerId(managerId);
    if (!manager) {
        return null;
    }
    const query = [
        'SELECT',
        '  customer_manager_link.manager_link_id,',
        '  customer_manager_link.manager_customer,',
        '  customer_manager_link.status',
        'FROM customer_manager_link'
    ].join('\n');
    const requestOptions = {
        accessToken,
        data: { query: `${query} WHERE customer_manager_link.manager_customer = 'customers/${manager}'` }
    };
    if (loginCustomerId) {
        requestOptions.loginCustomerId = normalizeCustomerId(loginCustomerId);
    }
    const result = await googleAdsRequest('POST', `customers/${customerId}/googleAds:search`, requestOptions);
    const row = Array.isArray(result?.results) ? result.results[0] : null;
    if (!row?.customerManagerLink) {
        return null;
    }
    return {
        managerCustomerId: normalizeCustomerId(row.customerManagerLink.managerCustomer?.split('/').pop()),
        managerLinkId: row.customerManagerLink.managerLinkId,
        status: row.customerManagerLink.status
    };
}

async function fetchAllGoogleBusinessAccounts(accessToken) {
    const accounts = [];
    let nextPageToken = null;
    do {
        const resp = await axios.get(`${GOOGLE_BUSINESS_ACCOUNT_API}/accounts`, {
            params: { pageSize: 100, pageToken: nextPageToken || undefined },
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const batch = resp.data?.accounts || [];
        accounts.push(...batch);
        nextPageToken = resp.data?.nextPageToken || null;
    } while (nextPageToken);
    return accounts;
}

async function fetchAllGoogleBusinessLocations(accessToken, accountName) {
    const locations = [];
    let nextPageToken = null;
    const paramsBase = {
        pageSize: 100
    };
    do {
        const resp = await axios.get(`${GOOGLE_BUSINESS_INFORMATION_API}/${accountName}/locations`, {
            params: { ...paramsBase, pageToken: nextPageToken || undefined },
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const batch = resp.data?.locations || [];
        locations.push(...batch);
        nextPageToken = resp.data?.nextPageToken || null;
    } while (nextPageToken);
    return locations;
}

function normalizeBusinessLocation(location, account) {
    if (!location) {
        return null;
    }
    const accountName = account?.name || null;
    const accountDisplayName = account?.accountName || account?.name || null;
    const locationName = location.title || location.locationName || null;
    const resourceName = location.name || null;
    const storeCode = location.storeCode || null;
    const primaryCategory = location.primaryCategory?.displayName || location.primaryCategory?.name || null;
    const verificationStatus = location.metadata?.verificationState || location.metadata?.verificationStatus || null;
    const suspended = Array.isArray(location.metadata?.suspensionReasons) && location.metadata.suspensionReasons.length > 0;
    const verified = verificationStatus ? verificationStatus.toUpperCase() === 'VERIFIED' : !!location.metadata?.hasBusinessAuthority;
    const address = location.address || null;
    const locality = address?.locality || address?.localityName || null;
    const region = address?.administrativeArea || null;
    const country = address?.regionCode || null;
    const placeId = location.metadata?.placeId || location.locationKey?.placeId || null;
    return {
        id: resourceName,
        accountName,
        accountDisplayName,
        locationId: resourceName,
        locationName,
        storeCode,
        primaryCategory,
        verificationStatus,
        isVerified: verified,
        isSuspended: suspended,
        placeId,
        locality,
        region,
        country,
        websiteUri: location.websiteUri || null,
        phoneNumbers: location.phoneNumbers || null,
        openInfo: location.openInfo || null,
        serviceArea: location.serviceArea || null,
        labels: location.labels || null,
        rawLocation: location
    };
}

/**
 * GET /oauth/meta/callback
 * Maneja el callback de la autorización de Meta (Facebook).
 */
router.get('/meta/callback', async (req, res) => {
    const { code, state, error, error_reason, error_description } = req.query;

    console.log('➡️  Callback de Meta recibido.');

    if (error) {
        console.error('❌ Error en el callback de Meta:', { error, error_reason, error_description });
        return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
        console.error('❌ No se recibió el código de autorización.');
        return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('No se recibió el código de autorización.')}`);
    }

    console.log('✅ Código de autorización recibido: ' + code.substring(0, 20) + '...');

    try {
        // 1. Intercambiar el código por un Access Token de CORTA DURACIÓN
        console.log('🔄  Intercambiando código por Access Token de corta duración...');
        const tokenUrl = `${process.env.META_API_BASE_URL}/oauth/access_token`;
        const tokenParams = {
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            redirect_uri: REDIRECT_URI,
            code: code,
        };
        const tokenResponse = await axios.get(tokenUrl, { params: tokenParams });
        const shortLivedAccessToken = tokenResponse.data.access_token;
        
        if (!shortLivedAccessToken) {
            console.error('❌ No se pudo obtener el Access Token de corta duración.');
            throw new Error('No se pudo obtener el Access Token de corta duración.');
        }
        console.log('✅ Access Token de corta duración obtenido: ' + shortLivedAccessToken.substring(0, 20) + '...');

        // 2. Intercambiar el Access Token de CORTA DURACIÓN por uno de LARGA DURACIÓN
        console.log('🔄  Intercambiando por Access Token de LARGA DURACIÓN...');
        const longLivedTokenUrl = `${process.env.META_API_BASE_URL}/oauth/access_token`;
        const longLivedTokenParams = {
            grant_type: 'fb_exchange_token',
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            fb_exchange_token: shortLivedAccessToken,
        };
        const longLivedTokenResponse = await axios.get(longLivedTokenUrl, { params: longLivedTokenParams });
        const longLivedAccessToken = longLivedTokenResponse.data.access_token;
        const longLivedExpiresIn = longLivedTokenResponse.data.expires_in; // Generalmente 60 días

        if (!longLivedAccessToken) {
            console.error('❌ No se pudo obtener el Access Token de larga duración.');
            throw new Error('No se pudo obtener el Access Token de larga duración.');
        }
        console.log('✅ Access Token de LARGA DURACIÓN obtenido: ' + longLivedAccessToken.substring(0, 20) + '...');

        // 3. Obtener información básica del usuario de Meta
        console.log('👤 Obteniendo información del usuario de Meta...');
        const userProfileUrl = `${process.env.META_API_BASE_URL.replace('/v23.0', '')}/me?fields=id,name,email&access_token=${longLivedAccessToken}`;
        const userProfileResponse = await axios.get(userProfileUrl);
        const userData = userProfileResponse.data;
        console.log('👤 Usuario de Meta autenticado:', userData);

        // 4. Almacenar el token de larga duración en la base de datos
        console.log('💾 Almacenando conexión Meta en la base de datos...');
        
        // ARQUITECTURA CORREGIDA:
        // - userId = ID del usuario en la aplicación (obtenido del state parameter)
        // - metaUserId = ID del usuario en Meta (userData.id)
        
        // Obtener el userId del parámetro state que viene del frontend
        const userId = state; // El frontend debe enviar el userId de la aplicación en el state
        const metaUserId = userData.id; // ID del usuario de Meta
        
        console.log('🔍 userId (aplicación):', userId);
        console.log('🔍 metaUserId (Meta):', metaUserId);
        
        if (!userId) {
            console.error('❌ No se pudo obtener el userId del parámetro state');
            return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('No se pudo identificar al usuario logueado. Por favor, inicie sesión en la aplicación antes de conectar Meta.')}`);
        }

        // Calcular fecha de expiración del token de larga duración
        // Los tokens de larga duración de Meta duran 60 días
        let expiresAt;
        if (longLivedExpiresIn && !isNaN(longLivedExpiresIn)) {
            // Si Meta proporciona expires_in, usarlo
            expiresAt = new Date(Date.now() + longLivedExpiresIn * 1000);
            console.log('📅 Usando expires_in de Meta:', longLivedExpiresIn, 'segundos');
        } else {
            // Si no, usar 60 días por defecto (duración estándar de tokens de larga duración)
            const sixtyDaysInMs = 60 * 24 * 60 * 60 * 1000; // 60 días en milisegundos
            expiresAt = new Date(Date.now() + sixtyDaysInMs);
            console.log('📅 Usando duración por defecto: 60 días');
        }
        
        console.log('📅 Token expirará el:', expiresAt.toISOString());

        await MetaConnection.upsert({
            userId: userId, // ID del usuario de la aplicación
            metaUserId: metaUserId, // ID del usuario de Meta
            userName: userData.name,
            userEmail: userData.email,
            accessToken: longLivedAccessToken,
            expiresAt: expiresAt,
        });
        console.log('✅ Conexión Meta almacenada/actualizada en la base de datos.');

        // 5. Redirigir de vuelta al frontend con un indicador de éxito
        console.log(`🚀 Redirigiendo al frontend: ${FRONTEND_URL}/pages/settings?connected=meta&metaUserId=${userData.id}`);
        res.redirect(`${FRONTEND_URL}/pages/settings?connected=meta&metaUserId=${userData.id}`);

    } catch (err) {
        console.error('❌ Error fatal en el proceso de OAuth:', err.response ? err.response.data : err.message);
        res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('Error en el proceso de autenticación.')}`);
    }
});

/**
 * GOOGLE OAUTH — CONNECT URL
 * GET /oauth/google/connect
 * Devuelve la URL de autorización para iniciar el flujo (idéntico patrón a Meta)
 */
router.get('/google/connect', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: GOOGLE_REDIRECT_URI,
            response_type: 'code',
            scope: GOOGLE_SCOPES,
            access_type: 'offline',
            include_granted_scopes: 'true',
            prompt: 'consent',
            state: String(userId)
        });
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
        return res.json({ success: true, authUrl });
    } catch (e) {
        console.error('❌ Error generando authUrl de Google:', e.message);
        return res.status(500).json({ success: false, error: 'No se pudo generar authUrl' });
    }
});

/**
 * GOOGLE OAUTH — CALLBACK
 * GET /oauth/google/callback
 */
router.get('/google/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query;
        if (error) {
            console.error('❌ Error en callback Google:', error);
            return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent(String(error))}`);
        }
        if (!code) {
            return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('Código no proporcionado')}`);
        }

        // 1) Intercambiar code por tokens
        const tokenResp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            code: code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const accessToken = tokenResp.data?.access_token;
        const refreshToken = tokenResp.data?.refresh_token || null; // puede ser null si ya concedido
        const expiresIn = tokenResp.data?.expires_in || 3600;
        if (!accessToken) throw new Error('No access_token en respuesta de token');

        const expiresAt = new Date(Date.now() + (expiresIn * 1000));

        // 2) Userinfo (email, id)
        const ui = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
        const googleUserId = ui.data?.id || 'unknown';
        const userEmail = ui.data?.email || null;
        const userName = ui.data?.name || [ui.data?.given_name, ui.data?.family_name].filter(Boolean).join(' ') || null;

        // 3) Guardar/actualizar conexión
        const userId = String(state || '').trim();
        if (!userId) {
            console.warn('⚠️ state vacío en callback Google');
        }
        const existing = await GoogleConnection.findOne({ where: { userId: userId } });
        const payload = {
            userId,
            googleUserId,
            userEmail,
            userName,
            accessToken,
            refreshToken: refreshToken || existing?.refreshToken || null,
            scopes: GOOGLE_SCOPES,
            expiresAt
        };
        if (existing) {
            await existing.update(payload);
        } else {
            await GoogleConnection.create(payload);
        }

        // 4) Redirigir al frontend
        return res.redirect(`${FRONTEND_URL}/pages/settings?connected=google&googleUserId=${googleUserId}`);
    } catch (err) {
        console.error('❌ Error en /oauth/google/callback:', err.response?.data || err.message);
        return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('Error en autenticación de Google')}`);
    }
});

/**
 * GOOGLE — Connection status
 * GET /oauth/google/connection-status
 */
router.get('/google/connection-status', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ connected: false, message: 'Usuario no autenticado' });
        let conn;
        try {
            conn = await GoogleConnection.findOne({ where: { userId } });
        } catch (e) {
            console.warn('⚠️ Error obteniendo conexión Google:', e.message);
        }
        if (!conn) return res.json({ connected: false });

        const tokenInfo = await ensureGoogleAccessToken(conn, { allowExpired: true });

        return res.json({
            connected: !tokenInfo.expired,
            userEmail: conn.userEmail,
            googleUserId: conn.googleUserId,
            userName: conn.userName || null,
            expiresAt: conn.expiresAt,
            scopes: conn.scopes,
            expired: tokenInfo.expired
        });
    } catch (e) {
        console.error('❌ Error en connection-status Google:', e.message);
        return res.status(500).json({ connected: false, message: 'Error interno' });
    }
});

/**
 * GOOGLE — Listar propiedades de Search Console para el usuario conectado
 * GET /oauth/google/assets
 */
router.get('/google/assets', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAccessToken(conn));
        } catch (tokenErr) {
            console.error('❌ Token Google inválido al listar assets:', tokenErr.message);
            return res.status(401).json({ success: false, error: tokenErr.code || 'TOKEN_ERROR' });
        }

        // Llamar a Search Console sites.list
        const resp = await axios.get('https://www.googleapis.com/webmasters/v3/sites', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const entries = resp.data?.siteEntry || [];
        const assets = entries.map((s) => ({
            siteUrl: s.siteUrl,
            permissionLevel: s.permissionLevel,
            propertyType: s.siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix'
        }));
        return res.json({ success: true, assets, total: assets.length });
    } catch (e) {
        console.error('❌ Error en /oauth/google/assets:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error obteniendo propiedades' });
    }
});

/**
 * GOOGLE — Estado de conexión para Google Analytics
 */
router.get('/google/analytics/connection-status', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ connected: false, reason: 'unauthenticated' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.json({ connected: false, reason: 'no_connection' });

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAccessToken(conn));
        } catch (tokenErr) {
            if (tokenErr.code === 'TOKEN_EXPIRED' || tokenErr.code === 'REFRESH_FAILED') {
                return res.json({ connected: false, reason: 'token_expired' });
            }
            throw tokenErr;
        }

        try {
            const resp = await axios.get('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
                params: { pageSize: 1 },
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const summaries = resp.data?.accountSummaries || [];
            return res.json({
                connected: true,
                hasAccounts: summaries.length > 0,
                accounts: summaries.length,
                expiresAt: conn.expiresAt
            });
        } catch (apiErr) {
            const status = apiErr.response?.status;
            if (status === 403) {
                return res.json({ connected: false, reason: 'insufficient_scope' });
            }
            if (status === 401) {
                return res.json({ connected: false, reason: 'token_invalid' });
            }
            console.error('❌ Error comprobando Analytics:', apiErr.response?.data || apiErr.message);
            return res.json({ connected: false, reason: 'api_error' });
        }
    } catch (e) {
        console.error('❌ Error en analytics/connection-status:', e.message);
        return res.status(500).json({ connected: false, reason: 'internal_error' });
    }
});

/**
 * GOOGLE — Listar propiedades de Google Analytics (GA4)
 */
router.get('/google/analytics/properties', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAccessToken(conn));
        } catch (tokenErr) {
            console.error('❌ Token Google inválido al listar Analytics:', tokenErr.message);
            return res.status(401).json({ success: false, error: tokenErr.code || 'TOKEN_ERROR' });
        }

        const accountSummaries = [];
        let pageToken;
        do {
            const resp = await axios.get('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
                params: { pageSize: 200, pageToken },
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const entries = resp.data?.accountSummaries || [];
            accountSummaries.push(...entries);
            pageToken = resp.data?.nextPageToken || null;
        } while (pageToken);

        const mapped = accountSummaries.map((acc) => ({
            accountName: acc.name,
            accountDisplayName: acc.displayName,
            properties: (acc.propertySummaries || []).map((p) => ({
                propertyName: p.property,
                propertyDisplayName: p.displayName,
                propertyType: p.propertyType,
                parent: p.parent
            }))
        }));

        return res.json({ success: true, accounts: mapped });
    } catch (e) {
        const status = e.response?.status;
        if (status === 403) {
            return res.status(403).json({ success: false, error: 'insufficient_scope' });
        }
        console.error('❌ Error listando propiedades de Analytics:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error listando propiedades' });
    }
});

/**
 * GOOGLE — Guardar mapeo de propiedades GA4 a clínicas
 * body: { mappings: [{ clinicaId, propertyName, propertyDisplayName?, propertyType?, parent?, measurementId? }] }
 */
router.post('/google/analytics/map-properties', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!mappings.length) return res.status(400).json({ success: false, error: 'mappings requerido' });

        const createdOrUpdated = [];
        const propertiesToBackfill = [];
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const propertyName = String(m.propertyName || '').trim();
            if (!clinicaId || !propertyName) continue;

            const payload = {
                clinicaId,
                googleConnectionId: conn.id,
                propertyName,
                propertyDisplayName: m.propertyDisplayName || null,
                propertyType: m.propertyType || null,
                parent: m.parent || null,
                measurementId: m.measurementId || null,
                isActive: true
            };

            const existing = await ClinicAnalyticsProperty.findOne({ where: { clinicaId, propertyName } });
            if (existing) {
                await existing.update(payload);
                createdOrUpdated.push({ id: existing.id, ...payload });
                propertiesToBackfill.push({ clinicId: clinicaId, propertyId: existing.id, propertyName });
            } else {
                const rec = await ClinicAnalyticsProperty.create(payload);
                createdOrUpdated.push({ id: rec.id, ...payload });
                propertiesToBackfill.push({ clinicId: clinicaId, propertyId: rec.id, propertyName });
            }
        }

        if (propertiesToBackfill.length) {
            try {
                const job = await jobRequestsService.enqueueJobRequest({
                    type: 'analytics_backfill',
                    payload: { mappings: propertiesToBackfill },
                    priority: 'high',
                    origin: 'analytics:map-properties',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error lanzando analyticsSync tras mapeo:', err)
                );
            } catch (queueErr) {
                console.error('❌ Error encolando analyticsSync tras mapeo:', queueErr);
            }
        }

        return res.json({ success: true, mapped: createdOrUpdated.length, properties: createdOrUpdated });
    } catch (e) {
        console.error('❌ Error en /oauth/google/analytics/map-properties:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error mapeando propiedades' });
    }
});

/**
 * GOOGLE — Listar ubicaciones de Google Business Profile accesibles
 */
router.get('/google/local/locations', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAccessToken(conn));
        } catch (tokenErr) {
            const errCode = tokenErr.code || 'TOKEN_ERROR';
            if (errCode === 'INSUFFICIENT_SCOPE') {
                return res.status(403).json({ success: false, error: 'insufficient_scope' });
            }
            return res.status(401).json({ success: false, error: errCode });
        }

        try {
            const accounts = await fetchAllGoogleBusinessAccounts(accessToken);
            const response = [];
            for (const account of accounts) {
                const locations = await fetchAllGoogleBusinessLocations(accessToken, account.name);
                const simplified = locations
                    .map((loc) => normalizeBusinessLocation(loc, account))
                    .filter(Boolean);
                response.push({
                    accountName: account.name,
                    accountDisplayName: account.accountName || account.name,
                    accountNumber: account.accountNumber || null,
                    locations: simplified
                });
            }

            return res.json({ success: true, accounts: response });
        } catch (apiErr) {
            const status = apiErr.response?.status;
            if (status === 403) {
                return res.status(403).json({ success: false, error: 'insufficient_scope' });
            }
            console.error('❌ Error listando ubicaciones de Google Business Profile:', apiErr.response?.data || apiErr.message);
            return res.status(500).json({ success: false, error: 'Error obteniendo ubicaciones' });
        }
    } catch (err) {
        console.error('❌ Error interno en /oauth/google/local/locations:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

/**
 * GOOGLE — Guardar mapeo de ubicaciones de Google Business Profile con clínicas
 */
router.post('/google/local/map-locations', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!mappings.length) {
            return res.status(400).json({ success: false, error: 'mappings requerido' });
        }

        const createdOrUpdated = [];
        for (const mapping of mappings) {
            const clinicaId = parseInt(mapping?.clinicaId, 10);
            const locationId = String(mapping?.locationId || mapping?.id || '').trim();
            if (!clinicaId || !locationId) {
                continue;
            }

            const payload = {
                clinica_id: clinicaId,
                google_connection_id: conn.id,
                location_name: mapping.locationName || mapping.title || null,
                location_id: locationId,
                store_code: mapping.storeCode || null,
                primary_category: mapping.primaryCategory || null,
                sync_status: 'pending',
                is_verified: typeof mapping.isVerified === 'boolean' ? mapping.isVerified : false,
                is_suspended: typeof mapping.isSuspended === 'boolean' ? mapping.isSuspended : false,
                raw_payload: mapping.rawLocation || mapping.rawPayload || null,
                is_active: true,
                last_synced_at: null
            };

            let record = await ClinicBusinessLocation.findOne({ where: { location_id: locationId } });
            if (record) {
                await record.update(payload);
            } else {
                record = await ClinicBusinessLocation.create(payload);
            }
            createdOrUpdated.push({ id: record.id, clinicaId, locationId });
        }

        return res.json({ success: true, mapped: createdOrUpdated.length, locations: createdOrUpdated });
    } catch (err) {
        console.error('❌ Error en /oauth/google/local/map-locations:', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: 'Error guardando mapeo Local' });
    }
});

/**
 * GOOGLE — Obtener mapeos actuales de Local Business
 */
router.get('/google/local/mappings', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.json({ success: true, mappings: [] });
        }

        const rows = await ClinicBusinessLocation.findAll({
            where: { google_connection_id: conn.id, is_active: true },
            include: [{ model: Clinica, as: 'clinica', required: false }],
            order: [['location_name', 'ASC']]
        });

        const byClinic = new Map();
        for (const row of rows) {
            const clinicaId = row.clinica_id;
            if (!byClinic.has(clinicaId)) {
                const clinic = row.clinica || {};
                byClinic.set(clinicaId, {
                    clinicaId,
                    clinicName: clinic.nombre_clinica || clinic.nombre || null,
                    clinicAvatar: clinic.url_avatar || null,
                    locations: []
                });
            }
            byClinic.get(clinicaId).locations.push({
                locationId: row.location_id,
                locationName: row.location_name,
                storeCode: row.store_code,
                primaryCategory: row.primary_category,
                isVerified: !!row.is_verified,
                isSuspended: !!row.is_suspended,
                lastSyncedAt: row.last_synced_at
            });
        }

        return res.json({ success: true, mappings: Array.from(byClinic.values()) });
    } catch (err) {
        console.error('❌ Error en /oauth/google/local/mappings:', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: 'Error obteniendo mapeos Local' });
    }
});

/**
 * GOOGLE — Estado de conexión Google Ads
 */
router.get('/google/ads/connection-status', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ connected: false, reason: 'unauthenticated' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.json({ connected: false, reason: 'no_connection' });
        }

        if (!hasScopeText(conn.scopes || '', GOOGLE_ADS_SCOPE)) {
            return res.json({ connected: false, reason: 'insufficient_scope' });
        }

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAdsAccess(conn));
        } catch (tokenErr) {
            if (tokenErr.code === 'INSUFFICIENT_SCOPE') {
                return res.json({ connected: false, reason: 'insufficient_scope' });
            }
            if (tokenErr.code === 'TOKEN_EXPIRED' || tokenErr.code === 'REFRESH_FAILED') {
                return res.json({ connected: false, reason: 'token_expired' });
            }
            if (tokenErr.code === 'ADS_CONFIG_MISSING') {
                return res.json({ connected: false, reason: 'config_missing' });
            }
            console.error('❌ Error obteniendo token Google Ads:', tokenErr.message);
            return res.json({ connected: false, reason: 'token_error' });
        }

        let customers = [];
        try {
            customers = await listAccessibleAdsCustomers(accessToken);
        } catch (adsErr) {
            console.error('❌ Error consultando cuentas Ads accesibles:', adsErr.details || adsErr.message);
            return res.json({ connected: false, reason: 'api_error', details: adsErr.details || adsErr.message });
        }

        return res.json({
            connected: true,
            managerId: formatCustomerId(getGoogleManagerId()),
            customersCount: customers.length,
            customers
        });
    } catch (err) {
        if (err.code === 'ADS_CONFIG_MISSING') {
            return res.json({ connected: false, reason: 'config_missing' });
        }
        console.error('❌ Error en /oauth/google/ads/connection-status:', err.details || err.message);
        return res.status(500).json({ connected: false, reason: 'internal_error' });
    }
});

/**
 * GOOGLE — Listar cuentas Google Ads accesibles
 */
router.get('/google/ads/accounts', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        if (!hasScopeText(conn.scopes || '', GOOGLE_ADS_SCOPE)) {
            return res.status(403).json({ success: false, error: 'insufficient_scope' });
        }

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAdsAccess(conn));
        } catch (tokenErr) {
            const reason = tokenErr.code === 'INSUFFICIENT_SCOPE' ? 'insufficient_scope' : tokenErr.code === 'TOKEN_EXPIRED' ? 'token_expired' : tokenErr.code === 'ADS_CONFIG_MISSING' ? 'config_missing' : 'token_error';
            return res.status(400).json({ success: false, error: reason });
        }

        const baseCustomers = await listAccessibleAdsCustomers(accessToken);
        const uniqueCustomers = new Set();
        const queue = [];
        const parentByCustomer = new Map();

        for (const customerId of baseCustomers) {
            const cleanId = normalizeCustomerId(customerId);
            if (!cleanId || uniqueCustomers.has(cleanId)) {
                continue;
            }
            uniqueCustomers.add(cleanId);
            parentByCustomer.set(cleanId, null);
            queue.push(cleanId);
        }

        const summaries = new Map();
        const processedManagers = new Set();

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (!currentId) {
                continue;
            }

            const parentId = parentByCustomer.get(currentId) || undefined;
            let summary = summaries.get(currentId);
            if (!summary) {
                try {
                    summary = await fetchAdsCustomerSummary(accessToken, currentId, { loginCustomerId: parentId });
                    if (summary) {
                        summaries.set(currentId, summary);
                    }
                } catch (summaryErr) {
                    console.error(`❌ Error obteniendo summary de Ads para ${currentId}:`, summaryErr.details || summaryErr.message);
                    summary = null;
                }
            }

            if (!summary?.isManager || processedManagers.has(currentId)) {
                continue;
            }

            processedManagers.add(currentId);
            try {
                const clients = await fetchAdsCustomerClients(accessToken, currentId);
                for (const client of clients) {
                    if (!client?.customerId) {
                        continue;
                    }
                    if (!uniqueCustomers.has(client.customerId)) {
                        uniqueCustomers.add(client.customerId);
                        parentByCustomer.set(client.customerId, currentId);
                        queue.push(client.customerId);
                    }
                    if (!summaries.has(client.customerId)) {
                        summaries.set(client.customerId, {
                            customerId: client.customerId,
                            descriptiveName: client.descriptiveName || null,
                            currencyCode: client.currencyCode || null,
                            timeZone: client.timeZone || null,
                            accountStatus: client.status || null,
                            isManager: !!client.isManager
                        });
                    }
                }
            } catch (clientErr) {
                console.error(`❌ Error listando clientes de manager ${currentId}:`, clientErr.details || clientErr.message);
            }
        }

        const customers = Array.from(uniqueCustomers);

        const existing = await ClinicGoogleAdsAccount.findAll({ where: { googleConnectionId: conn.id, isActive: true }, raw: true });
        const existingByCustomer = new Map();
        for (const row of existing) {
            const key = normalizeCustomerId(row.customerId);
            if (!existingByCustomer.has(key)) {
                existingByCustomer.set(key, []);
            }
            existingByCustomer.get(key).push(row);
        }

        const clinicIds = Array.from(existingByCustomer.values()).flat().map(r => r.clinicaId);
        const uniqueClinicIds = Array.from(new Set(clinicIds));
        const clinicIndex = uniqueClinicIds.length
            ? new Map((await Clinica.findAll({ where: { id_clinica: uniqueClinicIds }, raw: true })).map(c => [c.id_clinica, c]))
            : new Map();

        const accounts = [];
        const mainManagerId = normalizeCustomerId(getGoogleManagerId());

        for (const customerId of customers) {
            const cleanId = normalizeCustomerId(customerId);
            const parentId = parentByCustomer.get(cleanId) || undefined;
            const response = {
                customerId: cleanId,
                formattedCustomerId: formatCustomerId(cleanId),
                parentCustomerId: parentId ? formatCustomerId(parentId) : null,
                parentDescriptiveName: null,
                loginCustomerId: parentId || null,
                inHierarchy: false
            };
            try {
                let summary = summaries.get(cleanId);
                if (!summary) {
                    summary = await fetchAdsCustomerSummary(accessToken, cleanId, { loginCustomerId: parentId });
                    if (summary) {
                        summaries.set(cleanId, summary);
                    }
                }
                const link = await fetchManagerLinkForCustomer(accessToken, cleanId, getGoogleManagerId(), { loginCustomerId: parentId });
                const parentSummary = parentId ? summaries.get(parentId) : null;
                response.descriptiveName = summary?.descriptiveName || null;
                response.currencyCode = summary?.currencyCode || null;
                response.timeZone = summary?.timeZone || null;
                response.accountStatus = summary?.accountStatus || null;
                response.isManager = !!summary?.isManager;
                response.parentDescriptiveName = parentSummary?.descriptiveName || null;
                if (link?.status === 'ACTIVE') {
                    response.loginCustomerId = mainManagerId;
                    response.inHierarchy = true;
                } else if (parentId) {
                    response.loginCustomerId = parentId;
                    response.inHierarchy = true;
                }
                response.managerCustomerId = link?.managerCustomerId ? formatCustomerId(link.managerCustomerId) : null;
                response.managerLinkId = link?.managerLinkId || null;
                response.managerLinkStatus = link?.status || null;
                response.isLinked = link?.status === 'ACTIVE';
                response.invitationStatus = link?.status === 'PENDING' ? 'PENDING' : null;

                const mappedRows = existingByCustomer.get(cleanId) || [];
                response.mappedClinics = mappedRows.map(row => {
                    const clinic = clinicIndex.get(row.clinicaId) || {};
                    return {
                        clinicaId: row.clinicaId,
                        clinicName: clinic.nombre_clinica || null,
                        clinicAvatar: clinic.url_avatar || null,
                        managerLinkStatus: row.managerLinkStatus || row.invitationStatus || null,
                        accountStatus: row.accountStatus || null,
                        invitationStatus: row.invitationStatus || null
                    };
                });
                if (response.loginCustomerId === null && response.inHierarchy) {
                    response.loginCustomerId = mainManagerId;
                }
            } catch (adsErr) {
                console.error(`❌ Error obteniendo detalles de Ads para ${cleanId}:`, adsErr.details || adsErr.message);
                response.error = adsErr.details || adsErr.message;
            }
            accounts.push(response);
        }

        return res.json({ success: true, managerId: formatCustomerId(getGoogleManagerId()), accounts });
    } catch (err) {
        if (err.code === 'ADS_CONFIG_MISSING') {
            return res.status(500).json({ success: false, error: 'config_missing' });
        }
        console.error('❌ Error en /oauth/google/ads/accounts:', err.details || err.message);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

/**
 * GOOGLE — Invitar cuenta al MCC (customerClientLink)
 */
router.post('/google/ads/request-link', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const customerId = normalizeCustomerId(req.body?.customerId);
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'customerId requerido' });
        }

        if (!hasScopeText(conn.scopes || '', GOOGLE_ADS_SCOPE)) {
            return res.status(403).json({ success: false, error: 'insufficient_scope' });
        }

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAdsAccess(conn));
        } catch (tokenErr) {
            const reason = tokenErr.code === 'INSUFFICIENT_SCOPE' ? 'insufficient_scope' : tokenErr.code === 'TOKEN_EXPIRED' ? 'token_expired' : tokenErr.code === 'ADS_CONFIG_MISSING' ? 'config_missing' : 'token_error';
            return res.status(400).json({ success: false, error: reason });
        }

        const managerId = ensureGoogleAdsConfig().managerId;
        try {
            const payload = {
                operation: {
                    create: {
                        clientCustomer: `customers/${customerId}`,
                        status: 'PENDING'
                    }
                }
            };
            const data = await googleAdsRequest('POST', `customers/${managerId}/customerClientLinks:mutate`, {
                accessToken,
                loginCustomerId: managerId,
                data: payload
            });
            const result = Array.isArray(data?.results) ? data.results[0] : null;
            return res.json({ success: true, invitation: result });
        } catch (adsErr) {
            const rawError = adsErr.response?.data?.error || adsErr.response?.data || null;
            let message = rawError?.message || adsErr.message;
            const inner = Array.isArray(rawError?.details) ? rawError.details.find(detail => Array.isArray(detail?.errors) && detail.errors.length) : null;
            const firstError = inner?.errors ? inner.errors[0] : null;
            if (firstError?.message) {
                message = firstError.message;
            }
            console.error('❌ Error creando invitación MCC:', message, rawError);
            return res.status(400).json({ success: false, error: message, details: rawError });
        }
    } catch (err) {
        if (err.code === 'ADS_CONFIG_MISSING') {
            return res.status(500).json({ success: false, error: 'config_missing' });
        }
        console.error('❌ Error en /oauth/google/ads/request-link:', err.details || err.message);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

/**
 * GOOGLE — Aceptar invitación MCC desde la cuenta cliente
 */
router.post('/google/ads/accept-link', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        if (!hasScopeText(conn.scopes || '', GOOGLE_ADS_SCOPE)) {
            return res.status(403).json({ success: false, error: 'insufficient_scope' });
        }

        const customerId = normalizeCustomerId(req.body?.customerId);
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'customerId requerido' });
        }

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAdsAccess(conn));
        } catch (tokenErr) {
            const reason = tokenErr.code === 'INSUFFICIENT_SCOPE' ? 'insufficient_scope' : tokenErr.code === 'TOKEN_EXPIRED' ? 'token_expired' : tokenErr.code === 'ADS_CONFIG_MISSING' ? 'config_missing' : 'token_error';
            return res.status(400).json({ success: false, error: reason });
        }

        const managerId = ensureGoogleAdsConfig().managerId;
        const link = await fetchManagerLinkForCustomer(accessToken, customerId, managerId);
        if (!link) {
            return res.status(404).json({ success: false, error: 'no_pending_invitation' });
        }

        if (link.status === 'ACTIVE') {
            return res.json({ success: true, status: 'ACTIVE', message: 'La cuenta ya está enlazada con el MCC' });
        }

        if (!link.managerLinkId) {
            return res.status(400).json({ success: false, error: 'missing_manager_link_id' });
        }

        try {
            const resourceName = `customers/${customerId}/customerManagerLinks/${managerId}~${link.managerLinkId}`;
            const payload = {
                operations: [
                    {
                        update: {
                            resourceName,
                            status: 'ACTIVE'
                        },
                        updateMask: 'status'
                    }
                ]
            };
            await googleAdsRequest('POST', `customers/${customerId}/customerManagerLinks:mutate`, {
                accessToken,
                loginCustomerId: customerId,
                data: payload
            });
            return res.json({ success: true, status: 'ACTIVE', managerLinkId: link.managerLinkId });
        } catch (adsErr) {
            console.error('❌ Error aceptando invitación MCC:', adsErr.details || adsErr.message);
            return res.status(500).json({ success: false, error: adsErr.details || adsErr.message });
        }
    } catch (err) {
        if (err.code === 'ADS_CONFIG_MISSING') {
            return res.status(500).json({ success: false, error: 'config_missing' });
        }
        console.error('❌ Error en /oauth/google/ads/accept-link:', err.details || err.message);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

/**
 * GOOGLE — Guardar mapeo de cuentas Ads ↔ clínicas
 */
router.post('/google/ads/map-accounts', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!mappings.length) {
            return res.status(400).json({ success: false, error: 'mappings requerido' });
        }

        const transaction = await db.sequelize.transaction();
        const results = [];
        const clinicsToSync = new Set();
        const clinicAssignmentCache = new Map();
        const groupCache = new Map();

        async function resolveAssignment(clinicaId) {
            if (!clinicaId) {
                return { assignmentScope: 'clinic', grupoClinicaId: null };
            }

            if (clinicAssignmentCache.has(clinicaId)) {
                return clinicAssignmentCache.get(clinicaId);
            }

            const clinic = await Clinica.findByPk(clinicaId, {
                attributes: ['id_clinica', 'grupoClinicaId']
            });

            let assignmentScope = 'clinic';
            let grupoClinicaId = null;

            if (clinic?.grupoClinicaId) {
                const groupId = clinic.grupoClinicaId;
                let group = groupCache.get(groupId);
                if (!group) {
                    group = await GrupoClinica.findByPk(groupId, {
                        attributes: ['id_grupo', 'ads_assignment_mode']
                    });
                    groupCache.set(groupId, group);
                }

                if (group?.ads_assignment_mode === 'automatic') {
                    assignmentScope = 'group';
                    grupoClinicaId = group.id_grupo;
                }
            }

            const resolved = { assignmentScope, grupoClinicaId };
            clinicAssignmentCache.set(clinicaId, resolved);
            return resolved;
        }

        try {
            for (const mapping of mappings) {
                const clinicaId = parseInt(mapping?.clinicaId, 10);
                const customerId = normalizeCustomerId(mapping?.customerId);
                if (!clinicaId || !customerId) {
                    continue;
                }

                const { assignmentScope, grupoClinicaId } = await resolveAssignment(clinicaId);

                const payload = {
                    clinicaId,
                    googleConnectionId: conn.id,
                    customerId,
                    descriptiveName: mapping?.descriptiveName || null,
                    currencyCode: mapping?.currencyCode || null,
                    timeZone: mapping?.timeZone || null,
                    accountStatus: mapping?.accountStatus || null,
                    managerCustomerId: mapping?.managerCustomerId ? normalizeCustomerId(mapping.managerCustomerId) : normalizeCustomerId(getGoogleManagerId()),
                    loginCustomerId: mapping?.loginCustomerId ? normalizeCustomerId(mapping.loginCustomerId) : (mapping?.managerCustomerId ? normalizeCustomerId(mapping.managerCustomerId) : normalizeCustomerId(getGoogleManagerId())),
                    managerLinkId: mapping?.managerLinkId || null,
                    managerLinkStatus: mapping?.managerLinkStatus || null,
                    invitationStatus: mapping?.invitationStatus || null,
                    linkedAt: mapping?.linkedAt ? new Date(mapping.linkedAt) : (mapping?.managerLinkStatus === 'ACTIVE' ? new Date() : null),
                    assignmentScope,
                    grupoClinicaId,
                    isActive: true
                };

                await ClinicGoogleAdsAccount.update(
                    { isActive: false },
                    {
                        where: {
                            clinicaId,
                            customerId: { [Op.ne]: customerId },
                            isActive: true
                        },
                        transaction
                    }
                );

                const existing = await ClinicGoogleAdsAccount.findOne({ where: { clinicaId, customerId }, transaction });
                if (existing) {
                    await existing.update(payload, { transaction });
                    results.push({ id: existing.id, ...payload });
                } else {
                    const rec = await ClinicGoogleAdsAccount.create(payload, { transaction });
                    results.push({ id: rec.id, ...payload });
                }

                clinicsToSync.add(clinicaId);
            }
            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        const clinicIds = Array.from(clinicsToSync).filter((id) => Number.isInteger(id));
        if (clinicIds.length) {
            try {
                const job = await jobRequestsService.enqueueJobRequest({
                    type: 'google_ads_recent',
                    payload: { clinicIds },
                    priority: 'critical',
                    origin: 'google:map-accounts',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error disparando resync de Google Ads desde cola:', err.message)
                );
            } catch (queueError) {
                console.error('❌ Error encolando resync de Google Ads tras map-accounts:', queueError);
            }
        }

        return res.json({ success: true, mapped: results.length, accounts: results });
    } catch (err) {
        console.error('❌ Error en /oauth/google/ads/map-accounts:', err.details || err.message);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

/**
 * GOOGLE — Obtener mapeos Ads actuales
 */
router.get('/google/ads/mappings', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const rows = await ClinicGoogleAdsAccount.findAll({ where: { googleConnectionId: conn.id, isActive: true }, raw: true });
        if (!rows.length) {
            return res.json({ success: true, mappings: [] });
        }

        const clinicIds = Array.from(new Set(rows.map(r => r.clinicaId))).filter(Boolean);
        const clinics = clinicIds.length ? await Clinica.findAll({ where: { id_clinica: clinicIds }, raw: true }) : [];
        const clinicIndex = new Map(clinics.map(c => [c.id_clinica, c]));

        const byClinic = new Map();
        for (const row of rows) {
            const clinicaId = row.clinicaId;
            if (!byClinic.has(clinicaId)) {
                const clinic = clinicIndex.get(clinicaId) || {};
                byClinic.set(clinicaId, {
                    clinicaId,
                    clinicName: clinic.nombre_clinica || null,
                    clinicAvatar: clinic.url_avatar || null,
                    ads: []
                });
            }
            byClinic.get(clinicaId).ads.push({
                id: row.id,
                customerId: row.customerId,
                formattedCustomerId: formatCustomerId(row.customerId),
                descriptiveName: row.descriptiveName || null,
                currencyCode: row.currencyCode || null,
                timeZone: row.timeZone || null,
                accountStatus: row.accountStatus || null,
                managerCustomerId: row.managerCustomerId ? formatCustomerId(row.managerCustomerId) : formatCustomerId(getGoogleManagerId()),
                managerLinkId: row.managerLinkId || null,
                managerLinkStatus: row.managerLinkStatus || null,
                invitationStatus: row.invitationStatus || null,
                linkedAt: row.linkedAt || null
            });
        }

        return res.json({ success: true, mappings: Array.from(byClinic.values()) });
    } catch (err) {
        console.error('❌ Error en /oauth/google/ads/mappings:', err.details || err.message);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

router.delete('/google/ads/mappings/:mappingId', async (req, res) => {
    const mappingId = Number.parseInt(req.params.mappingId, 10);
    if (!Number.isInteger(mappingId)) {
        return res.status(400).json({ success: false, error: 'mappingId inválido' });
    }
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const account = await ClinicGoogleAdsAccount.findOne({ where: { id: mappingId, googleConnectionId: conn.id } });
        if (!account) {
            return res.status(404).json({ success: false, error: 'Cuenta Google Ads no encontrada' });
        }

        await GroupAssetClinicAssignment.destroy({
            where: { assetType: 'google.ads_account', assetId: mappingId }
        });

        await account.destroy();

        return res.json({ success: true });
    } catch (error) {
        console.error('❌ Error eliminando mapeo de Google Ads:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GOOGLE — Obtener mapeos GA4 actuales
 */
router.get('/google/analytics/mappings', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const items = await ClinicAnalyticsProperty.findAll({
            where: { googleConnectionId: conn.id },
            include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }]
        });

        const mapped = items.map(item => ({
            id: item.id,
            clinicaId: item.clinicaId,
            clinicName: item.clinica?.nombre_clinica || null,
            propertyName: item.propertyName,
            propertyDisplayName: item.propertyDisplayName,
            propertyType: item.propertyType,
            parent: item.parent,
            measurementId: item.measurementId
        }));

        return res.json({ success: true, mappings: mapped });
    } catch (e) {
        console.error('❌ Error en /oauth/google/analytics/mappings:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error obteniendo mapeos de Analytics' });
    }
});

router.delete('/google/analytics/mappings/:mappingId', async (req, res) => {
    const mappingId = Number.parseInt(req.params.mappingId, 10);
    if (!Number.isInteger(mappingId)) {
        return res.status(400).json({ success: false, error: 'mappingId inválido' });
    }
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const mapping = await ClinicAnalyticsProperty.findOne({ where: { id: mappingId, googleConnectionId: conn.id } });
        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }

        await GroupAssetClinicAssignment.destroy({
            where: { assetType: 'google.analytics', assetId: mappingId }
        });

        await mapping.destroy();

        return res.json({ success: true });
    } catch (error) {
        console.error('❌ Error eliminando mapeo de Analytics:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GOOGLE — Mapear propiedades a clínicas
 * POST /oauth/google/map-assets
 * body: { mappings: [{ clinicaId, siteUrl, propertyType?, permissionLevel? }] }
 */
router.post('/google/map-assets', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!mappings.length) return res.status(400).json({ success: false, error: 'mappings requerido' });

        const createdOrUpdated = [];
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const siteUrl = String(m.siteUrl || '').trim();
            if (!clinicaId || !siteUrl) continue;
            const payload = {
                clinicaId,
                googleConnectionId: conn.id,
                siteUrl,
                propertyType: m.propertyType || (siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix'),
                permissionLevel: m.permissionLevel || null,
                verified: true,
                isActive: true
            };
            const existing = await ClinicWebAsset.findOne({ where: { clinicaId, siteUrl } });
            if (existing) {
                await existing.update(payload);
                createdOrUpdated.push({ id: existing.id, ...payload });
            } else {
                const rec = await ClinicWebAsset.create(payload);
                createdOrUpdated.push({ id: rec.id, ...payload });
            }
        }

        return res.json({ success: true, mapped: createdOrUpdated.length, assets: createdOrUpdated });
    } catch (e) {
        console.error('❌ Error en /oauth/google/map-assets:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error mapeando propiedades' });
    }
});

/**
 * GOOGLE — Obtener mapeos actuales por clínica
 * GET /oauth/google/mappings
 */
router.get('/google/mappings', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const rows = await ClinicWebAsset.findAll({ where: { googleConnectionId: conn.id, isActive: true }, raw: true });
        const clinicIds = Array.from(new Set(rows.map(r => r.clinicaId))).filter(Boolean);
        const clinics = clinicIds.length ? await Clinica.findAll({ where: { id_clinica: clinicIds }, raw: true }) : [];
        const clinicIndex = new Map(clinics.map(c => [c.id_clinica, c]));

        const byClinic = new Map();
        for (const r of rows) {
            if (!byClinic.has(r.clinicaId)) {
                const c = clinicIndex.get(r.clinicaId) || {};
                byClinic.set(r.clinicaId, {
                    clinica: { id: r.clinicaId, nombre: c.nombre_clinica || 'Clínica', avatar_url: c.url_avatar || null },
                    assets: { search_console: [] }
                });
            }
            byClinic.get(r.clinicaId).assets.search_console.push({
                id: r.id,
                siteUrl: r.siteUrl,
                propertyType: r.propertyType,
                permissionLevel: r.permissionLevel
            });
        }
        return res.json({ success: true, mappings: Array.from(byClinic.values()) });
    } catch (e) {
        console.error('❌ Error en /oauth/google/mappings:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error obteniendo mapeos' });
    }
});

router.delete('/google/mappings/:mappingId', async (req, res) => {
    const mappingId = Number.parseInt(req.params.mappingId, 10);
    if (!Number.isInteger(mappingId)) {
        return res.status(400).json({ success: false, error: 'mappingId inválido' });
    }
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });

        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const mapping = await ClinicWebAsset.findOne({ where: { id: mappingId, googleConnectionId: conn.id } });
        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }

        await GroupAssetClinicAssignment.destroy({
            where: { assetType: 'google.search_console', assetId: mappingId }
        });

        await mapping.destroy();

        return res.json({ success: true });
    } catch (error) {
        console.error('❌ Error eliminando mapeo de Search Console:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GOOGLE — Desconectar cuenta (elimina conexión y mapeos)
 * DELETE /oauth/google/disconnect
 */
router.delete('/google/disconnect', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        const conn = await GoogleConnection.findOne({ where: { userId } });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        await ClinicWebAsset.destroy({ where: { googleConnectionId: conn.id } });
        await ClinicAnalyticsProperty.destroy({ where: { googleConnectionId: conn.id } });
        await ClinicBusinessLocation.destroy({ where: { google_connection_id: conn.id } });
        await ClinicGoogleAdsAccount.destroy({ where: { googleConnectionId: conn.id } });
        await conn.destroy();
        return res.json({ success: true, message: 'Conexión Google desconectada y mapeos eliminados' });
    } catch (e) {
        console.error('❌ Error en /oauth/google/disconnect:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error al desconectar Google' });
    }
});

/**
 * GET /oauth/meta/connection-status
 * Endpoint para que el frontend consulte el estado de conexión de Meta para el usuario actual.
 */
router.get('/meta/connection-status', async (req, res) => {
    const userId = getUserIdFromToken(req); // Obtén el ID de tu usuario logueado
    if (!userId) {
        return res.status(401).json({ connected: false, message: 'Usuario no autenticado.' });
    }

    try {
        const connection = await MetaConnection.findOne({ where: { userId: userId } });
        if (connection) {
            return res.json({
                connected: true,
                metaUserId: connection.metaUserId,
                userName: connection.userName,
                userEmail: connection.userEmail,
                message: 'Conexión Meta activa.'
            });
        } else {
            return res.json({ connected: false, message: 'No hay conexión Meta para este usuario.' });
        }
    } catch (error) {
        console.error('Error al obtener estado de conexión Meta:', error);
        return res.status(500).json({ connected: false, message: 'Error interno del servidor.' });
    }
});

/**
 * GET /oauth/meta/assets
 * Obtener todos los activos de Meta del usuario con paginación completa
 */
router.get('/meta/assets', async (req, res) => {
    try {
        console.log('📋 Obteniendo activos de Meta con paginación completa...');
        
        // 1. Obtener userId del JWT
        const userId = getUserIdFromToken(req);
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({ 
                success: false, 
                error: 'Usuario no autenticado' 
            });
        }

        console.log('🔍 Token JWT decodificado para assets:', { userId });

        // 2. Buscar conexión Meta del usuario
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });

        if (!metaConnection) {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.status(404).json({ 
                success: false, 
                error: 'No hay conexión Meta activa para este usuario' 
            });
        }

        console.log('✅ Conexión Meta encontrada:', {
            id: metaConnection.id,
            metaUserId: metaConnection.metaUserId,
            userName: metaConnection.userName
        });

        // 3. Verificar que el token no haya expirado
        if (new Date() > metaConnection.expiresAt) {
            console.log('❌ Token de Meta expirado');
            return res.status(401).json({ 
                success: false, 
                error: 'Token de Meta expirado. Por favor, reconecta tu cuenta.' 
            });
        }

        console.log('✅ Token de usuario válido encontrado');

        // 4. Función para obtener todos los elementos con paginación
        async function getAllPaginatedData(initialUrl, accessToken) {
            let allData = [];
            let nextUrl = initialUrl;
            let pageCount = 0;

            while (nextUrl && pageCount < 50) { // Límite de seguridad: máximo 50 páginas
                pageCount++;
                console.log(`📄 Obteniendo página ${pageCount}...`);
                
                try {
                    const response = await axios.get(nextUrl, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });

                    if (response.data && response.data.data) {
                        allData.push(...response.data.data);
                        console.log(`✅ Página ${pageCount}: ${response.data.data.length} elementos obtenidos`);
                    }

                    // Verificar si hay más páginas
                    nextUrl = response.data.paging?.next || null;
                    
                    if (!nextUrl) {
                        console.log(`🏁 Paginación completada en ${pageCount} páginas`);
                    }
                } catch (error) {
                    console.log(`❌ Error en página ${pageCount}:`, error.message);
                    break; // Salir del bucle si hay error
                }
            }

            if (pageCount >= 50) {
                console.log('⚠️ Límite de paginación alcanzado (50 páginas)');
            }

            return allData;
        }

        // 5. Obtener todas las páginas de Facebook con paginación
        console.log('📄 Obteniendo páginas de Facebook...');
        const facebookPagesUrl = `${process.env.META_API_BASE_URL}/me/accounts?fields=id,name,picture.width(200).height(200),access_token,category,verification_status,followers_count,instagram_business_account{id,name,username,profile_picture_url,followers_count,media_count,biography}`;
        
        const allFacebookPages = await getAllPaginatedData(facebookPagesUrl, metaConnection.accessToken);
        console.log(`✅ ${allFacebookPages.length} páginas de Facebook encontradas`);

        // 6. Obtener todas las cuentas publicitarias con paginación
        console.log('💰 Obteniendo cuentas publicitarias...');
        const adAccountsUrl = `${process.env.META_API_BASE_URL}/me/adaccounts?fields=id,name,account_status,currency,timezone_name,business_name`;
        
        const allAdAccounts = await getAllPaginatedData(adAccountsUrl, metaConnection.accessToken);
        console.log(`✅ ${allAdAccounts.length} cuentas publicitarias encontradas`);

        // 7. Procesar páginas de Facebook
        const facebookPages = allFacebookPages.map(page => ({
            id: page.id,
            name: page.name,
            type: 'facebook_page',
            assetAvatarUrl: page.picture?.data?.url || null,
            pageAccessToken: page.access_token, // ⭐ TOKEN ESPECÍFICO
            additionalData: {
                category: page.category || null,
                verification_status: page.verification_status || null,
                followers_count: page.followers_count || 0
            }
        }));

        // 8. Procesar Instagram Business Accounts (separados)
        const instagramBusinessAccounts = [];
        allFacebookPages.forEach(page => {
            if (page.instagram_business_account) {
                const igAccount = page.instagram_business_account;
                instagramBusinessAccounts.push({
                    id: igAccount.id,
                    name: igAccount.name || igAccount.username,
                    username: igAccount.username,
                    type: 'instagram_business',
                    assetAvatarUrl: igAccount.profile_picture_url || null,
                    linked_facebook_page: page.id, // Referencia a la página vinculada
                    additionalData: {
                        followers_count: igAccount.followers_count || 0,
                        media_count: igAccount.media_count || 0,
                        biography: igAccount.biography || null,
                        username: igAccount.username
                    }
                });
            }
        });

        // 9. Procesar cuentas publicitarias
        const adAccounts = allAdAccounts.map(account => ({
            id: account.id,
            name: account.name,
            type: 'ad_account',
            assetAvatarUrl: null, // Las cuentas publicitarias no tienen avatar
            additionalData: {
                account_status: account.account_status || null,
                currency: account.currency || null,
                timezone_name: account.timezone_name || null,
                business_name: account.business_name || null
            }
        }));

        // 10. Preparar respuesta final
        const response = {
            success: true,
            user_info: {
                meta_user_id: metaConnection.metaUserId,
                name: metaConnection.userName,
                email: metaConnection.userEmail
            },
            assets: {
                facebook_pages: facebookPages,
                instagram_business: instagramBusinessAccounts,
                ad_accounts: adAccounts
            },
            total_assets: facebookPages.length + instagramBusinessAccounts.length + adAccounts.length,
            pagination_info: {
                facebook_pages_count: facebookPages.length,
                instagram_accounts_count: instagramBusinessAccounts.length,
                ad_accounts_count: adAccounts.length
            }
        };

        // 11. Log de resumen
        console.log('📊 Resumen de activos obtenidos:');
        console.log(`   - ${facebookPages.length} páginas de Facebook`);
        console.log(`   - ${instagramBusinessAccounts.length} cuentas de Instagram Business`);
        console.log(`   - ${adAccounts.length} cuentas publicitarias`);
        console.log('✅ Activos de Meta obtenidos correctamente');

        res.json(response);

    } catch (error) {
        console.error('❌ Error obteniendo activos de Meta:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Error interno del servidor al obtener activos de Meta',
            details: error.message 
        });
    }
});

/**
 * POST /oauth/meta/map-assets
 * Endpoint para que el frontend guarde los activos de Meta mapeados a una clínica.
 * Requiere que el usuario esté autenticado en tu app y tenga los roles adecuados.
 */
router.post('/meta/map-assets', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) {
        return res.status(401).json({ message: 'Usuario no autenticado.' });
    }

    const { clinicaId, selectedAssets } = req.body; // selectedAssets es un array de { id, name, type, pageAccessToken (opcional) }

    // TODO: AÑADIR LÓGICA DE ROLES/PERMISOS AQUÍ
    // Verificar que el userId tiene permisos de administrador/propietario para clinicaId
    // Esto es CRÍTICO para la seguridad y la lógica de negocio.
    // Necesitarás una función que consulte tu base de datos de roles/permisos.
    // Ejemplo:
    // const userHasPermission = await checkUserRoleForClinica(userId, clinicaId, ['admin', 'propietario']);
    // if (!userHasPermission) {
    //     return res.status(403).json({ message: 'Permisos insuficientes para mapear activos a esta clínica.' });
    // }

    try {
        const metaConnection = await MetaConnection.findOne({ where: { userId: userId } });
        if (!metaConnection) {
            return res.status(404).json({ message: 'No hay conexión Meta activa para este usuario.' });
        }

        // Nota: actualizamos/creamos mapeos. Además, forzamos unicidad por tipo en casos clave
        // (instagram_business) y limpiamos datos del activo desasociado.
        const createdOrUpdated = [];
        const selectedKeySet = new Set();
        const clinicsToSync = new Set();
        const clinicAssignmentCache = new Map();
        const groupCache = new Map();

        async function resolveAssignment(clinicId) {
            if (!clinicId) {
                return { assignmentScope: 'clinic', grupoClinicaId: null };
            }

            if (clinicAssignmentCache.has(clinicId)) {
                return clinicAssignmentCache.get(clinicId);
            }

            const clinic = await Clinica.findByPk(clinicId, {
                attributes: ['id_clinica', 'grupoClinicaId']
            });

            let assignmentScope = 'clinic';
            let grupoClinicaId = null;

            if (clinic?.grupoClinicaId) {
                const groupId = clinic.grupoClinicaId;
                let group = groupCache.get(groupId);
                if (!group) {
                    group = await GrupoClinica.findByPk(groupId, {
                        attributes: ['id_grupo', 'ads_assignment_mode']
                    });
                    groupCache.set(groupId, group);
                }

                if (group?.ads_assignment_mode === 'automatic') {
                    assignmentScope = 'group';
                    grupoClinicaId = group.id_grupo;
                }
            }

            const resolved = { assignmentScope, grupoClinicaId };
            clinicAssignmentCache.set(clinicId, resolved);
            return resolved;
        }

        // Traer mapeos actuales de la clínica del mismo usuario
        const existing = await ClinicMetaAsset.findAll({
            where: { clinicaId, metaConnectionId: metaConnection.id }
        });

        // Actualizar o crear assets seleccionados
        for (const asset of selectedAssets) {
            const key = `${asset.type}|${asset.id}`;
            selectedKeySet.add(key);

            const { assignmentScope, grupoClinicaId } = await resolveAssignment(clinicaId);

            const found = existing.find(a => a.assetType === asset.type && a.metaAssetId === String(asset.id));
            if (found) {
                await found.update({
                    metaAssetName: asset.name,
                    pageAccessToken: asset.pageAccessToken || found.pageAccessToken || null,
                    assetAvatarUrl: asset.assetAvatarUrl || found.assetAvatarUrl || null,
                    assignmentScope,
                    grupoClinicaId,
                    isActive: true
                });
                createdOrUpdated.push(found);
            } else {
                const newAsset = await ClinicMetaAsset.create({
                    clinicaId,
                    metaConnectionId: metaConnection.id,
                    assetType: asset.type,
                    metaAssetId: asset.id,
                    metaAssetName: asset.name,
                    assetAvatarUrl: asset.assetAvatarUrl || null,
                    pageAccessToken: asset.pageAccessToken || null,
                    assignmentScope,
                    grupoClinicaId,
                    isActive: true
                });
                createdOrUpdated.push(newAsset);
            }

            if (asset.type === 'ad_account') {
                const numericClinicId = Number(clinicaId);
                if (Number.isInteger(numericClinicId)) {
                    clinicsToSync.add(numericClinicId);
                }
            }

            // Auto-suscripción a leadgen para páginas con pageAccessToken disponible
            if (asset.type === 'facebook_page') {
                const pageToken = asset.pageAccessToken || createdOrUpdated[createdOrUpdated.length - 1]?.pageAccessToken || found?.pageAccessToken;
                await subscribeLeadgenToPage(asset.id, pageToken);
            }
        }

        // Desactivar los que ya no estén seleccionados y limpiar sus datos
        const toDeactivate = existing.filter(a => !selectedKeySet.has(`${a.assetType}|${a.metaAssetId}`) && a.isActive);
        if (toDeactivate.length) {
            await ClinicMetaAsset.update({ isActive: false }, { where: { id: toDeactivate.map(a => a.id) } });
            // Borrar datos asociados a IG/FB desactivados cuando aplica
            const { SocialStatsDaily, SocialPosts, SocialPostStatsDaily } = db;
            for (const a of toDeactivate) {
                try {
                    await SocialStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                    await SocialPostStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                    await SocialPosts.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                    // Opcional: eliminar el mapeo físico si es IG (se solicitó borrar anteriores)
                    if (a.assetType === 'instagram_business') {
                        await ClinicMetaAsset.destroy({ where: { id: a.id } });
                    }
                } catch (cleanErr) {
                    console.warn('⚠️ Error limpiando datos de activo desactivado', a.id, cleanErr.message);
                }
            }
        }

        // Enforce: solo 1 instagram_business activo por clínica
        try {
            const activeIGs = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'instagram_business', isActive: true } });
            if (activeIGs.length > 1) {
                // Conservar el IG que venga en selectedAssets (el primero) o el más reciente
                const selectedIGIds = selectedAssets.filter((a) => a.type === 'instagram_business').map((a) => String(a.id));
                let keep = null;
                if (selectedIGIds.length) {
                    keep = activeIGs.find(a => selectedIGIds.includes(String(a.metaAssetId))) || activeIGs[0];
                } else {
                    keep = activeIGs[0];
                }
                const toDrop = activeIGs.filter(a => a.id !== keep.id);
                if (toDrop.length) {
                    await ClinicMetaAsset.update({ isActive: false }, { where: { id: toDrop.map(a => a.id) } });
                    const { SocialStatsDaily, SocialPosts, SocialPostStatsDaily } = db;
                    for (const a of toDrop) {
                        try {
                            await SocialStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await SocialPostStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await SocialPosts.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await ClinicMetaAsset.destroy({ where: { id: a.id } });
                        } catch (e) {
                            console.warn('⚠️ Error limpiando datos IG duplicado', a.id, e.message);
                        }
                    }
                }
            }
        } catch (enfErr) {
            console.warn('⚠️ No se pudo forzar unicidad de Instagram por clínica:', enfErr.message);
        }

        // Enforce: solo 1 facebook_page activo por clínica
        try {
            const activeFB = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'facebook_page', isActive: true } });
            if (activeFB.length > 1) {
                const selectedFBIds = selectedAssets.filter((a) => a.type === 'facebook_page').map((a) => String(a.id));
                let keep = activeFB[0];
                if (selectedFBIds.length) keep = activeFB.find(a => selectedFBIds.includes(String(a.metaAssetId))) || activeFB[0];
                const toDrop = activeFB.filter(a => a.id !== keep.id);
                if (toDrop.length) {
                    await ClinicMetaAsset.update({ isActive: false }, { where: { id: toDrop.map(a => a.id) } });
                    const { SocialStatsDaily, SocialPosts, SocialPostStatsDaily } = db;
                    for (const a of toDrop) {
                        try {
                            await SocialStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await SocialPostStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await SocialPosts.destroy({ where: { clinica_id: clinicaId, asset_id: a.id } });
                            await ClinicMetaAsset.destroy({ where: { id: a.id } });
                        } catch (e) {
                            console.warn('⚠️ Error limpiando datos FB duplicado', a.id, e.message);
                        }
                    }
                }
            }
        } catch (enfErr) {
            console.warn('⚠️ No se pudo forzar unicidad de Facebook Page por clínica:', enfErr.message);
        }

        // Enforce: solo 1 ad_account activo por clínica
        try {
            const activeAD = await ClinicMetaAsset.findAll({ where: { clinicaId, assetType: 'ad_account', isActive: true } });
            if (activeAD.length > 1) {
                const selectedADIds = selectedAssets.filter((a) => a.type === 'ad_account').map((a) => String(a.id));
                let keep = activeAD[0];
                if (selectedADIds.length) keep = activeAD.find(a => selectedADIds.includes(String(a.metaAssetId))) || activeAD[0];
                const toDrop = activeAD.filter(a => a.id !== keep.id);
                if (toDrop.length) {
                    await ClinicMetaAsset.update({ isActive: false }, { where: { id: toDrop.map(a => a.id) } });
                    const { SocialAdsInsightsDaily, SocialAdsActionsDaily } = db;
                    for (const a of toDrop) {
                        try {
                            // Borrar datos de Ads vinculados al ad_account eliminado
                            await SocialAdsInsightsDaily.destroy({ where: { ad_account_id: a.metaAssetId } });
                            await SocialAdsActionsDaily.destroy({ where: { ad_account_id: a.metaAssetId } });
                            await ClinicMetaAsset.destroy({ where: { id: a.id } });
                        } catch (e) {
                            console.warn('⚠️ Error limpiando datos Ads duplicado', a.id, e.message);
                        }
                    }
                }
            }
        } catch (enfErr) {
            console.warn('⚠️ No se pudo forzar unicidad de Ad Account por clínica:', enfErr.message);
        }

        console.log(`✅ Mapeo actualizado para clínica ${clinicaId}: ${createdOrUpdated.length} activos activos, ${toDeactivate.length} inactivos (unicidad aplicada para IG/FB/Ads)`);

        const clinicIds = Array.from(clinicsToSync).filter((id) => Number.isInteger(id));
        if (clinicIds.length) {
            try {
                const job = await jobRequestsService.enqueueJobRequest({
                    type: 'meta_ads_recent',
                    payload: { clinicIds },
                    priority: 'critical',
                    origin: 'meta:map-assets',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error disparando resync de Meta Ads desde cola:', err.message)
                );
            } catch (queueError) {
                console.error('❌ Error encolando resync de Meta Ads tras map-assets:', queueError);
            }
        }

        // Disparar sincronización inicial SOLO del día actual (sin histórico)
        try {
            const { triggerInitialSync } = require('../controllers/metasync.controller');
            triggerInitialSync(clinicaId);
        } catch (err) {
            console.error('⚠️ No se pudo iniciar la sincronización inicial del día:', err);
        }

        res.status(200).json({
            message: 'Activos de Meta mapeados correctamente.',
            assets: createdOrUpdated,
            replacedMappings: false,
            totalActiveMappings: createdOrUpdated.length,
            totalDeactivated: toDeactivate.length
        });

    } catch (error) {
        console.error('Error al mapear activos de Meta:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error al mapear activos de Meta.', details: error.response ? error.response.data : error.message });
    }
});

/**
 * GET /oauth/test
 * Endpoint de prueba para verificar que las rutas OAuth están funcionando.
 */
router.get('/test', (req, res) => {
    res.json({
        message: '✅ El servicio OAuth está funcionando correctamente.',
        callback_url: REDIRECT_URI,
        frontend_redirect_url: FRONTEND_URL + '/pages/settings?connected=meta'
    });
});

/**
 * Función auxiliar para obtener el userId del token JWT
 */
const getUserIdFromToken = (req) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7); // Remover 'Bearer ' del inicio
            if (token) {
                // Usar la misma clave que se usa en auth.controllers.js ✅
                const decoded = jwt.verify(token, process.env.JWT_SECRET); // ✅ Usar variable de entorno
                console.log('🔍 Token JWT decodificado para connection-status:', decoded);
                return decoded.userId; // El campo correcto según auth.controllers.js
            }
        }
    } catch (error) {
        console.error("❌ Error decodificando JWT:", error);
    }
    return null;
};

/**
 * GET /oauth/meta/connection-status
 * Consulta el estado de conexión de Meta para el usuario logueado
 */
router.get('/meta/connection-status', async (req, res) => {
    try {
        console.log('🔍 Consultando estado de conexión Meta...');
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.json({
                connected: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Buscando conexión Meta para userId:', userId);
        
        // Buscar la conexión Meta en la base de datos
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });
        
        if (metaConnection) {
            console.log('✅ Conexión Meta encontrada:', {
                metaUserId: metaConnection.metaUserId,
                userName: metaConnection.userName,
                userEmail: metaConnection.userEmail
            });
            
            // Verificar si el token no ha expirado
            const now = new Date();
            const isExpired = metaConnection.expiresAt && metaConnection.expiresAt < now;
            
            if (isExpired) {
                console.log('⚠️ Token de Meta expirado');
                return res.json({
                    connected: false,
                    error: 'Token expirado'
                });
            }
            
            return res.json({
                connected: true,
                metaUserId: metaConnection.metaUserId,
                userName: metaConnection.userName,
                userEmail: metaConnection.userEmail,
                expiresAt: metaConnection.expiresAt
            });
        } else {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.json({
                connected: false
            });
        }
        
    } catch (error) {
        console.error('❌ Error consultando estado de conexión Meta:', error);
        res.status(500).json({
            connected: false,
            error: 'Error interno del servidor'
        });
    }
});

/**
 * GET /oauth/meta/mappings
 * Obtiene los mapeos de activos Meta existentes para el usuario logueado
 */
router.get('/meta/mappings', async (req, res) => {
    try {
        console.log('🔍 Obteniendo mapeos de activos Meta...');
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Buscando mapeos para userId:', userId);
        
        // Buscar la conexión Meta del usuario
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });
        
        if (!metaConnection) {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.json({
                success: false,
                error: 'Usuario no conectado a Meta'
            });
        }
        
        // ✅ CORREGIDO: Obtener todos los mapeos activos del usuario con nombres de columna correctos
        const mappings = await ClinicMetaAsset.findAll({
            where: {
                metaConnectionId: metaConnection.id,
                isActive: true
            },
            include: [
                {
                    model: db.Clinica,
                    as: 'clinica',
                    attributes: ['id_clinica', 'nombre_clinica', 'url_avatar'] // ✅ NOMBRES CORRECTOS
                }
            ],
            order: [['clinicaId', 'ASC'], ['assetType', 'ASC']]
        });
        
        // Agrupar mapeos por clínica
        const mappingsByClinica = {};
        
        mappings.forEach(mapping => {
            const clinicaId = mapping.clinicaId;
            
            if (!mappingsByClinica[clinicaId]) {
                mappingsByClinica[clinicaId] = {
                    clinica: {
                        id: mapping.clinica?.id_clinica || clinicaId, // ✅ CORREGIDO: id_clinica
                        nombre: mapping.clinica?.nombre_clinica || `Clínica ${clinicaId}`, // ✅ CORREGIDO: nombre_clinica
                        avatar_url: mapping.clinica?.url_avatar || null // ✅ CORREGIDO: url_avatar
                    },
                    assets: {
                        facebook_pages: [],
                        instagram_business: [],
                        ad_accounts: []
                    },
                    totalAssets: 0
                };
            }
            
            const assetData = {
                id: mapping.id,
                metaAssetId: mapping.metaAssetId,
                metaAssetName: mapping.metaAssetName,
                assetType: mapping.assetType,
                pageAccessToken: mapping.pageAccessToken,
                additionalData: mapping.additionalData,
                createdAt: mapping.createdAt,
                updatedAt: mapping.updatedAt
            };
            
            // Agregar a la categoría correspondiente
            switch (mapping.assetType) {
                case 'facebook_page':
                    mappingsByClinica[clinicaId].assets.facebook_pages.push(assetData);
                    break;
                case 'instagram_business':
                    mappingsByClinica[clinicaId].assets.instagram_business.push(assetData);
                    break;
                case 'ad_account':
                    mappingsByClinica[clinicaId].assets.ad_accounts.push(assetData);
                    break;
            }
            
            mappingsByClinica[clinicaId].totalAssets++;
        });
        
        // Convertir objeto a array
        const mappingsArray = Object.values(mappingsByClinica);
        
        console.log(`✅ Mapeos encontrados: ${mappings.length} activos en ${mappingsArray.length} clínicas`);
        
        res.json({
            success: true,
            mappings: mappingsArray,
            totalMappings: mappings.length,
            totalClinics: mappingsArray.length,
            userInfo: {
                metaUserId: metaConnection.metaUserId,
                userName: metaConnection.userName,
                userEmail: metaConnection.userEmail
            }
        });
        
    } catch (error) {
        console.error('❌ Error obteniendo mapeos de Meta:', error);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor',
            details: error.message
        });
    }
});

/**
 * DELETE /oauth/meta/mappings/:mappingId
 * Elimina un mapeo individual de activos Meta para el usuario logueado
 */
router.delete('/meta/mappings/:mappingId', async (req, res) => {
    const mappingId = Number.parseInt(req.params.mappingId, 10);
    if (!Number.isInteger(mappingId)) {
        return res.status(400).json({ success: false, error: 'mappingId inválido' });
    }

    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }

        const metaConnection = await MetaConnection.findOne({ where: { userId } });
        if (!metaConnection) {
            return res.status(404).json({ success: false, error: 'Usuario no conectado a Meta' });
        }

        const mapping = await ClinicMetaAsset.findOne({
            where: { id: mappingId, metaConnectionId: metaConnection.id }
        });

        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }

        const plain = mapping.get({ plain: true });
        const clinicaId = plain.clinicaId;
        const assetType = plain.assetType;
        const metaAssetId = plain.metaAssetId;

        const transaction = await db.sequelize.transaction();
        try {
            await GroupAssetClinicAssignment.destroy({
                where: {
                    assetId: mappingId,
                    assetType: assetType === 'ad_account'
                        ? 'meta.ad_account'
                        : assetType === 'instagram_business'
                            ? 'meta.instagram_business'
                            : 'meta.facebook_page'
                },
                transaction
            });

            await mapping.destroy({ transaction });
            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        try {
            if (assetType === 'instagram_business' || assetType === 'facebook_page') {
                await SocialStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: mappingId } });
                await SocialPostStatsDaily.destroy({ where: { clinica_id: clinicaId, asset_id: mappingId } });
                await SocialPosts.destroy({ where: { clinica_id: clinicaId, asset_id: mappingId } });
            } else if (assetType === 'ad_account') {
                await SocialAdsInsightsDaily.destroy({ where: { ad_account_id: metaAssetId } });
                await SocialAdsActionsDaily.destroy({ where: { ad_account_id: metaAssetId } });
            }
        } catch (cleanupErr) {
            console.warn('⚠️ Error limpiando datos asociados al mapeo Meta eliminado:', cleanupErr.message);
        }

        if (clinicaId) {
            try {
                const job = await jobRequestsService.enqueueJobRequest({
                    type: 'meta_ads_recent',
                    payload: { clinicIds: [clinicaId] },
                    priority: 'high',
                    origin: 'meta:delete-mapping',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error disparando resync tras eliminar mapeo Meta:', err.message)
                );
            } catch (queueErr) {
                console.error('⚠️ No se pudo encolar resync Meta Ads tras eliminar mapeo:', queueErr.message);
            }
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('❌ Error eliminando mapeo de Meta:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * DELETE /oauth/meta/disconnect
 * Elimina la conexión de Meta para el usuario logueado
 */
router.delete('/meta/disconnect', async (req, res) => {
    try {
        console.log('🗑️ Desconectando Meta...');
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Eliminando conexión Meta para userId:', userId);
        
        // Eliminar la conexión Meta de la base de datos
        const deletedRows = await MetaConnection.destroy({
            where: { userId: userId }
        });
        
        if (deletedRows > 0) {
            console.log('✅ Conexión Meta eliminada correctamente');
            return res.json({
                success: true,
                message: 'Conexión Meta desconectada correctamente'
            });
        } else {
            console.log('⚠️ No se encontró conexión Meta para eliminar');
            return res.json({
                success: false,
                error: 'No se encontró conexión Meta para este usuario'
            });
        }
        
    } catch (error) {
        console.error('❌ Error eliminando conexión Meta:', error);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

module.exports = router;



/**
 * GET /oauth/meta/mappings/:clinicaId
 * Obtiene los mapeos de activos Meta para una clínica específica
 */
router.get('/meta/mappings/:clinicaId', async (req, res) => {
    try {
        const { clinicaId } = req.params;
        console.log(`🔍 Obteniendo mapeos de Meta para clínica ${clinicaId}...`);
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log(`🔍 Buscando mapeos para userId: ${userId}, clinicaId: ${clinicaId}`);
        
        // Buscar conexión Meta del usuario
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });
        
        if (!metaConnection) {
            console.log('❌ Usuario no tiene conexión Meta activa');
            return res.status(404).json({
                success: false,
                error: 'Usuario no conectado a Meta'
            });
        }
        
        // Obtener mapeos específicos de la clínica
        const mappings = await ClinicMetaAsset.findAll({
            where: {
                metaConnectionId: metaConnection.id,
                clinicaId: parseInt(clinicaId),
                isActive: true
            },
            include: [
                {
                    model: db.Clinica,
                    as: 'clinica',
                    attributes: ['id_clinica', 'nombre_clinica', 'url_avatar']
                }
            ],
            order: [['assetType', 'ASC']]
        });
        
        if (mappings.length === 0) {
            console.log(`⚠️ No se encontraron mapeos para clínica ${clinicaId}`);
            return res.json({
                success: true,
                mappings: [],
                totalAssets: 0,
                clinica: null
            });
        }
        
        // Estructurar datos por tipo de activo
        const clinicaData = {
            id: mappings[0].clinica?.id_clinica || parseInt(clinicaId),
            nombre: mappings[0].clinica?.nombre_clinica || `Clínica ${clinicaId}`,
            avatar_url: mappings[0].clinica?.url_avatar || null
        };
        
        const assetsByType = {
            facebook_pages: [],
            instagram_business: [],
            ad_accounts: []
        };
        
        mappings.forEach(mapping => {
            const assetData = {
                id: mapping.id,
                metaAssetId: mapping.metaAssetId,
                metaAssetName: mapping.metaAssetName,
                assetType: mapping.assetType,
                assetAvatarUrl: mapping.assetAvatarUrl,
                pageAccessToken: mapping.pageAccessToken,
                additionalData: mapping.additionalData,
                createdAt: mapping.createdAt,
                // ✅ AÑADIDO: URL para usar como enlace
                assetUrl: generateAssetUrl(mapping.assetType, mapping.metaAssetId, mapping.additionalData)
            };
            
            switch (mapping.assetType) {
                case 'facebook_page':
                    assetsByType.facebook_pages.push(assetData);
                    break;
                case 'instagram_business':
                    assetsByType.instagram_business.push(assetData);
                    break;
                case 'ad_account':
                    assetsByType.ad_accounts.push(assetData);
                    break;
            }
        });
        
        console.log(`✅ Mapeos encontrados para clínica ${clinicaId}: ${mappings.length} activos`);
        
        res.json({
            success: true,
            mappings: assetsByType,
            totalAssets: mappings.length,
            clinica: clinicaData
        });
        
    } catch (error) {
        console.error(`❌ Error obteniendo mapeos para clínica ${req.params.clinicaId}:`, error);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor',
            details: error.message
        });
    }
});

/**
 * Generar URL directa para un activo Meta
 */
function generateAssetUrl(assetType, metaAssetId) {
    switch (assetType) {
        case 'facebook_page':
            return `https://facebook.com/${metaAssetId}`;
        case 'instagram_business':
            return `https://instagram.com/${metaAssetId}`;
        case 'ad_account':
            // ✅ CORREGIDO: URL correcta para Facebook Ads Manager
            return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${metaAssetId}`;
        default:
            return '#';
    }
}
