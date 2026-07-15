'use strict';

const express = require('express');
const axios = require('axios');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const db = require('../../models');
const GoogleConnection = db.GoogleConnection;
const Clinica = db.Clinica;
const WebGaDaily = db.WebGaDaily;
const WebGaDimensionDaily = db.WebGaDimensionDaily;
const ClinicAnalyticsProperty = db.ClinicAnalyticsProperty;
const sequelize = db.sequelize;
const {
  hasMarketingClinicScopeAccess,
} = require('../lib/marketingScopeAccess');
const {
  resolveEffectiveMarketingAssetInventory,
} = require('../services/effectiveMarketingAssets.service');

// Helper: get userId from JWT Authorization header
function getUserIdFromToken(req) {
  return req.userData?.userId || null;
}

router.use(authMiddleware);

router.use('/clinica/:clinicaId', async (req, res, next) => {
  const userId = getUserIdFromToken(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'unauthenticated' });
  }
  const clinicaId = Number.parseInt(String(req.params.clinicaId || ''), 10);
  if (!Number.isInteger(clinicaId) || clinicaId <= 0) {
    return res.status(400).json({ success: false, error: 'clinic_id_invalid' });
  }
  try {
    const access = req.method === 'GET' ? 'read' : 'write';
    const allowed = await hasMarketingClinicScopeAccess({
      userId,
      clinicIds: [clinicaId],
      access,
    });
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'clinic_scope_forbidden' });
    }
    req.webClinicUserId = userId;
    req.webClinicId = clinicaId;
    return next();
  } catch (error) {
    console.error('❌ /web clinic scope guard:', error.message);
    return res.status(500).json({ success: false, error: 'clinic_scope_check_failed' });
  }
});

async function getGoogleAccessTokenForConnection(connectionId, {
  connectionModel = GoogleConnection,
  http = axios,
  nowMs = Date.now()
} = {}) {
  const normalizedConnectionId = Number.parseInt(String(connectionId || ''), 10);
  if (!Number.isInteger(normalizedConnectionId) || normalizedConnectionId <= 0) {
    const error = new Error('Mapping web sin googleConnectionId válido');
    error.code = 'web_mapping_connection_missing';
    throw error;
  }
  const conn = await connectionModel.findByPk(normalizedConnectionId);
  if (!conn || Number(conn.id) !== normalizedConnectionId) {
    const error = new Error('La conexión Google del mapping web no existe');
    error.code = 'web_mapping_connection_missing';
    throw error;
  }
  let accessToken = conn.accessToken || null;
  const expiresAt = conn.expiresAt ? new Date(conn.expiresAt).getTime() : NaN;
  const mustRefresh = !Number.isFinite(expiresAt) || expiresAt < nowMs + 60_000;
  if (mustRefresh) {
    if (!conn.refreshToken) {
      const error = new Error('La conexión Google del mapping web requiere volver a autorizarse');
      error.code = Number.isFinite(expiresAt) ? 'web_mapping_token_expired' : 'web_mapping_token_expiry_unknown';
      throw error;
    }
    const resp = await http.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: conn.refreshToken
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    accessToken = resp.data?.access_token || null;
    if (!accessToken) {
      const error = new Error('Google no devolvió un token para el mapping web');
      error.code = 'web_mapping_refresh_failed';
      throw error;
    }
    const expiresIn = resp.data?.expires_in || 3600;
    await conn.update({ accessToken, expiresAt: new Date(nowMs + expiresIn * 1000) });
  }
  if (!accessToken) {
    const error = new Error('La conexión Google del mapping web no tiene token');
    error.code = 'web_mapping_token_missing';
    throw error;
  }
  return { accessToken, connection: conn };
}

async function getClinicSiteMappings(clinicaId, {
  inventoryResolver = resolveEffectiveMarketingAssetInventory
} = {}) {
  const inventory = await inventoryResolver({
    clinicIdRaw: clinicaId,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic'
  });
  const mappings = (inventory?.google?.available_assets?.search_console || [])
    .filter((row) => String(row?.site_url || '').trim())
    .map((row) => ({
      id: row.mapping_id || null,
      clinicaId: row.clinic_id || null,
      googleConnectionId: row.connection_id || null,
      siteUrl: row.site_url,
      propertyType: row.property_type || null,
      permissionLevel: row.permission_level || null,
      verified: row.verified !== false,
      assignmentOrigin: row.assignment_origin || null,
      isActive: true
    }));
  if (!mappings.length) throw new Error('No siteUrl mapped for clinic');
  return mappings;
}

