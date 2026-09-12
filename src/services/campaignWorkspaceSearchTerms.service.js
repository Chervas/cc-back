'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { performancePeriod } = require('./campaignWorkspacePerformanceSnapshot.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');

const MAX_TERMS = 2000;
const MAX_ROWS = MAX_TERMS * 28;
const TIMEOUT_MS = 45000;
const STATUSES = ['ADDED', 'ADDED_EXCLUDED', 'EXCLUDED', 'NONE', 'UNKNOWN', 'UNSPECIFIED'];
const fail = suffix => { throw Object.assign(new Error(`workspace_optimization_search_terms_${suffix}`),
  { code: `workspace_optimization_search_terms_${suffix}` }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const shift = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const count = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('incomplete');
  return Number(value);
};
const cost = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) * 10000n) fail('incomplete');
  return value;
};
const conversionCount = value => {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
    || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) fail('incomplete');
  if (typeof value === 'string' && Number(value) === 0 && /[1-9]/.test(value)) fail('incomplete');
  return Number(value);
};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...allowed].sort().join(',');

// A syntax/privacy filter, not an irrelevance classifier or a guarantee of anonymisation.
function usableSearchTerm(text) {
  if (typeof text !== 'string' || text !== text.normalize('NFC') || text !== text.trim().replace(/\s+/g, ' ')
    || !text || text.length > 80 || text.split(' ').length > 10 || /[\u0000-\u001f\u007f-\u009f]/.test(text)
    || !/^[\p{L}\p{M}\p{N} '\-]+$/u.test(text) || (text.match(/\d/g) || []).length >= 5) return null;
  return text;
}

const metric = row => {
  const conversions = conversionCount(row.metrics?.conversions); const all = conversionCount(row.metrics?.allConversions);
  if (all < conversions) fail('incomplete');
  return { date: row.segments?.date, clicks: count(row.metrics?.clicks), cost_micros: cost(row.metrics?.costMicros),
    conversions, all_conversions: all };
};

function termIdentity(row, reference, channel) {
  const search = channel === 'SEARCH'; const value = search ? row.searchTermView : row.campaignSearchTermView;
  if (typeof value?.searchTerm !== 'string' || !value.searchTerm.trim() || value.searchTerm.length > 512) fail('incomplete');
  const group = search ? row.adGroup?.id : null; if (search && !id(group)) fail('incomplete');
  const prefix = `customers/${reference.account_id}/${search ? 'searchTermViews' : 'campaignSearchTermViews'}/${reference.campaign_id}~${search ? group + '~' : ''}`;
  if (typeof value.resourceName !== 'string' || !value.resourceName.startsWith(prefix)) fail('incomplete');
  const encoded = value.resourceName.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)
    || encoded.replace(/=+$/, '') !== Buffer.from(value.searchTerm, 'utf8').toString('base64url')) fail('incomplete');
  if (search ? !STATUSES.includes(value.status) : value.campaign !== `customers/${reference.account_id}/campaigns/${reference.campaign_id}`) fail('incomplete');
  const text = usableSearchTerm(value.searchTerm);
  return { key: digest([reference, group, value.searchTerm]), group_id: group, text,
    text_state: text === null ? 'withheld' : 'usable', targeting_status: search ? value.status : 'UNAVAILABLE' };
}

