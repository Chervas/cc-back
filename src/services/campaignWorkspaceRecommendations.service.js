'use strict';

const { externalCampaignIdentityKey } = require('./externalCampaignAssignmentTargets.service');
const { adKey } = require('./campaignAdAttribution.service');
const { localDateTimeToUtc, formatDateLocal } = require('../lib/availability-calendar');
const { leadCampaign } = require('./campaignWorkspaceReport.service');

const DAY = 86400000;
const RULE = Object.freeze({ version: 1, minimum_leads: 10, minimum_difference_pct: 50 });
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const observed = (value, end, now) => value && Number.isFinite(+new Date(value)) && +new Date(value) >= end && +new Date(value) <= +now;
const nextDay = day => new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);

// This diagnostic never produces an executable command. Reconciled cached data is not provider-final spend or a causal experiment.
function buildAdCostRecommendations({ report, facts, ads, leads, evidence, now = new Date() }) {
  const result = [];
  if (![7, 30].includes(report.period.days) || report.period.timeZone !== 'Europe/Madrid') return result;
  const days = Array.from({ length: report.period.days }, (_, i) => new Date(Date.parse(`${report.period.start}T12:00:00Z`) + i * DAY).toISOString().slice(0, 10));
  if (days.at(-1) !== report.period.end) return result;
  const dayEnds = new Map(days.map(day => [day, +localDateTimeToUtc(nextDay(day), '00:00', 'Europe/Madrid')]));
  if ([...dayEnds.values()].some(end => end > +now)) return result;
  const inPeriod = value => dayEnds.has(value.date);
  const indexed = rows => {
    const index = new Map();
    for (const row of rows.filter(inPeriod)) {
      const key = externalCampaignIdentityKey(row);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    return index;
  };
  const factsByCampaign = indexed(facts); const adsByCampaign = indexed(ads.filter(ad => !ad.inventory));
  const campaigns = report.rows.map(row => row.campaign);
  const uncertainClinics = new Set(leads.filter(lead => lead.channel === 'paid' && Number.isFinite(+new Date(lead.created_at))
    && dayEnds.has(formatDateLocal(new Date(lead.created_at), 'Europe/Madrid')) && !leadCampaign(lead, campaigns)).map(lead => Number(lead.clinica_id)));
  const pending = new Set(report.findings.filter(item => item.technical || item.category === 'no-leads' || item.category === 'delivery')
    .flatMap(item => item.campaignIds));
  for (const row of report.rows) {
    const campaign = row.campaign; const reception = evidence.get(campaign.id)?.reception;
    if (!campaign.assigned || campaign.paused || campaign.currency !== 'EUR' || campaign.destinationCheck?.status
      || uncertainClinics.has(campaign.clinicId) || pending.has(campaign.id)
      || reception?.checked !== true || reception.ready !== true || reception.state !== 'verified'
      || row.adAttribution?.unattributed?.current?.leads !== 0 || row.adAttribution?.comparison?.status !== 'ready') continue;
    const active = row.ads.filter(ad => ad.active);
    if (active.some(ad => !ad.groupId || !Number.isSafeInteger(ad.current.leads) || ad.current.leads < RULE.minimum_leads
      || money(ad.current.spend) === null || money(ad.current.spend) <= 0)) continue;
    const key = externalCampaignIdentityKey(campaign);
    const daily = new Map(days.map(day => [day, { campaign: 0, ads: 0, campaignRows: 0, adIds: new Set() }]));
    let complete = true;
    for (const [kind, values] of [['campaign', factsByCampaign.get(key) || []], ['ads', adsByCampaign.get(key) || []]]) {
      const seen = new Set();
      for (const item of values) {
        const identity = JSON.stringify([kind === 'ads' ? adKey(item) : '', item.date, item.segment]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const amount = money(item.spend); const at = kind === 'ads' && Object.hasOwn(item, 'metricsUpdatedAt') ? item.metricsUpdatedAt : item.updatedAt;
        if (amount === null || !observed(at, dayEnds.get(item.date), now)) { complete = false; break; }
        const point = daily.get(item.date);
        // Keep unrounded totals until the daily reconciliation; segmented micros may include fractional cents.
        point[kind] += item.spend;
        if (!Number.isFinite(point[kind]) || money(point[kind]) === null) { complete = false; break; }
        if (kind === 'campaign') point.campaignRows++;
        else point.adIds.add(adKey(item));
      }
    }
    if (!complete || [...daily.values()].some(point => !point.campaignRows
      || active.some(ad => !point.adIds.has(ad.id)) || Math.abs(money(point.campaign) - money(point.ads)) > 1)) continue;
    const groups = new Map();
    for (const ad of active) { if (!groups.has(ad.groupId)) groups.set(ad.groupId, []); groups.get(ad.groupId).push(ad); }
    for (const [groupId, members] of groups) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => money(a.current.spend) / a.current.leads - money(b.current.spend) / b.current.leads || a.id.localeCompare(b.id));
      const lower = sorted[0]; const higher = sorted.at(-1);
      const numerator = BigInt(money(higher.current.spend)) * BigInt(lower.current.leads);
      const denominator = BigInt(money(lower.current.spend)) * BigInt(higher.current.leads);
      if (numerator * 100n < denominator * BigInt(100 + RULE.minimum_difference_pct)) continue;
      const percentage = Number((numerator - denominator) * 100n / denominator);
      if (!Number.isSafeInteger(percentage)) continue;
      const entry = ad => ({ id: ad.id, title: ad.title, groupId, spend: money(ad.current.spend) / 100,
        leads: ad.current.leads, cpl: money(ad.current.spend) / 100 / ad.current.leads });
      result.push({ id: `ad_cost_review:${campaign.id}:${groupId}`, kind: 'ad_cost_review', category: 'cost', ruleVersion: RULE.version,
        campaign, title: 'Revisa la diferencia de coste entre anuncios',
        detail: `Un anuncio tiene un coste por lead un ${percentage.toLocaleString('es-ES')}% mayor que otro del mismo grupo.`,
        nextStep: 'Compara el contenido y los resultados antes de decidir. No se ha pausado ni modificado ning\u00fan anuncio.',
        source: 'Inversi\u00f3n sincronizada y leads del CRM con anuncio identificado',
        window: { start: report.period.start, end: report.period.end }, checkedAt: now.toISOString(),
        higherCostAd: entry(higher), lowerCostAd: entry(lower), minimumLeads: RULE.minimum_leads,
        automatic: false, action: 'review_ads' });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { buildAdCostRecommendations, RULE };
