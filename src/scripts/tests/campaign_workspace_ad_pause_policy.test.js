'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualifiedFixture } = require('./fixtures/campaign_workspace_optimization_evidence.fixture');
const { POLICY, buildAdPauseProposals, validateAdPauseEvidence, assertPauseBaseline } = require('../../services/campaignWorkspaceAdPausePolicy.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const evaluationKey = digest('test-evaluation');
const seal = value => { const { fingerprint, ...body } = value; value.fingerprint = digest(body); return value; };

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: real collection produces one scoped pause with two complete windows and compact evidence`, async () => {
    const f = qualifiedFixture(provider); const source = await f.run(); assert.equal(source.collected, true, source.reason);
    const proposals = buildAdPauseProposals(source.evidence, { evaluationKey, now: f.state.now });
    assert.equal(proposals.length, 1); const { change, evidence } = proposals[0];
    assert.equal(change.target.id, '60'); assert.equal(change.after, 'PAUSED'); assert.equal(evidence.baseline_ad_id, '61');
    assert.equal(evidence.daily.length, 28); assert.equal(evidence.metrics.leads, 28); assert.equal(evidence.metrics.baseline_leads, 28);
    assert.equal(evidence.metrics.cost_cents, 168000); assert.equal(evidence.metrics.baseline_cost_cents, 56000);
    assert.equal(evidence.policy_version, POLICY.version);
    assert.deepEqual(validateAdPauseEvidence(evidence, f.state.now, change), evidence);
    assert.doesNotMatch(JSON.stringify(evidence), /accessToken|native_lead_id|external_id|raw_payload|email|phone|fixture-only/);
    assert.ok(JSON.stringify(evidence).length < 7000);
  });

  test(`${provider}: incomplete attribution, unverified reception and unauthorized resources never produce a pause`, async () => {
    const f = qualifiedFixture(provider); const source = (await f.run()).evidence;
    for (const mutate of [c => { c.attribution.complete = false; }, c => { c.attribution.unattributed_leads = 1; },
      c => { c.reception.ready = false; }, c => { c.authorization_targets = []; },
      c => { c.authorization_targets[0].id = '999'; }]) {
      const copy = structuredClone(source); mutate(copy); seal(copy);
      assert.deepEqual(buildAdPauseProposals(copy, { evaluationKey, now: f.state.now }), []);
    }
  });

  test(`${provider}: aggregate difference cannot hide an insufficient or contradictory fourteen-day window`, async () => {
    const f = qualifiedFixture(provider); const source = (await f.run()).evidence;
    for (const mutate of [c => { c.attribution.ad_daily = c.attribution.ad_daily.filter(row => !(row.ad_id === '60' && row.date < f.performance.dates[5])); },
      c => { c.performance.ad_daily.filter(row => row.ad_id === '60' && row.date < f.performance.dates[14]).forEach(row => { row.cost_micros = '30000000'; });
        c.performance.campaign_daily.filter(row => row.date < f.performance.dates[14]).forEach(row => { row.cost_micros = '50000000'; }); }]) {
      const copy = structuredClone(source); mutate(copy); seal(copy.performance); seal(copy);
      assert.deepEqual(buildAdPauseProposals(copy, { evaluationKey, now: f.state.now }), []);
    }
  });

  test(`${provider}: the two-times threshold is inclusive and requires positive mature samples`, async () => {
    const f = qualifiedFixture(provider); const source = (await f.run()).evidence;
    for (const row of source.performance.ad_daily.filter(row => row.ad_id === '60')) row.cost_micros = '40000000';
    for (const row of source.performance.campaign_daily) row.cost_micros = '60000000';
    seal(source.performance); seal(source);
    assert.equal(buildAdPauseProposals(source, { evaluationKey, now: f.state.now }).length, 1);
    source.performance.ad_daily[0].cost_micros = '39999999'; source.performance.campaign_daily[0].cost_micros = '59999999';
    seal(source.performance); seal(source);
    assert.equal(buildAdPauseProposals(source, { evaluationKey, now: f.state.now }).length, 0);
  });
}

test('corrupt or even re-signed inconsistent snapshots cannot become a rule decision', async () => {
  const f = qualifiedFixture(); const source = (await f.run()).evidence;
  for (const mutate of [c => { c.performance.ad_daily[0].cost_micros = '999'; },
    c => { c.performance.ad_daily[0].cost_micros = '999'; seal(c.performance); seal(c); },
    c => { c.reference.account_id = '99'; seal(c); }, c => { c.performance.inventory[0].active = false; },
    c => { c.attribution.ad_daily.push(c.attribution.ad_daily[0]); seal(c); }]) {
    const copy = structuredClone(source); mutate(copy);
    assert.throws(() => buildAdPauseProposals(copy, { evaluationKey, now: f.state.now }));
  }
});

test('Meta days without rows stay unknown and cannot be used as zero-cost evidence', async () => {
  const f = qualifiedFixture('meta_ads');
  f.state.campaignRows.shift(); f.state.adRows.splice(0, 2);
  const source = await f.run(); assert.equal(source.collected, true);
  assert.deepEqual(buildAdPauseProposals(source.evidence, { evaluationKey, now: f.state.now }), []);
});

test('compact proof validates its exact action, dates, source identity, aggregates and sampling rule', async () => {
  const f = qualifiedFixture(); const source = (await f.run()).evidence;
  const { change, evidence } = buildAdPauseProposals(source, { evaluationKey, now: f.state.now })[0];
  for (const mutate of [p => { p.policy_version = 2; }, p => { p.daily.pop(); }, p => { p.daily[0].leads = -1; },
    p => { p.daily[0].date = p.daily[1].date; }, p => { p.metrics.leads++; }, p => { p.baseline_ad_id = p.ad_id; },
    p => { p.ad_id = '99'; }, p => { p.group_id = '99'; }, p => { p.reference.account_id = '99'; },
    p => { p.patient = 'private'; }, p => { p.daily[0].clicks = Number.MAX_SAFE_INTEGER; },
    p => { p.daily[0].baseline_leads = 999; }]) {
    const copy = structuredClone(evidence); mutate(copy); assert.throws(() => validateAdPauseEvidence(copy, f.state.now, change));
  }
  assert.throws(() => validateAdPauseEvidence(evidence, new Date(+f.state.now + POLICY.evidence_ttl_ms), change));
  assert.doesNotThrow(() => validateAdPauseEvidence(evidence, new Date(+f.state.now + POLICY.evidence_ttl_ms - 1), change));
  assert.throws(() => buildAdPauseProposals(source, { evaluationKey, now: new Date(+f.state.now + 60000) }));
});

test('preflight requires the same baseline ad to remain active in the same group', async () => {
  const f = qualifiedFixture('meta_ads'); const source = (await f.run()).evidence;
  const { evidence, change } = buildAdPauseProposals(source, { evaluationKey, now: f.state.now })[0];
  const inspection = { reference: change.reference, currency: 'EUR', targets: [{ action: 'pause_underperforming_ads', id: '61', group_id: '50', value: 'ACTIVE' }] };
  assert.doesNotThrow(() => assertPauseBaseline(inspection, evidence, change));
  for (const mutate of [i => { i.targets = []; }, i => { i.targets[0].value = 'PAUSED'; }, i => { i.targets[0].group_id = '99'; },
    i => { i.reference.account_id = '99'; }, i => { i.currency = 'USD'; }]) {
    const copy = structuredClone(inspection); mutate(copy); assert.throws(() => assertPauseBaseline(copy, evidence, change), /baseline_changed/);
  }
});
