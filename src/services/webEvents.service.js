'use strict';

const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const db = require('../../models');

const {
  WebEvent,
  WebPageDaily,
  WebClickDaily,
  WebSessionDaily,
  sequelize,
} = db;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AGGREGATE_DAYS = Number(process.env.WEB_EVENTS_AGGREGATE_DAYS || 3);
const DEFAULT_RETENTION_DAYS = Number(process.env.WEB_EVENTS_RETENTION_DAYS || 120);

function cleanString(value, max = 1024) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value, fallback = new Date()) {
  if (!value) return fallback;
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function dateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function hashValue(value) {
  const raw = cleanString(value, 4096);
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req?.socket?.remoteAddress || req?.ip || null;
}

function boolFromConsent(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'si', 'sí', 'granted', 'accept', 'accepted', 'allow', 'allowed'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'denied', 'reject', 'rejected', 'deny', 'blocked'].includes(normalized)) return false;
  return null;
}

function normalizeConsent(raw) {
  const consent = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const analytics = boolFromConsent(consent.analytics ?? consent.analytics_storage ?? consent.analyticsStorage);
  const marketing = boolFromConsent(consent.marketing ?? consent.ad_storage ?? consent.adStorage);
  const adUserData = boolFromConsent(consent.ad_user_data ?? consent.adUserData ?? consent.user_data ?? consent.userData ?? marketing);
  const adPersonalization = boolFromConsent(consent.ad_personalization ?? consent.adPersonalization ?? consent.personalization ?? marketing);
  return {
    analytics,
    marketing,
    adUserData,
    adPersonalization,
    json: Object.keys(consent).length ? consent : null,
  };
}

function normalizeEventType(eventName) {
  const name = String(eventName || '').trim().toLowerCase();
  if (['viewcontent', 'page_view', 'pageview', 'page_viewed'].includes(name)) return 'page_view';
  if (['callinitiated', 'phone_click', 'tel_click', 'click_phone', 'click_tel'].includes(name)) return 'tel_click';
  if (['whatsapp_click', 'click_whatsapp', 'openwhatsapp', 'whatsappstarted'].includes(name)) return 'whatsapp_click';
  if (['form_submit', 'formsubmitted', 'submitform'].includes(name)) return 'form_submit';
  if (['consentupdate', 'consent_update'].includes(name)) return 'consent_update';
  if (name.startsWith('click')) return 'click';
  return name || 'event';
}

function parsePagePath(pageUrl) {
  try {
    const url = new URL(String(pageUrl || ''));
    return cleanString(url.pathname || '/', 512);
  } catch (_error) {
    return cleanString(pageUrl, 512);
  }
}

function shouldStoreEvent({ cfgRecord, consent, eventType }) {
  const config = cfgRecord?.config && typeof cfgRecord.config === 'object' ? cfgRecord.config : {};
  const features = config.features && typeof config.features === 'object' ? config.features : {};
  if (features.webevents_enabled === false) return false;

  const consentModeEnabled = features.consent_mode_enabled === true;
  if (!consentModeEnabled) return true;

  // Si el usuario tiene Consent Mode activo, respetamos analytics para medición propia.
  // Eventos de consentimiento se conservan para auditoría técnica sin contar como visitas.
  if (eventType === 'consent_update') return true;
  return consent.analytics === true;
}

async function recordWebEvent({ req, body, cfgRecord, clinicId, groupId, eventName, eventSourceUrl, customData }) {
  if (!WebEvent) return { stored: false, reason: 'model_missing' };

  const eventData = body?.event_data && typeof body.event_data === 'object' && !Array.isArray(body.event_data)
    ? body.event_data
    : {};
  const custom = customData && typeof customData === 'object' ? customData : {};
  const consent = normalizeConsent(body?.consent || custom.consent || eventData.consent || null);
  const eventType = normalizeEventType(eventName);

  if (!shouldStoreEvent({ cfgRecord, consent, eventType })) {
    return { stored: false, reason: 'consent_or_feature_disabled' };
  }

  const pageUrl = cleanString(eventSourceUrl || body?.page_url || body?.pageUrl || eventData.page_url || eventData.pageUrl, 1024);
  const occurredAt = parseDate(body?.event_time || body?.occurred_at || eventData.occurred_at || eventData.timestamp, new Date());

  const row = await WebEvent.create({
    clinic_id: parseInteger(clinicId),
    group_id: parseInteger(groupId),
    event_name: cleanString(eventName || 'ViewContent', 80) || 'ViewContent',
    event_type: eventType,
    event_id: cleanString(body?.event_id || body?.eventId || eventData.event_id, 128),
    session_id: cleanString(body?.session_id || body?.sessionId || eventData.session_id, 128),
    visitor_id: cleanString(body?.visitor_id || body?.visitorId || eventData.visitor_id, 128),
    domain: cleanString(body?.domain || eventData.domain, 255),
    page_url: pageUrl,
    page_path: parsePagePath(pageUrl),
    page_title: cleanString(eventData.page_title || eventData.pageTitle || custom.page_title, 512),
    referrer: cleanString(body?.referrer || eventData.referrer, 1024),
    utm_source: cleanString(body?.utm_source || custom.utm_source, 128),
    utm_medium: cleanString(body?.utm_medium || custom.utm_medium, 128),
    utm_campaign: cleanString(body?.utm_campaign || custom.utm_campaign, 255),
    utm_content: cleanString(body?.utm_content || custom.utm_content, 255),
    utm_term: cleanString(body?.utm_term || custom.utm_term, 255),
    gclid: cleanString(body?.gclid || custom.gclid, 255),
    fbclid: cleanString(body?.fbclid || custom.fbclid, 255),
    ttclid: cleanString(body?.ttclid || custom.ttclid, 255),
    msclkid: cleanString(body?.msclkid || custom.msclkid, 255),
    consent_analytics: consent.analytics,
    consent_marketing: consent.marketing,
    consent_ad_user_data: consent.adUserData,
    consent_ad_personalization: consent.adPersonalization,
    consent_json: consent.json,
    user_agent_hash: hashValue(req?.headers?.['user-agent']),
    ip_hash: hashValue(getClientIp(req)),
    screen_width: parseInteger(eventData.screen_width || eventData.screenWidth),
    screen_height: parseInteger(eventData.screen_height || eventData.screenHeight),
    viewport_width: parseInteger(eventData.viewport_width || eventData.viewportWidth),
    viewport_height: parseInteger(eventData.viewport_height || eventData.viewportHeight),
    language: cleanString(eventData.language || body?.language, 32),
    metadata: Object.keys(eventData).length ? eventData : null,
    occurred_at: occurredAt,
  });

  return { stored: true, id: row.id };
}

