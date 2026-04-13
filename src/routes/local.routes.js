'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../../models');
const ClinicBusinessLocation = db.ClinicBusinessLocation;
const BusinessProfileDailyMetric = db.BusinessProfileDailyMetric;
const BusinessProfileReview = db.BusinessProfileReview;
const BusinessProfilePost = db.BusinessProfilePost;

const LOCAL_METRIC_GROUPS = {
  profile_views: [
    'BUSINESS_IMPRESSIONS_TOTAL',
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
  ],
  search_views: [
    'BUSINESS_IMPRESSIONS_SEARCH',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
  ],
  map_views: [
    'BUSINESS_IMPRESSIONS_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS'
  ],
  call_clicks: ['BUSINESS_CONVERSIONS_CALL_CLICKS', 'CALL_CLICKS'],
  direction_clicks: ['BUSINESS_CONVERSIONS_DIRECTIONS', 'BUSINESS_DIRECTION_REQUESTS'],
  website_clicks: ['BUSINESS_CONVERSIONS_WEBSITE_CLICKS', 'WEBSITE_CLICKS']
};

function sumMetricGroup(rows, metrics) {
  const allowed = new Set(Array.isArray(metrics) ? metrics : [metrics]);
  return rows
    .filter((row) => allowed.has(row.metric_type))
    .reduce((acc, cur) => acc + (cur.value || 0), 0);
}

function resolveDateRange(startDate, endDate, fallbackDays = 90) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parse = (value, fallback) => {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return fallback;
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  };
  const end = parse(endDate, today);
  const fallbackStart = new Date(end);
  fallbackStart.setDate(fallbackStart.getDate() - (fallbackDays - 1));
  const start = parse(startDate, fallbackStart);
  if (end < start) throw new Error('Date range invalid');
  const spanDays = Math.round((end - start) / 86400000) + 1;
  const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (spanDays - 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    start: fmt(start),
    end: fmt(end),
    previous: { start: fmt(prevStart), end: fmt(prevEnd) },
    startObj: start,
    endObj: end
  };
}

router.get('/clinica/:clinicaId/status', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const locations = await ClinicBusinessLocation.findAll({ where: { clinica_id: clinicaId, is_active: true }, order: [['location_name', 'ASC']] });
    const mapped = locations.map((loc) => {
      const raw = loc.raw_payload && typeof loc.raw_payload === 'object' ? loc.raw_payload : {};
      const address = raw.storefrontAddress || raw.address || {};
      const addressLines = Array.isArray(address.addressLines) ? address.addressLines : [];
      return {
        id: loc.id,
        locationId: loc.location_id,
        name: loc.location_name,
        storeCode: loc.store_code,
        primaryCategory: loc.primary_category,
        verified: loc.is_verified,
        suspended: loc.is_suspended,
        syncStatus: loc.sync_status,
        lastSyncedAt: loc.last_synced_at,
        websiteUri: raw.websiteUri || null,
        phone: raw.phoneNumbers?.primaryPhone || null,
        address: {
          lines: addressLines,
          postalCode: address.postalCode || null,
          locality: address.locality || null,
          region: address.administrativeArea || null,
          country: address.regionCode || null,
          formatted: [...addressLines, address.postalCode, address.locality, address.administrativeArea]
            .filter(Boolean)
            .join(', ')
        },
        mapsUri: raw.metadata?.mapsUri || null,
        newReviewUri: raw.metadata?.newReviewUri || null,
        rawPayload: raw
      };
    });
    const hasMappings = mapped.length > 0;
    return res.json({ success: true, hasMappings, locations: mapped });
  } catch (e) {
    console.error('❌ /local/status:', e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo estado Local' });
  }
});

