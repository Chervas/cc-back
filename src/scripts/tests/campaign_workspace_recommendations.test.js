'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommendationFixture } = require('./fixtures/campaign_workspace_recommendations.fixture');
const { buildAdCostRecommendations } = require('../../services/campaignWorkspaceRecommendations.service');

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: real report and CRM identities produce a read-only comparison, not another incident or command`, () => {
    const f = recommendationFixture(provider); const report = f.build();
    assert.equal(report.recommendations.length, 1);
    const item = report.recommendations[0];
    assert.equal(item.higherCostAd.id, '800~701'); assert.equal(item.lowerCostAd.id, '800~700');
    assert.equal(item.higherCostAd.leads, 14); assert.equal(item.higherCostAd.spend, 280);
    assert.equal(item.lowerCostAd.cpl, 10); assert.equal(item.higherCostAd.cpl, 20);
    assert.match(item.detail, /100%/); assert.equal(item.automatic, false); assert.equal(item.action, 'review_ads');
    assert.equal(report.findings.length, 0); assert.equal(report.affectedCount, 0);
    assert.equal(report.healthBlocks.length, 6); const block = report.healthBlocks.find(block => block.id === 'cost');
    assert.equal(block.recommendations.length, 1); assert.equal(block.status, 'Sin comparativa'); assert.match(block.summary, /periodo anterior/);
    assert.doesNotMatch(JSON.stringify(item), /accessToken|email|phone|mandate|fingerprint|before|after|change|payload/);
  });
  test(`${provider}: missing day, ad or amount reconciliation suppresses a recommendation without deleting results`, () => {
    for (const change of [f => f.facts.pop(), f => f.ads.pop(), f => { f.facts[0].spend++; },
      f => { f.ads[0].spend = NaN; }, f => { f.facts[0].spend = null; }]) {
      const f = recommendationFixture(provider); change(f);
      const result = f.build(); assert.equal(result.recommendations.length, 0); assert.equal(result.current.leads, 28);
    }
  });
  test(`${provider}: missing, intra-day, stale and future metric observations do not support a proposal`, () => {
    for (const change of [f => { f.ads[0].metricsUpdatedAt = null; }, f => { f.ads[0].metricsUpdatedAt = `${f.period.start}T12:00:00Z`; },
      f => { f.facts[0].updatedAt = new Date(+f.now + 1); },
      f => f.ads.forEach(ad => { ad.metricsUpdatedAt = '2026-09-01T00:00:00Z'; })]) {
      const f = recommendationFixture(provider); change(f); assert.deepEqual(f.build().recommendations, []);
    }
  });
  test(`${provider}: unknown reception, revoked permissions, unassigned leads or small samples never become optimization suggestions`, () => {
    for (const change of [f => f.evidence.clear(), f => { f.evidence.get(f.campaign.id).reception.ready = false; },
      f => { f.campaign.destinationCheck = { status: 'failed', error: 'workspace_meta_permissions_required' }; },
      f => { f.campaign.assigned = false; }, f => { f.campaign.paused = true; }, f => { f.campaign.currency = 'USD'; },
      f => { f.leads[0].advertising_identity = null; f.leads[0].advertising_ad_identity = null; }, f => f.leads.splice(0, 5)]) {
      const f = recommendationFixture(provider); change(f); assert.equal(f.build().recommendations.length, 0);
    }
  });
  test(`${provider}: another campaign, account or ad group cannot supply a cheap comparison`, () => {
    for (const change of [f => f.ads.filter(ad => ad.id === '700').forEach(ad => { ad.account_id = '99'; }),
      f => f.ads.filter(ad => ad.id === '700').forEach(ad => { ad.campaign_id = '99'; }),
      f => { f.ads.filter(ad => ad.id === '700').forEach(ad => { ad.groupId = '900'; });
        for (const lead of f.leads.slice(0, 14)) (lead.advertising_identity || lead.advertising_ad_identity).adgroup_id = '900'; }]) {
      const f = recommendationFixture(provider); change(f); assert.equal(f.build().recommendations.length, 0);
    }
  });
  test(`${provider}: threshold is inclusive, deterministic and deduplicates matching cached segments`, () => {
    const f = recommendationFixture(provider);
    f.ads.filter(ad => ad.id === '701').forEach(ad => { ad.spend = 30; }); f.facts.forEach(fact => { fact.spend = 50; });
    f.facts.push(...structuredClone(f.facts)); f.ads.push(...structuredClone(f.ads));
    const items = f.build().recommendations; assert.equal(items.length, 1); assert.match(items[0].detail, /50%/);
    f.facts.reverse(); f.ads.reverse(); assert.deepEqual(f.build().recommendations, items);
    f.ads.filter(ad => ad.id === '701').forEach(ad => { ad.spend = 29; }); f.facts.forEach(fact => { fact.spend = 49; });
    assert.equal(f.build().recommendations.length, 0);
  });
}

test('recommendations respect the full 30-day period and tolerate only one cent of daily rounding', () => {
  const f = recommendationFixture('meta_ads', 30);
  f.facts.forEach(fact => { fact.spend += .01; });
  assert.equal(f.build().recommendations.length, 1);
  f.facts[0].spend += .02; assert.equal(f.build().recommendations.length, 0);
});
test('partial or unsupported report windows do not silently reduce the comparison period', () => {
  const f = recommendationFixture(); const report = f.build();
  for (const period of [{ ...f.period, days: 1 }, { ...f.period, end: '2026-09-09' }, { ...f.period, timeZone: 'UTC' }]) {
    assert.deepEqual(buildAdCostRecommendations({ ...f, report: { ...report, period } }), []);
  }
});
test('unattributed paid leads suppress only the potentially affected clinic, not unrelated clinics', () => {
  const f = recommendationFixture();
  f.leads.push({ id: 999, clinica_id: 902, channel: 'paid', created_at: `${f.period.end}T10:00:00Z` });
  assert.equal(f.build().recommendations.length, 1);
  f.leads.at(-1).clinica_id = 901; assert.equal(f.build().recommendations.length, 0);
});
test('viewing proposals never calls the optimization producer or a provider transport', () => {
  const moduleId = require.resolve('../../services/campaignWorkspaceOptimizationExecution.service');
  const original = require.cache[moduleId];
  require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true,
    exports: { enqueueOptimizationAdjustment: () => assert.fail('Read-only recommendations must not enqueue changes') } };
  try { assert.equal(recommendationFixture().build().recommendations.length, 1); }
  finally { if (original) require.cache[moduleId] = original; else delete require.cache[moduleId]; }
});
test('unresolved technical incidents and missing recent leads take priority over cost recommendations', () => {
  for (const patch of [f => { f.evidence.get(f.campaign.id).optimization = [{ id: 'pending', action: 'adjust_bids', actionLabel: 'Ajuste de puja' }]; },
    f => f.leads.forEach(lead => { lead.created_at = `${f.period.start}T12:00:00Z`; })]) {
    const f = recommendationFixture(); patch(f);
    const report = f.build(); assert.ok(report.findings.length > 0); assert.equal(report.recommendations.length, 0);
  }
});
test('the browser fixture runs isolated by default and snapshots valid and revoked states independently', () => {
  const output = require('node:child_process').execFileSync(process.execPath,
    [require.resolve('./fixtures/campaign_workspace_recommendations.fixture')],
    { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
  const states = JSON.parse(output);
  assert.equal(states.single.recommendations.length, 1); assert.equal(states.aggregate.recommendations.length, 2);
  assert.equal(states.revoked.recommendations.length, 0);
  assert.equal(states.single.rows[0].campaign.destinationCheck, undefined);
  assert.ok(states.aggregate.rows.every(row => !row.campaign.destinationCheck));
  assert.equal(states.aggregate.findings.length, 0);
});