function buildDateRange(options = {}) {
  const end = options.end ? startOfUtcDay(parseDate(options.end)) : startOfUtcDay(new Date());
  const start = options.start
    ? startOfUtcDay(parseDate(options.start))
    : addDays(end, -Math.max(DEFAULT_AGGREGATE_DAYS - 1, 0));
  return { start, end, endExclusive: addDays(end, 1) };
}

function scopeWhere(options = {}) {
  const where = {};
  if (options.clinicId || options.clinicaId) where.clinic_id = Number(options.clinicId || options.clinicaId);
  if (options.groupId) where.group_id = Number(options.groupId);
  return where;
}

async function aggregateWebEvents(options = {}) {
  if (!WebEvent || !WebPageDaily || !WebClickDaily || !WebSessionDaily) {
    return { processed: 0, reason: 'models_missing' };
  }

  const range = buildDateRange(options);
  const where = {
    ...scopeWhere(options),
    occurred_at: { [Op.gte]: range.start, [Op.lt]: range.endExclusive },
  };

  const pageRows = await WebEvent.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.col('occurred_at')), 'date'],
      'clinic_id', 'group_id', 'domain', 'page_url', 'page_path',
      [sequelize.fn('MAX', sequelize.col('page_title')), 'page_title'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='page_view' THEN 1 ELSE 0 END")), 'pageviews'],
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('session_id'))), 'unique_sessions'],
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('visitor_id'))), 'unique_visitors'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='tel_click' THEN 1 ELSE 0 END")), 'tel_clicks'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='whatsapp_click' THEN 1 ELSE 0 END")), 'whatsapp_clicks'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='form_submit' THEN 1 ELSE 0 END")), 'form_submits'],
    ],
    where,
    group: ['date', 'clinic_id', 'group_id', 'domain', 'page_url', 'page_path'],
    raw: true,
  });

  const clickRows = await WebEvent.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.col('occurred_at')), 'date'],
      'clinic_id', 'group_id', 'domain', 'page_url',
      [sequelize.col('event_type'), 'click_type'],
      [sequelize.fn('MAX', sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.target'))")), 'target'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'clicks'],
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('session_id'))), 'unique_sessions'],
    ],
    where: { ...where, event_type: { [Op.in]: ['tel_click', 'whatsapp_click', 'click', 'form_submit'] } },
    group: ['date', 'clinic_id', 'group_id', 'domain', 'page_url', 'event_type'],
    raw: true,
  });

  const sessionRows = await WebEvent.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.col('occurred_at')), 'date'],
      'clinic_id', 'group_id', 'domain',
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('session_id'))), 'sessions'],
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('visitor_id'))), 'visitors'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='page_view' THEN 1 ELSE 0 END")), 'pageviews'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='tel_click' THEN 1 ELSE 0 END")), 'tel_clicks'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='whatsapp_click' THEN 1 ELSE 0 END")), 'whatsapp_clicks'],
      [sequelize.fn('SUM', sequelize.literal("CASE WHEN event_type='form_submit' THEN 1 ELSE 0 END")), 'form_submits'],
    ],
    where,
    group: ['date', 'clinic_id', 'group_id', 'domain'],
    raw: true,
  });

  const deleteWhere = {
    ...scopeWhere(options),
    date: { [Op.gte]: dateOnly(range.start), [Op.lte]: dateOnly(range.end) },
  };
  await Promise.all([
    WebPageDaily.destroy({ where: deleteWhere }),
    WebClickDaily.destroy({ where: deleteWhere }),
    WebSessionDaily.destroy({ where: deleteWhere }),
  ]);

  const now = new Date();
  await WebPageDaily.bulkCreate(pageRows.map((row) => ({
    clinic_id: parseInteger(row.clinic_id),
    group_id: parseInteger(row.group_id),
    date: dateOnly(row.date),
    domain: cleanString(row.domain, 255),
    page_url: cleanString(row.page_url, 1024),
    page_path: cleanString(row.page_path, 512),
    page_title: cleanString(row.page_title, 512),
    pageviews: Number(row.pageviews || 0),
    unique_sessions: Number(row.unique_sessions || 0),
    unique_visitors: Number(row.unique_visitors || 0),
    tel_clicks: Number(row.tel_clicks || 0),
    whatsapp_clicks: Number(row.whatsapp_clicks || 0),
    form_submits: Number(row.form_submits || 0),
    leads: 0,
    created_at: now,
    updated_at: now,
  })));

  await WebClickDaily.bulkCreate(clickRows.map((row) => ({
    clinic_id: parseInteger(row.clinic_id),
    group_id: parseInteger(row.group_id),
    date: dateOnly(row.date),
    domain: cleanString(row.domain, 255),
    page_url: cleanString(row.page_url, 1024),
    click_type: cleanString(row.click_type, 80) || 'click',
    target: cleanString(row.target, 512),
    clicks: Number(row.clicks || 0),
    unique_sessions: Number(row.unique_sessions || 0),
    created_at: now,
    updated_at: now,
  })));

  await WebSessionDaily.bulkCreate(sessionRows.map((row) => ({
    clinic_id: parseInteger(row.clinic_id),
    group_id: parseInteger(row.group_id),
    date: dateOnly(row.date),
    domain: cleanString(row.domain, 255),
    sessions: Number(row.sessions || 0),
    visitors: Number(row.visitors || 0),
    pageviews: Number(row.pageviews || 0),
    tel_clicks: Number(row.tel_clicks || 0),
    whatsapp_clicks: Number(row.whatsapp_clicks || 0),
    form_submits: Number(row.form_submits || 0),
    created_at: now,
    updated_at: now,
  })));

  return {
    processed: pageRows.length + clickRows.length + sessionRows.length,
    pages: pageRows.length,
    clicks: clickRows.length,
    sessions: sessionRows.length,
    start: dateOnly(range.start),
    end: dateOnly(range.end),
  };
}

