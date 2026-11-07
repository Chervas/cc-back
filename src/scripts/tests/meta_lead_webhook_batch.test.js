'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
require('./fixtures/campaign_offline_runtime.cjs');
const { Op } = require('sequelize');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');
const secret = 'FICTITIOUS_BATCH_META_APP_SECRET';
const notification = pages => ({ object: 'page', entry: pages.map((pageId, index) => ({ id: pageId,
  changes: [{ field: 'leadgen', value: { leadgen_id: String(700 + index), page_id: pageId, form_id: String(800 + index), ad_id: String(900 + index) } }] })) });
function response() {
  const res = { statusCode: 0, headers: {} };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.status = status => { res.statusCode = status; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}
function fixture(pages) {
  const body = notification(pages), raw = Buffer.from(' \n' + JSON.stringify(body) + ' ');
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const state = { calls: [], ownerReceipts: new Map(), jobs: new Map(), enqueueCalls: [],
    failures: new Map(), queueFailures: new Set(), malformed: new Set(), invalidAfter: null };
  const configured = [{ id: 10, metaAssetId: '401', metaConnectionId: 159 }, { id: 20, metaAssetId: '402', metaConnectionId: 159 }];
  const models = { ClinicMetaAsset: { findAll: async ({ where }) => configured.filter(row => where.metaAssetId[Op.in].includes(row.metaAssetId)) },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => where.mapping_id
      ? [{ mapping_id: where.mapping_id, enrollment_id: 'cohort:' + where.mapping_id, scope_key: 'group:29', connection_ref: 'meta:fixture' }]
      : [{ mapping_id: Number(where.enrollment_id.split(':')[1]) + 1, asset_ref: 'meta-ad_account:500' }] } };
  const reader = { preparePair: async (pageId, accountId) => ({ page: configured.find(row => row.id === pageId), accountId }),
    assertPair: async () => ({}), read: async (pair, family, payload) => {
      assert.equal(family, 'receiptAccept'); assert.equal(payload.rawBase64, raw.toString('base64'));
      assert.equal(Buffer.from(payload.rawBase64, 'base64').equals(raw), true);
      state.calls.push({ pageId: pair.page.metaAssetId, rawBase64: payload.rawBase64, signature: payload.signature });
      if (payload.signature !== signature || state.invalidAfter === pair.page.metaAssetId) throw Object.assign(Error('invalid_signature'), { code: 'invalid_signature' });
      if (state.failures.has(pair.page.metaAssetId)) throw Object.assign(Error('owner_unavailable'), { code: state.failures.get(pair.page.metaAssetId) });
      const entry = body.entry.find(row => row.id === pair.page.metaAssetId), event = { lead_id: entry.changes[0].value.leadgen_id,
        page_id: entry.id, form_id: entry.changes[0].value.form_id, ad_id: entry.changes[0].value.ad_id };
      if (!state.ownerReceipts.has(event.lead_id)) state.ownerReceipts.set(event.lead_id, {
        receiptRef: '11111111-1111-4111-8111-' + event.lead_id.padStart(12, '0'), event,
      });
      return { persisted: true, receipts: state.malformed.has(pair.page.metaAssetId) ? [] : [state.ownerReceipts.get(event.lead_id)] };
    } };
  const enqueue = async job => {
    state.enqueueCalls.push(job);
    assert.ok(state.ownerReceipts.has(job.payload.lead_id), 'owner receipt must be durable before enqueue');
    if (state.queueFailures.has(job.payload.page_id)) throw Object.assign(Error('queue_unavailable'), { code: 'queue_unavailable' });
    const existing = state.jobs.get(job.dedupeScope);
    if (existing) { assert.deepEqual(existing.payload, job.payload); return { job: existing, created: false }; }
    state.jobs.set(job.dedupeScope, structuredClone(job)); return { job, created: true };
  };
  const handlers = createMetaLeadWebhookHandlers({ models, reader, enqueue,
    env: { RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging' } });
  const deliver = async (givenSignature = signature) => {
    const res = response(); await handlers.receive({ rawBody: raw, rawHeaders: ['x-hub-signature-256', givenSignature],
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': givenSignature } }, res); return res;
  };
  return { state, body, raw, signature, deliver };
}
test('unknown first Page does not starve the later eligible BS Page; no success ACK; redelivery deduplicates', async () => {
  const f = fixture(['999', '401']);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await f.deliver(); assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { success: false, code: 'meta_lead_receipt_unavailable' });
    assert.equal(f.state.ownerReceipts.size, 1); assert.equal(f.state.jobs.size, 1);
  }
  assert.deepEqual(f.state.calls.map(row => row.pageId), ['401', '401']);
  assert.ok(f.state.calls.every(row => row.rawBase64 === f.raw.toString('base64') && row.signature === f.signature));
  const job = [...f.state.jobs.values()][0]; assert.equal(job.payload.page_id, '401'); assert.equal(job.payload.__runtime_namespace, 'staging');
  assert.deepEqual(Object.keys(job.payload).sort(), ['account_asset_id', '__runtime_namespace', 'ad_id', 'form_id', 'lead_id', 'page_asset_id', 'page_id', 'receipt_ref'].sort());
  assert.ok(!JSON.stringify(job).includes('FICTITIOUS')); assert.ok(!Object.hasOwn(job.payload, 'rawBase64'));
});
test('eligible BS first preserves receipt/job when a later configured Page fails, and retry fills only the missing Page', async () => {
  const f = fixture(['401', '402']); f.state.failures.set('402', 'scope_denied');
  assert.equal((await f.deliver()).statusCode, 503); assert.equal(f.state.ownerReceipts.size, 1); assert.equal(f.state.jobs.size, 1);
  assert.deepEqual(f.state.calls.map(row => row.pageId), ['401', '402']);
  assert.equal((await f.deliver()).statusCode, 503); assert.equal(f.state.jobs.size, 1);
  f.state.failures.clear(); assert.equal((await f.deliver()).statusCode, 200); assert.equal(f.state.ownerReceipts.size, 2); assert.equal(f.state.jobs.size, 2);
  assert.ok(f.state.calls.every(row => row.rawBase64 === f.raw.toString('base64') && row.signature === f.signature));
});
test('unknown later Page never turns an already accepted Page into a success ACK', async () => {
  const f = fixture(['401', '999']); assert.equal((await f.deliver()).statusCode, 503);
  assert.equal(f.state.jobs.size, 1); assert.equal(f.state.ownerReceipts.size, 1); assert.deepEqual(f.state.calls.map(row => row.pageId), ['401']);
});
test('invalid global signature creates no receipt/jobs even with an unknown Page before the valid mapping', async () => {
  for (const pages of [['999', '401'], ['401', '402']]) {
    const f = fixture(pages); assert.equal((await f.deliver('sha256=' + '0'.repeat(64))).statusCode, 401);
    assert.equal(f.state.jobs.size, 0); assert.equal(f.state.ownerReceipts.size, 0); assert.equal(f.state.enqueueCalls.length, 0);
  }
});
test('a later signature rejection leaves earlier owner receipts durable but creates zero new jobs', async () => {
  const f = fixture(['401', '402']); f.state.invalidAfter = '402';
  assert.equal((await f.deliver()).statusCode, 401); assert.equal(f.state.ownerReceipts.size, 1); assert.equal(f.state.enqueueCalls.length, 0);
  f.state.invalidAfter = null; assert.equal((await f.deliver()).statusCode, 200); assert.equal(f.state.ownerReceipts.size, 2); assert.equal(f.state.jobs.size, 2);
});
test('one queue failure preserves both owner receipts and still enqueues another accepted Page; retry deduplicates', async () => {
  const f = fixture(['401', '402']); f.state.queueFailures.add('401');
  assert.equal((await f.deliver()).statusCode, 503); assert.equal(f.state.ownerReceipts.size, 2); assert.equal(f.state.jobs.size, 1);
  assert.equal([...f.state.jobs.values()][0].payload.page_id, '402');
  f.state.queueFailures.clear(); assert.equal((await f.deliver()).statusCode, 200); assert.equal(f.state.ownerReceipts.size, 2); assert.equal(f.state.jobs.size, 2);
});
test('an incomplete receipt set never partially enqueues its Page while another complete Page is processed', async () => {
  const f = fixture(['401', '402']); f.state.malformed.add('401');
  assert.equal((await f.deliver()).statusCode, 503); assert.equal(f.state.jobs.size, 1); assert.equal([...f.state.jobs.values()][0].payload.page_id, '402');
});