function selectPrimarySiteMapping(mappings) {
  const rows = Array.isArray(mappings) ? mappings : [];
  return rows.find((row) => String(row.siteUrl || '').startsWith('http')) || rows[0] || null;
}

async function getAccessTokenForWebMapping(mapping, tokenCache = new Map(), dependencies = {}) {
  const connectionId = Number.parseInt(String(mapping?.googleConnectionId || ''), 10);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    const error = new Error('Mapping web sin googleConnectionId válido');
    error.code = 'web_mapping_connection_missing';
    throw error;
  }
  if (!tokenCache.has(connectionId)) {
    tokenCache.set(connectionId, getGoogleAccessTokenForConnection(connectionId, dependencies)
      .catch((error) => {
        tokenCache.delete(connectionId);
        throw error;
      }));
  }
  return tokenCache.get(connectionId);
}

function resolveDateRange(startDate, endDate, fallbackDays = 90) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parse = (value, fallback) => {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return null;
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  };
  const endObj = parse(endDate, today);
  if (!endObj) throw new Error('Fecha final inválida');
  let startObj = parse(startDate, null);
  if (!startObj) {
    startObj = new Date(endObj);
    startObj.setDate(startObj.getDate() - (fallbackDays - 1));
  }
  if (endObj < startObj) throw new Error('El rango de fechas es inválido');
  const spanDays = Math.round((endObj - startObj) / 86400000) + 1;
  const prevEndObj = new Date(startObj); prevEndObj.setDate(prevEndObj.getDate() - 1);
  const prevStartObj = new Date(prevEndObj); prevStartObj.setDate(prevStartObj.getDate() - (spanDays - 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    start: fmt(startObj),
    end: fmt(endObj),
    startObj,
    endObj,
    spanDays,
    previous: { start: fmt(prevStartObj), end: fmt(prevEndObj), startObj: prevStartObj, endObj: prevEndObj }
  };
}

const { WebScDaily, WebScDailyAgg, WebPsiSnapshot, WebIndexCoverageDaily } = require('../../models');

// GET /web/clinica/:clinicaId/status
router.get('/clinica/:clinicaId/status', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { Op } = require('sequelize');
    const clinic = await Clinica.findByPk(clinicaId, { raw: true });
    const assets = await getClinicSiteMappings(clinicaId);
    const scLastRow = await WebScDaily.findOne({ where: { clinica_id: clinicaId }, order: [['date','DESC']], raw: true });
    const psiLast = await WebPsiSnapshot.findOne({ where: { clinica_id: clinicaId }, order: [['fetched_at','DESC']], raw: true });
    const connectionIds = Array.from(new Set(assets
      .map((asset) => Number.parseInt(String(asset.googleConnectionId || ''), 10))
      .filter((id) => Number.isInteger(id) && id > 0)));
    const tokenCache = new Map();
    const authorizationChecks = await Promise.all(assets.map(async (asset) => {
      try {
        await getAccessTokenForWebMapping(asset, tokenCache);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.code || 'web_mapping_authorization_failed' };
      }
    }));
    const authorizationFailures = authorizationChecks.filter((item) => !item.ok);
    const googleConnected = assets.length > 0 && authorizationFailures.length === 0;
    return res.json({
      success: true,
      clinic: { id: clinicaId, website: clinic?.url_web || null },
      googleConnected,
      googleConnectionStatus: {
        connected: googleConnected,
        mapped_connections: connectionIds.length,
        mapped_sites: assets.length,
        unavailable_sites: authorizationFailures.length,
        reasons: Array.from(new Set(authorizationFailures.map((item) => item.reason)))
      },
      hasAssets: assets.length > 0,
      siteUrls: assets.map(a => a.siteUrl),
      lastScDate: scLastRow?.date || null,
      lastPsiAt: psiLast?.fetched_at || null,
      lastTech: psiLast ? { https_ok: psiLast.https_ok, https_status: psiLast.https_status, sitemap_found: psiLast.sitemap_found, sitemap_url: psiLast.sitemap_url, sitemap_status: psiLast.sitemap_status } : null
    });
  } catch (e) {
    console.error('❌ /web/status:', e.message);
    return res.status(500).json({ success:false, error: 'Error obteniendo estado Web' });
  }
});

