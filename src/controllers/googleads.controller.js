'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { ClinicGoogleAdsAccount, GoogleAdsInsightsDaily } = require('../../models');
const { formatCustomerId } = require('../lib/googleAdsClient');
const { resolveClinicScope, buildAssetScopeWhere } = require('../lib/clinicScope');

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

function getAttr(instance, key) {
  if (!instance) return null;
  if (typeof instance.get === 'function') {
    return instance.get(key);
  }
  return instance[key];
}

function dedupeAccounts(accounts) {
  const map = new Map();
  for (const acc of accounts) {
    const key = getAttr(acc, 'customerId') || getAttr(acc, 'id');
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, acc);
    }
  }
  return Array.from(map.values());
}

async function aggregateMetrics(where) {
  const rows = await GoogleAdsInsightsDaily.findAll({
    attributes: [
      [fn('SUM', col('impressions')), 'impressions'],
      [fn('SUM', col('clicks')), 'clicks'],
      [fn('SUM', col('costMicros')), 'costMicros'],
      [fn('SUM', col('conversions')), 'conversions']
    ],
    where,
    raw: true
  });
  const row = rows?.[0] || {};
  const impressions = safeNumber(row.impressions);
  const clicks = safeNumber(row.clicks);
  const costMicros = safeNumber(row.costMicros);
  const conversions = safeNumber(row.conversions);
  const spend = microsToCurrency(costMicros);
  return {
    impressions,
    clicks,
    spend,
    conversions,
    ctr: impressions ? clicks / impressions : 0,
    cpc: clicks ? spend / clicks : 0,
    cpm: impressions ? spend / (impressions / 1000) : 0,
    cpa: conversions ? spend / conversions : null,
    conversionRate: clicks ? conversions / clicks : 0
  };
}

function computeDelta(current, previous) {
  const pct = (curr, prev) => {
    if (!Number.isFinite(prev) || prev === 0) return null;
    return Number((((curr - prev) / prev) * 100).toFixed(1));
  };
  return {
    spend: pct(current.spend, previous.spend),
    impressions: pct(current.impressions, previous.impressions),
    clicks: pct(current.clicks, previous.clicks),
    conversions: pct(current.conversions, previous.conversions)
  };
}

exports.getOverview = async (req, res) => {
  try {
    const clinicaParam = req.params.clinicaId;
    const scope = await resolveClinicScope(clinicaParam);
    if (scope.notFound) {
      return res.status(404).json({ message: 'Grupo de clínicas no encontrado' });
    }
    if (!scope.isValid && scope.scope !== 'group') {
      return res.status(400).json({ message: 'clinicaId/grupo inválido' });
    }

    const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];

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

    const accountWhere = buildAssetScopeWhere(scope);
    accountWhere.isActive = true;
    const accountsRaw = await ClinicGoogleAdsAccount.findAll({ where: accountWhere, raw: true });
    const accounts = dedupeAccounts(accountsRaw);
    const customerIds = accounts.map(acc => acc.customerId).filter(Boolean);

    const basePeriod = {
      start: formatDate(start),
      end: formatDate(end),
      previousStart: formatDate(prevStart),
      previousEnd: formatDate(prevEnd)
    };

    if (!accounts.length || !customerIds.length) {
      return res.json({
        scope: scope.scope,
        clinicIds,
        groupId: scope.groupId ?? null,
        period: basePeriod,
        totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0, cpm: 0, cpa: null, conversionRate: 0 },
        previousTotals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0, cpm: 0, cpa: null, conversionRate: 0 },
        unassignedTotals: null,
        delta: { spend: null, impressions: null, clicks: null, conversions: null },
        accounts: []
      });
    }

    const startStr = formatDate(start);
    const endStr = formatDate(end);
    const prevStartStr = formatDate(prevStart);
    const prevEndStr = formatDate(prevEnd);

    const baseAssignedWhere = {
      customerId: { [Op.in]: customerIds }
    };
    if (clinicIds.length) {
      baseAssignedWhere.clinicaId = clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds };
    }

    const currentTotals = await aggregateMetrics({
      ...baseAssignedWhere,
      date: { [Op.between]: [startStr, endStr] }
    });

    const previousTotals = await aggregateMetrics({
      ...baseAssignedWhere,
      date: { [Op.between]: [prevStartStr, prevEndStr] }
    });

    let unassignedTotals = null;
    if (scope.groupId) {
      unassignedTotals = await aggregateMetrics({
        customerId: { [Op.in]: customerIds },
        grupoClinicaId: scope.groupId,
        clinicaId: { [Op.is]: null },
        date: { [Op.between]: [startStr, endStr] }
      });
    }

    const delta = computeDelta(currentTotals, previousTotals);

    const accountSummaries = accounts.map(acc => ({
      id: acc.id,
      clinicaId: acc.clinicaId || null,
      grupoClinicaId: acc.grupoClinicaId || null,
      assignmentScope: acc.assignmentScope,
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

    return res.json({
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
      period: basePeriod,
      totals: currentTotals,
      previousTotals,
      unassignedTotals,
      delta,
      accounts: accountSummaries
    });
  } catch (error) {
    console.error('❌ getOverview Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo resumen de Google Ads', error: error.message });
  }
};

