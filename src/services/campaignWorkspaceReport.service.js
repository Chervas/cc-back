'use strict';

const { formatDateLocal, localDateTimeToUtc } = require('../lib/availability-calendar');
const { canonicalExternalCampaignIdentity, externalCampaignIdentityKey } = require('./externalCampaignAssignmentTargets.service');

const TIME_ZONE = 'Europe/Madrid';
const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const dateShift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const accountId = value => String(value || '').replace(/^act_/i, '').replace(/\D/g, '');
const dayOf = value => value && Number.isFinite(new Date(value).getTime()) ? formatDateLocal(new Date(value), TIME_ZONE) : null;
const empty = () => ({ spend: 0, leads: 0, appointments: 0, accepted: null, providerConversions: null });
const cpl = metrics => metrics?.spend != null && metrics?.leads > 0 ? metrics.spend / metrics.leads : null;

function reportPeriod(days = 30, now = new Date()) {
  if (![7, 30].includes(Number(days))) throw Object.assign(new Error('invalid_period'), { status: 400 });
  const end = dateShift(formatDateLocal(now, TIME_ZONE), -1);
  const start = dateShift(end, 1 - Number(days));
  const previousStart = dateShift(start, -Number(days));
  return {
    days: Number(days), timeZone: TIME_ZONE, start, end, previousStart, previousEnd: dateShift(start, -1),
    from: localDateTimeToUtc(previousStart, '00:00', TIME_ZONE),
    until: localDateTimeToUtc(dateShift(end, 1), '00:00', TIME_ZONE),
  };
}

function mappingIdentity(row, provider) {
  return { provider, accountId: accountId(provider === 'google_ads' ? row.customerId : row.metaAssetId),
    clinicId: row.assignmentScope === 'group' ? null : number(row.clinicaId) || null,
    groupId: row.assignmentScope === 'group' ? number(row.grupoClinicaId) || null : null };
}

// Reviewed assignments win. A shared account never implicitly belongs to every clinic mapped to it.
function visibleCampaigns({ scope, mappings, assignments, inventory }) {
  const clinics = new Set(scope.clinicIds.map(Number));
  const mappingIndex = new Map();
  for (const mapping of mappings) {
    const key = `${mapping.provider}:${mapping.accountId}`;
    if (!mappingIndex.has(key)) mappingIndex.set(key, []);
    mappingIndex.get(key).push(mapping);
  }
  const reviewed = new Map();
  for (const assignment of assignments) {
    const key = externalCampaignIdentityKey(assignment);
    if (!key) continue;
    if (!reviewed.has(key)) reviewed.set(key, []);
    reviewed.get(key).push(assignment);
  }
  const result = new Map();
  for (const item of inventory) {
    const identity = canonicalExternalCampaignIdentity(item);
    const key = externalCampaignIdentityKey(identity);
    if (!key || result.has(key)) continue;
    const owners = mappingIndex.get(`${identity.provider}:${identity.account_id}`) || [];
    const accessible = owners.some(owner => clinics.has(owner.clinicId)
      || scope.groupId && owner.groupId === scope.groupId || scope.memberGroupIds?.includes(owner.groupId));
    if (!accessible) continue;
    const reviews = reviewed.get(key) || [];
    // Conflicting ownership is an exception, never a reason to expose another clinic's campaign.
    if (reviews.length > 1 || reviews.some(row => row.status !== 'active' || !clinics.has(number(row.clinica_id)))) continue;
    const exclusive = owners.length > 0 && owners.every(owner => owner.clinicId && owner.clinicId === owners[0].clinicId);
    const assignedClinic = reviews[0] ? number(reviews[0].clinica_id) : exclusive ? owners[0].clinicId : null;
    const ownsGroup = owners.length > 0 && owners.every(owner => clinics.has(owner.clinicId)
      || scope.groupId && owner.groupId === scope.groupId || scope.authorizedGroupIds?.includes(owner.groupId));
    if (!assignedClinic && !ownsGroup) continue;
    if (assignedClinic && !clinics.has(assignedClinic)) continue;
    result.set(key, {
      ...identity, id: key, name: item.campaign_name || identity.campaign_id,
      clinicId: assignedClinic, assigned: !!assignedClinic, accountName: item.account_name || identity.account_id,
      provider: identity.provider, status: item.status || 'UNKNOWN',
      paused: /PAUSED|REMOVED|DELETED|ARCHIVED/i.test(item.status || ''),
      destination: item.destination_detection?.kind === 'web' ? 'web' : item.destination_detection?.kind === 'lead_form' ? 'native' : 'unknown',
      urls: (item.destination_detection?.urls || []).filter(url => {
        try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch (_) { return false; }
      }),
      lastSeenAt: item.last_seen_at || null,
    });
  }
  return [...result.values()];
}

