'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const billing = require('../../services/googleWeeklyBilling.service');
const { runQuery } = require('../../services/googleAdsTransparencyOfficial.service').__testing;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { client_email: 'offline@example.invalid', project_id: 'clinicaclick', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const runKey = 'google-atc-es:2026-09-14';
const collectedAt = '2026-09-14T04:00:00.000Z';
const row = (change = {}) => ({ month: '2026-09', service: 'Maps', currency: 'EUR', gross: '1.123456789',
  credits: '-0.123456789', net: '1', latestUsageDay: '2026-09-13', ...change });
const envelope = (kind, value) => ({ kind, payload: JSON.stringify(value) });
const resultRows = [envelope('advertiser', { advertiser_id: 'AR1', ads_count: '3' }), envelope('billing', row())];
function harness({ lostAck = false, repeatedToken = false, failPage = false, dryBytes = '20000000000' } = {}) {
  let job, submissions = 0, dryRuns = 0;
  const http = {
    post: async (url, body) => {
      if (url.endsWith('/token')) return { data: { access_token: 'offline-token', expires_in: 3600 } };
      if (body.dryRun) { dryRuns++; return { data: { totalBytesProcessed: dryBytes } }; }
      assert(url.endsWith('/jobs')); submissions++;
      job = { ...body, status: { state: 'DONE' }, statistics: { creationTime: String(Date.parse(collectedAt)) } };
      if (lostAck) throw Object.assign(Error('lost_ack'), { code: 'ECONNRESET' });
      return { data: job };
    },
    get: async (url, options) => {
      if (url.includes('/jobs/')) {
        if (!job) throw Object.assign(Error('absent'), { response: { status: 404 } });
        return { data: job };
      }
      if (options.params.pageToken && failPage) throw Error('page_failed');
      const rows = options.params.pageToken ? [resultRows[1]] : [resultRows[0]];
      return { data: { jobComplete: true, totalRows: '2', totalBytesProcessed: '20000000000',
        schema: { fields: [{ name: 'kind' }, { name: 'payload' }] },
        rows: rows.map(r => ({ f: [{ v: r.kind }, { v: r.payload }] })),
        ...(!options.params.pageToken || repeatedToken ? { pageToken: 'second' } : {}) } };
    },
  };
  const input = { config: { enabled: true, credentials, projectId: 'clinicaclick', location: 'US', billingEnabled: true },
    candidateNames: ['Fictitious clinic'], candidateIds: [], regionCodes: ['ES'], lookbackDays: 365, rowLimit: 2000, runKey, http };
  return { input, counts: () => ({ submissions, dryRuns }), job: () => job };
}
test('one paginated job returns both ads and exact decimal costs; restart reuses it', async () => {
  const h = harness();
  const first = await runQuery(h.input);
  assert.equal(first.rows[0].advertiser_id, 'AR1'); assert.equal(first.billingSnapshots[0].net, '1');
  assert.equal(first.billingSnapshots[0].gross, '1.123456789');
  assert.deepEqual(await runQuery(h.input), { ...first, dryRunBytes: null });
  assert.deepEqual(h.counts(), { submissions: 1, dryRuns: 1 });
  const query = h.job().configuration.query;
  assert(query.query.includes('google_ads_transparency_center')); assert(query.query.includes(billing.VIEW));
  assert.equal(query.maximumBytesBilled, '25000000000');
});
test('lost acknowledgement recovers the same job without another submission', async () => {
  const h = harness({ lostAck: true }); await runQuery(h.input);
  assert.equal(h.counts().submissions, 1);
});
test('same weekly ID with changed scope fails closed rather than charges again', async () => {
  const h = harness(); await runQuery(h.input);
  await assert.rejects(runQuery({ ...h.input, candidateNames: ['different'] }), { code: 'GOOGLE_ATC_WEEKLY_JOB_CONFLICT' });
  assert.equal(h.counts().submissions, 1);
});
test('bad dry run and upper billing bound prevent the paid job', async () => {
  for (const dryBytes of ['26000000000', 'unknown', '-1']) {
    const h = harness({ dryBytes });
    await assert.rejects(runQuery(h.input), { code: 'GOOGLE_ATC_BIGQUERY_BYTES_LIMIT' });
    assert.equal(h.counts().submissions, 0);
  }
});
test('page failure and repeated page tokens never return a partial snapshot', async () => {
  for (const options of [{ repeatedToken: true }, { failPage: true }]) {
    const h = harness(options); await assert.rejects(runQuery(h.input));
  }
});
test('empty export stays absent; currency, totals, duplicated services and dates fail closed', () => {
  const context = { runKey, collectedAt };
  assert.deepEqual(billing.splitRows([], context).snapshots, []);
  for (const change of [{ currency: 'USD' }, { net: '1.1' }, { month: '2026-07' }, { latestUsageDay: '2026-09-14' }]) {
    assert.throws(() => billing.splitRows([envelope('billing', row(change))], context));
  }
  assert.throws(() => billing.splitRows([envelope('billing', row()), envelope('billing', row())], context));
  assert.throws(() => billing.cutoffForRun('google-atc-es:2026-09-31'));
  assert.throws(() => billing.cutoffForRun('google-atc-es:2026-09-15'));
});
