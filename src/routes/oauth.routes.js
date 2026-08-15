// backendclinicaclick/src/routes/oauth.routes.js
const express = require('express');
const axios = require('axios');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const { Op } = require('sequelize');
const db = require('../../models'); // <-- Importa el objeto db de models/index.js
const MetaConnection = db.MetaConnection; // <-- Accede al modelo MetaConnection
const GoogleConnection = db.GoogleConnection; // <-- Modelo GoogleConnection
const MetaConnectionAssignment = db.MetaConnectionAssignment;
const GoogleConnectionAssignment = db.GoogleConnectionAssignment;
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
const GrupoClinica = db.GrupoClinica;
const {
    googleAdsRequest,
    normalizeCustomerId,
    formatCustomerId,
    ensureGoogleAdsConfig,
    getGoogleAdsUsageStatus,
    resumeGoogleAdsUsage
} = require('../lib/googleAdsClient');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const {
    consumeOAuthState,
    issueOAuthState
} = require('../services/oauthState.service');
const {
    normalizeScope,
    buildSharedConnectionScope,
    findSingleUserConnection,
    upsertMetaAssignment,
    upsertGoogleAssignment,
    resolveMetaConnectionForScope,
    resolveGoogleConnectionForScope
} = require('../services/scopeConnectionResolver.service');
const {
    getAccessibleMarketingClinicIds,
    hasMarketingClinicScopeAccess
} = require('../lib/marketingScopeAccess');
const {
    accessibleProviderLocationsById,
    assertBusinessProfileConnectionCoherence,
    mergeBusinessProfileRawPayload,
    movedOriginClinicIds,
    normalizeBusinessProfileVerification,
    normalizeBusinessProfileLocationMappings,
    resolveAuthorizedDestinationGoogleConnection
} = require('../lib/businessProfileLocationMapping');
const {
    authorizeRequestedMarketingConnectionScope,
    marketingScopeInputFromRequest
} = require('../lib/oauthMarketingScopeAccess');
const {
    selectAuthorizedMetaAssets,
    withoutMetaAccessToken
} = require('../lib/metaAssetAuthorization');
const {
    assertSharedMarketingAssetMutationAccess
} = require('../lib/sharedMarketingAssetMutationAccess');
const { normalizeOAuthReturnTo } = require('../lib/oauthRedirect');
const { evaluateMetaConnectionHealth } = require('../lib/oauthConnectionHealth');
const {
    persistGoogleConnection,
    persistMetaConnection
} = require('../services/oauthConnectionPersistence.service');
const {
    deactivateGoogleMappingsForScope,
    deactivateMetaMappingsForScope
} = require('../services/oauthScopedDisconnect.service');
const {
    resolveEffectiveGoogleMappings
} = require('../services/effectiveMarketingAssets.service');
const {
    resolveClinicGoogleReviewProfile
} = require('../services/googleLocalLinks.service');
const {
    buildReviewProfileAliasConfiguration
} = require('../lib/reviewProfileAlias');

// Configuración de la App de Meta
const META_APP_ID = '1807844546609897'; // <-- App ID correcto
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const REDIRECT_URI = 'https://autenticacion.clinicaclick.com/oauth/meta/callback';
const FRONTEND_URL = 'https://app.clinicaclick.com';
const FRONTEND_DEV_URL = 'http://localhost:4200'; // Para desarrollo local
const FRONTEND_DEV_INTEGRATION_URL = 'http://localhost:4203';
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v24.0';
const META_BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.META_BM_ID || null;
const ALLOWED_FRONTEND_ORIGINS = new Set([
    FRONTEND_URL,
    'https://crm.clinicaclick.com',
    FRONTEND_DEV_URL,
    FRONTEND_DEV_INTEGRATION_URL
]);

function getMetaGraphError(error) {
    return error?.response?.data?.error || null;
}

function isMetaApplicationRateLimit(error) {
    const graphError = getMetaGraphError(error);
    return Number(graphError?.code) === 4
        && /application request limit reached/i.test(String(graphError?.message || ''));
}

function metaOAuthPublicErrorMessage(error) {
    if (isMetaApplicationRateLimit(error)) {
        return 'Meta ha limitado temporalmente la conexión por exceso de solicitudes. Espera unos minutos y vuelve a intentarlo.';
    }
    return 'Error en el proceso de autenticación.';
}

function metaOAuthErrorCode(error) {
    if (isMetaApplicationRateLimit(error)) {
        return 'meta_rate_limit';
    }
    return 'meta_oauth_failed';
}

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
    'https://www.googleapis.com/auth/adwords',
    'https://www.googleapis.com/auth/datamanager'
].join(' ');

const GOOGLE_SCOPES = (process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_GOOGLE_SCOPES).split(/\s+/).join(' ');
const GOOGLE_BUSINESS_INFORMATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GOOGLE_BUSINESS_ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const GOOGLE_BUSINESS_LOCATION_READ_MASK = [
    'name',
    'title',
    'storeCode',
    'phoneNumbers',
    'categories',
    'storefrontAddress',
    'latlng',
    'websiteUri',
    'metadata',
    'openInfo',
    'regularHours',
    'specialHours',
    'moreHours',
    'serviceArea',
    'serviceItems',
    'labels'
].join(',');

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

function normalizeFrontendReturnTo(candidate) {
    return normalizeOAuthReturnTo(candidate, {
        allowedOrigins: ALLOWED_FRONTEND_ORIGINS,
        fallback: FRONTEND_URL
    });
}

function buildFrontendSettingsRedirect(origin, query) {
    let target;
    try {
        target = new URL(normalizeFrontendReturnTo(origin));
    } catch (error) {
        target = new URL(FRONTEND_URL);
    }

    if (!target.pathname || target.pathname === '/') {
        target.pathname = '/pages/settings';
        target.search = '';
    }

    if (query) {
        const extraParams = new URLSearchParams(String(query).replace(/^\?/, ''));
        extraParams.forEach((value, key) => target.searchParams.set(key, value));
    }

    return target.toString();
}

function getScopeInputFromRequest(req) {
    return marketingScopeInputFromRequest(req);
}

function hasRequestedScope(req) {
    const { clinicIdRaw, groupIdRaw, assignmentScopeRaw } = getScopeInputFromRequest(req);
    return Boolean(clinicIdRaw || groupIdRaw || assignmentScopeRaw);
}

async function getClinicIdsForGroup(groupId) {
    if (!groupId) return [];
    const clinics = await Clinica.findAll({
        where: { grupoClinicaId: groupId },
        attributes: ['id_clinica'],
        raw: true
    });
    return clinics
        .map((clinic) => Number(clinic.id_clinica))
        .filter((id) => Number.isInteger(id));
}

function buildScopeResponse(scope, assignment) {
    return {
        assignment_scope: assignment?.assignmentScope || scope?.assignmentScope || null,
        clinic_id: assignment?.clinicaId || scope?.clinicId || null,
        group_id: assignment?.grupoClinicaId || scope?.groupId || null,
        scope_key: assignment?.scopeKey || scope?.scopeKey || null
    };
}

async function resolveGoogleRequestConnection(req, {
    allowLegacyUserFallback = true,
    scopeInput = null
} = {}) {
    const userId = getUserIdFromToken(req);
    const resolved = await resolveGoogleConnectionForScope({
        userId,
        ...(scopeInput || getScopeInputFromRequest(req)),
        allowLegacyUserFallback
    });
    return { userId, ...resolved };
}

async function resolveMetaRequestConnection(req, {
    allowLegacyUserFallback = true,
    scopeInput = null
} = {}) {
    const userId = getUserIdFromToken(req);
    const resolved = await resolveMetaConnectionForScope({
        userId,
        ...(scopeInput || getScopeInputFromRequest(req)),
        allowLegacyUserFallback
    });
    return { userId, ...resolved };
}

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
    let refreshError = null;
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
            refreshError = refreshErr;
            if (!allowExpired) {
                throw googleTokenError('REFRESH_FAILED', refreshErr.response?.data?.error_description || refreshErr.message || 'No se pudo refrescar el token');
            }
        }
    }

    if (!expiresAt) {
        if (refreshError) {
            throw googleTokenError(
                'REFRESH_FAILED',
                refreshError.response?.data?.error_description || refreshError.message || 'No se pudo refrescar el token'
            );
        }
        throw googleTokenError('TOKEN_EXPIRY_UNKNOWN', 'La conexión Google no tiene una expiración verificable');
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
        pageSize: 100,
        readMask: GOOGLE_BUSINESS_LOCATION_READ_MASK
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

async function fetchAccessibleGoogleBusinessLocations(connection) {
    const { accessToken } = await ensureGoogleAccessToken(connection);
    const accounts = await fetchAllGoogleBusinessAccounts(accessToken);
    const locations = [];
    for (const account of accounts) {
        const accountLocations = await fetchAllGoogleBusinessLocations(accessToken, account.name);
        locations.push(...accountLocations
            .map((location) => normalizeBusinessLocation(location, account))
            .filter(Boolean));
    }
    return locations;
}

function inaccessibleAssetError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.httpStatus = 400;
    return error;
}

async function loadAuthorizedSearchConsoleSites(connection) {
    const { accessToken } = await ensureGoogleAccessToken(connection);
    const response = await axios.get('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    return new Map((response.data?.siteEntry || [])
        .filter((site) => String(site?.siteUrl || '').trim())
        .map((site) => {
            const siteUrl = String(site.siteUrl).trim();
            return [siteUrl, {
                siteUrl,
                permissionLevel: site.permissionLevel || null,
                propertyType: siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix'
            }];
        }));
}