async function cleanupWebEvents(options = {}) {
  if (!WebEvent) return { deleted: 0 };
  const days = Number(options.retentionDays || DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0, reason: 'disabled' };
  const cutoff = addDays(startOfUtcDay(new Date()), -days);
  const deleted = await WebEvent.destroy({ where: { occurred_at: { [Op.lt]: cutoff } } });
  return { deleted, cutoff: dateOnly(cutoff) };
}

async function getFirstPartySummary(scope, range) {
  if (!WebSessionDaily || !WebPageDaily) {
    return { connected: false, sessions: 0, visitors: 0, pageviews: 0, telClicks: 0, whatsappClicks: 0, formSubmits: 0, lastDate: null };
  }
  const replacements = {
    start: range.startLabel,
    end: range.endLabel,
  };
  let scopeSql = '';
  if (scope?.scope === 'clinic' && Array.isArray(scope.clinicIds) && scope.clinicIds.length) {
    scopeSql = `AND clinic_id IN (:clinicIds)`;
    replacements.clinicIds = scope.clinicIds;
  } else if (scope?.scope === 'group' && scope.groupId) {
    scopeSql = `AND group_id = :groupId`;
    replacements.groupId = scope.groupId;
  }

  const [summary] = await sequelize.query(
    `SELECT COALESCE(SUM(sessions),0) AS sessions,
            COALESCE(SUM(visitors),0) AS visitors,
            COALESCE(SUM(pageviews),0) AS pageviews,
            COALESCE(SUM(tel_clicks),0) AS telClicks,
            COALESCE(SUM(whatsapp_clicks),0) AS whatsappClicks,
            COALESCE(SUM(form_submits),0) AS formSubmits,
            MAX(date) AS lastDate
       FROM WebSessionDaily
      WHERE date >= :start AND date <= :end ${scopeSql}`,
    { replacements, type: QueryTypes.SELECT }
  );

  const totals = {
    sessions: Number(summary?.sessions || 0),
    visitors: Number(summary?.visitors || 0),
    pageviews: Number(summary?.pageviews || 0),
    telClicks: Number(summary?.telClicks || 0),
    whatsappClicks: Number(summary?.whatsappClicks || 0),
    formSubmits: Number(summary?.formSubmits || 0),
  };

  return {
    connected: Object.values(totals).some((value) => value > 0),
    ...totals,
    lastDate: summary?.lastDate || null,
  };
}

module.exports = {
  recordWebEvent,
  aggregateWebEvents,
  cleanupWebEvents,
  getFirstPartySummary,
};
