'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('./fixtures/campaign_offline_runtime.cjs');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');

const signature = 'sha256=' + 'f'.repeat(64);
const sensitive = 'fictional.person@example.test';
const dm = { object: 'instagram', entry: [{ id: '987654', messaging: [{ message: { text: sensitive } }] }] };
const unavailable = code => Object.assign(new Error(sensitive), { code });
const receiverEnv = { META_SOCIAL_INBOX_RECEIVER_ENABLED: 'true', RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway',
  AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging' };
function request(body, host = 'app.clinicaclick.com') {
  return { rawBody: Buffer.from(JSON.stringify(body)), headers: { host, 'content-type': 'application/json', 'x-hub-signature-256': signature },
    rawHeaders: ['x-hub-signature-256', signature], query: { 'hub.verify_token': sensitive }, originalUrl: '/webhook?secret=' + sensitive };
}
function response() {
  return { headers: {}, set(name,value) { this.headers[name] = value; return this; },
    status(status) { this.statusCode = status; return this; }, json(body) { this.body = body; return this; } };
}
async function receive(handlers, req) {
  const res = response();
  await handlers.receive(req, res);
  return res;
}
test('503 classifies a failed Instagram verification and correlates retries without exposing inputs', async () => {
  const records = [];
  const handlers = createMetaLeadWebhookHandlers({ env: receiverEnv, socialVerify: async () => { throw unavailable(sensitive); },
    onUnavailable: row => records.push(row) });
  for (const text of [sensitive, sensitive, 'changed']) {
    const body = structuredClone(dm);
    body.entry[0].messaging[0].message.text = text;
    const res = await receive(handlers, request(body));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { success: false, code: 'meta_lead_receipt_unavailable' });
    assert.equal(res.headers['Retry-After'], '60');
  }
  const { delivery, ...safe } = records[0];
  assert.deepEqual(safe, { event: 'meta_webhook_reception_unavailable', host: 'app.clinicaclick.com',
    envelope: 'instagram_messaging', stage: 'social_verify', cause: 'other' });
  assert.match(delivery, /^[a-f0-9]{24}$/);
  assert.equal(records[1].delivery, delivery);
  assert.notEqual(records[2].delivery, delivery);
  for (const privateValue of [sensitive, signature, '987654', '/webhook']) assert.ok(!JSON.stringify(records).includes(privateValue));
});
test('mixed envelopes preserve acknowledged social ingestion and attribute a forms failure correctly', async () => {
  const records = [];
  let accepted = false;
  const handlers = createMetaLeadWebhookHandlers({ env: receiverEnv, models: {}, reader: {},
    receive: async () => { throw unavailable('meta_lead_page_access_required'); },
    socialVerify: async () => ({ appId: '11', destinations: [{ accountId: '987654', clinicId: 1 }] }),
    socialAccept: async () => { accepted = true; }, onUnavailable: record => records.push(record) });
  const body = structuredClone(dm);
  body.object = 'page';
  body.entry[0].changes = [{ field: 'leadgen', value: {} }];
  assert.equal((await receive(handlers, request(body, sensitive))).statusCode, 503);
  assert.equal(accepted, true);
  assert.equal(records[0].envelope, 'page_mixed');
  assert.equal(records[0].stage, 'lead_receipt');
  assert.equal(records[0].cause, 'meta_lead_page_access_required');
  assert.equal(records[0].host, 'other');
});
test('standby, changes and malformed shapes are bounded; a logging error cannot change the public reply', async () => {
  const records = [];
  const handlers = createMetaLeadWebhookHandlers({ env: {}, onUnavailable: row => { records.push(row); throw Error(sensitive); } });
  for (const [entry, envelope] of [
    [{ standby: [{}] }, 'instagram_standby'], [{ changes: [{ field: 'comments' }] }, 'instagram_comments'],
    [{ changes: [{ field: sensitive }] }, 'instagram_other_change'], [null, 'instagram_other']]) {
    assert.equal((await receive(handlers, request({ object: 'instagram', entry: [entry] }))).statusCode, 503);
    assert.equal(records.at(-1).envelope, envelope);
    assert.equal(records.at(-1).cause, 'meta_lead_unsupported_notification');
  }
  const malformed = request(dm);
  malformed.rawBody = Buffer.from('bad json');
  assert.equal((await receive(handlers, malformed)).statusCode, 400);
  const unsigned = request(dm);
  unsigned.rawHeaders = [];
  assert.equal((await receive(handlers, unsigned)).statusCode, 401);
  assert.equal(records.length, 4);
});
test('challenge failures never include the query, request body or a digest', async () => {
  const records = [];
  const handlers = createMetaLeadWebhookHandlers({ models: {}, reader: { verificationPair: async () => { throw unavailable('scope_denied'); } },
    onUnavailable: row => records.push(row) });
  const res = response();
  await handlers.verify(request(dm), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(records, [{ event: 'meta_webhook_reception_unavailable', host: 'app.clinicaclick.com', envelope: 'challenge',
    stage: 'challenge', cause: 'scope_denied' }]);
});
test('a social intake database failure is distinct from broker verification and a later success emits nothing', async () => {
  const records = [];
  let fail = true;
  const handlers = createMetaLeadWebhookHandlers({ env: receiverEnv,
    socialVerify: async () => ({ appId: '11', destinations: [{ accountId: '987654', clinicId: 1 }] }),
    socialAccept: async () => { if (fail) throw Object.assign(Error(sensitive), { name: 'SequelizeDatabaseError', sql: sensitive }); },
    onUnavailable: row => records.push(row) });
  assert.equal((await receive(handlers, request(dm))).statusCode, 503);
  assert.equal(records[0].stage, 'social_intake');
  assert.equal(records[0].cause, 'database_error');
  fail = false;
  assert.equal((await receive(handlers, request(dm))).statusCode, 200);
  assert.equal(records.length, 1);
});