// GET /web/clinica/:clinicaId/seo/summary
router.get('/clinica/:clinicaId/seo/summary', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate } = req.query;
    let range;
    try {
      range = resolveDateRange(startDate, endDate, 30);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const { start, end, previous } = range;
    const prevStart = previous.start;
    const prevEnd = previous.end;
    const { Op } = require('sequelize');
    const rows = await WebScDaily.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [start, end] } }, raw: true });
    const prevRows = await WebScDaily.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [prevStart, prevEnd] } }, raw: true });
    const clicks = rows.reduce((acc, row) => acc + (row.clicks || 0), 0);
    const impressions = rows.reduce((acc, row) => acc + (row.impressions || 0), 0);
    const prevClicks = prevRows.reduce((acc, row) => acc + (row.clicks || 0), 0);
    const prevImpressions = prevRows.reduce((acc, row) => acc + (row.impressions || 0), 0);
    const agg = await WebScDailyAgg.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [start, end] } }, raw: true });
    const prevAgg = await WebScDailyAgg.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [prevStart, prevEnd] } }, raw: true });
    const sumAgg = (collection, field) => collection.reduce((acc, row) => acc + (row[field] || 0), 0);
    const top10 = sumAgg(agg, 'queries_top10');
    const top3 = sumAgg(agg, 'queries_top3');
    const prevTop10 = sumAgg(prevAgg, 'queries_top10');
    const prevTop3 = sumAgg(prevAgg, 'queries_top3');
    const lastDate = rows.length ? rows.map((r) => r.date).sort().slice(-1)[0] : null;
    return res.json({
      success: true,
      period: { start, end },
      comparison: { start: prevStart, end: prevEnd },
      lastUpdate: lastDate,
      kpis: {
        clicks,
        impressions,
        top10,
        top3,
        ctr: impressions > 0 ? clicks / impressions : 0
      },
      previous: {
        clicks: prevClicks,
        impressions: prevImpressions,
        top10: prevTop10,
        top3: prevTop3,
        ctr: prevImpressions > 0 ? prevClicks / prevImpressions : 0
      }
    });
  } catch (e) {
    console.error('❌ /web/seo/summary:', e.response?.data || e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo resumen SEO' });
  }
});

// GET /web/clinica/:clinicaId/analytics/overview
router.get('/clinica/:clinicaId/analytics/overview', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate } = req.query;
    let range;
    try {
      range = resolveDateRange(startDate, endDate, 90);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const { Op, fn, col } = require('sequelize');
    const { start, end, previous } = range;
    const prevStart = previous.start;
    const prevEnd = previous.end;
    const aggregate = async (rangeStart, rangeEnd) => {
      const [row] = await WebGaDaily.findAll({
        attributes: [
          [fn('SUM', col('sessions')), 'sessions'],
          [fn('SUM', col('active_users')), 'active_users'],
          [fn('SUM', col('new_users')), 'new_users'],
          [fn('SUM', col('conversions')), 'conversions'],
          [fn('SUM', col('total_revenue')), 'total_revenue']
        ],
        where: { clinica_id: clinicaId, date: { [Op.between]: [rangeStart, rangeEnd] } },
        raw: true
      });
      return row || {};
    };
    const currentTotals = await aggregate(start, end);
    const previousTotals = await aggregate(prevStart, prevEnd);
    const toNumber = (value, decimals = false) => {
      if (value === null || value === undefined) return 0;
      const num = Number(value);
      if (Number.isNaN(num)) return 0;
      return decimals ? num : Math.round(num);
    };
    const buildMetric = (current, previous, decimals = false) => {
      const curVal = toNumber(current, decimals);
      const prevVal = toNumber(previous, decimals);
      const delta = curVal - prevVal;
      const deltaPct = prevVal !== 0 ? delta / prevVal : null;
      return { current: curVal, previous: prevVal, delta, deltaPct };
    };
    return res.json({
      success: true,
      period: { start, end },
      comparison: { start: prevStart, end: prevEnd },
      metrics: {
        sessions: buildMetric(currentTotals.sessions, previousTotals.sessions),
        activeUsers: buildMetric(currentTotals.active_users, previousTotals.active_users),
        newUsers: buildMetric(currentTotals.new_users, previousTotals.new_users),
        conversions: buildMetric(currentTotals.conversions, previousTotals.conversions),
        totalRevenue: buildMetric(currentTotals.total_revenue, previousTotals.total_revenue, true)
      }
    });
  } catch (e) {
    console.error('❌ /web/analytics/overview:', e.response?.data || e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo overview de Analytics' });
  }
});

