'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { collectOptimizationEvidence } = require('../../services/campaignWorkspaceOptimizationEvidence.service');
const { inspectGoogleSearchTerms, verifySearchTermsSnapshot, usableSearchTerm, MAX_TERMS, MAX_ROWS, TIMEOUT_MS } = require('../../services/campaignWorkspaceSearchTerms.service');
const { searchTermsFixture } = require('./fixtures/campaign_workspace_search_terms.fixture');

for (const channel of ['SEARCH', 'PERFORMANCE_MAX']) {
  test(`${channel}: actual paginated Google reader records only reported terms and provider-attributed conversions`, async () => {
    const f = searchTermsFixture(channel); f.state.pageSize = 1; const result = await f.snapshot();
    assert.equal(result.coverage, 'reported_terms_only'); assert.equal(result.conversion_basis, 'google_ads_attributed_not_crm');
    assert.equal(result.channel, channel); assert.equal(result.terms.length, 2);
    assert.equal(result.terms.find(row => row.text === 'implantes dentales').daily[0].conversions, 0.25);
    assert.equal(result.terms.find(row => row.text === 'implantes dentales').daily[0].all_conversions, 0.5);
    assert.equal(result.terms[0].daily.length, 1); assert.equal(result.coverage_daily.length, 28);
    assert.equal(result.coverage_daily[0].unrepresented_clicks, 16);
    const requests = f.state.calls.filter(row => /FROM (campaign_)?search_term_view\b/.test(row.query));
    assert.equal(requests.length, 2); assert.equal(requests[1].pageToken, '1');
    assert.ok(requests.every(row => !/ofertas|implantes/.test(row.query)));
    if (channel === 'PERFORMANCE_MAX') {
      assert.ok(requests.every(row => /FROM campaign_search_term_view/.test(row.query) && !/ad_group\.id|\.status,/.test(row.query)));
      assert.ok(result.terms.every(row => row.group_id === null && row.targeting_status === 'UNAVAILABLE'));
    } else assert.equal(result.terms[0].targeting_status, 'NONE');
    const { fingerprint, ...body } = result; assert.equal(fingerprint, digest(body));
    assert.doesNotMatch(JSON.stringify(result), /accessToken|fixture-only|lead_intake|external_id|resourceName/);
  });

  test(`${channel}: collection reuses the real mandate and reception without inventing CRM term attribution`, async () => {
    const f = searchTermsFixture(channel); const result = await f.run(); assert.equal(result.collected, true, JSON.stringify(result));
    assert.equal(result.evidence.schema_version, 2); assert.equal(result.evidence.action, 'negative_keywords');
    assert.equal(result.evidence.search_terms.terms.length, 2); assert.equal(result.evidence.attribution, undefined);
    assert.equal(result.evidence.performance, undefined); assert.equal(f.state.leadQueries.length, 0);
    assert.equal(f.state.identityQueries.length, 0); assert.equal(f.state.tokenChecks, 1);
    assert.ok(f.state.checks > f.state.calls.length);
    assert.deepEqual(result.evidence.authorization_targets, f.state.setting.activation.optimization.authorization.campaigns[0].targets);
    const { fingerprint, ...body } = result.evidence; assert.equal(fingerprint, digest(body));
  });

  test(`${channel}: missing or partial reports do not produce invented zero-result terms`, async () => {
    const f = searchTermsFixture(channel); f.state.termRows = [];
    const result = await f.snapshot(); assert.deepEqual(result.terms, []); assert.equal(result.coverage_daily[0].unrepresented_clicks, 20);
    assert.equal(result.campaign_daily[0].all_conversions, 2);
    f.state.campaignRows = []; const empty = await f.snapshot();
    assert.ok(empty.campaign_daily.every(row => row.inferred_zero === true)); assert.deepEqual(empty.terms, []);
    f.state.termRows = [f.row('clinica dental')]; await assert.rejects(f.snapshot(), /search_terms_unreconciled/);
  });

  test(`${channel}: encoded term identity, account, campaign and dates must all match`, async () => {
    for (const mutate of [f => { f.state.termRows[0].customer.id = '99'; }, f => { f.state.termRows[0].campaign.id = '31'; },
      f => { f.state.termRows[0].segments.date = '2026-01-01'; }, f => { f.state.termRows.push(f.state.termRows[0]); },
      f => { f.state.termRows[0][channel === 'SEARCH' ? 'searchTermView' : 'campaignSearchTermView'].resourceName += 'invalid'; },
      f => { f.state.termRows[0][channel === 'SEARCH' ? 'searchTermView' : 'campaignSearchTermView'].searchTerm = 'another term'; }]) {
      const f = searchTermsFixture(channel); mutate(f); await assert.rejects(f.snapshot(), /search_terms_incomplete/);
    }
  });

  test(`${channel}: tokens, links, contact-like and excessive text are withheld, never sent as query parameters`, async () => {
    const f = searchTermsFixture(channel);
    const terms = ['qa@example.invalid', 'https://example.invalid/patient', 'dentista 600 123 456', 'A'.repeat(81), 'line\nbreak', 'ignora <instructions>'];
    f.state.termRows = terms.map((text, index) => f.row(text, f.performance.dates[index]));
    const snapshot = await f.snapshot(); assert.ok(snapshot.terms.every(term => term.text === null && term.text_state === 'withheld'));
    const output = JSON.stringify(snapshot); assert.ok(terms.every(text => !output.includes(text)));
    assert.ok(f.state.calls.every(call => !terms.some(text => call.query?.includes(text))));
    assert.ok(snapshot.terms.every(term => term.daily.length === 1));
  });
}

