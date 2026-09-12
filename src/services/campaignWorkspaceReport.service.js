'use strict';

const { formatDateLocal, localDateTimeToUtc } = require('../lib/availability-calendar');
const { canonicalExternalCampaignIdentity, externalCampaignIdentityKey } = require('./externalCampaignAssignmentTargets.service');
const { canonicalLeadAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');
const { nativeForms } = require('./campaignWorkspaceNativeReception.service');
const { destinationCheck } = require('./campaignWorkspaceMetaDestination.service');
const { googleNativeForms } = require('./campaignWorkspaceGoogleReception.service');
const { googleDestinationDetection } = require('./campaignWorkspaceGoogleDestination.service');
const { adKey, createLeadAdMatcher, evaluateAdComparison, evaluateAdSpendCoverage } = require('./campaignAdAttribution.service');

const TIME_ZONE = 'Europe/Madrid';
const DAY = 86400000;
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const dateShift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const accountId = value => String(value || '').replace(/^act_/i, '').replace(/\D/g, '');
const dayOf = value => value && Number.isFinite(new Date(value).getTime()) ? formatDateLocal(new Date(value), TIME_ZONE) : null;
const empty = () => ({ spend: 0, leads: 0, appointments: 0, accepted: null, providerConversions: null });
const cpl = metrics => metrics?.spend != null && metrics?.leads > 0 ? metrics.spend / metrics.leads : null;
const observationTime = (value, now) => {
  const time = value ? +new Date(value) : NaN;
  return Number.isFinite(time) && time <= +now ? time : null;
};
function freshObservation(value, now = new Date()) {
  const time = observationTime(value, now);
  return time !== null && +now - time < 36 * 3600000;
}

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

function accountAliases(provider, value) {
  const id = accountId(value);
  return [...new Set([id, `act_${id}`,
    ...(provider === 'google_ads' && id.length === 10 ? [`${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`] : [])])];
}

function ownsCampaignAccount(scope, owners) {
  return owners.length > 0 && owners.every(owner => scope.clinicIds.includes(owner.clinicId)
    || scope.groupId && owner.groupId === scope.groupId || scope.authorizedGroupIds?.includes(owner.groupId));
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
    const ownsGroup = ownsCampaignAccount(scope, owners);
    if (!assignedClinic && !ownsGroup) continue;
    if (assignedClinic && !clinics.has(assignedClinic)) continue;
    const detection = (identity.provider === 'google_ads' && googleDestinationDetection(item.destination_detection)) || item.destination_detection;
    const verifiedSource = ['workspace_meta_graph', 'workspace_google_ads'].includes(detection?.source);
    const metaCheck = identity.provider === 'meta_ads' ? destinationCheck(detection) : null;
    result.set(key, {
      ...identity, id: key, name: item.campaign_name || identity.campaign_id,
      clinicId: assignedClinic, assigned: !!assignedClinic, accountName: item.account_name || identity.account_id,
      provider: identity.provider, status: item.status || 'UNKNOWN',
      paused: /PAUSED|REMOVED|DELETED|ARCHIVED/i.test(item.status || ''),
      destination: ({ web: 'web', lead_form: 'native', mixed: 'mixed' })[detection?.kind] || 'unknown',
      nativeForms: identity.provider === 'meta_ads' ? nativeForms(detection) : googleNativeForms(item.destination_detection),
      destinationCheckedAt: verifiedSource ? detection.checked_at || null : null,
      destinationComplete: verifiedSource && detection.complete === true && !metaCheck?.status,
      ...(metaCheck?.status ? { destinationCheck: metaCheck } : {}),
      urls: (Array.isArray(detection?.urls) ? detection.urls : []).filter(url => {
        try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch (_) { return false; }
      }),
      lastSeenAt: item.last_seen_at || null,
    });
  }
  return [...result.values()];
}