// GET /web/clinica/:clinicaId/analytics/timeseries
router.get('/clinica/:clinicaId/analytics/timeseries', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate, metric = 'sessions' } = req.query;
    const allowedMetrics = {
      sessions: 'sessions',
      activeUsers: 'active_users',
      newUsers: 'new_users',
      conversions: 'conversions'
    };
    const column = allowedMetrics[metric] || allowedMetrics.sessions;
    let range;
    try {
      range = resolveDateRange(startDate, endDate, 90);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const { Op } = require('sequelize');
    const { start, end, previous } = range;
    const prevStart = previous.start;
    const prevEnd = previous.end;
    const fetchSeries = async (rangeStart, rangeEnd) => {
      const rows = await WebGaDaily.findAll({
        attributes: ['date', column],
        where: { clinica_id: clinicaId, date: { [Op.between]: [rangeStart, rangeEnd] } },
        order: [['date', 'ASC']],
        raw: true
      });
      return rows.map((row) => ({ date: row.date, value: Number(row[column] || 0) }));
    };
    const currentSeries = await fetchSeries(start, end);
    const previousSeries = await fetchSeries(prevStart, prevEnd);
    return res.json({
      success: true,
      metric,
      period: { start, end },
      comparison: { start: prevStart, end: prevEnd },
      current: currentSeries,
      previous: previousSeries
    });
  } catch (e) {
    console.error('❌ /web/analytics/timeseries:', e.response?.data || e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo serie temporal de Analytics' });
  }
});

// GET /web/clinica/:clinicaId/analytics/dimensions/:dimension
router.get('/clinica/:clinicaId/analytics/dimensions/:dimension', async (req, res) => {
  try {
    const { clinicaId, dimension } = req.params;
    const { startDate, endDate, limit = 25 } = req.query;
    const dimensionMap = {
      channel: 'channel',
      source_medium: 'source_medium',
      device: 'device',
      country: 'country',
      city: 'city',
      language: 'language',
      gender: 'gender',
      age: 'age'
    };
    const dimensionType = dimensionMap[dimension];
    if (!dimensionType) {
      return res.status(400).json({ success: false, error: 'Dimension no soportada' });
    }
    let range;
    try {
      range = resolveDateRange(startDate, endDate, 90);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const { Op, fn, col } = require('sequelize');
    const { start, end } = range;
    const max = Math.min(Number(limit) || 25, 100);
    const rows = await WebGaDimensionDaily.findAll({
      attributes: [
        'dimension_value',
        [fn('SUM', col('sessions')), 'sessions'],
        [fn('SUM', col('active_users')), 'active_users'],
        [fn('SUM', col('conversions')), 'conversions'],
        [fn('SUM', col('total_revenue')), 'total_revenue']
      ],
      where: { clinica_id: clinicaId, dimension_type: dimensionType, date: { [Op.between]: [start, end] } },
      group: ['dimension_value'],
      order: [[fn('SUM', col('sessions')), 'DESC']],
      limit: max,
      raw: true
    });
    const items = rows.map((row) => ({
      dimension: row.dimension_value,
      sessions: Number(row.sessions || 0),
      activeUsers: Number(row.active_users || 0),
      conversions: Number(row.conversions || 0),
      totalRevenue: Number(row.total_revenue || 0)
    }));
    return res.json({ success: true, period: { start, end }, items });
  } catch (e) {
    console.error('❌ /web/analytics/dimensions:', e.response?.data || e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo desglose de Analytics' });
  }
});

// GET /web/clinica/:clinicaId/sc/queries
router.get('/clinica/:clinicaId/sc/queries', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end = endDate || new Date().toISOString().slice(0, 10);
    const max = Math.max(1, Math.min(Number(limit) || 10, 100));

    const topQueries = await sequelize.query(
      `SELECT query,
              SUM(clicks) AS clicks,
              SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END AS position
       FROM WebScQueryDaily
       WHERE clinica_id = :clinicaId AND date BETWEEN :start AND :end
       GROUP BY query
       ORDER BY SUM(clicks) DESC
       LIMIT :limit;`,
      {
        replacements: { clinicaId, start, end, limit: max },
        type: db.Sequelize.QueryTypes.SELECT
      }
    );

    if (!topQueries.length) {
      return res.json({ success: true, items: [], total: 0, period: { start, end } });
    }

    const queryNames = topQueries.map((q) => q.query);
    const pagesRaw = await sequelize.query(
      `SELECT query,
              COALESCE(page_url, '') AS page_url,
              SUM(clicks) AS clicks,
              SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END AS position
       FROM WebScQueryDaily
       WHERE clinica_id = :clinicaId AND date BETWEEN :start AND :end AND query IN (:queries)
       GROUP BY query, page_url;`,
      {
        replacements: { clinicaId, start, end, queries: queryNames },
        type: db.Sequelize.QueryTypes.SELECT
      }
    );

    const pagesByQuery = new Map();
    for (const row of pagesRaw) {
      const url = row.page_url || null;
      if (!url) continue;
      if (!pagesByQuery.has(row.query)) {
        pagesByQuery.set(row.query, []);
      }
      pagesByQuery.get(row.query).push({
        url,
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctr: Number(row.impressions || 0) ? Number(row.clicks || 0) / Number(row.impressions || 0) : 0,
        position: row.position !== null && row.position !== undefined ? Number(row.position) : null
      });
    }

    const items = topQueries.map((entry) => {
      const clicks = Number(entry.clicks || 0);
      const impressions = Number(entry.impressions || 0);
      const ctr = impressions ? clicks / impressions : 0;
      const position = entry.position !== null && entry.position !== undefined ? Number(entry.position) : null;
      const pages = (pagesByQuery.get(entry.query) || [])
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 5);
      return {
        query: entry.query,
        clicks,
        impressions,
        ctr,
        position,
        pages
      };
    });

    return res.json({ success: true, items, total: items.length, period: { start, end } });
  } catch (e) {
    console.error('❌ /web/sc/queries:', e.message);
    return res.status(500).json({ success: false, error: 'Error consultando queries' });
  }
});