router.get('/clinica/:clinicaId/overview', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate } = req.query;
    const range = resolveDateRange(startDate, endDate, 90);
    const metrics = await BusinessProfileDailyMetric.findAll({
      where: {
        clinica_id: clinicaId,
        date: { [Op.between]: [range.start, range.end] }
      },
      raw: true
    });
    const prevMetrics = await BusinessProfileDailyMetric.findAll({
      where: {
        clinica_id: clinicaId,
        date: { [Op.between]: [range.previous.start, range.previous.end] }
      },
      raw: true
    });

    const current = {};
    const previous = {};
    Object.entries(LOCAL_METRIC_GROUPS).forEach(([key, metricGroup]) => {
      current[key] = sumMetricGroup(metrics, metricGroup);
      previous[key] = sumMetricGroup(prevMetrics, metricGroup);
    });

    const delta = (cur, prev) => {
      if (!prev) return null;
      if (prev === 0) return null;
      return (cur - prev) / prev;
    };

    const reviewsAgg = await BusinessProfileReview.findAll({ where: { clinica_id: clinicaId }, raw: true });
    const totalReviews = reviewsAgg.length;
    const avgRating = totalReviews ? (reviewsAgg.reduce((acc, cur) => acc + (cur.star_rating || 0), 0) / totalReviews) : 0;
    const newReviews = reviewsAgg.filter(r => r.is_new).length;
    const negativeReviews = reviewsAgg.filter(r => r.is_negative).length;
    const unansweredReviews = reviewsAgg.filter(r => !r.has_reply).length;

    return res.json({
      success: true,
      period: { start: range.start, end: range.end },
      comparison: range.previous,
      metrics: {
        profileViews: { current: current.profile_views, previous: previous.profile_views, delta: delta(current.profile_views, previous.profile_views) },
        searchViews: { current: current.search_views, previous: previous.search_views, delta: delta(current.search_views, previous.search_views) },
        mapViews: { current: current.map_views, previous: previous.map_views, delta: delta(current.map_views, previous.map_views) },
        callClicks: { current: current.call_clicks, previous: previous.call_clicks, delta: delta(current.call_clicks, previous.call_clicks) },
        directionClicks: { current: current.direction_clicks, previous: previous.direction_clicks, delta: delta(current.direction_clicks, previous.direction_clicks) },
        websiteClicks: { current: current.website_clicks, previous: previous.website_clicks, delta: delta(current.website_clicks, previous.website_clicks) },
        reviews: { total: totalReviews, averageRating: avgRating, newReviews, negativeReviews, unansweredReviews }
      }
    });
  } catch (e) {
    console.error('❌ /local/overview:', e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo overview Local' });
  }
});

router.get('/clinica/:clinicaId/timeseries', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { startDate, endDate, metric = 'profile_views' } = req.query;
    const range = resolveDateRange(startDate, endDate, 90);
    const metricGroup = LOCAL_METRIC_GROUPS[metric] || [metric];
    const rows = await BusinessProfileDailyMetric.findAll({
      where: {
        clinica_id: clinicaId,
        metric_type: { [Op.in]: metricGroup },
        date: { [Op.between]: [range.start, range.end] }
      },
      order: [['date', 'ASC']],
      raw: true
    });
    const toSeries = (items) => {
      const grouped = new Map();
      items.forEach((row) => grouped.set(row.date, (grouped.get(row.date) || 0) + (row.value || 0)));
      return Array.from(grouped.entries()).map(([date, value]) => ({ date, value }));
    };
    const current = toSeries(rows);

    const prevRows = await BusinessProfileDailyMetric.findAll({
      where: {
        clinica_id: clinicaId,
        metric_type: { [Op.in]: metricGroup },
        date: { [Op.between]: [range.previous.start, range.previous.end] }
      },
      order: [['date', 'ASC']],
      raw: true
    });
    const previous = toSeries(prevRows);
    return res.json({ success: true, metric, period: { start: range.start, end: range.end }, comparison: range.previous, current, previous });
  } catch (e) {
    console.error('❌ /local/timeseries:', e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo series Local' });
  }
});

router.get('/clinica/:clinicaId/reviews', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const { rating, unreplied, negative, limit = 25, offset = 0 } = req.query;
    const where = { clinica_id: clinicaId };
    if (rating) {
      where.star_rating = Number(rating);
    }
    if (typeof unreplied !== 'undefined') {
      where.has_reply = unreplied === 'true' ? false : { [Op.ne]: false };
    }
    if (typeof negative !== 'undefined') {
      where.is_negative = negative === 'true';
    }
    const rows = await BusinessProfileReview.findAll({
      where,
      order: [['create_time', 'DESC']],
      limit: Number(limit) || 25,
      offset: Number(offset) || 0
    });
    const total = await BusinessProfileReview.count({ where });
    return res.json({ success: true, items: rows, total });
  } catch (e) {
    console.error('❌ /local/reviews:', e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo reseñas' });
  }
});

router.get('/clinica/:clinicaId/posts', async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const rows = await BusinessProfilePost.findAll({
      where: { clinica_id: clinicaId },
      order: [['create_time', 'DESC']],
      limit: 20
    });
    return res.json({ success: true, items: rows });
  } catch (e) {
    console.error('❌ /local/posts:', e.message);
    return res.status(500).json({ success: false, error: 'Error obteniendo publicaciones' });
  }
});

module.exports = router;
