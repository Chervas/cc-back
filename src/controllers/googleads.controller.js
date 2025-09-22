'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { ClinicGoogleAdsAccount, GoogleAdsInsightsDaily } = require('../../models');
const { formatCustomerId } = require('../lib/googleAdsClient');

function parseDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function microsToCurrency(value) {
  return Number(value || 0) / 1_000_000;
}

function safeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

exports.getOverview = async (req, res) => {
  try {
    const clinicaId = parseInt(req.params.clinicaId, 10);
    if (!clinicaId) {
      return res.status(400).json({ message: 'clinicaId requerido' });
    }

    const end = parseDate(req.query.endDate, (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '7', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * 86400000));
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (end.getTime() - start.getTime()));

    const accounts = await ClinicGoogleAdsAccount.findAll({
      where: { clinicaId, isActive: true },
      raw: true
    });

    if (!accounts.length) {
      return res.json({
        period: { start: formatDate(start), end: formatDate(end), previousStart: formatDate(prevStart), previousEnd: formatDate(prevEnd) },
        totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0, cpm: 0 },
        delta: { spend: null, impressions: null, clicks: null, conversions: null },
        accounts: []
      });
    }

    const accountIds = accounts.map(a => a.id);

    const buildWhere = (dateStart, dateEnd) => ({
      clinicaId,
      date: { [Op.between]: [formatDate(dateStart), formatDate(dateEnd)] }
    });

    const aggregateMetrics = async (dateStart, dateEnd) => {
      const rows = await GoogleAdsInsightsDaily.findAll({
        attributes: [
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('costMicros')), 'costMicros'],
          [fn('SUM', col('conversions')), 'conversions']
        ],
        where: buildWhere(dateStart, dateEnd),
        raw: true
      });
      const row = rows?.[0] || {};
      const impressions = safeNumber(row.impressions);
      const clicks = safeNumber(row.clicks);
      const costMicros = safeNumber(row.costMicros);
      const conversions = safeNumber(row.conversions);
      const spend = microsToCurrency(costMicros);
      const ctr = impressions ? clicks / impressions : 0;
      const cpc = clicks ? spend / clicks : 0;
      const cpm = impressions ? spend / (impressions / 1000) : 0;
      const cpa = conversions ? spend / conversions : null;
      const conversionRate = clicks ? conversions / clicks : 0;
      return { impressions, clicks, spend, conversions, ctr, cpc, cpm, cpa, conversionRate };
    };

    const currentTotals = await aggregateMetrics(start, end);
    const previousTotals = await aggregateMetrics(prevStart, prevEnd);

    const pctDelta = (curr, prev) => {
      if (!prev) return null;
      return Number((((curr - prev) / prev) * 100).toFixed(1));
    };

    const delta = {
      spend: pctDelta(currentTotals.spend, previousTotals.spend),
      impressions: pctDelta(currentTotals.impressions, previousTotals.impressions),
      clicks: pctDelta(currentTotals.clicks, previousTotals.clicks),
      conversions: pctDelta(currentTotals.conversions, previousTotals.conversions)
    };

    const accountSummaries = accounts.map(acc => ({
      id: acc.id,
      customerId: acc.customerId,
      formattedCustomerId: formatCustomerId(acc.customerId),
      descriptiveName: acc.descriptiveName,
      currencyCode: acc.currencyCode,
      timeZone: acc.timeZone,
      managerLinkStatus: acc.managerLinkStatus,
      invitationStatus: acc.invitationStatus,
      loginCustomerId: acc.loginCustomerId,
      lastSyncedAt: acc.lastSyncedAt
    }));

    const payload = {
      period: {
        start: formatDate(start),
        end: formatDate(end),
        previousStart: formatDate(prevStart),
        previousEnd: formatDate(prevEnd)
      },
      totals: currentTotals,
      previousTotals,
      delta,
      accounts: accountSummaries
    };

    res.json(payload);
  } catch (error) {
    console.error('❌ getOverview Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo resumen de Google Ads', error: error.message });
  }
};

exports.getTimeseries = async (req, res) => {
  try {
    const clinicaId = parseInt(req.params.clinicaId, 10);
    if (!clinicaId) return res.status(400).json({ message: 'clinicaId requerido' });

    const end = parseDate(req.query.endDate, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '30', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * 86400000));

    const accounts = await ClinicGoogleAdsAccount.findAll({
      where: { clinicaId, isActive: true },
      attributes: ['id'],
      raw: true
    });
    if (!accounts.length) {
      return res.json({ series: [], totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0 } });
    }

    const accountIds = accounts.map(a => a.id);
    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'date',
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: { clinicaId, date: { [Op.between]: [formatDate(start), formatDate(end)] } },
      group: ['date'],
      order: [[col('date'), 'ASC']],
      raw: true
    });

    const series = rows.map(row => ({
      date: row.date,
      impressions: safeNumber(row.impressions),
      clicks: safeNumber(row.clicks),
      spend: microsToCurrency(row.costMicros),
      conversions: safeNumber(row.conversions)
    }));

    const totals = series.reduce((acc, item) => ({
      impressions: acc.impressions + item.impressions,
      clicks: acc.clicks + item.clicks,
      spend: acc.spend + item.spend,
      conversions: acc.conversions + item.conversions
    }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

    res.json({ series, totals });
  } catch (error) {
    console.error('❌ getTimeseries Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo serie temporal de Google Ads', error: error.message });
  }
};