// GET /web/clinica/:clinicaId/sc/pages
router.get('/clinica/:clinicaId/sc/pages', async (req, res) => {
  try {
    const { clinicaId } = req.params; const { startDate, endDate, limit=100, offset=0 } = req.query;
    const start = startDate || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const end = endDate || new Date().toISOString().slice(0,10);
    const mappings = await getClinicSiteMappings(clinicaId);
    const tokenCache = new Map();
    const out = [];
    const authorizationErrors = [];
    for (const mapping of mappings) {
      const siteUrl = mapping.siteUrl;
      try {
        const { accessToken } = await getAccessTokenForWebMapping(mapping, tokenCache);
        const resp = await axios.post(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
          startDate: start, endDate: end, dimensions: ['page'], rowLimit: Number(limit), startRow: Number(offset)
        }, { headers: { Authorization: `Bearer ${accessToken}` } });
        (resp.data?.rows||[]).forEach(r=>out.push({ page: r.keys?.[0]||'', clicks: r.clicks||0, impressions: r.impressions||0, ctr: r.ctr||0, position: r.position||0 }));
      } catch (error) {
        authorizationErrors.push({
          site_url: siteUrl,
          reason: error.code || 'search_console_request_failed'
        });
      }
    }
    if (!out.length && authorizationErrors.length === mappings.length) {
      return res.status(409).json({
        success: false,
        error: 'web_mapping_authorization_unavailable',
        authorization_errors: authorizationErrors
      });
    }
    return res.json({
      success:true,
      items: out,
      total: out.length,
      partial: authorizationErrors.length > 0,
      authorization_errors: authorizationErrors
    });
  } catch (e) {
    console.error('❌ /web/sc/pages:', e.response?.data || e.message);
    return res.status(500).json({ success:false, error:'Error consultando páginas' });
  }
});

// GET /web/clinica/:clinicaId/psi/latest (live) y /psi/snapshot (BD)
router.get('/clinica/:clinicaId/psi/latest', async (req, res) => {
  try {
    const { clinicaId } = req.params; const key = process.env.GOOGLE_PSI_API_KEY || '';
    const mappings = await getClinicSiteMappings(clinicaId);
    const primaryMapping = selectPrimarySiteMapping(mappings);
    const url = primaryMapping.siteUrl.startsWith('http')
      ? primaryMapping.siteUrl
      : primaryMapping.siteUrl.replace('sc-domain:','https://');
    const params = { url, strategy: 'mobile', category: ['performance','accessibility'] };
    if (key) params['key'] = key;
    const resp = await axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', { params });
    const lr = resp.data?.lighthouseResult || {};
    const cats = lr.categories || {};
    // Extract Core Web Vitals
    const audits = lr.audits || {};
    const lcp = audits['largest-contentful-paint']?.numericValue || null;
    const cls = audits['cumulative-layout-shift']?.numericValue || null;
    const inp = audits['interaction-to-next-paint']?.numericValue || null;
    return res.json({ success:true, url, scores:{ performance: (cats.performance?.score||0)*100, accessibility: (cats.accessibility?.score||0)*100 }, cwv:{ lcp_ms:lcp, cls, inp_ms:inp } });
  } catch (e) {
    console.error('❌ /web/psi/latest:', e.response?.data || e.message);
    return res.status(500).json({ success:false, error:'Error ejecutando PSI' });
  }
});