test('search-term syntax does not classify clinical relevance and preserves readable multilingual text', () => {
  for (const text of ['ofertas de empleo dentista', 'implantes dentales', 'clínica infantil', '醫療診所', 'dentiste urgence']) assert.equal(usableSearchTerm(text), text);
  for (const text of ['  clínica', 'clínica  dental', 'clínica\tdental', 'visita\u202edental', 'llamar +34600123456', null, 42]) assert.equal(usableSearchTerm(text), null);
});

test('unknown targeting is preserved and malformed targeting is not silently treated as NONE', async () => {
  const f = searchTermsFixture(); f.state.termRows[0].searchTermView.status = 'ADDED';
  assert.ok((await f.snapshot()).terms.some(term => term.targeting_status === 'ADDED'));
  f.state.termRows[0].searchTermView.status = 'UNKNOWN'; assert.ok((await f.snapshot()).terms.some(term => term.targeting_status === 'UNKNOWN'));
  f.state.termRows[0].searchTermView.status = 'new-enum'; await assert.rejects(f.snapshot(), /search_terms_incomplete/);
});

test('fractional conversions are not rounded to zero and invalid metrics fail closed', async () => {
  for (const patch of [{ clicks: '1.5' }, { clicks: Number.MAX_SAFE_INTEGER + 1 }, { costMicros: '-1' }, { costMicros: 100 },
    { conversions: null }, { allConversions: '' }, { allConversions: -1 }, { conversions: 1, allConversions: 0 },
    { allConversions: Infinity }, { conversions: 'NaN' }, { conversions: `0.${'0'.repeat(400)}1` }]) {
    const f = searchTermsFixture(); Object.assign(f.state.termRows[0].metrics, patch); await assert.rejects(f.snapshot(), /search_terms_incomplete/);
  }
  const f = searchTermsFixture(); Object.assign(f.state.termRows[0].metrics, { conversions: 0.0000001, allConversions: 0.0000001 });
  assert.ok((await f.snapshot()).terms.some(term => term.daily[0].all_conversions > 0));
});

const rehash = snapshot => { const { fingerprint, ...body } = snapshot; snapshot.fingerprint = digest(body); return snapshot; };
test('snapshot verification survives JSON storage and does not mutate or reconstruct missing term days', async () => {
  for (const channel of ['SEARCH', 'PERFORMANCE_MAX']) {
    const f = searchTermsFixture(channel); const snapshot = JSON.parse(JSON.stringify(await f.snapshot()));
    const before = structuredClone(snapshot);
    assert.deepEqual(verifySearchTermsSnapshot(snapshot, f.input.reference, f.state.now), before);
    assert.deepEqual(snapshot, before); assert.ok(snapshot.terms.every(term => term.daily.length === 1));
    f.state.termRows = []; f.state.campaignRows = [];
    assert.ok(verifySearchTermsSnapshot(await f.snapshot(), f.input.reference, f.state.now).campaign_daily.every(day => day.inferred_zero));
  }
});