async function loadAuthorizedAnalyticsProperties(connection) {
    const { accessToken } = await ensureGoogleAccessToken(connection);
    const properties = new Map();
    let pageToken = null;
    do {
        const response = await axios.get('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
            params: { pageSize: 200, pageToken: pageToken || undefined },
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        for (const account of response.data?.accountSummaries || []) {
            for (const property of account.propertySummaries || []) {
                const propertyName = String(property?.property || '').trim();
                if (!propertyName) continue;
                properties.set(propertyName, {
                    propertyName,
                    propertyDisplayName: property.displayName || null,
                    propertyType: property.propertyType || null,
                    parent: property.parent || account.name || null,
                    measurementId: null
                });
            }
        }
        pageToken = response.data?.nextPageToken || null;
    } while (pageToken);
    return properties;
}

async function loadAuthorizedGoogleAdsAccounts(connection) {
    const { accessToken } = await ensureGoogleAdsAccess(connection);
    const queue = (await listAccessibleAdsCustomers(accessToken)).map((customerId) => ({ customerId, parentId: null }));
    const seen = new Set();
    const accounts = new Map();
    while (queue.length) {
        const { customerId, parentId } = queue.shift();
        const cleanId = normalizeCustomerId(customerId);
        if (!cleanId || seen.has(cleanId)) continue;
        seen.add(cleanId);
        let summary = null;
        try {
            summary = await fetchAdsCustomerSummary(accessToken, cleanId, { loginCustomerId: parentId || undefined });
        } catch (_) {
            continue;
        }
        const link = await fetchManagerLinkForCustomer(
            accessToken,
            cleanId,
            getGoogleManagerId(),
            { loginCustomerId: parentId || undefined }
        ).catch(() => null);
        const mainManagerId = normalizeCustomerId(getGoogleManagerId());
        accounts.set(cleanId, {
            customerId: cleanId,
            descriptiveName: summary?.descriptiveName || null,
            currencyCode: summary?.currencyCode || null,
            timeZone: summary?.timeZone || null,
            accountStatus: summary?.accountStatus || null,
            managerCustomerId: link?.managerCustomerId || null,
            loginCustomerId: link?.status === 'ACTIVE' ? mainManagerId : (parentId || null),
            managerLinkId: link?.managerLinkId || null,
            managerLinkStatus: link?.status || null,
            invitationStatus: link?.status === 'PENDING' ? 'PENDING' : null,
            linkedAt: link?.status === 'ACTIVE' ? new Date() : null
        });
        if (summary?.isManager) {
            const children = await fetchAdsCustomerClients(accessToken, cleanId).catch(() => []);
            for (const child of children) queue.push({ customerId: child.customerId, parentId: cleanId });
        }
    }
    return accounts;
}

async function fetchAllMetaPaginatedData(initialUrl, accessToken) {
    const allData = [];
    let nextUrl = initialUrl;
    let pageCount = 0;
    while (nextUrl && pageCount < 50) {
        pageCount += 1;
        const parsedNextUrl = new URL(String(nextUrl), META_API_BASE_URL);
        const allowedOrigin = new URL(META_API_BASE_URL).origin;
        if (parsedNextUrl.protocol !== 'https:' || parsedNextUrl.origin !== allowedOrigin) {
            throw inaccessibleAssetError(
                'meta_pagination_url_invalid',
                'Meta devolvió una URL de paginación fuera del dominio autorizado.'
            );
        }
        const response = await axios.get(parsedNextUrl.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (Array.isArray(response.data?.data)) allData.push(...response.data.data);
        nextUrl = response.data?.paging?.next || null;
    }
    if (nextUrl) throw new Error('Meta devolvió más páginas de activos de las permitidas.');
    return allData;
}

async function loadAuthorizedMetaAssets(metaConnection) {
    const pagesUrl = `${META_API_BASE_URL}/me/accounts?fields=id,name,picture.width(200).height(200),access_token,category,verification_status,followers_count,instagram_business_account{id,name,username,profile_picture_url,followers_count,media_count,biography}`;
    const adsUrl = `${META_API_BASE_URL}/me/adaccounts?fields=id,name,account_status,currency,timezone_name,business_name`;
    const [pages, adAccounts] = await Promise.all([
        fetchAllMetaPaginatedData(pagesUrl, metaConnection.accessToken),
        fetchAllMetaPaginatedData(adsUrl, metaConnection.accessToken)
    ]);

    const facebookPages = pages.map((page) => ({
        id: String(page.id),
        name: page.name || null,
        type: 'facebook_page',
        assetAvatarUrl: page.picture?.data?.url || null,
        pageAccessToken: page.access_token || null,
        additionalData: {
            category: page.category || null,
            verification_status: page.verification_status || null,
            followers_count: page.followers_count || 0
        }
    }));
    const instagramBusinessAccounts = pages
        .filter((page) => page.instagram_business_account?.id)
        .map((page) => {
            const account = page.instagram_business_account;
            return {
                id: String(account.id),
                name: account.name || account.username || null,
                username: account.username || null,
                type: 'instagram_business',
                assetAvatarUrl: account.profile_picture_url || null,
                linked_facebook_page: String(page.id),
                pageAccessToken: null,
                additionalData: {
                    followers_count: account.followers_count || 0,
                    media_count: account.media_count || 0,
                    biography: account.biography || null,
                    username: account.username || null
                }
            };
        });
    const ads = adAccounts.map((account) => ({
        id: String(account.id),
        name: account.name || null,
        type: 'ad_account',
        assetAvatarUrl: null,
        pageAccessToken: null,
        additionalData: {
            account_status: account.account_status || null,
            currency: account.currency || null,
            timezone_name: account.timezone_name || null,
            business_name: account.business_name || null
        }
    }));
    return {
        facebook_pages: facebookPages,
        instagram_business: instagramBusinessAccounts,
        ad_accounts: ads,
        all: [...facebookPages, ...instagramBusinessAccounts, ...ads]
    };
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
    const primaryCategory = location.primaryCategory?.displayName
        || location.primaryCategory?.name
        || location.categories?.primaryCategory?.displayName
        || location.categories?.primaryCategory?.name
        || null;
    const verification = normalizeBusinessProfileVerification(location.metadata);
    const verificationStatus = verification.verificationStatus;
    const suspended = Array.isArray(location.metadata?.suspensionReasons) && location.metadata.suspensionReasons.length > 0;
    const verified = verification.isVerified;
    const address = location.address || location.storefrontAddress || null;
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
        regularHours: location.regularHours || null,
        specialHours: location.specialHours || null,
        moreHours: location.moreHours || null,
        serviceArea: location.serviceArea || null,
        labels: location.labels || null,
        rawLocation: location
    };
}

async function authorizeExplicitConnectionScope(req, access = 'read') {
    const userId = getUserIdFromToken(req);
    if (!userId) {
        const error = new Error('Usuario no autenticado');
        error.code = 'unauthenticated';
        error.httpStatus = 401;
        throw error;
    }
    const scopeInput = getScopeInputFromRequest(req);
    return authorizeRequestedMarketingConnectionScope({
        userId,
        ...scopeInput,
        access,
        findClinicGroupId: async (clinicId) => {
            const clinic = await Clinica.findByPk(clinicId, {
                attributes: ['grupoClinicaId'],
                raw: true
            });
            return clinic?.grupoClinicaId || null;
        },
        findGroupClinicIds: getClinicIdsForGroup,
        authorizeClinicIds: hasMarketingClinicScopeAccess
    });
}

async function authorizeStoredOAuthState(oauthState) {
    return authorizeRequestedMarketingConnectionScope({
        userId: oauthState.userId,
        clinicIdRaw: oauthState.clinicId,
        groupIdRaw: oauthState.groupId,
        assignmentScopeRaw: oauthState.assignmentScope,
        access: 'write',
        findClinicGroupId: async (clinicId) => {
            const clinic = await Clinica.findByPk(clinicId, {
                attributes: ['grupoClinicaId'],
                raw: true
            });
            return clinic?.grupoClinicaId || null;
        },
        findGroupClinicIds: getClinicIdsForGroup,
        authorizeClinicIds: hasMarketingClinicScopeAccess
    });
}

function clinicIdsFromAssetMappings(mappings) {
    return Array.from(new Set((Array.isArray(mappings) ? mappings : [])
        .map((mapping) => Number.parseInt(String(mapping?.clinicaId ?? ''), 10))
        .filter((clinicId) => Number.isInteger(clinicId) && clinicId > 0)));
}

async function requireAssetMappingClinicAccess(res, userId, mappings, access = 'write') {
    const clinicIds = clinicIdsFromAssetMappings(mappings);
    if (!clinicIds.length) {
        res.status(400).json({
            success: false,
            error: 'asset_mapping_clinic_required',
            message: 'Debes indicar al menos una clínica válida.'
        });
        return null;
    }
    const allowed = await hasMarketingClinicScopeAccess({ userId, clinicIds, access });
    if (!allowed) {
        res.status(403).json({
            success: false,
            error: access === 'write' ? 'asset_mapping_scope_write_forbidden' : 'asset_mapping_scope_forbidden',
            message: 'No tienes permisos sobre todas las clínicas solicitadas.'
        });
        return null;
    }
    return clinicIds;
}

async function filterReadableClinicMappings(req, userId, rows, clinicIdOf) {
    const candidates = Array.from(new Set((Array.isArray(rows) ? rows : [])
        .map((row) => Number.parseInt(String(clinicIdOf(row) ?? ''), 10))
        .filter((clinicId) => Number.isInteger(clinicId) && clinicId > 0)));
    if (!candidates.length) return [];

    const explicitScopeClinicIds = req.marketingConnectionScopeAuthorization?.requested
        ? req.marketingConnectionScopeAuthorization.clinicIds
        : null;
    const allowedClinicIds = explicitScopeClinicIds || await getAccessibleMarketingClinicIds({
        userId,
        clinicIds: candidates,
        access: 'read'
    });
    const allowed = new Set(allowedClinicIds.map(Number));
    return rows.filter((row) => allowed.has(Number(clinicIdOf(row))));
}

async function requireSingleMappingClinicWrite(res, userId, clinicId) {
    const allowed = await hasMarketingClinicScopeAccess({
        userId,
        clinicIds: [clinicId],
        access: 'write'
    });
    if (!allowed) {
        res.status(403).json({
            success: false,
            error: 'asset_mapping_scope_write_forbidden',
            message: 'No tienes permisos para eliminar este mapeo.'
        });
        return false;
    }
    return true;
}

function sendKnownOAuthMappingError(res, error) {
    const status = Number(error?.httpStatus || 0);
    if (![400, 403, 404, 409].includes(status)) return false;
    res.status(status).json({
        success: false,
        error: error?.code || 'asset_mapping_failed',
        message: error?.message || 'No se pudo completar el mapeo.'
    });
    return true;
}

const PROVIDER_INVENTORY_PATHS = new Set([
    '/google/assets',
    '/google/analytics/properties',
    '/google/local/locations',
    '/google/ads/accounts',
    '/meta/assets'
]);
const EXPLICIT_SCOPE_REQUIRED_PATHS = new Set([
    ...PROVIDER_INVENTORY_PATHS,
    '/google/effective-mappings',
    '/google/connect',
    '/meta/connect',
    '/google/ads/request-link',
    '/google/ads/accept-link'
]);
const PUBLIC_OAUTH_PATHS = new Set([
    '/google/callback',
    '/meta/callback',
    '/test'
]);

// Los callbacks se autentican con state opaco de un solo uso. El resto de la
// superficie usa el middleware JWT canónico, incluido el bloqueo de usuarios
// revocados, antes de consultar grants o mappings centrales.
router.use((req, res, next) => {
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';
    if (PUBLIC_OAUTH_PATHS.has(normalizedPath)) return next();
    return authMiddleware(req, res, next);
});

// Toda lectura o mutación scope-aware pasa por este guard antes de que los
// resolvers puedan consultar, promover o crear assignments de conexión.
router.use(async (req, res, next) => {
    if (!req.path.startsWith('/google/') && !req.path.startsWith('/meta/')) {
        return next();
    }
    const normalizedPath = req.path.replace(/\/+$/, '') || '/';
    const providerInventory = PROVIDER_INVENTORY_PATHS.has(normalizedPath);
    const explicitScopeRequired = EXPLICIT_SCOPE_REQUIRED_PATHS.has(normalizedPath);
    if (!hasRequestedScope(req)) {
        if (explicitScopeRequired) {
            return res.status(400).json({
                success: false,
                error: 'marketing_connection_scope_required',
                message: 'Debes indicar la clínica o grupo donde se gestionará esta conexión.'
            });
        }
        return next();
    }

    const isConnectionMutation = providerInventory
        || req.method !== 'GET'
        || /\/(?:connect|disconnect)$/.test(normalizedPath);
    try {
        req.marketingConnectionScopeAuthorization = await authorizeExplicitConnectionScope(
            req,
            isConnectionMutation ? 'write' : 'read'
        );
        return next();
    } catch (error) {
        const status = Number(error?.httpStatus || 500);
        if (status >= 500) {
            console.error('❌ Error autorizando scope de conexión:', error);
        }
        return res.status(status >= 400 && status < 500 ? status : 500).json({
            success: false,
            error: error?.code || 'marketing_connection_scope_authorization_failed',
            message: error?.message || 'No se pudo autorizar el scope solicitado.'
        });
    }
});

/**
 * Inventario efectivo Google del scope solicitado.
 *
 * Es una proyección DB-only y de solo lectura: no consulta APIs de Google, no
 * crea assignments y no sustituye a los endpoints `mappings` editables.
 */
router.get('/google/effective-mappings', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
        const effective = await resolveEffectiveGoogleMappings(getScopeInputFromRequest(req));
        return res.json({ success: true, ...effective });
    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
        console.error('❌ Error en /oauth/google/effective-mappings:', error.message);
        return res.status(500).json({
            success: false,
            error: 'effective_google_mappings_failed',
            message: 'No se pudieron cargar los activos Google efectivos.'
        });
    }
});