router.get('/clinica/:clinicaId/psi/snapshot', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const snap = await WebPsiSnapshot.findOne({ where: { clinica_id: clinicaId }, order: [['fetched_at','DESC']], raw: true });
    if (!snap) return res.json({ success:false, error:'No snapshot' });
    return res.json({ success:true, url: snap.url, scores: { performance: snap.performance, accessibility: snap.accessibility }, cwv: { lcp_ms: snap.lcp_ms, cls: snap.cls, inp_ms: snap.inp_ms }, indexed_ok: snap.indexed_ok, fetched_at: snap.fetched_at });
  } catch (e) {
    console.error('❌ /web/psi/snapshot:', e.message);
    return res.status(500).json({ success:false, error:'Error leyendo snapshot PSI' });
  }
});

// POST /web/clinica/:clinicaId/psi/refresh → fuerza snapshot PSI + devuelve snapshot y checks técnicos
router.post('/clinica/:clinicaId/psi/refresh', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const mappings = await getClinicSiteMappings(clinicaId);
    const primaryMapping = selectPrimarySiteMapping(mappings);
    const siteUrl = primaryMapping.siteUrl.startsWith('http')
      ? primaryMapping.siteUrl
      : ('https://' + primaryMapping.siteUrl.replace('sc-domain:',''));

    // PSI live
    const params = { url: siteUrl, strategy: 'mobile', category: ['performance','accessibility'] };
    if (process.env.GOOGLE_PSI_API_KEY) params['key'] = process.env.GOOGLE_PSI_API_KEY;
    let snapshot = null; let tech = {};
    try {
      const psi = await axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', { params });
      const lr = psi.data?.lighthouseResult || {};
      // HTTPS check (previo a persistir)
      let https_ok = null, https_status = null, sitemap_found = null, sitemap_url = null, sitemap_status = null;
      try {
        const origin = new URL(siteUrl).origin;
        const r = await axios.get(origin, { timeout: 3500, maxRedirects: 2, validateStatus: ()=>true });
        https_status = r.status; https_ok = (r.status>=200 && r.status<400);
      } catch (e) { https_ok = false; https_status = null; }
      // Sitemap check
      try {
        const origin = new URL(siteUrl).origin;
        const cands = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
        for (const u of cands) {
          try { const h = await axios.head(u, { timeout: 2500, validateStatus: ()=>true }); if (h.status>=200 && h.status<400) { sitemap_found=true; sitemap_url=u; sitemap_status=h.status; break; } } catch {}
        }
        if (sitemap_found !== true) { sitemap_found = false; }
      } catch {}

      // Index status (1 URL via URL Inspection API)
      let indexed_ok = null;
      try {
        const { accessToken } = await getAccessTokenForWebMapping(primaryMapping);
        const siteProperty = primaryMapping.siteUrl;
        const inspectUrl = siteUrl.startsWith('http') ? siteUrl : ('https://' + siteUrl.replace('sc-domain:',''));
        const inspectEndpoint = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
        const respI = await axios.post(inspectEndpoint, { inspectionUrl: inspectUrl, siteUrl: siteProperty }, { headers: { Authorization: `Bearer ${accessToken}` } });
        const verdict = respI.data?.inspectionResult?.indexStatusResult?.verdict || '';
        const coverageState = respI.data?.inspectionResult?.indexStatusResult?.coverageState || '';
        indexed_ok = (String(verdict).toUpperCase() === 'PASS') || /indexed/i.test(String(coverageState));
      } catch {}

      snapshot = await db.WebPsiSnapshot.create({
        clinica_id: clinicaId,
        url: siteUrl,
        fetched_at: new Date(),
        performance: Math.round((lr.categories?.performance?.score||0)*100),
        accessibility: Math.round((lr.categories?.accessibility?.score||0)*100),
        lcp_ms: lr.audits?.['largest-contentful-paint']?.numericValue || null,
        cls: lr.audits?.['cumulative-layout-shift']?.numericValue || null,
        inp_ms: lr.audits?.['interaction-to-next-paint']?.numericValue || null,
        https_ok, https_status, sitemap_found, sitemap_url, sitemap_status,
        indexed_ok
      }, { returning: true });
    } catch (e) {
      return res.status(429).json({ success:false, error: e.response?.data?.error?.message || e.message });
    }

    tech['https_reach'] = { url: new URL(snapshot.url).origin, status: snapshot.https_status, ok: snapshot.https_ok };
    tech['sitemap'] = { found: snapshot.sitemap_found, url: snapshot.sitemap_url, status: snapshot.sitemap_status };

    return res.json({ success:true, snapshot: {
      url: snapshot.url,
      fetched_at: snapshot.fetched_at,
      scores: { performance: snapshot.performance, accessibility: snapshot.accessibility },
      cwv: { lcp_ms: snapshot.lcp_ms, cls: snapshot.cls, inp_ms: snapshot.inp_ms },
      indexed_ok: snapshot.indexed_ok
    }, tech });
  } catch (e) {
    console.error('❌ /web/psi/refresh:', e.message);
    return res.status(500).json({ success:false, error:'Error refrescando PSI' });
  }
});