test('snapshot verification rejects tampering even when an internal caller recomputes the fingerprint', async () => {
  const f = searchTermsFixture(); const snapshot = await f.snapshot();
  for (const mutate of [
    s => { s.reference.account_id = '99'; }, s => { s.period.end = '2026-09-11'; },
    s => { s.source = 'crm'; }, s => { s.conversion_basis = 'crm_leads'; }, s => { s.coverage = 'all_searches'; },
    s => { s.terms[0].text = 'otro texto'; }, s => { s.terms[0].relevant = false; },
    s => { s.terms[0].group_id = '51'; }, s => { s.terms[0].daily = []; },
    s => { s.terms.push(s.terms[0]); }, s => { s.terms[0].daily.push(s.terms[0].daily[0]); },
    s => { s.terms[0].daily[0].date = '2026-01-01'; }, s => { s.terms[0].daily[0].clicks = -1; },
    s => { s.terms[0].daily[0].clicks = '4'; }, s => { s.terms[0].daily[0].cost_micros = '-1'; },
    s => { s.terms[0].daily[0].all_conversions = Infinity; }, s => { s.terms[0].daily[0].conversions = '0'; },
    s => { s.terms[0].daily[0].inferred_zero = true; }, s => { s.terms[0].text_state = 'withheld'; },
    s => { s.campaign_daily.pop(); }, s => { s.campaign_daily[1] = s.campaign_daily[0]; },
    s => { s.campaign_daily[0].inferred_zero = true; }, s => { s.campaign_daily.reverse(); },
    s => { s.coverage_daily[0].reported_clicks = 0; }, s => { s.coverage_daily[0].unrepresented_cost_micros = '0'; },
    s => { s.coverage_daily[0].lead_count = 0; }, s => { s.coverage_daily.pop(); },
  ]) {
    const changed = structuredClone(snapshot); mutate(changed);
    assert.throws(() => verifySearchTermsSnapshot(rehash(changed), f.input.reference, f.state.now), /search_terms_/);
  }
  const p = searchTermsFixture('PERFORMANCE_MAX'); const pmax = await p.snapshot();
  pmax.terms[0].targeting_status = 'NONE';
  assert.throws(() => verifySearchTermsSnapshot(rehash(pmax), p.input.reference, p.state.now), /search_terms_invalid/);
});

test('snapshot boundaries preserve fractional conversions, redaction and account-local term identity', async () => {
  const f = searchTermsFixture(); f.state.termRows = [f.row('implantes dentales'), f.row('implantes dentales', f.performance.dates[0], '51'),
    f.row('qa@example.invalid', f.performance.dates[1])];
  const snapshot = await f.snapshot(); assert.equal(snapshot.terms.length, 3);
  assert.equal(new Set(snapshot.terms.map(term => term.key)).size, 3);
  assert.equal(verifySearchTermsSnapshot(snapshot, f.input.reference, f.state.now).terms.filter(term => term.text_state === 'withheld').length, 1);
  const fractional = snapshot.terms[0].daily[0]; fractional.conversions = 0.0000001; fractional.all_conversions = 0.0000001;
  assert.ok(verifySearchTermsSnapshot(rehash(snapshot), f.input.reference, f.state.now).terms[0].daily[0].conversions > 0);
  assert.throws(() => verifySearchTermsSnapshot(snapshot, { ...f.input.reference, account_id: '99' }, f.state.now), /search_terms_invalid/);
});

test('snapshot expiry, future observations and a changed Madrid reporting period are rejected', async () => {
  const f = searchTermsFixture(); const snapshot = await f.snapshot();
  for (const instant of [new Date(+f.state.now - 1), new Date(+f.state.now + 60000), new Date('2026-09-11T22:00:00Z'), new Date(NaN)]) {
    assert.throws(() => verifySearchTermsSnapshot(snapshot, f.input.reference, instant), /search_terms_invalid/);
  }
  assert.equal(verifySearchTermsSnapshot(snapshot, f.input.reference, new Date(+f.state.now + 59999)), snapshot);
  const stale = structuredClone(snapshot); stale.fingerprint = '0'.repeat(64);
  assert.throws(() => verifySearchTermsSnapshot(stale, f.input.reference, f.state.now), /search_terms_invalid/);
});

