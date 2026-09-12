'use strict';

if (require.main === module) {
  require('./campaign_offline_runtime.cjs');
  const modelFile = require.resolve('../../../../models');
  if (require.cache[modelFile]) throw Error('The offline fixture must run before the production model index is loaded');
  require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true, exports: {} };
}

const { aggregateReport, reportPeriod } = require('../../../services/campaignWorkspaceReport.service');
const { buildWorkspaceHealth } = require('../../../services/campaignWorkspaceHealth.service');
const { buildAdCostRecommendations } = require('../../../services/campaignWorkspaceRecommendations.service');
const { externalCampaignIdentityKey } = require('../../../services/externalCampaignAssignmentTargets.service');

function recommendationFixture(provider = 'meta_ads', days = 7) {
  const now = new Date('2026-09-11T12:00:00Z'); const period = reportPeriod(days, now);
  const reference = { provider, account_id: '20', campaign_id: '30' };
  const campaign = { ...reference, id: externalCampaignIdentityKey(reference), clinicId: 901, assigned: true, currency: 'EUR',
    name: 'Primera visita', accountName: 'Cuenta de prueba', status: provider === 'meta_ads' ? 'ACTIVE' : 'ENABLED', paused: false,
    destination: 'native', urls: [], lastSeenAt: now.toISOString() };
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(period.start) + i * 86400000).toISOString().slice(0, 10));
  const facts = dates.map(date => ({ ...reference, date, spend: 60, updatedAt: now, segment: ['TOTAL'] }));
  const ads = dates.flatMap(date => ['700', '701'].map(id => ({ ...reference, id, groupId: '800', groupName: 'Primera visita',
    title: id === '700' ? 'Conoce nuestra clinica' : 'Primera visita informativa', status: campaign.status,
    date, spend: id === '700' ? 20 : 40, segment: ['TOTAL'], updatedAt: now, metricsUpdatedAt: now })));
  const leads = ['700', '701'].flatMap((adId, index) => Array.from({ length: 14 }, (_, i) => ({ id: index * 100 + i,
    clinica_id: 901, source: provider, channel: 'paid', created_at: `${dates[Math.floor(i * (dates.length - 1) / 13)]}T12:00:00Z`,
    google_ads_customer_id: provider === 'google_ads' ? '20' : null, google_ads_campaign_id: provider === 'google_ads' ? '30' : null,
    external_source: provider === 'google_ads' ? 'google_lead_form' : 'meta_lead_form',
    [provider === 'google_ads' ? 'advertising_ad_identity' : 'advertising_identity']: { ...reference, version: 1, clinic_id: 901,
      verified_by: provider === 'google_ads' ? 'google_ads_api' : 'meta_graph', form_id: '50', page_id: '40', ad_id: adId, adgroup_id: '800' },
  })));
  const evidence = new Map([[campaign.id, { reception: { checked: true, ready: true, state: 'verified' } }]]);
  const fixture = { now, period, campaign, facts, ads, leads, evidence };
  fixture.build = () => {
    const report = buildWorkspaceHealth(aggregateReport({ campaigns: [campaign], period, facts, ads, leads, now }), evidence, now);
    report.recommendations = buildAdCostRecommendations({ report, facts, ads, leads, evidence, now });
    for (const block of report.healthBlocks) block.recommendations = report.recommendations.filter(item => item.category === block.id);
    return report;
  };
  return fixture;
}

module.exports = { recommendationFixture };

if (require.main === module) {
  const meta = recommendationFixture('meta_ads', 30); const google = recommendationFixture('google_ads', 30);
  google.campaign.name = 'Revisiones en Google'; google.leads.forEach(lead => { lead.id += 1000; });
  const facts = [...meta.facts, ...google.facts]; const ads = [...meta.ads, ...google.ads]; const leads = [...meta.leads, ...google.leads];
  const evidence = new Map([...meta.evidence, ...google.evidence]);
  const aggregate = buildWorkspaceHealth(aggregateReport({ campaigns: [meta.campaign, google.campaign], facts, ads, leads, period: meta.period, now: meta.now }), evidence, meta.now);
  aggregate.recommendations = buildAdCostRecommendations({ report: aggregate, facts, ads, leads, evidence, now: meta.now });
  for (const block of aggregate.healthBlocks) block.recommendations = aggregate.recommendations.filter(item => item.category === block.id);
  const single = structuredClone(meta.build()); const combined = structuredClone(aggregate);
  meta.campaign.destinationCheck = { status: 'failed', error: 'workspace_meta_permissions_required' };
  const revoked = meta.build();
  delete meta.campaign.destinationCheck;
  meta.ads.forEach(ad => { ad.status = ad.id === '700' ? 'PAUSED' : 'PENDING_BILLING_INFO'; });
  google.ads.forEach(ad => { ad.status = 'UNKNOWN'; });
  const delivery = buildWorkspaceHealth(aggregateReport({ campaigns: [meta.campaign, google.campaign], facts, ads, leads,
    period: meta.period, now: meta.now }), evidence, meta.now);
  const { googleAdDeliveryObservation, googleAdDeliveryStatus } = require('../../../services/googleAdDelivery.service');
  google.ads.forEach(ad => {
    const rejected = ad.id === '700';
    const deliveryObservation = googleAdDeliveryObservation({ primaryStatus: rejected ? 'NOT_ELIGIBLE' : 'LIMITED',
      policySummary: { approvalStatus: rejected ? 'DISAPPROVED' : 'APPROVED_LIMITED', reviewStatus: 'REVIEWED' } }, google.now);
    ad.status = googleAdDeliveryStatus({ campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', adStatus: 'ENABLED',
      observedAt: google.now, present: true, deliveryObservation });
  });
  const googleDelivery = google.build();
  process.stdout.write(JSON.stringify({ single, aggregate: combined, revoked, delivery, googleDelivery }));
}