function leadCampaign(lead, campaigns) {
  if (lead.advertising_identity_conflict === true) return null;
  const identity = canonicalLeadAdvertisingIdentity(lead);
  if (identity && ['paid', null, undefined].includes(lead.channel)) return campaigns.find(campaign =>
    campaign.provider === identity.provider && campaign.clinicId === number(lead.clinica_id)
    && campaign.account_id === identity.account_id && campaign.campaign_id === identity.campaign_id)?.id || null;
  // Legacy web intake stores the contact method as source. This is report attribution,
  // not verified ad-level evidence for signals, economic attribution or Optimiza.
  if (['web', 'call_click'].includes(lead.source)
    && (lead.google_ads_customer_id != null || lead.google_ads_campaign_id != null)) {
    if (lead.channel !== 'paid' || typeof lead.google_ads_customer_id !== 'string'
      || !/^(\d{10}|\d{3}-\d{3}-\d{4})$/.test(lead.google_ads_customer_id)
      || typeof lead.google_ads_campaign_id !== 'string' || !/^[1-9]\d{0,63}$/.test(lead.google_ads_campaign_id)) return null;
    const matches = campaigns.filter(campaign => campaign.provider === 'google_ads' && campaign.assigned
      && campaign.clinicId === number(lead.clinica_id) && campaign.account_id === accountId(lead.google_ads_customer_id)
      && campaign.campaign_id === lead.google_ads_campaign_id);
    return matches.length === 1 ? matches[0].id : null;
  }
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

function withFreshGoogleCampaignStates(campaigns, metricRows, now = new Date()) {
  const latest = new Map();
  for (const row of metricRows) {
    if (!freshObservation(row.updated_at, now) || !['ENABLED', 'PAUSED', 'REMOVED'].includes(row.campaignStatus)) continue;
    const key = JSON.stringify([accountId(row.customerId), String(row.campaignId)]);
    const at = +new Date(row.updated_at); const previous = latest.get(key);
    if (!previous || at > previous.at) latest.set(key, { at, statuses: new Set([row.campaignStatus]) });
    else if (at === previous.at) previous.statuses.add(row.campaignStatus);
  }
  return campaigns.map(item => {
    if (item.provider !== 'google_ads') return item;
    const observed = latest.get(JSON.stringify([item.account_id, item.campaign_id]));
    if (!observed || observed.at <= (observationTime(item.lastSeenAt, now) ?? -1)) return item;
    const status = observed.statuses.size === 1 ? [...observed.statuses][0] : 'UNKNOWN';
    // Campaign status is not ad approval, destination verification or an authorization.
    return { ...item, status, paused: ['PAUSED', 'REMOVED'].includes(status), lastSeenAt: new Date(observed.at).toISOString() };
  });
}

function aggregateReport({ campaigns, facts = [], leads = [], appointments = [], ads = [], budgetAttribution = null, period, now = new Date() }) {
  const rows = campaigns.map(campaign => ({ campaign, current: empty(), previous: empty(),
    daily: Array.from({ length: period.days }, (_, i) => ({ date: dateShift(period.start, i), leads: 0, appointments: 0 })),
    ads: [], receptionReady: false, performance: campaign.paused ? 'paused' : 'insufficient',
    coverage: { spend: false, previousSpend: false, latestMetricDate: null, updatedAt: null, recentSpend: 0, recentLeads: 0 },
  }));
  const index = new Map(rows.map(row => [row.campaign.id, row]));
  const periodKey = day => !day || day < period.previousStart || day > period.end ? null : day < period.start ? 'previous' : 'current';
  if (budgetAttribution) {
    const amounts = new Map(rows.filter(row => row.campaign.assigned && budgetAttribution.supportedProviders.includes(row.campaign.provider))
      .map(row => [row.campaign.id, { current: 0, previous: 0 }]));
    for (const allocation of budgetAttribution.allocations) {
      const target = periodKey(dayOf(allocation.acceptedAt));
      const totals = amounts.get(allocation.campaignId);
      if (target && totals) totals[target] += allocation.amountCents;
    }
    for (const row of rows) {
      const totals = amounts.get(row.campaign.id);
      if (totals) { row.current.accepted = totals.current / 100; row.previous.accepted = totals.previous / 100; }
    }
  }
  const seenFacts = new Set();
  const campaignDates = new Map(rows.map(row => [row.campaign.id, { current: new Map(), previous: new Map() }]));
  const adDaily = new Map(rows.map(row => [row.campaign.id, { current: new Map(), previous: new Map() }]));
  const recentStart = dateShift(period.end, -1);
  for (const fact of facts) {
    const key = externalCampaignIdentityKey(fact);
    const row = index.get(key);
    const target = periodKey(fact.date);
    if (!row || !target) continue;
    const dedupe = JSON.stringify([key, fact.date, fact.segment]);
    if (seenFacts.has(dedupe)) continue;
    seenFacts.add(dedupe);
    const dates = campaignDates.get(key)[target];
    dates.set(fact.date, (dates.get(fact.date) || 0) + number(fact.spend));
    row[target].spend += number(fact.spend);
    if (fact.providerConversions != null) row[target].providerConversions = (row[target].providerConversions || 0) + number(fact.providerConversions);
    row.coverage[target === 'current' ? 'spend' : 'previousSpend'] = true;
    // Freshness belongs to the latest metric day, using its oldest segment observation.
    // A backfill of older dates must not make a stale campaign appear current.
    const observed = observationTime(fact.updatedAt, now);
    if (!row.coverage.latestMetricDate || fact.date > row.coverage.latestMetricDate) {
      row.coverage.latestMetricDate = fact.date;
      row.coverage.updatedAt = observed === null ? null : fact.updatedAt;
    } else if (fact.date === row.coverage.latestMetricDate) {
      const previous = observationTime(row.coverage.updatedAt, now);
      row.coverage.updatedAt = observed === null || previous === null ? null : observed < previous ? fact.updatedAt : row.coverage.updatedAt;
    }
    if (fact.date >= recentStart) row.coverage.recentSpend += number(fact.spend);
  }
  const leadRows = new Map();
  const seenLeads = new Set();
  let unattributedLeads = 0;
  for (const lead of leads) {
    if (seenLeads.has(String(lead.id))) continue;
    seenLeads.add(String(lead.id));
    const key = leadCampaign(lead, campaigns);
    if (key) leadRows.set(String(lead.id), { row: index.get(key), clinicId: number(lead.clinica_id), lead });
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
  const booked = [];
  for (const appointment of appointments) {
    if (seenAppointments.has(String(appointment.id_cita)) || ['cancelada', 'reprogramada'].includes(appointment.estado) || appointment.es_provisional) continue;
    seenAppointments.add(String(appointment.id_cita));
    const match = leadRows.get(String(appointment.lead_intake_id));
    if (!match || match.clinicId !== number(appointment.clinica_id)
      || !dayOf(match.lead.created_at) || +new Date(match.lead.created_at) > +new Date(appointment.created_at)) continue;
    const day = dayOf(appointment.created_at);
    const target = periodKey(day);
    if (!target) continue;
    booked.push({ ...match, target });
    match.row[target].appointments++;
    const daily = match.row.daily.find(point => point.date === day);
    if (daily) daily.appointments++;
  }
  const adIndex = new Map();
  const adDates = new Map();
  const seenAds = new Set();
  for (const ad of ads) {
    const row = index.get(externalCampaignIdentityKey(ad));
    const target = periodKey(ad.date);
    if (!row || !target && ad.inventory !== true) continue;
    const key = `${row.campaign.id}:${adKey(ad)}`;
    const dedupe = JSON.stringify([key, ad.date, ad.segment]);
    if (seenAds.has(dedupe)) continue;
    seenAds.add(dedupe);
    const status = row.campaign.paused && /^(ACTIVE|ENABLED|LIMITED)$/i.test(ad.status || '') ? 'PAUSED' : ad.status || 'UNKNOWN';
    if (!adIndex.has(key)) {
      const value = { id: adKey(ad), advertisingId: ad.id, groupId: ad.groupId || null, groupName: ad.groupName || null,
        title: ad.title || ad.id, status,
        current: empty(), previous: empty(), currentCpl: null, previousCpl: null,
        metricsUpdatedAt: null, latestMetricDate: null,
        lastSeenAt: ad.updatedAt || null, active: !row.campaign.paused && /^(ACTIVE|ENABLED|LIMITED)$/i.test(ad.status || ''),
        lowestCost: false, rejected: /DISAPPROVED|REJECTED/i.test(ad.status || '') };
      adIndex.set(key, value); row.ads.push(value);
      adDates.set(key, { current: new Set(), previous: new Set() });
    }
    const value = adIndex.get(key);
    if (target && ad.inventory !== true) {
      value[target].spend += number(ad.spend);
      adDates.get(key)[target].add(ad.date);
      const dates = adDaily.get(row.campaign.id)[target];
      dates.set(ad.date, (dates.get(ad.date) || 0) + number(ad.spend));
      value.periods = { ...(value.periods || {}), [target]: true };
      const updated = ad.metricsUpdatedAt || ad.updatedAt;
      if (!value.latestMetricDate || ad.date > value.latestMetricDate) {
        value.latestMetricDate = ad.date; value.metricsUpdatedAt = updated || null;
      } else if (ad.date === value.latestMetricDate && (!updated || +new Date(updated) < +new Date(value.metricsUpdatedAt))) {
        value.metricsUpdatedAt = updated || null;
      }
      if (ad.providerConversions != null) value[target].providerConversions = (value[target].providerConversions || 0) + number(ad.providerConversions);
    }
    if (ad.updatedAt && new Date(ad.updatedAt) > new Date(value.lastSeenAt || 0)) {
      value.lastSeenAt = ad.updatedAt; value.status = status;
      value.rejected = /DISAPPROVED|REJECTED/i.test(value.status);
      value.active = !row.campaign.paused && /^(ACTIVE|ENABLED|LIMITED)$/i.test(value.status);
    }
  }
  const matchAd = createLeadAdMatcher(campaigns, new Map(rows.map(row => [row.campaign.id, row.ads])));
  for (const row of rows) {
    if (!row.coverage.spend) row.current.spend = null;
    if (!row.coverage.previousSpend) row.previous.spend = null;
    const dates = campaignDates.get(row.campaign.id);
    row.coverage.metricDays = { current: dates.current.size, previous: dates.previous.size };
    row.adAttribution = { method: 'native_or_inventory_checked_web_ad_identity', unattributed: { current: { ...empty(), spend: null }, previous: { ...empty(), spend: null } } };
    for (const target of ['current', 'previous']) {
      row.adAttribution.unattributed[target].accepted = row[target].accepted;
      for (const ad of row.ads) ad[target].accepted = row[target].accepted === null ? null : 0;
    }
  }
  for (const { row, lead } of leadRows.values()) {
    const target = periodKey(dayOf(lead.created_at));
    if (!target) continue;
    const adId = matchAd(lead, row.campaign.id);
    const ad = adId ? adIndex.get(`${row.campaign.id}:${adId}`) : null;
    if (ad) ad[target].leads++;
    else row.adAttribution.unattributed[target].leads++;
  }
  for (const { row, lead, target } of booked) {
    const adId = matchAd(lead, row.campaign.id);
    const ad = adId ? adIndex.get(`${row.campaign.id}:${adId}`) : null;
    if (ad) ad[target].appointments++;
    else row.adAttribution.unattributed[target].appointments++;
  }
  for (const allocation of budgetAttribution?.adAllocations || []) {
    const row = index.get(allocation.campaignId); const target = periodKey(dayOf(allocation.acceptedAt));
    const ad = adIndex.get(`${allocation.campaignId}:${allocation.adId}`);
    if (!row || !target || !ad || ad[target].accepted === null) continue;
    ad[target].accepted = Math.round((ad[target].accepted * 100) + allocation.amountCents) / 100;
    row.adAttribution.unattributed[target].accepted = Math.round(row.adAttribution.unattributed[target].accepted * 100 - allocation.amountCents) / 100;
  }
  for (const row of rows) {
    if (!row.campaign.assigned) {
      row.current.leads = row.previous.leads = null;
      row.current.appointments = row.previous.appointments = null;
      for (const target of ['current', 'previous']) {
        row.adAttribution.unattributed[target].leads = row.adAttribution.unattributed[target].appointments = null;
        for (const ad of row.ads) ad[target].leads = ad[target].appointments = null;
      }
    }
    for (const ad of row.ads) {
      if (!ad.periods?.current) ad.current.spend = null;
      if (!ad.periods?.previous) ad.previous.spend = null;
      delete ad.periods;
      const dates = adDates.get(`${row.campaign.id}:${ad.id}`);
      ad.metricDays = { current: dates.current.size, previous: dates.previous.size };
    }
    row.adSpendCoverage = evaluateAdSpendCoverage(row, period, campaignDates.get(row.campaign.id), adDaily.get(row.campaign.id));
    for (const ad of row.ads) {
      ad.currentCpl = row.adSpendCoverage.current.status === 'matched' && row.campaign.assigned
        && row.adAttribution.unattributed.current.leads === 0 ? cpl(ad.current) : null;
      ad.previousCpl = row.adSpendCoverage.previous.status === 'matched' && row.campaign.assigned
        && row.adAttribution.unattributed.previous.leads === 0 ? cpl(ad.previous) : null;
    }
    row.adAttribution.comparison = evaluateAdComparison(row, period, now);
    for (const ad of row.ads) ad.lowestCost = ad.id === row.adAttribution.comparison.bestAdId;
    const comparable = row.current.leads >= 10 && row.previous.leads >= 10 && cpl(row.previous) > 0 && cpl(row.current) !== null;
    const fresh = freshObservation(row.coverage.updatedAt, now) && row.coverage.latestMetricDate === period.end;
    row.performance = row.campaign.paused ? 'paused' : !fresh || !comparable ? 'insufficient'
      : cpl(row.current) / cpl(row.previous) >= 1.25 ? 'attention' : 'stable';
  }
  const included = rows.filter(row => row.campaign.assigned);
  const currencies = new Set(included.map(row => row.campaign.currency || null));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const sum = key => included.reduce((total, row) => ({
    spend: total.spend === null || row[key].spend === null ? null : total.spend + row[key].spend,
    leads: total.leads + row[key].leads, appointments: total.appointments + row[key].appointments,
    accepted: total.accepted === null || row[key].accepted === null ? null : Math.round((total.accepted + row[key].accepted) * 100) / 100,
    providerConversions: total.providerConversions === null || row[key].providerConversions === null ? null : total.providerConversions + row[key].providerConversions,
  }), { ...empty(), spend: included.length ? 0 : null, leads: included.length ? 0 : null,
    appointments: included.length ? 0 : null, accepted: included.length && budgetAttribution ? 0 : null,
    providerConversions: included.length ? 0 : null });
  return {
    days: period.days, period, currency, rows,
    current: { ...sum('current'), ...(currency ? {} : { spend: null }) },
    previous: { ...sum('previous'), ...(currency ? {} : { spend: null }) },
    daily: Array.from({ length: period.days }, (_, i) => ({ date: dateShift(period.start, i),
      leads: included.reduce((total, row) => total + row.daily[i].leads, 0),
      appointments: included.reduce((total, row) => total + row.daily[i].appointments, 0) })),
    unattributedLeads, attribution: {
      leads: 'unique_lead_intake_id', appointments: 'linked_appointment_created_at_excluding_cancelled',
      accepted: budgetAttribution?.method || 'pending_budget_campaign_attribution', adLeads: 'native_or_inventory_checked_web_ad_identity_with_unattributed_remainder',
    },
    budgetAttribution: budgetAttribution ? { currency: budgetAttribution.currency, supportedProviders: budgetAttribution.supportedProviders, ...budgetAttribution.coverage } : null,
  };
}

module.exports = { TIME_ZONE, accountId, accountAliases, ownsCampaignAccount, mappingIdentity, reportPeriod, visibleCampaigns, leadCampaign, aggregateReport, cpl, freshObservation, withFreshGoogleCampaignStates };