exports.getCampaigns = async (req, res) => {
  try {
    const clinicaId = parseInt(req.params.clinicaId, 10);
    if (!clinicaId) return res.status(400).json({ message: 'clinicaId requerido' });
    const end = parseDate(req.query.endDate, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '30', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * 86400000));

    const accounts = await ClinicGoogleAdsAccount.findAll({ where: { clinicaId, isActive: true }, attributes: ['id'], raw: true });
    if (!accounts.length) {
      return res.json({ campaigns: [] });
    }
    const accountIds = accounts.map(a => a.id);

    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'campaignId',
        'campaignName',
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: { clinicaId, date: { [Op.between]: [formatDate(start), formatDate(end)] } },
      group: ['campaignId', 'campaignName'],
      order: [[literal('SUM(costMicros)'), 'DESC']],
      raw: true
    });

    const campaigns = rows.map(row => {
      const impressions = safeNumber(row.impressions);
      const clicks = safeNumber(row.clicks);
      const spend = microsToCurrency(row.costMicros);
      const conversions = safeNumber(row.conversions);
      const ctr = impressions ? clicks / impressions : 0;
      const cpc = clicks ? spend / clicks : 0;
      const cpm = impressions ? spend / (impressions / 1000) : 0;
      const cpa = conversions ? spend / conversions : null;
      const conversionRate = clicks ? conversions / clicks : 0;
      return {
        campaignId: row.campaignId,
        campaignName: row.campaignName || 'Campaña sin nombre',
        impressions,
        clicks,
        spend,
        conversions,
        ctr,
        cpc,
        cpm,
        cpa,
        conversionRate
      };
    });

    res.json({ campaigns });
  } catch (error) {
    console.error('❌ getCampaigns Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo campañas de Google Ads', error: error.message });
  }
};