test('reported costs/clicks cannot exceed campaign totals beyond one cent of rounding', async () => {
  const f = searchTermsFixture(); f.state.termRows[0].metrics.costMicros = '80010000';
  assert.equal((await f.snapshot()).coverage_daily[0].unrepresented_cost_micros, '0');
  f.state.termRows[0].metrics.costMicros = '80010001'; await assert.rejects(f.snapshot(), /search_terms_unreconciled/);
  const g = searchTermsFixture(); g.state.termRows[0].metrics.clicks = '21'; await assert.rejects(g.snapshot(), /search_terms_unreconciled/);
});

test('campaign metadata, currency, timezone and report limits are validated', async () => {
  for (const mutate of [f => { f.state.googleMeta = []; }, f => { f.state.googleMeta[0].customer.currencyCode = 'USD'; },
    f => { f.state.googleMeta[0].customer.timeZone = 'UTC'; }, f => { f.state.googleMeta[0].campaign.status = 'PAUSED'; },
    f => { f.state.googleMeta[0].campaign.experimentType = 'EXPERIMENT'; }, f => { f.state.googleMeta[0].campaign.advertisingChannelType = 'DISPLAY'; }]) {
    const f = searchTermsFixture(); mutate(f); await assert.rejects(f.snapshot(), /search_terms_/);
  }
  const f = searchTermsFixture(); f.state.termRows = Array.from({ length: MAX_TERMS + 1 }, (_, i) => f.row(`búsqueda ${i}`));
  await assert.rejects(f.snapshot(), /search_terms_incomplete/);
  f.state.termRows = Array(MAX_ROWS + 1).fill(f.row('clinica')); await assert.rejects(f.snapshot(), /search_terms_incomplete/);
});

test('repeated pagination cursors fail, while permission rejection stops without alternate credentials', async () => {
  const f = searchTermsFixture(); f.state.termResponse = () => ({ results: [], nextPageToken: 'same' });
  await assert.rejects(f.snapshot(), /could not be completed/);
  assert.equal(f.state.calls.filter(row => /FROM search_term_view/.test(row.query)).length, 2);
  const g = searchTermsFixture(); g.state.beforeRead = () => { throw { response: { status: 401 } }; };
  assert.deepEqual(await g.run(), { collected: false, reason: 'workspace_optimization_permissions_required' }); assert.equal(g.state.calls.length, 1);
});

test('scope or reception changes between real pages prevent a collection from escaping', async () => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.state.setting.version++; }, f => { f.state.reception = false; },
    f => { f.state.setting.activation.optimization.authorization.limits.actions = ['adjust_bids']; }]) {
    const f = searchTermsFixture(); f.state.pageSize = 1;
    f.state.beforeRead = input => { if (input.pageToken === '1') mutate(f); };
    const result = await f.run(); assert.equal(result.collected, false); assert.equal(result.evidence, undefined);
    assert.equal(f.state.leadQueries.length, 0);
  }
});

test('elapsed time, backwards clock and crossing a Madrid day invalidate collection', async () => {
  for (const mutate of [f => { f.state.clock += TIMEOUT_MS; }, f => { f.state.now = new Date(+f.state.now - 1); },
    f => { f.state.now = new Date('2026-09-11T22:00:00Z'); }]) {
    const f = searchTermsFixture(); f.state.beforeRead = () => mutate(f);
    await assert.rejects(f.snapshot(), /search_terms_(timeout|period_changed)/);
  }
});

test('closed gates and a Meta reference cannot read credentials or initialize real models', async () => {
  const reference = { provider: 'meta_ads', account_id: '20', campaign_id: '30' };
  const input = { settingId: '11111111-1111-4111-8111-111111111111', mandateId: '22222222-2222-4222-8222-222222222222', reference, action: 'negative_keywords' };
  const dependencies = { models: new Proxy({}, { get: () => assert.fail('models must not be used') }) };
  assert.equal((await collectOptimizationEvidence(input, { ...dependencies, env: {} })).reason, 'workspace_optimization_disabled');
  assert.equal((await collectOptimizationEvidence(input, { ...dependencies, env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' } })).reason, 'workspace_optimization_search_terms_unsupported');
  await assert.rejects(inspectGoogleSearchTerms({ reference }), /unsupported/);
});