exports.getTimeseries = async (req, res) => {
  try {
    const clinicaParam = req.params.clinicaId;
    const scope = await resolveClinicScope(clinicaParam);
    if (scope.notFound) {
      return res.status(404).json({ message: 'Grupo de clínicas no encontrado' });
    }
    if (!scope.isValid && scope.scope !== 'group') {
      return res.status(400).json({ message: 'clinicaId/grupo inválido' });
    }

    const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];

    const end = parseDate(req.query.endDate, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '30', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * 86400000));
    const startStr = formatDate(start);
    const endStr = formatDate(end);

    const accountWhere = buildAssetScopeWhere(scope);
    accountWhere.isActive = true;
    const accountsRaw = await ClinicGoogleAdsAccount.findAll({ where: accountWhere, raw: true });
    const accounts = dedupeAccounts(accountsRaw);
    const customerIds = accounts.map(acc => acc.customerId).filter(Boolean);

    const baseResponse = {
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
      series: [],
      totals: { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
      unassignedSeries: [],
      unassignedTotals: { impressions: 0, clicks: 0, spend: 0, conversions: 0 }
    };

    if (!accounts.length || !customerIds.length) {
      return res.json(baseResponse);
    }

    const assignedWhere = {
      customerId: { [Op.in]: customerIds },
      date: { [Op.between]: [startStr, endStr] }
    };
    if (clinicIds.length) {
      assignedWhere.clinicaId = clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds };
    }

    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'date',
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: assignedWhere,
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

    let unassignedSeries = [];
    let unassignedTotals = { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
    if (scope.groupId) {
      const unassignedWhere = {
        customerId: { [Op.in]: customerIds },
        grupoClinicaId: scope.groupId,
        clinicaId: { [Op.is]: null },
        date: { [Op.between]: [startStr, endStr] }
      };
      const unassignedRows = await GoogleAdsInsightsDaily.findAll({
        attributes: [
          'date',
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('costMicros')), 'costMicros'],
          [fn('SUM', col('conversions')), 'conversions']
        ],
        where: unassignedWhere,
        group: ['date'],
        order: [[col('date'), 'ASC']],
        raw: true
      });
      unassignedSeries = unassignedRows.map(row => ({
        date: row.date,
        impressions: safeNumber(row.impressions),
        clicks: safeNumber(row.clicks),
        spend: microsToCurrency(row.costMicros),
        conversions: safeNumber(row.conversions)
      }));
      unassignedTotals = unassignedSeries.reduce((acc, item) => ({
        impressions: acc.impressions + item.impressions,
        clicks: acc.clicks + item.clicks,
        spend: acc.spend + item.spend,
        conversions: acc.conversions + item.conversions
      }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });
    }

    return res.json({
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
      series,
      totals,
      unassignedSeries,
      unassignedTotals
    });
  } catch (error) {
    console.error('❌ getTimeseries Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo serie temporal de Google Ads', error: error.message });
  }
};