function leadCampaign(lead, campaigns) {
  const provider = lead.source === 'google_ads' || /google/i.test(lead.utm_source || '') ? 'google_ads'
    : lead.source === 'meta_ads' || /^(facebook|instagram|meta|fb|ig)$/i.test(lead.utm_source || '') ? 'meta_ads' : null;
  if (!provider || !['paid', null, undefined].includes(lead.channel)) return null;
  const available = campaigns.filter(c => c.provider === provider && c.clinicId === number(lead.clinica_id));
  const customer = accountId(lead.google_ads_customer_id);
  const externalId = String(lead.google_ads_campaign_id || '').trim();
  if (provider === 'google_ads' && customer && externalId) {
    return available.find(c => c.account_id === customer && c.campaign_id === externalId)?.id || null;
  }
  // Legacy UTM attribution is accepted only when the whole clinic scope has one unambiguous match.
  const tokens = [lead.utm_campaign, lead.source_detail, externalId].filter(Boolean).map(v => String(v).trim().toLowerCase());
  const matches = available.filter(c => tokens.some(token => token === c.campaign_id.toLowerCase() || token === c.name.toLowerCase()));
  return matches.length === 1 ? matches[0].id : null;
}

function aggregateReport({ campaigns, facts = [], leads = [], appointments = [], ads = [], period, now = new Date() }) {
  const rows = campaigns.map(campaign => ({ campaign, current: empty(), previous: empty(),
    daily: Array.from({ length: period.days }, (_, i) => ({ date: dateShift(period.start, i), leads: 0, appointments: 0 })),
    ads: [], receptionReady: false, performance: campaign.paused ? 'paused' : 'insufficient',
    coverage: { spend: false, previousSpend: false, latestMetricDate: null, updatedAt: null, recentSpend: 0, recentLeads: 0 },
  }));
  const index = new Map(rows.map(row => [row.campaign.id, row]));
  const periodKey = day => !day || day < period.previousStart || day > period.end ? null : day < period.start ? 'previous' : 'current';
  const seenFacts = new Set();
  const recentStart = dateShift(period.end, -1);
  for (const fact of facts) {
    const key = externalCampaignIdentityKey(fact);
    const row = index.get(key);
    const target = periodKey(fact.date);
    if (!row || !target) continue;
    const dedupe = JSON.stringify([key, fact.date, fact.segment]);
    if (seenFacts.has(dedupe)) continue;
    seenFacts.add(dedupe);
    row[target].spend += number(fact.spend);
    if (fact.providerConversions != null) row[target].providerConversions = (row[target].providerConversions || 0) + number(fact.providerConversions);
    row.coverage[target === 'current' ? 'spend' : 'previousSpend'] = true;
    row.coverage.latestMetricDate = [row.coverage.latestMetricDate, fact.date].filter(Boolean).sort().at(-1);
    if (fact.updatedAt && (!row.coverage.updatedAt || new Date(fact.updatedAt) > new Date(row.coverage.updatedAt))) row.coverage.updatedAt = fact.updatedAt;
    if (fact.date >= recentStart) row.coverage.recentSpend += number(fact.spend);
  }
  const leadRows = new Map();
  const seenLeads = new Set();
  let unattributedLeads = 0;
  for (const lead of leads) {
    if (seenLeads.has(String(lead.id))) continue;
    seenLeads.add(String(lead.id));
    const key = leadCampaign(lead, campaigns);
    if (key) leadRows.set(String(lead.id), { row: index.get(key), clinicId: number(lead.clinica_id) });
    const day = dayOf(lead.created_at);
    const target = periodKey(day);
    if (!target) continue;
    if (!key) { if (target === 'current' && lead.channel === 'paid') unattributedLeads++; continue; }
    const row = index.get(key);
    row[target].leads++;
    const daily = row.daily.find(point => point.date === day);
    if (daily) daily.leads++;
    if (day >= recentStart) row.coverage.recentLeads++;
  }
  const seenAppointments = new Set();
  for (const appointment of appointments) {
    if (seenAppointments.has(String(appointment.id_cita)) || ['cancelada', 'reprogramada'].includes(appointment.estado) || appointment.es_provisional) continue;
    seenAppointments.add(String(appointment.id_cita));
    const match = leadRows.get(String(appointment.lead_intake_id));
    if (!match || match.clinicId !== number(appointment.clinica_id)) continue;
    const day = dayOf(appointment.created_at);
    const target = periodKey(day);
    if (!target) continue;
    match.row[target].appointments++;
    const daily = match.row.daily.find(point => point.date === day);
    if (daily) daily.appointments++;
  }
  const adIndex = new Map();
  const seenAds = new Set();
  for (const ad of ads) {
    const row = index.get(externalCampaignIdentityKey(ad));
    const target = periodKey(ad.date);
    if (!row || !target && ad.inventory !== true) continue;
    const key = `${row.campaign.id}:${ad.id}`;
    const dedupe = JSON.stringify([key, ad.date, ad.segment]);
    if (seenAds.has(dedupe)) continue;
    seenAds.add(dedupe);
    if (!adIndex.has(key)) {
      const value = { id: ad.id, title: ad.title || ad.id, status: ad.status || 'UNKNOWN',
        current: { ...empty(), leads: null, appointments: null }, previous: { ...empty(), leads: null, appointments: null },
        lastSeenAt: ad.updatedAt || null, active: !row.campaign.paused && /^(ACTIVE|ENABLED)$/i.test(ad.status || ''),
        lowestCost: false, rejected: /DISAPPROVED|REJECTED/i.test(ad.status || '') };
      adIndex.set(key, value); row.ads.push(value);
    }
    const value = adIndex.get(key);
    if (target && ad.inventory !== true) {
      value[target].spend += number(ad.spend);
      value.periods = { ...(value.periods || {}), [target]: true };
      if (ad.providerConversions != null) value[target].providerConversions = (value[target].providerConversions || 0) + number(ad.providerConversions);
    }
    if (ad.updatedAt && new Date(ad.updatedAt) > new Date(value.lastSeenAt || 0)) {
      value.lastSeenAt = ad.updatedAt; value.status = ad.status || 'UNKNOWN';
      value.rejected = /DISAPPROVED|REJECTED/i.test(value.status);
      value.active = !row.campaign.paused && /^(ACTIVE|ENABLED)$/i.test(value.status);
    }
  }
  for (const row of rows) {
    for (const ad of row.ads) {
      if (!ad.periods?.current) ad.current.spend = null;
      if (!ad.periods?.previous) ad.previous.spend = null;
      delete ad.periods;
    }
    if (!row.coverage.spend) row.current.spend = null;
    if (!row.coverage.previousSpend) row.previous.spend = null;
    const comparable = row.current.leads >= 10 && row.previous.leads >= 10 && cpl(row.previous) > 0 && cpl(row.current) !== null;
    const fresh = row.coverage.updatedAt && new Date(now) - new Date(row.coverage.updatedAt) < 36 * 3600000 && row.coverage.latestMetricDate === period.end;
    row.performance = row.campaign.paused ? 'paused' : !fresh || !comparable ? 'insufficient'
      : cpl(row.current) / cpl(row.previous) >= 1.25 ? 'attention' : 'stable';
  }
  const included = rows.filter(row => row.campaign.assigned);
  const currencies = new Set(included.map(row => row.campaign.currency || null));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const sum = key => included.reduce((total, row) => ({
    spend: total.spend === null || row[key].spend === null ? null : total.spend + row[key].spend,
    leads: total.leads + row[key].leads, appointments: total.appointments + row[key].appointments,
    accepted: null, providerConversions: total.providerConversions === null || row[key].providerConversions === null ? null : total.providerConversions + row[key].providerConversions,
  }), { ...empty(), spend: included.length ? 0 : null, providerConversions: included.length ? 0 : null });
  return {
    days: period.days, period, currency, rows,
    current: { ...sum('current'), ...(currency ? {} : { spend: null }) },
    previous: { ...sum('previous'), ...(currency ? {} : { spend: null }) },
    daily: Array.from({ length: period.days }, (_, i) => ({ date: dateShift(period.start, i),
      leads: included.reduce((total, row) => total + row.daily[i].leads, 0),
      appointments: included.reduce((total, row) => total + row.daily[i].appointments, 0) })),
    unattributedLeads, attribution: {
      leads: 'unique_lead_intake_id', appointments: 'linked_appointment_created_at_excluding_cancelled',
      accepted: 'pending_budget_campaign_attribution', adLeads: 'pending_ad_level_crm_attribution',
    },
  };
}

module.exports = { TIME_ZONE, accountId, mappingIdentity, reportPeriod, visibleCampaigns, leadCampaign, aggregateReport, cpl };