/**
 * GET /oauth/meta/connect
 * Devuelve la URL de autorización para iniciar el flujo OAuth de Meta.
 */
router.get('/meta/connect', async (req, res) => {
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        if (!META_APP_SECRET) {
            return res.status(503).json({ success: false, error: 'meta_oauth_not_configured' });
        }

        const returnTo = normalizeFrontendReturnTo(req.query?.return_to || null);
        const requestedScope = getScopeInputFromRequest(req);
        const state = await issueOAuthState({
            provider: 'meta',
            userId,
            returnTo,
            clinicId: requestedScope.clinicIdRaw,
            groupId: requestedScope.groupIdRaw,
            assignmentScope: requestedScope.assignmentScopeRaw
        });
        const scope = [
            'public_profile',
            'pages_read_engagement',
            'pages_show_list',
            'pages_manage_ads',
            'pages_manage_metadata',
            'ads_read',
            'leads_retrieval',
            'instagram_basic',
            'instagram_manage_insights'
        ].join(',');

        const authUrl =
            `https://www.facebook.com/v24.0/dialog/oauth?client_id=${META_APP_ID}` +
            `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
            `&scope=${encodeURIComponent(scope)}` +
            `&response_type=code` +
            `&state=${encodeURIComponent(state)}`;

        return res.json({ success: true, authUrl });
    } catch (e) {
        console.error('❌ Error generando authUrl de Meta:', e.message);
        return res.status(500).json({ success: false, error: 'No se pudo generar authUrl' });
    }
});

/**
 * GET /oauth/meta/callback
 * Maneja el callback de la autorización de Meta (Facebook).
 */
router.get('/meta/callback', async (req, res) => {
    const { code, state, error, error_reason, error_description } = req.query;
    let oauthState;
    let frontendOrigin = FRONTEND_URL;

    try {
        oauthState = await consumeOAuthState('meta', state);
        frontendOrigin = normalizeFrontendReturnTo(oauthState.returnTo);
        await authorizeStoredOAuthState(oauthState);
    } catch (stateError) {
        console.error('❌ State OAuth Meta rechazado:', stateError.code || stateError.message);
        return res.redirect(buildFrontendSettingsRedirect(
            frontendOrigin,
            `?error=${encodeURIComponent('La autorización ha caducado o ya no es válida. Vuelve a iniciarla.')}`
        ));
    }

    console.log('➡️  Callback de Meta recibido.');

    if (error) {
        console.error('❌ Error en el callback de Meta:', { error, error_reason, error_description });
        return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent(error_description || error)}`));
    }

    if (!code) {
        console.error('❌ No se recibió el código de autorización.');
        return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent('No se recibió el código de autorización.')}`));
    }

    console.log('✅ Código de autorización Meta recibido.');

    try {
        if (!META_APP_SECRET) throw new Error('Meta OAuth no está configurado');
        // 1. Intercambiar el código por un Access Token de CORTA DURACIÓN
        console.log('🔄  Intercambiando código por Access Token de corta duración...');
        const tokenUrl = `${META_API_BASE_URL}/oauth/access_token`;
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
        console.log('✅ Access Token de corta duración obtenido.');

        // 2. Intercambiar el Access Token de CORTA DURACIÓN por uno de LARGA DURACIÓN
        console.log('🔄  Intercambiando por Access Token de LARGA DURACIÓN...');
        const longLivedTokenUrl = `${META_API_BASE_URL}/oauth/access_token`;
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
        console.log('✅ Access Token de larga duración obtenido.');

        // 3. Obtener información básica del usuario de Meta
        console.log('👤 Obteniendo información del usuario de Meta...');
        const userProfileUrl = `${META_API_BASE_URL.replace(/\/v\d+\.\d+$/, '')}/me?fields=id,name,email&access_token=${longLivedAccessToken}`;
        const userProfileResponse = await axios.get(userProfileUrl);
        const userData = userProfileResponse.data;
        console.log('👤 Usuario de Meta autenticado:', userData);

        // 4. Almacenar el token de larga duración en la base de datos
        console.log('💾 Almacenando conexión Meta en la base de datos...');
        
        // ARQUITECTURA CORREGIDA:
        // - userId = ID del usuario en la aplicación (obtenido del state parameter)
        // - metaUserId = ID del usuario en Meta (userData.id)
        
        // Obtener el userId del parámetro state que viene del frontend
        const userId = oauthState.userId;
        const metaUserId = userData.id; // ID del usuario de Meta
        
        console.log('🔍 userId (aplicación):', userId);
        console.log('🔍 metaUserId (Meta):', metaUserId);
        
        if (!userId) {
            console.error('❌ No se pudo obtener el userId del parámetro state');
            return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent('No se pudo identificar al usuario logueado. Por favor, inicie sesión en la aplicación antes de conectar Meta.')}`));
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

        const storedConnection = await persistMetaConnection({
            userId: userId, // ID del usuario de la aplicación
            metaUserId: metaUserId, // ID del usuario de Meta
            userName: userData.name,
            userEmail: userData.email,
            accessToken: longLivedAccessToken,
            expiresAt: expiresAt,
        });
        console.log('✅ Conexión Meta almacenada/actualizada en la base de datos.');

        const scope = await normalizeScope({
            clinicIdRaw: oauthState.clinicId,
            groupIdRaw: oauthState.groupId,
            assignmentScopeRaw: oauthState.assignmentScope
        });
        const connectionScope = buildSharedConnectionScope(scope);
        if (storedConnection && connectionScope?.scopeKey) {
            await upsertMetaAssignment({
                connection: storedConnection,
                scope: connectionScope,
                authorizedByUserId: userId
            });
        }

        // 5. Redirigir de vuelta al frontend con un indicador de éxito
        const redirectUrl = buildFrontendSettingsRedirect(frontendOrigin, `?connected=meta&metaUserId=${userData.id}`);
        console.log(`🚀 Redirigiendo al frontend: ${redirectUrl}`);
        res.redirect(redirectUrl);

    } catch (err) {
        console.error('❌ Error fatal en el proceso de OAuth:', err.response ? err.response.data : err.message);
        const publicMessage = metaOAuthPublicErrorMessage(err);
        const publicCode = metaOAuthErrorCode(err);
        res.redirect(buildFrontendSettingsRedirect(
            frontendOrigin,
            `?error=${encodeURIComponent(publicMessage)}&error_code=${encodeURIComponent(publicCode)}`
        ));
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
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            return res.status(503).json({ success: false, error: 'google_oauth_not_configured' });
        }
        const returnTo = normalizeFrontendReturnTo(req.query?.return_to || null);
        const requestedScope = getScopeInputFromRequest(req);
        const state = await issueOAuthState({
            provider: 'google',
            userId,
            returnTo,
            clinicId: requestedScope.clinicIdRaw,
            groupId: requestedScope.groupIdRaw,
            assignmentScope: requestedScope.assignmentScopeRaw
        });

        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: GOOGLE_REDIRECT_URI,
            response_type: 'code',
            scope: GOOGLE_SCOPES,
            access_type: 'offline',
            include_granted_scopes: 'true',
            prompt: 'consent',
            state
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
    let frontendOrigin = FRONTEND_URL;
    try {
        const { code, state, error } = req.query;
        const oauthState = await consumeOAuthState('google', state);
        frontendOrigin = normalizeFrontendReturnTo(oauthState.returnTo);
        await authorizeStoredOAuthState(oauthState);
        if (error) {
            console.error('❌ Error en callback Google:', error);
            return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent(String(error))}`));
        }
        if (!code) {
            return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent('Código no proporcionado')}`));
        }
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            throw new Error('Google OAuth no está configurado');
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
        const googleUserId = String(ui.data?.id || '').trim();
        if (!googleUserId) throw new Error('Google no devolvió una identidad de usuario válida');
        const userEmail = ui.data?.email || null;
        const userName = ui.data?.name || [ui.data?.given_name, ui.data?.family_name].filter(Boolean).join(' ') || null;

        // 3) Guardar/actualizar conexión
        const userId = String(oauthState.userId || '').trim();
        if (!userId) {
            console.warn('⚠️ state vacío en callback Google');
        }
        const storedConnection = await persistGoogleConnection({
            userId,
            googleUserId,
            userEmail,
            userName,
            accessToken,
            refreshToken,
            scopes: tokenResp.data?.scope || GOOGLE_SCOPES,
            expiresAt
        });
        const scope = await normalizeScope({
            clinicIdRaw: oauthState.clinicId,
            groupIdRaw: oauthState.groupId,
            assignmentScopeRaw: oauthState.assignmentScope
        });
        const connectionScope = buildSharedConnectionScope(scope);
        if (storedConnection && connectionScope?.scopeKey) {
            await upsertGoogleAssignment({
                connection: storedConnection,
                scope: connectionScope,
                authorizedByUserId: userId
            });
        }

        // 4) Redirigir al frontend
        return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?connected=google&googleUserId=${googleUserId}`));
    } catch (err) {
        console.error('❌ Error en /oauth/google/callback:', err.response?.data || err.message);
        return res.redirect(buildFrontendSettingsRedirect(frontendOrigin, `?error=${encodeURIComponent('Error en autenticación de Google')}`));
    }
});

/**
 * GOOGLE — Connection status
 * GET /oauth/google/connection-status
 */
router.get('/google/connection-status', async (req, res) => {
    try {
        const scopedRequest = hasRequestedScope(req);
        const { userId, connection: conn, assignment, scope, source } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: !scopedRequest
        });
        if (!userId) return res.status(401).json({ connected: false, message: 'Usuario no autenticado' });
        if (!conn) {
            return res.json({
                connected: false,
                reason: source === 'legacy_user_ambiguous' ? 'connection_scope_required' : null,
                source
            });
        }

        let tokenInfo;
        try {
            tokenInfo = await ensureGoogleAccessToken(conn, { allowExpired: true });
        } catch (tokenError) {
            if (['TOKEN_EXPIRY_UNKNOWN', 'REFRESH_FAILED', 'TOKEN_EXPIRED'].includes(tokenError.code)) {
                return res.json({
                    connected: false,
                    expired: tokenError.code === 'TOKEN_EXPIRED',
                    reason: tokenError.code.toLowerCase(),
                    reauthorizationRequired: true,
                    scope: buildScopeResponse(scope, assignment),
                    source
                });
            }
            throw tokenError;
        }

        return res.json({
            connected: !tokenInfo.expired,
            userEmail: conn.userEmail,
            googleUserId: conn.googleUserId,
            userName: conn.userName || null,
            authorizedByUserId: assignment?.authorizedByUserId || conn.userId || null,
            authorizedByName: assignment?.authorizedByName || conn.userName || null,
            authorizedByEmail: assignment?.authorizedByEmail || conn.userEmail || null,
            expiresAt: conn.expiresAt,
            scopes: conn.scopes,
            expired: tokenInfo.expired,
            scope: buildScopeResponse(scope, assignment),
            source
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
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
        const { userId, connection: conn, assignment, scope, source } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) return res.status(401).json({ connected: false, reason: 'unauthenticated' });
        if (!conn) return res.json({ connected: false, reason: 'no_connection' });

        let accessToken;
        try {
            ({ accessToken } = await ensureGoogleAccessToken(conn));
        } catch (tokenErr) {
            if (['TOKEN_EXPIRED', 'TOKEN_EXPIRY_UNKNOWN', 'REFRESH_FAILED'].includes(tokenErr.code)) {
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
                expiresAt: conn.expiresAt,
                scope: buildScopeResponse(scope, assignment),
                source
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
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
        const requestedMappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!requestedMappings.length) return res.status(400).json({ success: false, error: 'mappings requerido' });
        if (requestedMappings.some((mapping) => (
            !Number.isInteger(Number.parseInt(String(mapping?.clinicaId ?? ''), 10))
            || Number.parseInt(String(mapping?.clinicaId ?? ''), 10) <= 0
            || !String(mapping?.propertyName || '').trim()
        ))) {
            throw inaccessibleAssetError('analytics_mapping_invalid', 'Todos los mapeos de Analytics deben indicar una clínica y una propiedad válidas.');
        }
        const mappings = Array.from(new Map(requestedMappings.map((mapping) => [
            `${Number.parseInt(String(mapping.clinicaId), 10)}|${String(mapping.propertyName).trim()}`,
            mapping
        ])).values());
        const { connection: conn } = await resolveAuthorizedDestinationGoogleConnection({
            userId,
            mappings,
            authorizeDestinations: hasMarketingClinicScopeAccess,
            resolveForClinic: (clinicId) => resolveGoogleRequestConnection(req, {
                allowLegacyUserFallback: true,
                scopeInput: { clinicIdRaw: clinicId, groupIdRaw: null, assignmentScopeRaw: 'clinic' }
            })
        });
        const authorizedProperties = await loadAuthorizedAnalyticsProperties(conn);
        for (const mapping of mappings) {
            const propertyName = String(mapping?.propertyName || '').trim();
            if (!propertyName || !authorizedProperties.has(propertyName)) {
                throw inaccessibleAssetError(
                    'analytics_property_not_accessible',
                    'Alguna propiedad de Analytics no pertenece a la conexión Google autorizada.'
                );
            }
        }

        const createdOrUpdated = [];
        const propertiesToBackfill = [];
        const replaceExisting = req.body?.replace_existing === true;
        const selectedByClinic = new Map();
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const propertyName = String(m.propertyName || '').trim();
            if (!clinicaId || !propertyName) continue;
            if (!selectedByClinic.has(clinicaId)) selectedByClinic.set(clinicaId, new Set());
            selectedByClinic.get(clinicaId).add(propertyName);
        }
        const existingByClinicProperty = new Map();
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const propertyName = String(m.propertyName || '').trim();
            const existing = await ClinicAnalyticsProperty.findOne({ where: { clinicaId, propertyName } });
            if (!existing) continue;
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: 'google.analytics',
                assetId: existing.id,
                ownerClinicId: existing.clinicaId
            });
            existingByClinicProperty.set(`${clinicaId}|${propertyName}`, existing);
        }

        if (replaceExisting) {
            const recordsToDeactivate = [];
            for (const [clinicaId, propertyNames] of selectedByClinic.entries()) {
                recordsToDeactivate.push(...await ClinicAnalyticsProperty.findAll({
                    where: {
                        clinicaId,
                        isActive: true,
                        propertyName: { [Op.notIn]: Array.from(propertyNames) }
                    }
                }));
            }
            for (const record of recordsToDeactivate) {
                await assertSharedMarketingAssetMutationAccess({
                    userId,
                    assetType: 'google.analytics',
                    assetId: record.id,
                    ownerClinicId: record.clinicaId
                });
            }
            if (recordsToDeactivate.length) {
                await ClinicAnalyticsProperty.update(
                    { isActive: false },
                    { where: { id: { [Op.in]: recordsToDeactivate.map((record) => record.id) } } }
                );
            }
        }

        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const propertyName = String(m.propertyName || '').trim();
            if (!clinicaId || !propertyName) continue;
            const providerProperty = authorizedProperties.get(propertyName);

            const payload = {
                clinicaId,
                googleConnectionId: conn.id,
                propertyName,
                propertyDisplayName: providerProperty.propertyDisplayName,
                propertyType: providerProperty.propertyType,
                parent: providerProperty.parent,
                measurementId: providerProperty.measurementId,
                isActive: true
            };

            const existing = existingByClinicProperty.get(`${clinicaId}|${propertyName}`) || null;
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
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'analytics_backfill_properties',
                    payload: withRequestedRuntimeNamespace(req, { mappings: propertiesToBackfill }),
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
        if (sendKnownOAuthMappingError(res, e)) return;
        console.error('❌ Error en /oauth/google/analytics/map-properties:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error mapeando propiedades' });
    }
});

/**
 * GOOGLE — Listar ubicaciones de Google Business Profile accesibles
 */
router.get('/google/local/locations', async (req, res) => {
    try {
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
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
                try {
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
                } catch (accountErr) {
                    const status = accountErr.response?.status;
                    if (status === 403) {
                        throw accountErr;
                    }
                    console.warn('⚠️ Cuenta Google Business omitida al listar ubicaciones:', {
                        accountName: account?.name,
                        status,
                        error: accountErr.response?.data || accountErr.message
                    });
                }
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

        const mappings = normalizeBusinessProfileLocationMappings(req.body?.mappings);
        const mappingPurpose = cleanString(req.body?.mapping_purpose || req.body?.mappingPurpose)?.toLowerCase();

        if (mappingPurpose === 'reviews') {
            const destinationClinicIds = Array.from(new Set(
                mappings.map((mapping) => Number(mapping.clinicaId)).filter(Boolean)
            ));
            if (destinationClinicIds.length !== 1 || mappings.length !== 1) {
                const error = new Error('Selecciona una sola clinica y una sola ficha para las resenas.');
                error.code = 'review_profile_single_mapping_required';
                error.httpStatus = 400;
                throw error;
            }
            const canWriteTarget = await hasMarketingClinicScopeAccess({
                userId,
                clinicIds: destinationClinicIds,
                access: 'write'
            });
            if (!canWriteTarget) {
                const error = new Error('No tienes permisos para cambiar el destino de resenas de esta clinica.');
                error.code = 'review_profile_target_scope_forbidden';
                error.httpStatus = 403;
                throw error;
            }

            const mapping = mappings[0];
            const savedAlias = await db.sequelize.transaction(async (transaction) => {
                const location = await ClinicBusinessLocation.findOne({
                    where: {
                        location_id: mapping.locationId,
                        is_active: true
                    },
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });
                if (!location) {
                    const error = new Error(
                        'Esta ficha debe estar conectada primero a su clinica real antes de compartirla para resenas.'
                    );
                    error.code = 'review_profile_source_not_mapped';
                    error.httpStatus = 409;
                    throw error;
                }

                const targetClinic = await Clinica.findByPk(mapping.clinicaId, {
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });
                const sourceClinic = await Clinica.findByPk(location.clinica_id, {
                    transaction
                });
                if (!targetClinic || !sourceClinic) {
                    const error = new Error('No se ha encontrado la clinica asociada a la ficha.');
                    error.code = 'review_profile_clinic_not_found';
                    error.httpStatus = 404;
                    throw error;
                }

                const targetGroupId = Number(targetClinic.grupoClinicaId || targetClinic.grupo_clinica_id || 0);
                const sourceGroupId = Number(sourceClinic.grupoClinicaId || sourceClinic.grupo_clinica_id || 0);
                if (
                    Number(targetClinic.id_clinica) !== Number(sourceClinic.id_clinica)
                    && (!targetGroupId || targetGroupId !== sourceGroupId)
                ) {
                    const error = new Error('Solo puedes compartir fichas entre clinicas del mismo grupo.');
                    error.code = 'review_profile_group_scope_forbidden';
                    error.httpStatus = 403;
                    throw error;
                }

                const canReadSource = await hasMarketingClinicScopeAccess({
                    userId,
                    clinicIds: [Number(sourceClinic.id_clinica)],
                    access: 'read'
                });
                if (!canReadSource) {
                    const error = new Error('No tienes acceso a la clinica propietaria de esta ficha.');
                    error.code = 'review_profile_source_scope_forbidden';
                    error.httpStatus = 403;
                    throw error;
                }

                const configuracion = buildReviewProfileAliasConfiguration(
                    targetClinic.configuracion,
                    {
                        targetClinicId: targetClinic.id_clinica,
                        sourceClinicId: sourceClinic.id_clinica,
                        sourceClinicName: sourceClinic.nombre_clinica,
                        businessLocationId: location.id,
                        locationId: location.location_id
                    }
                );
                await targetClinic.update({ configuracion }, { transaction });

                return {
                    id: location.id,
                    clinicaId: Number(targetClinic.id_clinica),
                    sourceClinicaId: Number(sourceClinic.id_clinica),
                    locationId: location.location_id,
                    locationName: location.location_name,
                    alias: Number(targetClinic.id_clinica) !== Number(sourceClinic.id_clinica)
                };
            });

            return res.json({
                success: true,
                mapped: 1,
                review_alias: true,
                locations: [savedAlias]
            });
        }

        const { connection: conn, destinationClinicIds } = await resolveAuthorizedDestinationGoogleConnection({
            userId,
            mappings,
            authorizeDestinations: hasMarketingClinicScopeAccess,
            resolveForClinic: (clinicId) => resolveGoogleRequestConnection(req, {
                allowLegacyUserFallback: true,
                scopeInput: {
                    clinicIdRaw: clinicId,
                    groupIdRaw: null,
                    assignmentScopeRaw: 'clinic'
                }
            })
        });
        const providerLocationsById = accessibleProviderLocationsById(
            mappings,
            await fetchAccessibleGoogleBusinessLocations(conn)
        );
        const createdOrUpdated = [];
        const locationsToBackfill = [];
        const replaceExisting = req.body?.replace_existing === true;
        const selectedByClinic = new Map();
        for (const mapping of mappings) {
            const { clinicaId, locationId } = mapping;
            if (!selectedByClinic.has(clinicaId)) selectedByClinic.set(clinicaId, new Set());
            selectedByClinic.get(clinicaId).add(locationId);
        }

        await db.sequelize.transaction(async (transaction) => {
            const requestedLocationIds = mappings.map((mapping) => mapping.locationId);
            const affectedWhere = replaceExisting
                ? {
                    [Op.or]: [
                        { location_id: { [Op.in]: requestedLocationIds } },
                        { clinica_id: { [Op.in]: destinationClinicIds }, is_active: true }
                    ]
                }
                : { location_id: { [Op.in]: requestedLocationIds } };
            // Bloqueamos en un solo orden estable tanto las fichas solicitadas como
            // las que replace_existing podría desactivar. Así no existe una ventana
            // entre la comprobación del origen y la mutación, y reducimos deadlocks
            // entre dos guardados simultáneos de una misma clínica.
            const affectedRecords = await ClinicBusinessLocation.findAll({
                where: affectedWhere,
                transaction,
                lock: transaction.LOCK.UPDATE,
                order: [['id', 'ASC']]
            });
            const existingByLocation = new Map(
                affectedRecords
                    .filter((record) => requestedLocationIds.includes(String(record.location_id)))
                    .map((record) => [String(record.location_id), record])
            );
            const originClinicIds = movedOriginClinicIds(affectedRecords, mappings);

            if (originClinicIds.length) {
                const canWriteOrigins = await hasMarketingClinicScopeAccess({
                    userId,
                    clinicIds: originClinicIds,
                    access: 'write'
                });
                if (!canWriteOrigins) {
                    const error = new Error(
                        'No tienes permisos para mover una ubicación desde su clínica de origen.'
                    );
                    error.code = 'business_profile_origin_scope_forbidden';
                    error.httpStatus = 403;
                    throw error;
                }
            }
            assertBusinessProfileConnectionCoherence(affectedRecords, mappings, conn.id);

            if (replaceExisting) {
                const recordsToDeactivate = affectedRecords
                    .filter((record) => {
                        const selectedLocationIds = selectedByClinic.get(Number(record.clinica_id));
                        return selectedLocationIds
                            && record.is_active
                            && !selectedLocationIds.has(String(record.location_id));
                    });
                for (const record of recordsToDeactivate) {
                    await assertSharedMarketingAssetMutationAccess({
                        userId,
                        assetType: 'google.business_profile',
                        assetId: record.id,
                        ownerClinicId: record.clinica_id,
                        transaction
                    });
                }
                if (recordsToDeactivate.length) {
                    await ClinicBusinessLocation.update(
                        { is_active: false },
                        {
                            where: { id: { [Op.in]: recordsToDeactivate.map((record) => record.id) } },
                            transaction
                        }
                    );
                }
            }

            for (const mapping of mappings) {
                const { clinicaId, locationId } = mapping;
                const providerLocation = providerLocationsById.get(locationId);
                let record = existingByLocation.get(locationId);
                if (record && Number(record.clinica_id) !== clinicaId) {
                    await assertSharedMarketingAssetMutationAccess({
                        userId,
                        assetType: 'google.business_profile',
                        assetId: record.id,
                        ownerClinicId: record.clinica_id,
                        transaction
                    });
                }
                const payload = {
                    clinica_id: clinicaId,
                    google_connection_id: conn.id,
                    location_name: providerLocation.locationName || mapping.locationName || mapping.title || null,
                    location_id: locationId,
                    store_code: providerLocation.storeCode || mapping.storeCode || null,
                    primary_category: providerLocation.primaryCategory || mapping.primaryCategory || null,
                    sync_status: 'pending',
                    is_verified: !!providerLocation.isVerified,
                    is_suspended: !!providerLocation.isSuspended,
                    raw_payload: mergeBusinessProfileRawPayload(
                        record?.raw_payload,
                        providerLocation.rawLocation,
                        {
                            accountName: providerLocation.accountName,
                            accountDisplayName: providerLocation.accountDisplayName
                        }
                    ),
                    is_active: true,
                    last_synced_at: null
                };

                if (record) {
                    await record.update(payload, { transaction });
                } else {
                    record = await ClinicBusinessLocation.create(payload, { transaction });
                    existingByLocation.set(locationId, record);
                }
                createdOrUpdated.push({ id: record.id, clinicaId, locationId });
                locationsToBackfill.push({ clinicId: clinicaId, locationId });
            }
        });

        if (locationsToBackfill.length) {
            try {
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'business_profile_backfill_locations',
                    payload: withRequestedRuntimeNamespace(req, { mappings: locationsToBackfill }),
                    priority: 'high',
                    origin: 'business-profile:map-locations',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error lanzando businessProfileSync tras mapeo:', err)
                );
            } catch (queueErr) {
                console.error('❌ Error encolando businessProfileSync tras mapeo:', queueErr);
            }
        }

        return res.json({ success: true, mapped: createdOrUpdated.length, locations: createdOrUpdated });
    } catch (err) {
        console.error('❌ Error en /oauth/google/local/map-locations:', err.response?.data || err.message);
        const status = Number(err.httpStatus || err.status || 500);
        if ([400, 403, 404, 409].includes(status)) {
            return res.status(status).json({
                success: false,
                error: err.code || 'business_profile_mapping_failed',
                message: err.message
            });
        }
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
        const mappingPurpose = cleanString(req.query?.mapping_purpose || req.query?.mappingPurpose)?.toLowerCase();
        const targetClinicId = Number(req.query?.clinic_id || req.query?.clinica_id || 0);
        if (mappingPurpose === 'reviews' && Number.isInteger(targetClinicId) && targetClinicId > 0) {
            const canReadTarget = await hasMarketingClinicScopeAccess({
                userId,
                clinicIds: [targetClinicId],
                access: 'read'
            });
            if (!canReadTarget) {
                return res.status(403).json({
                    success: false,
                    error: 'review_profile_target_scope_forbidden'
                });
            }

            const profile = await resolveClinicGoogleReviewProfile(targetClinicId);
            const selectedLocation = profile.alias && profile.location
                ? profile.location
                : await ClinicBusinessLocation.findOne({
                    where: {
                        clinica_id: targetClinicId,
                        is_active: true
                    },
                    order: [['last_synced_at', 'DESC'], ['updated_at', 'DESC']],
                    raw: true
                });
            const clinic = profile.clinic || await Clinica.findByPk(targetClinicId, { raw: true });
            const mappings = selectedLocation ? [{
                clinicaId: targetClinicId,
                clinicName: clinic?.nombre_clinica || null,
                clinicAvatar: clinic?.url_avatar || null,
                locations: [{
                    locationId: selectedLocation.location_id,
                    locationName: selectedLocation.location_name,
                    storeCode: selectedLocation.store_code,
                    primaryCategory: selectedLocation.primary_category,
                    isVerified: !!selectedLocation.is_verified,
                    isSuspended: !!selectedLocation.is_suspended,
                    lastSyncedAt: selectedLocation.last_synced_at
                }]
            }] : [];
            return res.json({ success: true, mappings, review_alias: !!profile.alias });
        }

        const { connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!conn) {
            return res.json({ success: true, mappings: [] });
        }
        const allRows = await ClinicBusinessLocation.findAll({
            where: { google_connection_id: conn.id, is_active: true },
            include: [{ model: Clinica, as: 'clinica', required: false }],
            order: [['location_name', 'ASC']]
        });
        const rows = await filterReadableClinicMappings(
            req,
            userId,
            allRows,
            (row) => row.clinica_id
        );

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
        const { userId, connection: conn, assignment, scope, source } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ connected: false, reason: 'unauthenticated' });
        }
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
            if (['TOKEN_EXPIRED', 'TOKEN_EXPIRY_UNKNOWN', 'REFRESH_FAILED'].includes(tokenErr.code)) {
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
            hasAccessibleAccounts: customers.length > 0,
            scope: buildScopeResponse(scope, assignment),
            source
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
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

        const allExisting = await ClinicGoogleAdsAccount.findAll({
            where: { googleConnectionId: conn.id, isActive: true },
            raw: true
        });
        const existing = await filterReadableClinicMappings(
            req,
            userId,
            allExisting,
            (row) => row.clinicaId
        );
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
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
        const requestedMappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!requestedMappings.length) {
            return res.status(400).json({ success: false, error: 'mappings requerido' });
        }
        if (requestedMappings.some((mapping) => (
            !Number.isInteger(Number.parseInt(String(mapping?.clinicaId ?? ''), 10))
            || Number.parseInt(String(mapping?.clinicaId ?? ''), 10) <= 0
            || !normalizeCustomerId(mapping?.customerId)
        ))) {
            throw inaccessibleAssetError('google_ads_mapping_invalid', 'Todos los mapeos de Google Ads deben indicar una clínica y una cuenta válidas.');
        }
        const mappings = Array.from(new Map(requestedMappings.map((mapping) => [
            `${Number.parseInt(String(mapping.clinicaId), 10)}|${normalizeCustomerId(mapping.customerId)}`,
            mapping
        ])).values());
        const { connection: conn } = await resolveAuthorizedDestinationGoogleConnection({
            userId,
            mappings,
            authorizeDestinations: hasMarketingClinicScopeAccess,
            resolveForClinic: (clinicId) => resolveGoogleRequestConnection(req, {
                allowLegacyUserFallback: true,
                scopeInput: { clinicIdRaw: clinicId, groupIdRaw: null, assignmentScopeRaw: 'clinic' }
            })
        });
        const authorizedAccounts = await loadAuthorizedGoogleAdsAccounts(conn);
        for (const mapping of mappings) {
            const customerId = normalizeCustomerId(mapping?.customerId);
            if (!customerId || !authorizedAccounts.has(customerId)) {
                throw inaccessibleAssetError(
                    'google_ads_account_not_accessible',
                    'Alguna cuenta de Google Ads no pertenece a la conexión Google autorizada.'
                );
            }
        }

        const replaceExisting = req.body?.replace_existing === true;
        const selectedByClinic = new Map();
        for (const mapping of mappings) {
            const clinicaId = parseInt(mapping?.clinicaId, 10);
            const customerId = normalizeCustomerId(mapping?.customerId);
            if (!clinicaId || !customerId) {
                continue;
            }
            if (!selectedByClinic.has(clinicaId)) selectedByClinic.set(clinicaId, new Set());
            selectedByClinic.get(clinicaId).add(customerId);
        }

        const transaction = await db.sequelize.transaction();
        const results = [];
        const clinicsToSync = new Set();
        const clinicAssignmentCache = new Map();

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

            const resolved = {
                assignmentScope: 'clinic',
                grupoClinicaId: clinic?.grupoClinicaId || null
            };
            clinicAssignmentCache.set(clinicaId, resolved);
            return resolved;
        }

        try {
            if (replaceExisting) {
                for (const [clinicaId, customerIds] of selectedByClinic.entries()) {
                    const recordsToDeactivate = await ClinicGoogleAdsAccount.findAll({
                        where: {
                            clinicaId,
                            isActive: true,
                            customerId: { [Op.notIn]: Array.from(customerIds) }
                        },
                        transaction,
                        lock: transaction.LOCK.UPDATE
                    });
                    for (const record of recordsToDeactivate) {
                        await assertSharedMarketingAssetMutationAccess({
                            userId,
                            assetType: 'google.ads_account',
                            assetId: record.id,
                            ownerClinicId: record.clinicaId,
                            transaction
                        });
                    }
                    if (recordsToDeactivate.length) {
                        await ClinicGoogleAdsAccount.update(
                            { isActive: false },
                            {
                                where: { id: { [Op.in]: recordsToDeactivate.map((record) => record.id) } },
                                transaction
                            }
                        );
                    }
                }
            }

            for (const mapping of mappings) {
                const clinicaId = parseInt(mapping?.clinicaId, 10);
                const customerId = normalizeCustomerId(mapping?.customerId);
                if (!clinicaId || !customerId) {
                    continue;
                }
                const providerAccount = authorizedAccounts.get(customerId);

                const { assignmentScope, grupoClinicaId } = await resolveAssignment(clinicaId);

                const payload = {
                    clinicaId,
                    googleConnectionId: conn.id,
                    customerId,
                    descriptiveName: providerAccount.descriptiveName,
                    currencyCode: providerAccount.currencyCode,
                    timeZone: providerAccount.timeZone,
                    accountStatus: providerAccount.accountStatus,
                    managerCustomerId: providerAccount.managerCustomerId,
                    loginCustomerId: providerAccount.loginCustomerId,
                    managerLinkId: providerAccount.managerLinkId,
                    managerLinkStatus: providerAccount.managerLinkStatus,
                    invitationStatus: providerAccount.invitationStatus,
                    linkedAt: providerAccount.linkedAt,
                    assignmentScope,
                    grupoClinicaId,
                    isActive: true
                };

                const existing = await ClinicGoogleAdsAccount.findOne({ where: { clinicaId, customerId }, transaction });
                if (existing) {
                    await assertSharedMarketingAssetMutationAccess({
                        userId,
                        assetType: 'google.ads_account',
                        assetId: existing.id,
                        ownerClinicId: existing.clinicaId,
                        transaction
                    });
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
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'google_ads_recent',
                    payload: withRequestedRuntimeNamespace(req, { clinicIds }),
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
        if (sendKnownOAuthMappingError(res, err)) return;
        const detail = Array.isArray(err?.errors)
            ? err.errors.map((item) => item.message).filter(Boolean).join('; ')
            : (err.details || err.message);
        console.error('❌ Error en /oauth/google/ads/map-accounts:', detail);

        if (err?.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({
                success: false,
                error: 'duplicate_mapping',
                message: 'Esa cuenta de Google Ads ya está vinculada y no se pudo guardar el mapeo.'
            });
        }

        if (err?.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                error: 'validation_error',
                message: detail || 'No se pudo guardar el mapeo de Google Ads.'
            });
        }

        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

/**
 * GOOGLE — Obtener mapeos Ads actuales
 */
router.get('/google/ads/mappings', async (req, res) => {
    try {
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        }
        if (!conn) {
            return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        }

        const allRows = await ClinicGoogleAdsAccount.findAll({ where: { googleConnectionId: conn.id, isActive: true }, raw: true });
        const rows = await filterReadableClinicMappings(req, userId, allRows, (row) => row.clinicaId);
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
        const account = await ClinicGoogleAdsAccount.findByPk(mappingId);
        if (!account) {
            return res.status(404).json({ success: false, error: 'Cuenta Google Ads no encontrada' });
        }
        if (!await requireSingleMappingClinicWrite(res, userId, account.clinicaId)) return;

        await db.sequelize.transaction(async (transaction) => {
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: 'google.ads_account',
                assetId: mappingId,
                ownerClinicId: account.clinicaId,
                transaction
            });
            await GroupAssetClinicAssignment.destroy({
                where: { assetType: 'google.ads_account', assetId: mappingId },
                transaction
            });
            await account.destroy({ transaction });
        });

        return res.json({ success: true });
    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
        console.error('❌ Error eliminando mapeo de Google Ads:', error);
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

/**
 * GOOGLE — Obtener mapeos GA4 actuales
 */
router.get('/google/analytics/mappings', async (req, res) => {
    try {
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const allItems = await ClinicAnalyticsProperty.findAll({
            where: { googleConnectionId: conn.id, isActive: true },
            include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }]
        });
        const items = await filterReadableClinicMappings(req, userId, allItems, (item) => item.clinicaId);

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
        const mapping = await ClinicAnalyticsProperty.findByPk(mappingId);
        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }
        if (!await requireSingleMappingClinicWrite(res, userId, mapping.clinicaId)) return;

        await db.sequelize.transaction(async (transaction) => {
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: 'google.analytics',
                assetId: mappingId,
                ownerClinicId: mapping.clinicaId,
                transaction
            });
            await GroupAssetClinicAssignment.destroy({
                where: { assetType: 'google.analytics', assetId: mappingId },
                transaction
            });
            await mapping.destroy({ transaction });
        });

        return res.json({ success: true });
    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
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
        const requestedMappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
        if (!requestedMappings.length) return res.status(400).json({ success: false, error: 'mappings requerido' });
        if (requestedMappings.some((mapping) => (
            !Number.isInteger(Number.parseInt(String(mapping?.clinicaId ?? ''), 10))
            || Number.parseInt(String(mapping?.clinicaId ?? ''), 10) <= 0
            || !String(mapping?.siteUrl || '').trim()
        ))) {
            throw inaccessibleAssetError('search_console_mapping_invalid', 'Todos los mapeos de Search Console deben indicar una clínica y una propiedad válidas.');
        }
        const mappings = Array.from(new Map(requestedMappings.map((mapping) => [
            `${Number.parseInt(String(mapping.clinicaId), 10)}|${String(mapping.siteUrl).trim()}`,
            mapping
        ])).values());
        const { connection: conn } = await resolveAuthorizedDestinationGoogleConnection({
            userId,
            mappings,
            authorizeDestinations: hasMarketingClinicScopeAccess,
            resolveForClinic: (clinicId) => resolveGoogleRequestConnection(req, {
                allowLegacyUserFallback: true,
                scopeInput: { clinicIdRaw: clinicId, groupIdRaw: null, assignmentScopeRaw: 'clinic' }
            })
        });
        const authorizedSites = await loadAuthorizedSearchConsoleSites(conn);
        for (const mapping of mappings) {
            const siteUrl = String(mapping?.siteUrl || '').trim();
            if (!siteUrl || !authorizedSites.has(siteUrl)) {
                throw inaccessibleAssetError(
                    'search_console_site_not_accessible',
                    'Alguna propiedad de Search Console no pertenece a la conexión Google autorizada.'
                );
            }
        }

        const createdOrUpdated = [];
        const sitesToBackfill = [];
        const replaceExisting = req.body?.replace_existing === true;
        const selectedByClinic = new Map();
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const siteUrl = String(m.siteUrl || '').trim();
            if (!clinicaId || !siteUrl) continue;
            if (!selectedByClinic.has(clinicaId)) selectedByClinic.set(clinicaId, new Set());
            selectedByClinic.get(clinicaId).add(siteUrl);
        }
        const existingByClinicSite = new Map();
        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const siteUrl = String(m.siteUrl || '').trim();
            const existing = await ClinicWebAsset.findOne({ where: { clinicaId, siteUrl } });
            if (!existing) continue;
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: 'google.search_console',
                assetId: existing.id,
                ownerClinicId: existing.clinicaId
            });
            existingByClinicSite.set(`${clinicaId}|${siteUrl}`, existing);
        }

        if (replaceExisting) {
            const recordsToDeactivate = [];
            for (const [clinicaId, siteUrls] of selectedByClinic.entries()) {
                recordsToDeactivate.push(...await ClinicWebAsset.findAll({
                    where: {
                        clinicaId,
                        isActive: true,
                        siteUrl: { [Op.notIn]: Array.from(siteUrls) }
                    }
                }));
            }
            for (const record of recordsToDeactivate) {
                await assertSharedMarketingAssetMutationAccess({
                    userId,
                    assetType: 'google.search_console',
                    assetId: record.id,
                    ownerClinicId: record.clinicaId
                });
            }
            if (recordsToDeactivate.length) {
                await ClinicWebAsset.update(
                    { isActive: false },
                    { where: { id: { [Op.in]: recordsToDeactivate.map((record) => record.id) } } }
                );
            }
        }

        for (const m of mappings) {
            const clinicaId = parseInt(m.clinicaId, 10);
            const siteUrl = String(m.siteUrl || '').trim();
            if (!clinicaId || !siteUrl) continue;
            const providerSite = authorizedSites.get(siteUrl);
            const payload = {
                clinicaId,
                googleConnectionId: conn.id,
                siteUrl,
                propertyType: providerSite.propertyType,
                permissionLevel: providerSite.permissionLevel,
                verified: true,
                isActive: true
            };
            const existing = existingByClinicSite.get(`${clinicaId}|${siteUrl}`) || null;
            if (existing) {
                await existing.update(payload);
                createdOrUpdated.push({ id: existing.id, ...payload });
                sitesToBackfill.push({ clinicId: clinicaId, siteUrl });
            } else {
                const rec = await ClinicWebAsset.create(payload);
                createdOrUpdated.push({ id: rec.id, ...payload });
                sitesToBackfill.push({ clinicId: clinicaId, siteUrl });
            }
        }

        if (sitesToBackfill.length) {
            try {
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'web_backfill_for_sites',
                    payload: withRequestedRuntimeNamespace(req, { siteMappings: sitesToBackfill }),
                    priority: 'high',
                    origin: 'search-console:map-assets',
                    requestedBy: userId
                });
                jobScheduler.triggerImmediate(job.id).catch((err) =>
                    console.error('❌ Error lanzando webSync tras mapeo:', err)
                );
            } catch (queueErr) {
                console.error('❌ Error encolando webSync tras mapeo:', queueErr);
            }
        }

        return res.json({ success: true, mapped: createdOrUpdated.length, assets: createdOrUpdated });
    } catch (e) {
        if (sendKnownOAuthMappingError(res, e)) return;
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
        const { userId, connection: conn } = await resolveGoogleRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });

        const allRows = await ClinicWebAsset.findAll({ where: { googleConnectionId: conn.id, isActive: true }, raw: true });
        const rows = await filterReadableClinicMappings(req, userId, allRows, (row) => row.clinicaId);
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
        const mapping = await ClinicWebAsset.findByPk(mappingId);
        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }
        if (!await requireSingleMappingClinicWrite(res, userId, mapping.clinicaId)) return;

        await db.sequelize.transaction(async (transaction) => {
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: 'google.search_console',
                assetId: mappingId,
                ownerClinicId: mapping.clinicaId,
                transaction
            });
            await GroupAssetClinicAssignment.destroy({
                where: { assetType: 'google.search_console', assetId: mappingId },
                transaction
            });
            await mapping.destroy({ transaction });
        });

        return res.json({ success: true });
    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
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
        const scopeInput = getScopeInputFromRequest(req);
        const requestedScope = await normalizeScope(scopeInput);
        const scope = buildSharedConnectionScope(requestedScope);

        if (scope.scopeKey) {
            const { connection, assignment } = await resolveGoogleRequestConnection(req, {
                allowLegacyUserFallback: true
            });

            if (!connection && !assignment) {
                return res.status(404).json({ success: false, error: 'No hay conexión Google para este scope' });
            }

            const connectionId = connection?.id || assignment?.googleConnectionId || null;
            if (connectionId) {
                await db.sequelize.transaction(async (transaction) => {
                    await deactivateGoogleMappingsForScope({
                        scope,
                        connectionId,
                        transaction
                    });
                    await GoogleConnectionAssignment.upsert({
                        scopeKey: scope.scopeKey,
                        assignmentScope: scope.assignmentScope,
                        clinicaId: scope.assignmentScope === 'clinic' ? scope.clinicId : null,
                        grupoClinicaId: scope.groupId || null,
                        googleConnectionId: connectionId,
                        status: 'disconnected',
                        authorizedByUserId: userId,
                        authorizedByName: connection?.userName || assignment?.authorizedByName || null,
                        authorizedByEmail: connection?.userEmail || assignment?.authorizedByEmail || null,
                        connectedAt: assignment?.connectedAt || connection?.updatedAt || connection?.createdAt || new Date(),
                        lastValidatedAt: new Date(),
                        lastErrorCode: 'DISCONNECTED_BY_USER',
                        lastErrorMessage: 'Disconnected from scope settings'
                    }, { transaction });
                });
            }

            return res.json({ success: true, message: scope.assignmentScope === 'group' ? 'Conexión Google desconectada para todo el grupo' : 'Conexión Google desconectada para esta clínica' });
        }

        const { connection: conn, ambiguous } = await findSingleUserConnection(GoogleConnection, userId);
        if (ambiguous) {
            const error = new Error('Hay varias conexiones Google; indica la clínica o el grupo que quieres desconectar.');
            error.code = 'connection_scope_required';
            error.httpStatus = 409;
            throw error;
        }
        if (!conn) return res.status(404).json({ success: false, error: 'No hay conexión Google' });
        const [activeAssignments, webMappings, analyticsMappings, localMappings, adsMappings] = await Promise.all([
            GoogleConnectionAssignment.count({
                where: {
                    googleConnectionId: conn.id,
                    status: { [Op.in]: ['active', 'reauthorization_required'] }
                }
            }),
            ClinicWebAsset.count({ where: { googleConnectionId: conn.id } }),
            ClinicAnalyticsProperty.count({ where: { googleConnectionId: conn.id } }),
            ClinicBusinessLocation.count({ where: { google_connection_id: conn.id } }),
            ClinicGoogleAdsAccount.count({ where: { googleConnectionId: conn.id } })
        ]);
        if (activeAssignments + webMappings + analyticsMappings + localMappings + adsMappings > 0) {
            const conflict = new Error('La conexión sigue en uso por uno o más scopes o mappings. Desconéctalos de forma individual.');
            conflict.code = 'connection_in_use';
            conflict.httpStatus = 409;
            throw conflict;
        }
        await GoogleConnectionAssignment.destroy({ where: { googleConnectionId: conn.id } });
        await conn.destroy();
        return res.json({ success: true, message: 'Conexión Google desconectada' });
    } catch (e) {
        if (sendKnownOAuthMappingError(res, e)) return;
        console.error('❌ Error en /oauth/google/disconnect:', e.response?.data || e.message);
        return res.status(500).json({ success: false, error: 'Error al desconectar Google' });
    }
});

/**
 * GET /oauth/meta/connection-status
 * Endpoint para que el frontend consulte el estado de conexión de Meta para el usuario actual.
 */
router.get('/meta/connection-status', async (req, res) => {
    const scopedRequest = hasRequestedScope(req);
    const { userId, connection, assignment, scope, source } = await resolveMetaRequestConnection(req, {
        allowLegacyUserFallback: !scopedRequest
    });
    if (!userId) {
        return res.status(401).json({ connected: false, message: 'Usuario no autenticado.' });
    }

    try {
        if (connection) {
            const storedHealth = evaluateMetaConnectionHealth(connection, { is_valid: true });
            if (!storedHealth.connected) {
                return res.json({
                    ...storedHealth,
                    message: 'La conexión Meta necesita volver a autorizarse.',
                    scope: buildScopeResponse(scope, assignment),
                    source
                });
            }
            let scopes = [];
            let missingScopes = [];
            let debugData = null;
            try {
                const dbg = await axios.get(`${META_API_BASE_URL}/debug_token`, {
                    params: {
                        input_token: connection.accessToken,
                        access_token: connection.accessToken
                    }
                });
                debugData = dbg.data?.data || null;
                scopes = Array.isArray(debugData?.scopes)
                    ? debugData.scopes.map((s) => String(s).toLowerCase())
                    : [];
            } catch (err) {
                console.warn('⚠️ No se pudo obtener scopes de Meta (debug_token):', err.response?.data || err.message);
                return res.json({
                    connected: false,
                    reason: 'token_validation_failed',
                    reauthorizationRequired: true,
                    message: 'La conexión Meta necesita volver a autorizarse.',
                    scope: buildScopeResponse(scope, assignment),
                    source
                });
            }

            const health = evaluateMetaConnectionHealth(connection, debugData, {
                expectedAppId: META_APP_ID
            });
            if (!health.connected) {
                return res.json({
                    ...health,
                    message: 'La conexión Meta necesita volver a autorizarse.',
                    scope: buildScopeResponse(scope, assignment),
                    source
                });
            }

            const critical = ['pages_manage_ads', 'leads_retrieval'];
            missingScopes = critical.filter((s) => !scopes.includes(s));

            return res.json({
                connected: true,
                metaUserId: connection.metaUserId,
                userName: connection.userName,
                userEmail: connection.userEmail,
                authorizedByUserId: assignment?.authorizedByUserId || connection.userId || null,
                authorizedByName: assignment?.authorizedByName || connection.userName || null,
                authorizedByEmail: assignment?.authorizedByEmail || connection.userEmail || null,
                scopes,
                missingScopes,
                message: 'Conexión Meta activa.',
                scope: buildScopeResponse(scope, assignment),
                source
            });
        } else {
            return res.json({
                connected: false,
                reason: source === 'legacy_user_ambiguous' ? 'connection_scope_required' : null,
                source,
                message: source === 'legacy_user_ambiguous'
                    ? 'Hay varias conexiones Meta; indica la clínica o el grupo.'
                    : 'No hay conexión Meta para este usuario.'
            });
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
        const { userId, connection: metaConnection } = await resolveMetaRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({ 
                success: false, 
                error: 'Usuario no autenticado' 
            });
        }

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
        const storedHealth = evaluateMetaConnectionHealth(metaConnection, { is_valid: true });
        if (!storedHealth.connected) {
            console.log('❌ Token de Meta no verificable o expirado:', storedHealth.reason);
            return res.status(401).json({ 
                success: false, 
                error: storedHealth.reason,
                message: 'La conexión Meta necesita volver a autorizarse.'
            });
        }

        console.log('✅ Token de usuario válido encontrado');
        const authorizedAssets = await loadAuthorizedMetaAssets(metaConnection);
        const facebookPages = authorizedAssets.facebook_pages.map(withoutMetaAccessToken);
        const instagramBusinessAccounts = authorizedAssets.instagram_business.map(withoutMetaAccessToken);
        const adAccounts = authorizedAssets.ad_accounts.map(withoutMetaAccessToken);

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
    try {
        const userId = getUserIdFromToken(req);
        if (!userId) {
            return res.status(401).json({ message: 'Usuario no autenticado.' });
        }
        const clinicaId = Number.parseInt(String(req.body?.clinicaId ?? ''), 10);
        const requestedAssets = Array.isArray(req.body?.selectedAssets) ? req.body.selectedAssets : [];
        if (!Number.isInteger(clinicaId) || clinicaId <= 0) {
            return res.status(400).json({ success: false, error: 'asset_mapping_clinic_required' });
        }
        if (!await requireAssetMappingClinicAccess(res, userId, [{ clinicaId }], 'write')) return;

        const { connection: metaConnection } = await resolveMetaRequestConnection(req, {
            allowLegacyUserFallback: true,
            scopeInput: {
                clinicIdRaw: clinicaId,
                groupIdRaw: null,
                assignmentScopeRaw: 'clinic'
            }
        });
        if (!metaConnection) {
            return res.status(404).json({ message: 'No hay conexión Meta activa para este usuario.' });
        }
        const authorizedAssets = await loadAuthorizedMetaAssets(metaConnection);
        const selectedAssets = selectAuthorizedMetaAssets(requestedAssets, authorizedAssets.all);

        // Cada tipo representa un único activo efectivo por clínica. Rechazamos
        // selecciones ambiguas antes de realizar cualquier mutación.
        const selectedCountByType = new Map();
        for (const asset of selectedAssets) {
            selectedCountByType.set(asset.type, (selectedCountByType.get(asset.type) || 0) + 1);
        }
        if (Array.from(selectedCountByType.values()).some((count) => count > 1)) {
            throw inaccessibleAssetError(
                'meta_asset_type_conflict',
                'Solo puedes seleccionar un activo de cada tipo para una clínica.'
            );
        }

        const createdOrUpdated = [];
        const selectedKeySet = new Set(selectedAssets.map((asset) => `${asset.type}|${asset.id}`));
        const selectedTypes = new Set(selectedAssets.map((asset) => asset?.type).filter(Boolean));
        const clinicsToSync = new Set();
        const clinicAssignmentCache = new Map();

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

            const resolved = {
                assignmentScope: 'clinic',
                grupoClinicaId: clinic?.grupoClinicaId || null
            };
            clinicAssignmentCache.set(clinicId, resolved);
            return resolved;
        }

        // Traer todos los mapeos de la clínica. La conexión efectiva ya fue
        // autorizada y el ID remoto se revalidó contra Meta.
        const existing = await ClinicMetaAsset.findAll({
            where: { clinicaId }
        });
        const toDeactivate = existing.filter((asset) => (
            asset.isActive
            && selectedTypes.has(asset.assetType)
            && !selectedKeySet.has(`${asset.assetType}|${asset.metaAssetId}`)
        ));
        for (const asset of toDeactivate) {
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: asset.assetType === 'ad_account'
                    ? 'meta.ad_account'
                    : asset.assetType === 'instagram_business'
                        ? 'meta.instagram_business'
                        : 'meta.facebook_page',
                assetId: asset.id,
                ownerClinicId: asset.clinicaId
            });
        }
        for (const asset of selectedAssets) {
            const found = existing.find((candidate) => (
                candidate.assetType === asset.type
                && candidate.metaAssetId === String(asset.id)
            ));
            if (found && Number(found.metaConnectionId) !== Number(metaConnection.id)) {
                await assertSharedMarketingAssetMutationAccess({
                    userId,
                    assetType: found.assetType === 'ad_account'
                        ? 'meta.ad_account'
                        : found.assetType === 'instagram_business'
                            ? 'meta.instagram_business'
                            : 'meta.facebook_page',
                    assetId: found.id,
                    ownerClinicId: found.clinicaId
                });
            }
        }

        // Actualizar o crear assets seleccionados
        for (const asset of selectedAssets) {
            const { assignmentScope, grupoClinicaId } = await resolveAssignment(clinicaId);

            const found = existing.find(a => a.assetType === asset.type && a.metaAssetId === String(asset.id));
            if (found) {
                await found.update({
                    metaConnectionId: metaConnection.id,
                    metaAssetName: asset.name,
                    pageAccessToken: asset.pageAccessToken || found.pageAccessToken || null,
                    assetAvatarUrl: asset.assetAvatarUrl || found.assetAvatarUrl || null,
                    additionalData: asset.additionalData || null,
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
                    additionalData: asset.additionalData || null,
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

        // El histórico puede ser consumido por otras clínicas cuando el activo
        // es compartido. Desactivamos el mapeo, pero no borramos caches globales.
        if (toDeactivate.length) {
            await ClinicMetaAsset.update({ isActive: false }, { where: { id: toDeactivate.map(a => a.id) } });
        }

        console.log(`✅ Mapeo actualizado para clínica ${clinicaId}: ${createdOrUpdated.length} activos activos, ${toDeactivate.length} inactivos (unicidad aplicada para IG/FB/Ads)`);

        const clinicIds = Array.from(clinicsToSync).filter((id) => Number.isInteger(id));
        if (clinicIds.length) {
            try {
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'meta_ads_recent',
                    payload: withRequestedRuntimeNamespace(req, { clinicIds }),
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

        res.status(200).json({
            message: 'Activos de Meta mapeados correctamente.',
            assets: createdOrUpdated.map(withoutMetaAccessToken),
            replacedMappings: false,
            totalActiveMappings: createdOrUpdated.length,
            totalDeactivated: toDeactivate.length
        });

    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
        const sequelizeDetails = Array.isArray(error?.errors)
            ? error.errors.map((item) => item?.message).filter(Boolean)
            : [];
        const details = sequelizeDetails.length
            ? sequelizeDetails.join('; ')
            : (error.response ? error.response.data : error.message);
        const statusCode = error?.name === 'SequelizeUniqueConstraintError' ? 409 : 500;
        console.error('Error al mapear activos de Meta:', details);
        res.status(statusCode).json({ message: 'Error al mapear activos de Meta.', details });
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
    return req.userData?.userId || null;
};

/**
 * GET /oauth/meta/mappings
 * Obtiene los mapeos de activos Meta existentes para el usuario logueado
 */
router.get('/meta/mappings', async (req, res) => {
    try {
        console.log('🔍 Obteniendo mapeos de activos Meta...');
        
        // Obtener el userId del token JWT
        const { userId, connection: metaConnection } = await resolveMetaRequestConnection(req, {
            allowLegacyUserFallback: true
        });
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Buscando mapeos para userId:', userId);
        
        if (!metaConnection) {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.json({
                success: false,
                error: 'Usuario no conectado a Meta'
            });
        }
        
        // ✅ CORREGIDO: Obtener todos los mapeos activos del usuario con nombres de columna correctos
        const allMappings = await ClinicMetaAsset.findAll({
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
        const mappings = await filterReadableClinicMappings(
            req,
            userId,
            allMappings,
            (mapping) => mapping.clinicaId
        );
        
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
            
            const assetData = withoutMetaAccessToken({
                id: mapping.id,
                metaAssetId: mapping.metaAssetId,
                metaAssetName: mapping.metaAssetName,
                assetType: mapping.assetType,
                additionalData: mapping.additionalData,
                createdAt: mapping.createdAt,
                updatedAt: mapping.updatedAt
            });
            
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
        const mapping = await ClinicMetaAsset.findByPk(mappingId);
        if (!mapping) {
            return res.status(404).json({ success: false, error: 'Mapeo no encontrado' });
        }
        if (!await requireSingleMappingClinicWrite(res, userId, mapping.clinicaId)) return;

        const plain = mapping.get({ plain: true });
        const clinicaId = plain.clinicaId;
        const assetType = plain.assetType;

        const transaction = await db.sequelize.transaction();
        try {
            const sharedAssetType = assetType === 'ad_account'
                ? 'meta.ad_account'
                : assetType === 'instagram_business'
                    ? 'meta.instagram_business'
                    : 'meta.facebook_page';
            await assertSharedMarketingAssetMutationAccess({
                userId,
                assetType: sharedAssetType,
                assetId: mappingId,
                ownerClinicId: clinicaId,
                transaction
            });
            await GroupAssetClinicAssignment.destroy({
                where: {
                    assetId: mappingId,
                    assetType: sharedAssetType
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
            }
        } catch (cleanupErr) {
            console.warn('⚠️ Error limpiando datos asociados al mapeo Meta eliminado:', cleanupErr.message);
        }

        if (clinicaId) {
            try {
                const { job } = await jobRequestsService.enqueueUniqueJobRequest({
                    type: 'meta_ads_recent',
                    payload: withRequestedRuntimeNamespace(req, { clinicIds: [clinicaId] }),
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
        if (sendKnownOAuthMappingError(res, error)) return;
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
        
        const scopeInput = getScopeInputFromRequest(req);
        const requestedScope = await normalizeScope(scopeInput);
        const scope = buildSharedConnectionScope(requestedScope);

        if (scope.scopeKey) {
            const { connection, assignment } = await resolveMetaRequestConnection(req, {
                allowLegacyUserFallback: true
            });

            if (!connection && !assignment) {
                return res.status(404).json({
                    success: false,
                    error: 'No hay conexión Meta para este scope'
                });
            }

            const connectionId = connection?.id || assignment?.metaConnectionId || null;
            if (connectionId) {
                await db.sequelize.transaction(async (transaction) => {
                    await deactivateMetaMappingsForScope({
                        scope,
                        connectionId,
                        transaction
                    });
                    await MetaConnectionAssignment.upsert({
                        scopeKey: scope.scopeKey,
                        assignmentScope: scope.assignmentScope,
                        clinicaId: scope.assignmentScope === 'clinic' ? scope.clinicId : null,
                        grupoClinicaId: scope.groupId || null,
                        metaConnectionId: connectionId,
                        status: 'disconnected',
                        authorizedByUserId: userId,
                        authorizedByName: connection?.userName || assignment?.authorizedByName || null,
                        authorizedByEmail: connection?.userEmail || assignment?.authorizedByEmail || null,
                        connectedAt: assignment?.connectedAt || connection?.updatedAt || connection?.createdAt || new Date(),
                        lastValidatedAt: new Date(),
                        lastErrorCode: 'DISCONNECTED_BY_USER',
                        lastErrorMessage: 'Disconnected from scope settings'
                    }, { transaction });
                });
            }

            return res.json({
                success: true,
                message: scope.assignmentScope === 'group' ? 'Conexión Meta desconectada para todo el grupo' : 'Conexión Meta desconectada para esta clínica'
            });
        }

        console.log('🔍 Eliminando conexión Meta para userId:', userId);

        const { connection, ambiguous } = await findSingleUserConnection(MetaConnection, userId);
        if (ambiguous) {
            const conflict = new Error('Hay varias conexiones Meta; indica la clínica o el grupo que quieres desconectar.');
            conflict.code = 'connection_scope_required';
            conflict.httpStatus = 409;
            throw conflict;
        }
        if (!connection) {
            console.log('⚠️ No se encontró conexión Meta para eliminar');
            return res.json({
                success: false,
                error: 'No se encontró conexión Meta para este usuario'
            });
        }

        const [activeAssignments, mappings] = await Promise.all([
            MetaConnectionAssignment.count({
                where: {
                    metaConnectionId: connection.id,
                    status: { [Op.in]: ['active', 'reauthorization_required'] }
                }
            }),
            ClinicMetaAsset.count({ where: { metaConnectionId: connection.id } })
        ]);
        if (activeAssignments + mappings > 0) {
            const conflict = new Error('La conexión sigue en uso por uno o más scopes o mappings. Desconéctalos de forma individual.');
            conflict.code = 'connection_in_use';
            conflict.httpStatus = 409;
            throw conflict;
        }
        await MetaConnectionAssignment.destroy({ where: { metaConnectionId: connection.id } });
        await connection.destroy();

        console.log('✅ Conexión Meta eliminada correctamente');
        return res.json({
            success: true,
            message: 'Conexión Meta desconectada correctamente'
        });
        
    } catch (error) {
        if (sendKnownOAuthMappingError(res, error)) return;
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
        const clinicaId = Number.parseInt(String(req.params.clinicaId || ''), 10);
        if (!Number.isInteger(clinicaId) || clinicaId <= 0) {
            return res.status(400).json({ success: false, error: 'clinic_id_invalid' });
        }
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
        const allowed = await hasMarketingClinicScopeAccess({
            userId,
            clinicIds: [clinicaId],
            access: 'read'
        });
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'asset_mapping_scope_forbidden' });
        }
        
        console.log(`🔍 Buscando mapeos para userId: ${userId}, clinicaId: ${clinicaId}`);
        
        // Buscar conexión Meta del usuario
        const { connection: metaConnection } = await resolveMetaRequestConnection(req, {
            allowLegacyUserFallback: true,
            scopeInput: {
                clinicIdRaw: clinicaId,
                groupIdRaw: null,
                assignmentScopeRaw: 'clinic'
            }
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
                clinicaId,
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
            id: mappings[0].clinica?.id_clinica || clinicaId,
            nombre: mappings[0].clinica?.nombre_clinica || `Clínica ${clinicaId}`,
            avatar_url: mappings[0].clinica?.url_avatar || null
        };
        
        const assetsByType = {
            facebook_pages: [],
            instagram_business: [],
            ad_accounts: []
        };
        
        mappings.forEach(mapping => {
            const assetData = withoutMetaAccessToken({
                id: mapping.id,
                metaAssetId: mapping.metaAssetId,
                metaAssetName: mapping.metaAssetName,
                assetType: mapping.assetType,
                assetAvatarUrl: mapping.assetAvatarUrl,
                additionalData: mapping.additionalData,
                createdAt: mapping.createdAt,
                // ✅ AÑADIDO: URL para usar como enlace
                assetUrl: generateAssetUrl(mapping.assetType, mapping.metaAssetId, mapping.additionalData)
            });
            
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