exports.getCampaigns = async (req, res) => {
  try {
    const clinicaParam = req.params.clinicaId;
    const scope = await resolveClinicScope(clinicaParam);
    if (scope.notFound) {
      return res.status(404).json({ message: 'Grupo de clínicas no encontrado' });
    }
    if (!scope.isValid && scope.scope !== 'group') {
      return res.status(400).json({ message: 'clinicaId/grupo inválido' });
    }

    const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];

    const end = parseDate(req.query.endDate, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })());
    const windowDays = parseInt(req.query.windowDays || req.query.days || '30', 10);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    const start = parseDate(req.query.startDate, new Date(end.getTime() - (days - 1) * 86400000));
    const startStr = formatDate(start);
    const endStr = formatDate(end);

    const accountWhere = buildAssetScopeWhere(scope);
    accountWhere.isActive = true;
    const accountsRaw = await ClinicGoogleAdsAccount.findAll({ where: accountWhere, raw: true });
    const accounts = dedupeAccounts(accountsRaw);
    const customerIds = accounts.map(acc => acc.customerId).filter(Boolean);

    const baseResponse = {
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
      campaigns: [],
      unassignedCampaigns: []
    };

    if (!accounts.length || !customerIds.length) {
      return res.json(baseResponse);
    }

    const assignedWhere = {
      customerId: { [Op.in]: customerIds },
      date: { [Op.between]: [startStr, endStr] }
    };
    if (clinicIds.length) {
      assignedWhere.clinicaId = clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds };
    }

    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'campaignId',
        'campaignName',
        'clinicaId',
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: assignedWhere,
      group: ['campaignId', 'campaignName', 'clinicaId'],
      order: [[literal('SUM(costMicros)'), 'DESC']],
      raw: true
    });

    const campaigns = rows.map(row => {
      const impressions = safeNumber(row.impressions);
      const clicks = safeNumber(row.clicks);
      const spend = microsToCurrency(row.costMicros);
      const conversions = safeNumber(row.conversions);
      return {
        campaignId: row.campaignId,
        campaignName: row.campaignName || 'Campaña sin nombre',
        clinicaId: row.clinicaId ?? null,
        impressions,
        clicks,
        spend,
        conversions,
        ctr: impressions ? clicks / impressions : 0,
        cpc: clicks ? spend / clicks : 0,
        cpm: impressions ? spend / (impressions / 1000) : 0,
        cpa: conversions ? spend / conversions : null,
        conversionRate: clicks ? conversions / clicks : 0
      };
    });

    let unassignedCampaigns = [];
    if (scope.groupId) {
      const unassignedWhere = {
        customerId: { [Op.in]: customerIds },
        grupoClinicaId: scope.groupId,
        clinicaId: { [Op.is]: null },
        date: { [Op.between]: [startStr, endStr] }
      };
      const unassignedRows = await GoogleAdsInsightsDaily.findAll({
        attributes: [
          'campaignId',
          'campaignName',
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('costMicros')), 'costMicros'],
          [fn('SUM', col('conversions')), 'conversions']
        ],
        where: unassignedWhere,
        group: ['campaignId', 'campaignName'],
        order: [[literal('SUM(costMicros)'), 'DESC']],
        raw: true
      });
      unassignedCampaigns = unassignedRows.map(row => {
        const impressions = safeNumber(row.impressions);
        const clicks = safeNumber(row.clicks);
        const spend = microsToCurrency(row.costMicros);
        const conversions = safeNumber(row.conversions);
        return {
          campaignId: row.campaignId,
          campaignName: row.campaignName || 'Campaña sin nombre',
          clinicaId: null,
          impressions,
          clicks,
          spend,
          conversions,
          ctr: impressions ? clicks / impressions : 0,
          cpc: clicks ? spend / clicks : 0,
          cpm: impressions ? spend / (impressions / 1000) : 0,
          cpa: conversions ? spend / conversions : null,
          conversionRate: clicks ? conversions / clicks : 0
        };
      });
    }

    return res.json({
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
      campaigns,
      unassignedCampaigns
    });
  } catch (error) {
    console.error('❌ getCampaigns Google Ads error:', error);
    res.status(500).json({ message: 'Error obteniendo campañas de Google Ads', error: error.message });
  }
};

exports.getHealth = async (req, res) => {
  try {
    const clinicaParam = req.params.clinicaId;
    const scope = await resolveClinicScope(clinicaParam);
    if (scope.notFound) {
      return res.status(404).json({ message: 'Grupo de clínicas no encontrado' });
    }
    if (!scope.isValid && scope.scope !== 'group') {
      return res.status(400).json({ message: 'clinicaId/grupo inválido' });
    }

    const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];

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

    const accountWhere = buildAssetScopeWhere(scope);
    accountWhere.isActive = true;
    const accountsRaw = await ClinicGoogleAdsAccount.findAll({ where: accountWhere, raw: true });
    const accounts = dedupeAccounts(accountsRaw);
    const customerIds = accounts.map(acc => acc.customerId).filter(Boolean);

    if (!accounts.length || !customerIds.length) {
      return res.json({
        scope: scope.scope,
        clinicIds,
        groupId: scope.groupId ?? null,
        platform: 'google',
        period: { start: startStr, end: endStr },
        cards: [],
        thresholds: {
          minSpend,
          ctr: ctrThreshold,
          cpa: cpaThreshold,
          growth: cpaGrowthThreshold,
          minImpressions
        }
      });
    }

    const insightsWhere = {
      customerId: { [Op.in]: customerIds },
      date: { [Op.between]: [formatDate(prevStart), endStr] }
    };
    if (scope.groupId) {
      const clauses = [];
      if (clinicIds.length) {
        clauses.push({ clinicaId: { [Op.in]: clinicIds } });
      }
      clauses.push({ clinicaId: { [Op.is]: null }, grupoClinicaId: scope.groupId });
      insightsWhere[Op.or] = clauses;
    } else if (clinicIds.length) {
      insightsWhere.clinicaId = clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds };
    }

    const rowsRaw = await GoogleAdsInsightsDaily.findAll({
      where: insightsWhere,
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
      scope: scope.scope,
      clinicIds,
      groupId: scope.groupId ?? null,
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