exports.getHealth = async (req, res) => {
  try {
    const clinicaId = parseInt(req.params.clinicaId, 10);
    if (!clinicaId) {
      return res.status(400).json({ message: 'clinicaId requerido' });
    }

    const dayMs = 86400000;
    const end = parseDate(req.query.endDate, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '7', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * dayMs));
    const prevEnd = new Date(start.getTime() - dayMs);
    const prevStart = new Date(prevEnd.getTime() - (end.getTime() - start.getTime()));
    const recentEnd = new Date(end.getTime() - dayMs);
    const recentStartCandidate = new Date(recentEnd.getTime() - dayMs);
    const recentStart = new Date(Math.max(start.getTime(), recentStartCandidate.getTime()));
    const startStr = formatDate(start);
    const endStr = formatDate(end);
    const prevStartStr = formatDate(prevStart);
    const prevEndStr = formatDate(prevEnd);
    const recentStartStr = formatDate(recentStart);
    const recentEndStr = formatDate(recentEnd);

    const minSpend = parseFloat(process.env.GOOGLE_ADS_HEALTH_MIN_SPEND || '1');
    const ctrThreshold = parseFloat(process.env.GOOGLE_ADS_HEALTH_CTR_MIN || '0.02');
    const cpaThreshold = parseFloat(process.env.GOOGLE_ADS_HEALTH_CPA_MAX || '25');
    const cpaGrowthThreshold = parseFloat(process.env.GOOGLE_ADS_HEALTH_CPA_GROWTH || '0.3');
    const minImpressions = parseFloat(process.env.GOOGLE_ADS_HEALTH_MIN_IMPRESSIONS || '200');

    const rowsRaw = await GoogleAdsInsightsDaily.findAll({
      where: {
        clinicaId,
        date: { [Op.between]: [formatDate(prevStart), endStr] }
      },
      attributes: ['date', 'campaignId', 'campaignName', 'impressions', 'clicks', 'costMicros', 'conversions'],
      raw: true
    });

    const rows = rowsRaw.map(row => ({
      date: row.date,
      campaignId: row.campaignId ? String(row.campaignId) : null,
      campaignName: row.campaignName || 'Campaña sin nombre',
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: microsToCurrency(row.costMicros),
      conversions: Number(row.conversions || 0)
    }));

    const filterRange = (startLabel, endLabel) => rows.filter(r => r.date >= startLabel && r.date <= endLabel);

    const aggregateTotals = (subset) => subset.reduce((acc, row) => {
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.spend += row.spend;
      acc.conversions += row.conversions;
      return acc;
    }, { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

    const aggregateCampaigns = (subset) => {
      const map = new Map();
      subset.forEach(row => {
        const key = row.campaignId || `name:${row.campaignName}`;
        if (!map.has(key)) {
          map.set(key, {
            campaignId: row.campaignId,
            campaignName: row.campaignName,
            impressions: 0,
            clicks: 0,
            spend: 0,
            conversions: 0
          });
        }
        const entry = map.get(key);
        entry.impressions += row.impressions;
        entry.clicks += row.clicks;
        entry.spend += row.spend;
        entry.conversions += row.conversions;
      });
      return map;
    };

    const currentRows = filterRange(startStr, endStr);
    const previousRows = filterRange(prevStartStr, prevEndStr);
    const recentRows = filterRange(recentStartStr, recentEndStr);

    const totalsCurrent = aggregateTotals(currentRows);
    const totalsPrevious = aggregateTotals(previousRows);
    const campaignsCurrent = aggregateCampaigns(currentRows);
    const campaignsPrevious = aggregateCampaigns(previousRows);
    const campaignsRecent = aggregateCampaigns(recentRows);

    const cards = [];

    // Card: account spend
    cards.push({
      id: 'account-spend',
      title: 'Cuenta publicitaria (inversión)',
      status: totalsCurrent.spend >= minSpend ? 'ok' : 'warning',
      rangeLabel: `${startStr} - ${endStr}`,
      summary: {
        spend: totalsCurrent.spend,
        clicks: totalsCurrent.clicks,
        conversions: totalsCurrent.conversions
      }
    });

    // Card: no conversions last 48h
    const noConversionsItems = [];
    campaignsRecent.forEach(entry => {
      if (entry.spend >= minSpend && entry.conversions === 0) {
        noConversionsItems.push({
          campaignName: entry.campaignName,
          spend: entry.spend,
          clicks: entry.clicks
        });
      }
    });
    noConversionsItems.sort((a, b) => b.spend - a.spend);
    cards.push({
      id: 'no-conversions',
      title: 'Campañas con gasto sin conversiones (últimas 48 h)',
      status: noConversionsItems.length ? 'error' : 'ok',
      rangeLabel: `${recentStartStr} - ${recentEndStr}`,
      items: noConversionsItems
    });

    // Card: CPA growth vs previous period
    const cpaGrowthItems = [];
    campaignsCurrent.forEach((curr, key) => {
      const prev = campaignsPrevious.get(key);
      if (!prev) return;
      if (curr.conversions < 1 || prev.conversions < 1) return;
      const currCpa = curr.spend / curr.conversions;
      const prevCpa = prev.spend / prev.conversions;
      if (!prevCpa) return;
      const delta = (currCpa - prevCpa) / prevCpa;
      if (delta >= cpaGrowthThreshold) {
        cpaGrowthItems.push({
          campaignName: curr.campaignName,
          cpaCurrent: currCpa,
          cpaPrevious: prevCpa,
          deltaPct: delta * 100
        });
      }
    });
    cpaGrowthItems.sort((a, b) => b.deltaPct - a.deltaPct);
    cards.push({
      id: 'cpa-growth',
      title: `CPA aumenta ≥ ${Math.round(cpaGrowthThreshold * 100)}% vs semana anterior`,
      status: cpaGrowthItems.length ? 'warning' : 'ok',
      rangeLabel: `${startStr} - ${endStr}`,
      previousRangeLabel: `${prevStartStr} - ${prevEndStr}`,
      items: cpaGrowthItems
    });

    // Card: CPA above threshold
    const cpaHighItems = [];
    campaignsRecent.forEach(entry => {
      if (entry.conversions > 0) {
        const cpa = entry.spend / entry.conversions;
        if (cpa >= cpaThreshold) {
          cpaHighItems.push({
            campaignName: entry.campaignName,
            cpa,
            conversions: entry.conversions,
            spend: entry.spend
          });
        }
      }
    });
    cpaHighItems.sort((a, b) => b.cpa - a.cpa);
    cards.push({
      id: 'cpa-high',
      title: `CPA superior a ${cpaThreshold.toFixed(0)} € (últimas 48 h)`,
      status: cpaHighItems.length ? 'warning' : 'ok',
      rangeLabel: `${recentStartStr} - ${recentEndStr}`,
      items: cpaHighItems
    });

    // Card: CTR low
    const ctrLowItems = [];
    campaignsCurrent.forEach(entry => {
      if (entry.impressions >= minImpressions) {
        const ctr = entry.impressions ? (entry.clicks / entry.impressions) * 100 : 0;
        if (ctr < ctrThreshold * 100) {
          ctrLowItems.push({
            campaignName: entry.campaignName,
            ctr,
            impressions: entry.impressions,
            clicks: entry.clicks
          });
        }
      }
    });
    ctrLowItems.sort((a, b) => a.ctr - b.ctr);
    cards.push({
      id: 'ctr-low',
      title: `CTR por debajo de ${(ctrThreshold * 100).toFixed(1)}%`,
      status: ctrLowItems.length ? 'warning' : 'ok',
      rangeLabel: `${startStr} - ${endStr}`,
      items: ctrLowItems
    });

    res.json({
      platform: 'google',
      period: { start: startStr, end: endStr },
      cards,
      thresholds: {
        minSpend,
        ctr: ctrThreshold,
        cpa: cpaThreshold,
        growth: cpaGrowthThreshold,
        minImpressions
      }
    });
  } catch (error) {
    console.error('❌ getGoogleAdsHealth error:', error);
    res.status(500).json({ message: 'Error obteniendo salud de Google Ads', error: error.message });
  }
};