// GET /web/clinica/:clinicaId/seo/timeseries (lee desde BD)
router.get('/clinica/:clinicaId/seo/timeseries', async (req, res) => {
  try {
    const { clinicaId } = req.params; const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const end = endDate || new Date().toISOString().slice(0,10);
    const { Op } = require('sequelize');
    const rows = await WebScDaily.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [start, end] } }, raw: true });
    const byDate = new Map();
    for (const r of rows) {
      const d = r.date;
      const cur = byDate.get(d) || { clicks:0, impressions:0, posW:0, w:0 };
      cur.clicks += r.clicks || 0;
      cur.impressions += r.impressions || 0;
      if (typeof r.position === 'number' && r.impressions != null) {
        cur.posW += Number(r.position) * Number(r.impressions || 1);
        cur.w += Number(r.impressions || 1);
      }
      byDate.set(d, cur);
    }
    const series = Array.from(byDate.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,v]) => ({
      date,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions>0 ? (v.clicks / v.impressions) : 0,
      position: v.w>0 ? (v.posW / v.w) : null
    }));
    return res.json({ success:true, period:{ start, end }, series });
  } catch (e) {
    console.error('❌ /web/seo/timeseries:', e.response?.data || e.message);
    return res.status(500).json({ success:false, error:'Error obteniendo serie diaria' });
  }
});

