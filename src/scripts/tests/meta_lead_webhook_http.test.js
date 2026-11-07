'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), { createHmac } = require('node:crypto');
const offline = require('./fixtures/campaign_offline_runtime.cjs');
const express = require('express');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');
const secret = 'FICTITIOUS_HTTP_META_APP_SECRET', token = 'FICTITIOUS_WEBHOOK_VERIFY_TOKEN_123456789';
async function fixture(t) {
  const state = { queued: [], receipts: 0, ownerCalls: 0 };
  const models = { ClinicMetaAsset: { findAll: async ({ where }) => where.metaAssetId[require('sequelize').Op.in].includes('401')
    ? [{ id: 10, metaAssetId: '401', metaConnectionId: 1 }] : [] },
  MetaMarketingBrokerBinding: { findAll: async ({ where }) => where.app_id ? [{ asset_ref: 'meta-facebook_page:401' }]
    : where.mapping_id ? [{ enrollment_id: '11111111-1111-4111-8111-111111111111', scope_key: 'group:9', connection_ref: 'meta:fixture' }]
      : [{ mapping_id: 11, asset_ref: 'meta-ad_account:301' }] } };
  const reader = { preparePair: async () => ({}), assertPair: async () => ({}), read: async (_pair, family, payload) => {
    state.ownerCalls++;
    if (family === 'challenge') {
      if (payload.token !== token) throw Object.assign(Error('invalid_signature'), { code: 'invalid_signature' });
      return { challenge: payload.challenge };
    }
    const raw = Buffer.from(payload.rawBase64, 'base64');
    if (payload.signature !== 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')) throw Object.assign(Error('invalid_signature'), { code: 'invalid_signature' });
    state.receipts++;
    return { persisted: true, receipts: [{ receiptRef: '11111111-1111-4111-8111-111111111111',
      event: { lead_id: '701', page_id: '401', form_id: '702', ad_id: '603' } }] };
  } };
  const handlers = createMetaLeadWebhookHandlers({ models, reader, env: { META_APP_ID: '101', JOB_RUNTIME_NAMESPACE: 'qa' }, enqueue: async job => state.queued.push(job) });
  const app = express(); app.use(express.json({ verify: (req, _res, bytes) => { req.rawBody = bytes; } }));
  for (const path of ['/api/intake/leads/webhook', '/api/leads/webhook']) { app.get(path, handlers.verify); app.post(path, handlers.receive); }
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = offline.connectionForTestServer(server);
  t.after(() => agent.destroy());
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, raw, signature, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: raw ? 'POST' : 'GET', agent,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length,
        'x-hub-signature-256': signature } : {}), ...extraHeaders } }, res => {
      const bytes = []; res.on('data', part => bytes.push(part)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bytes).toString('utf8') }));
    }); req.on('error', reject); req.end(raw);
  });
  return { state, request };
}
const raw = Buffer.from('{ "object": "page", "entry": [{"id":"401","changes":[{"field":"leadgen","value":{"leadgen_id":"701","page_id":"401","form_id":"702","ad_id":"603"}}]}] }');
const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
test('both existing webhook aliases preserve exact signed bytes and enqueue only after durable owner acknowledgement', async t => {
  const f = await fixture(t);
  for (const path of ['/api/intake/leads/webhook', '/api/leads/webhook']) assert.equal((await f.request(path, raw, signature)).status, 200);
  assert.equal(f.state.receipts, 2); assert.equal(f.state.queued.length, 2);
  assert(f.state.queued.every(job => job.payload.receipt_ref && job.payload.__runtime_namespace === 'qa'));
  assert(!JSON.stringify(f.state.queued).includes('FICTITIOUS'));
});
test('invalid or duplicate signatures and unhandled Page fields never acknowledge or enqueue a lead', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/leads/webhook', raw, 'sha256=' + '0'.repeat(64))).status, 401);
  assert.equal((await f.request('/api/leads/webhook', raw, signature, { 'x-hub-signature-256': [signature, signature] })).status, 401);
  const mixed = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '401', changes: [{ field: 'feed', value: {} }] }] }));
  assert.equal((await f.request('/api/leads/webhook', mixed, signature)).status, 503);
  assert.equal(f.state.queued.length, 0); assert.equal(f.state.receipts, 0);
});
test('challenge is delegated to owner and returns only the exact challenge, never the verify token', async t => {
  const f = await fixture(t), path = '/api/intake/leads/webhook?hub.mode=subscribe&hub.challenge=qa-challenge&hub.verify_token=';
  assert.deepEqual(await f.request(path + token), { status: 200, body: 'qa-challenge' });
  assert.equal((await f.request(path + 'incorrect')).status, 401); assert.equal(f.state.queued.length, 0);
});