function snapshotBody(reference, period, channel, terms, campaignDaily, observedAt) {
  const dates = new Set(Array.from({ length: period.days }, (_, index) => shift(period.start, index)));
  const campaigns = new Map(campaignDaily.map(day => [day.date, day])); const reported = new Map();
  for (const term of terms) for (const value of term.daily) {
    const total = reported.get(value.date) || { clicks: 0n, cost: 0n };
    total.clicks += BigInt(value.clicks); total.cost += BigInt(value.cost_micros); reported.set(value.date, total);
  }
  const coverage = [];
  for (const date of dates) {
    // Missing campaign rows are all-zero only after the complete Google query. Missing terms are never reconstructed.
    const campaign = campaigns.get(date) || { date, clicks: 0, cost_micros: '0', conversions: 0, all_conversions: 0, inferred_zero: true };
    const visible = reported.get(date) || { clicks: 0n, cost: 0n };
    const costDifference = BigInt(campaign.cost_micros) - visible.cost;
    if (visible.clicks > BigInt(campaign.clicks) || costDifference < -10000n) fail('unreconciled');
    campaigns.set(date, campaign);
    coverage.push({ date, reported_clicks: Number(visible.clicks), reported_cost_micros: String(visible.cost),
      unrepresented_clicks: campaign.clicks - Number(visible.clicks), unrepresented_cost_micros: String(costDifference > 0n ? costDifference : 0n) });
  }
  return { schema_version: 1, reference, period, currency: 'EUR', channel, observed_at: observedAt,
    source: channel === 'SEARCH' ? 'google_ads_search_term_view' : 'google_ads_campaign_search_term_view',
    coverage: 'reported_terms_only', conversion_basis: 'google_ads_attributed_not_crm',
    terms: terms.map(term => ({ ...term, daily: [...term.daily].sort((a, b) => a.date.localeCompare(b.date)) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    campaign_daily: [...campaigns.values()].sort((a, b) => a.date.localeCompare(b.date)), coverage_daily: coverage };
}

function buildSnapshot(reference, period, channel, termRows, campaignRows, observedAt) {
  const dates = new Set(Array.from({ length: period.days }, (_, index) => shift(period.start, index)));
  const campaigns = new Map(); const terms = new Map();
  for (const row of campaignRows) {
    const value = metric(row);
    if (!dates.has(value.date) || campaigns.has(value.date)) fail('incomplete');
    campaigns.set(value.date, value);
  }
  for (const row of termRows) {
    const identity = termIdentity(row, reference, channel); const value = metric(row);
    if (!dates.has(value.date)) fail('incomplete');
    const existing = terms.get(identity.key);
    if (existing && (existing.targeting_status !== identity.targeting_status || existing.daily.some(day => day.date === value.date))) fail('incomplete');
    if (!existing) terms.set(identity.key, { ...identity, daily: [] });
    if (terms.size > MAX_TERMS) fail('incomplete');
    terms.get(identity.key).daily.push(value);
  }
  const body = snapshotBody(reference, period, channel, [...terms.values()], [...campaigns.values()], observedAt);
  return { ...body, fingerprint: digest(body) };
}

// A fingerprint detects accidental changes; it does not prove provider provenance or relevance.
function verifySearchTermsSnapshot(snapshot, reference, now = new Date()) {
  optimizationReference(reference);
  const { fingerprint, ...body } = snapshot || {};
  if (reference.provider !== 'google_ads' || !hash(fingerprint) || fingerprint !== digest(body)
    || !keys(body, ['schema_version', 'reference', 'period', 'currency', 'channel', 'observed_at', 'source', 'coverage',
      'conversion_basis', 'terms', 'campaign_daily', 'coverage_daily'])
    || body.schema_version !== 1 || digest(body.reference) !== digest(reference) || body.currency !== 'EUR'
    || !['SEARCH', 'PERFORMANCE_MAX'].includes(body.channel) || !instant(body.observed_at)
    || !Number.isFinite(+now) || +new Date(body.observed_at) > +now || +now - +new Date(body.observed_at) >= 60000
    || digest(body.period) !== digest(performancePeriod(now))
    || !Array.isArray(body.terms) || body.terms.length > MAX_TERMS
    || !Array.isArray(body.campaign_daily) || body.campaign_daily.length !== body.period.days
    || !Array.isArray(body.coverage_daily) || body.coverage_daily.length !== body.period.days) fail('invalid');
  const dates = new Set(Array.from({ length: body.period.days }, (_, index) => shift(body.period.start, index)));
  const daily = (rows, campaign = false) => {
    if (!Array.isArray(rows) || !rows.length || rows.length > body.period.days) fail('invalid');
    const seen = new Set();
    for (const row of rows) {
      const inferred = campaign && row?.inferred_zero === true;
      if (!keys(row, ['date', 'clicks', 'cost_micros', 'conversions', 'all_conversions', ...(inferred ? ['inferred_zero'] : [])])
        || !dates.has(row.date) || seen.has(row.date) || !Number.isSafeInteger(row.clicks) || row.clicks < 0
        || typeof row.conversions !== 'number' || typeof row.all_conversions !== 'number'
        || conversionCount(row.conversions) > conversionCount(row.all_conversions)
        || cost(row.cost_micros) !== row.cost_micros
        || inferred && (row.clicks !== 0 || row.cost_micros !== '0' || row.conversions !== 0 || row.all_conversions !== 0)) fail('invalid');
      seen.add(row.date);
    }
  };
  daily(body.campaign_daily, true);
  const seen = new Set();
  for (const term of body.terms) {
    if (!keys(term, ['key', 'group_id', 'text', 'text_state', 'targeting_status', 'daily']) || !hash(term.key) || seen.has(term.key)
      || (body.channel === 'SEARCH' ? !id(term.group_id) || !STATUSES.includes(term.targeting_status)
        : term.group_id !== null || term.targeting_status !== 'UNAVAILABLE')
      || (term.text_state === 'usable' ? usableSearchTerm(term.text) === null || term.key !== digest([reference, term.group_id, term.text])
        : term.text_state !== 'withheld' || term.text !== null)) fail('invalid');
    seen.add(term.key); daily(term.daily);
  }
  const expected = snapshotBody(reference, body.period, body.channel, body.terms, body.campaign_daily, body.observed_at);
  if (digest(expected) !== fingerprint) fail('invalid');
  return snapshot;
}

async function inspectGoogleSearchTerms({ reference, accessToken, loginCustomerId, now = () => new Date(), clock = Date.now, read = googleAdsSearchRows }) {
  optimizationReference(reference); if (reference.provider !== 'google_ads') fail('unsupported');
  const start = now(); const period = performancePeriod(start); const deadline = clock() + TIMEOUT_MS;
  const remaining = () => {
    const current = now(); const duration = +current - +start; const left = deadline - clock();
    if (left <= 0 || duration < 0 || duration >= TIMEOUT_MS) fail('timeout');
    if (digest(performancePeriod(current)) !== digest(period)) fail('period_changed');
    return left;
  };
  const search = async (query, limit) => {
    const rows = await read({ customerId: reference.account_id, accessToken, loginCustomerId, query: `${query} LIMIT ${limit + 1}`,
      maxPages: 12, timeoutMs: remaining() });
    remaining();
    if (!Array.isArray(rows) || rows.length > limit || rows.some(row => row.customer?.id !== reference.account_id || row.campaign?.id !== reference.campaign_id)) fail('incomplete');
    return rows;
  };
  const metadata = await search(`SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id,
    campaign.status, campaign.experiment_type, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${reference.campaign_id}`, 1);
  if (metadata.length !== 1) fail('incomplete');
  const owner = metadata[0]; const channel = owner.campaign.advertisingChannelType;
  if (owner.customer.currencyCode !== 'EUR') fail('currency');
  if (owner.customer.timeZone !== 'Europe/Madrid') fail('timezone');
  if (owner.campaign.status !== 'ENABLED' || owner.campaign.experimentType !== 'BASE' || !['SEARCH', 'PERFORMANCE_MAX'].includes(channel)) fail('unsupported');
  const condition = `WHERE campaign.id = ${reference.campaign_id} AND segments.date BETWEEN '${period.start}' AND '${period.end}'`;
  const campaignRows = await search(`SELECT customer.id, campaign.id, segments.date, metrics.clicks, metrics.cost_micros,
    metrics.conversions, metrics.all_conversions FROM campaign ${condition}`, period.days);
  const view = channel === 'SEARCH' ? 'search_term_view' : 'campaign_search_term_view';
  const termRows = await search(`SELECT customer.id, campaign.id, ${channel === 'SEARCH' ? 'ad_group.id,' : ''}
    ${view}.resource_name, ${view}.search_term, ${view}.${channel === 'SEARCH' ? 'status' : 'campaign'},
    segments.date, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions FROM ${view} ${condition}`, MAX_ROWS);
  remaining();
  const snapshot = buildSnapshot(reference, period, channel, termRows, campaignRows, now().toISOString());
  remaining();
  return verifySearchTermsSnapshot(snapshot, reference, now());
}

module.exports = { inspectGoogleSearchTerms, verifySearchTermsSnapshot, usableSearchTerm, MAX_TERMS, MAX_ROWS, TIMEOUT_MS };