// GET /web/clinica/:clinicaId/seo/health
router.get('/clinica/:clinicaId/seo/health', async (req, res) => {
  try {
    const { clinicaId } = req.params; const { startDate, endDate } = req.query;
    const end = endDate || new Date().toISOString().slice(0,10);
    const start = startDate || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const startD = new Date(start), endD = new Date(end);
    const days = Math.max(1, Math.round((endD - startD)/86400000) + 1);
    const prevEnd = new Date(startD.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (days-1)*86400000);
    const fmt = (d)=>d.toISOString().slice(0,10);
    const siteMappings = await getClinicSiteMappings(clinicaId);
    const primarySiteMapping = selectPrimarySiteMapping(siteMappings);
    const primarySiteUrl = primarySiteMapping.siteUrl.startsWith('http')
      ? primarySiteMapping.siteUrl
      : ('https://' + primarySiteMapping.siteUrl.replace('sc-domain:','').replace(/^https?:\/\//,''));

    // Agregados desde BD (WebScDaily) para periodo actual y previo
    const { Op } = require('sequelize');
    async function aggregateRangeDB(s, e) {
      const rows = await WebScDaily.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [s, e] } }, raw: true });
      let clicks=0, impressions=0, posW=0, w=0;
      for (const r of rows) {
        clicks += r.clicks||0; impressions += r.impressions||0;
        if (typeof r.position === 'number' && r.impressions != null) { posW += Number(r.position) * Number(r.impressions||1); w += Number(r.impressions||1); }
      }
      const avgPos = w>0 ? posW/w : null;
      return { clicks, impressions, avgPos };
    }

    const cur = await aggregateRangeDB(start, end);
    const prev = await aggregateRangeDB(fmt(prevStart), fmt(prevEnd));

    const rules = [];
    // Tráfico: caída >=30%
    if (prev.clicks>0 && cur.clicks < 0.7*prev.clicks) {
      rules.push({ id:'traffic_drop_30', status:'warning', message:'Caída ≥30% de clicks vs período previo', details:{ cur: cur.clicks, prev: prev.clicks } });
    } else {
      rules.push({ id:'traffic_drop_30', status:'ok', message:'Tráfico estable', details:{ cur: cur.clicks, prev: prev.clicks } });
    }
    // Posición media: empeora ≥30%
    if (prev.avgPos && cur.avgPos && cur.avgPos > 1.3*prev.avgPos) {
      rules.push({ id:'position_drop_30', status:'warning', message:'Empeora ≥30% posición media', details:{ cur: cur.avgPos, prev: prev.avgPos } });
    } else {
      rules.push({ id:'position_drop_30', status:'ok', message:'Posición estable', details:{ cur: cur.avgPos, prev: prev.avgPos } });
    }
    // CLS (desde snapshot PSI si existe; evita cuota live)
    let clsStatus = 'unknown'; let clsVal = null;
    try {
      const snap = await WebPsiSnapshot.findOne({ where: { clinica_id: clinicaId }, order: [['fetched_at','DESC']], raw: true });
      if (snap && snap.cls!=null) { clsVal = Number(snap.cls); clsStatus = clsVal > 0.1 ? 'warning' : 'ok'; }
    } catch { clsStatus = 'unknown'; }
    rules.push({ id:'cwv_cls', status: clsStatus, message: 'CLS (PSI)', details:{ cls: clsVal } });

    // HTTPS reachability
    try {
      const testUrl = new URL(primarySiteUrl).origin;
      const resp = await axios.get(testUrl, { timeout: 3500, maxRedirects: 2, validateStatus: ()=>true });
      const ok = (resp.status >= 200 && resp.status < 400);
      rules.push({ id:'https_reach', status: ok ? 'ok' : 'warning', message: 'Sitio accesible por HTTPS', details:{ url: testUrl, status: resp.status } });
    } catch (e) {
      rules.push({ id:'https_reach', status: 'warning', message: 'Sitio accesible por HTTPS', details:{ error: e.message } });
    }

    // Sitemap presence
    try {
      const origin = new URL(primarySiteUrl).origin;
      const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
      let found = false; let code = null; let urlOk = null;
      for (const u of candidates) {
        try {
          const r = await axios.head(u, { timeout: 2500, validateStatus: ()=>true });
          code = r.status; if (r.status >= 200 && r.status < 400) { found = true; urlOk = u; break; }
        } catch {}
      }
      rules.push({ id:'sitemap_presence', status: found ? 'ok' : 'warning', message:'Sitemap accesible', details:{ url: urlOk, status: code } });
    } catch { rules.push({ id:'sitemap_presence', status:'unknown', message:'Sitemap accesible', details:{} }); }

    return res.json({ success:true, period:{ start, end, prevStart: fmt(prevStart), prevEnd: fmt(prevEnd) }, rules });
  } catch (e) {
    console.error('❌ /web/seo/health:', e.response?.data || e.message);
    return res.status(500).json({ success:false, error:'Error obteniendo health SEO' });
  }
});

// GET /web/clinica/:clinicaId/coverage/timeseries (BD)
router.get('/clinica/:clinicaId/coverage/timeseries', async (req, res) => {
  try {
    const { clinicaId } = req.params; const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const end = endDate || new Date().toISOString().slice(0,10);
    const { Op } = require('sequelize');
    const rows = await WebIndexCoverageDaily.findAll({ where: { clinica_id: clinicaId, date: { [Op.between]: [start, end] } }, raw: true, order: [['date','ASC']] });
    const series = (rows||[]).map(r => ({ date: r.date, indexed: r.indexed_count||0, nonIndexed: r.nonindexed_count||0 }));
    return res.json({ success: true, period: { start, end }, series });
  } catch (e) {
    console.error('❌ /web/coverage/timeseries:', e.message);
    return res.status(500).json({ success:false, error:'Error obteniendo cobertura' });
  }
});

router.__test = {
  getAccessTokenForWebMapping,
  getClinicSiteMappings,
  getGoogleAccessTokenForConnection,
  selectPrimarySiteMapping
};

module.exports = router;
