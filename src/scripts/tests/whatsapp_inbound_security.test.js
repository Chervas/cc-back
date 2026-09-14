'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHmac } = require('node:crypto');
require('./fixtures/security_offline_runtime.cjs');
const { Op } = require('sequelize');
const { authenticate, MAX_BYTES } = require('../../lib/whatsappWebhookAuthentication');
const SECRET = 'FICTITIOUS_APP_SECRET_FOR_OFFLINE_QA';
function fake(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
// This suite exercises the candidate authentication/routing layer behind the
// closed ingress. The actual public containment is tested separately; bypassing
// it here does not configure or enable a runtime route.
fake('../../lib/whatsappWebhookContainment', (_req, _res, next) => next());
let reads, sensitiveReads, queued, assets, settings, destination, webOrigin, blocked, failSql;
const baseAsset = () => ({ id: 10, wabaId: '111111', phoneNumberId: '222222', assignmentScope: 'clinic', clinicaId: 4,
  grupoClinicaId: null, assetType: 'whatsapp_phone_number', additionalData: {}, isActive: true });
const body = () => ({ object: 'whatsapp_business_account', entry: [{ id: '111111', changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '222222' }, messages: [{ id: 'fictitious-message', from: '34600000000', text: { body: 'Fictitious message' } }],
} }] }] });
const models = {
  ClinicMetaAsset: { findAll: async options => {
    reads++; if (failSql) throw Error('SENTINEL_SQL_SECRET');
    assert(!options.attributes.includes('waAccessToken')); assert(!options.attributes.includes('pageAccessToken'));
    return assets.filter(asset => Object.entries(options.where).every(([key, value]) => asset[key] === value));
  } },
  PatientDirectionSetting: { findAll: async () => settings },
  Clinica: { findByPk: async id => ({ id_clinica: id, grupoClinicaId: null }), findAll: async () => [{ id_clinica: 4 }, { id_clinica: 5 }] },
  MetaScopeBlock: { findOne: async options => { assert(options.where.scope_key[Op.in].includes('clinic:4') || options.where.scope_key[Op.in].includes('clinic:5')); return blocked ? { scope_key: 'clinic:4' } : null; } },
  Paciente: { findOne: async () => { sensitiveReads++; return null; } },
  LeadIntake: { findOne: async () => { sensitiveReads++; return null; }, findAll: async () => [] },
  Conversation: { findAll: async () => [] }, Message: { findAll: async () => [] },
  WhatsAppWebOrigin: { findOne: async () => webOrigin },
};
assert.equal(require.cache[require.resolve('../../../models')], undefined);
fake('../../../models', models);
fake('../../services/patientDirection.service', {
  resolveInboundDestination: async () => destination,
  captureUnassignedInbound: async () => { queued.push('unassigned'); },
});
fake('../../services/queue.service', { queues: { webhookWhatsApp: { add: async (_name, data) => { queued.push(data); } } } });
let server, agent;
test.before(async () => {
  const app = require('express')(); app.use(require('express').json({ limit: '2mb', type: () => true, verify: (req, _res, raw) => { req.rawBody = raw; } }));
  app.use('/api', require('../../routes/whatsapp-webhook.routes'));
  server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
});
test.beforeEach(() => {
  process.env.FACEBOOK_APP_SECRET = SECRET; delete process.env.APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'fictitious-verify-token'; delete process.env.META_VERIFY_TOKEN; delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  reads = 0; sensitiveReads = 0; queued = []; assets = [baseAsset()]; settings = []; destination = null; webOrigin = null; blocked = false; failSql = false;
});
test.after(async () => { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
function request({ value = body(), raw = JSON.stringify(value), signature = createHmac('sha256', SECRET).update(raw).digest('hex'),
  header = signature === null ? null : 'sha256=' + signature, path = '', headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method, path: '/api/whatsapp/webhook' + path,
      headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'x-hub-signature-256': header }), ...headers } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }); req.on('error', reject); req.end(method === 'GET' ? undefined : raw);
  });
}
test('missing secret fails closed before models, queue or patient access', async () => {
  delete process.env.FACEBOOK_APP_SECRET;
  const r = await request(); assert.equal(r.status, 503); assert.equal(reads + sensitiveReads + queued.length, 0);
  assert(!r.data.includes(SECRET));
});
test('missing, malformed, duplicated and tampered signatures cannot reach models', async () => {
  for (const header of [null, 'sha1=' + '0'.repeat(64), 'sha256=' + '0'.repeat(64), ['sha256=' + '0'.repeat(64), 'sha256=' + '0'.repeat(64)], 'sha256=abc']) {
    assert.equal((await request({ header })).status, 401);
  }
  const raw = JSON.stringify(body());
  assert.equal((await request({ raw: raw + ' ', signature: createHmac('sha256', SECRET).update(raw).digest('hex') })).status, 401);
  assert.equal(reads + sensitiveReads + queued.length, 0);
});
test('raw signed bytes are mandatory; a prebuilt body cannot substitute them', () => {
  assert.throws(() => authenticate({ headers: {}, body: body() }, { FACEBOOK_APP_SECRET: SECRET }), error => error.status === 503);
});
test('valid whitespace-preserving signature accepts one registered scope, ignores URL and payload clinic overrides', async () => {
  const value = body(); value.clinic_id = 999;
  const r = await request({ value, raw: JSON.stringify(value, null, 2), path: '?clinic_id=999&group_id=999' });
  assert.equal(r.status, 200); assert.equal(queued.length, 1); assert.equal(queued[0].clinic_id, 4);
  assert.equal(queued[0].whatsapp_origin_asset_id, 10); assert.equal(r.headers['cache-control'], 'no-store');
});
test('unknown phone, mismatched WABA and ambiguous registered scopes do not fall back', async () => {
  const value = body(); value.entry[0].changes[0].value.metadata.phone_number_id = '999999';
  assert.equal((await request({ value })).status, 403);
  value.entry[0].changes[0].value.metadata.phone_number_id = '222222'; value.entry[0].id = '999999';
  assert.equal((await request({ value })).status, 403);
  assets.push({ ...baseAsset(), id: 11, clinicaId: 999 });
  assert.equal((await request()).status, 403); assert.equal(sensitiveReads + queued.length, 0);
});
test('persistent scope blocks apply before patient lookup or queue writes', async () => {
  blocked = true; assert.equal((await request()).status, 403); assert.equal(sensitiveReads + queued.length, 0);
});
test('foreign, expired or unresolved cc_ref cannot be recovered later by the worker', async () => {
  const value = body(); value.entry[0].changes[0].value.messages[0].text.body = '[cc_ref:abcdef12]';
  for (const record of [null, { clinic_id: 999 }, { clinic_id: 4, expires_at: '2020-01-01' }, { clinic_id: 4, group_id: 99 }]) {
    webOrigin = record; assert.equal((await request({ value })).status, 403);
  }
  assert.equal(sensitiveReads + queued.length, 0);
  webOrigin = { clinic_id: 4, group_id: null };
  assert.equal((await request({ value })).status, 200); assert.equal(queued[0].web_origin_ref, 'abcdef12');
});
test('director routing requires a registered clinic and preserves its legitimate shared assignment', async () => {
  destination = { clinicId: 5, assignmentId: 22 };
  assert.equal((await request()).status, 403); assert.equal(queued.length, 0);
  settings = [{ clinic_id: 5 }]; assert.equal((await request()).status, 200); assert.equal(queued[0].clinic_id, 5);
});
test('unsupported mixed scope/contact batches are rejected before any side effect', async () => {
  const values = [body(), body(), body()];
  values[0].entry.push({ ...values[0].entry[0], id: '999999' });
  values[1].entry[0].changes.push(values[1].entry[0].changes[0]);
  values[2].entry[0].changes[0].value.messages.push({ from: '34611111111', text: { body: 'other' } });
  for (const value of values) assert.equal((await request({ value })).status, 400);
  assert.equal(reads + sensitiveReads + queued.length, 0);
});
test('oversized bodies and non-JSON content types cannot reach models', async () => {
  const value = body(); value.padding = 'x'.repeat(MAX_BYTES);
  assert.equal((await request({ value })).status, 413);
  assert.equal((await request({ headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(reads + sensitiveReads + queued.length, 0);
});
test('SQL errors have fixed responses without logging raw secrets', async () => {
  failSql = true; const errors = []; const original = console.error; console.error = (...args) => errors.push(args);
  try { const r = await request(); assert.equal(r.status, 503); assert(!r.data.includes('SENTINEL')); assert.equal(errors.length, 0); }
  finally { console.error = original; }
});
test('GET challenge is bounded plain text and does not authenticate POST delivery', async () => {
  const r = await request({ method: 'GET', path: '?hub.mode=subscribe&hub.verify_token=fictitious-verify-token&hub.challenge=1234' });
  assert.equal(r.status, 200); assert.equal(r.data, '1234'); assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal((await request({ method: 'GET', path: '?hub.mode=subscribe&hub.verify_token=fictitious-verify-token&hub.challenge=%3Cscript%3E' })).status, 403);
  assert.equal((await request({ header: null, path: '?hub.verify_token=fictitious-verify-token' })).status, 401);
  assert.equal(reads + sensitiveReads + queued.length, 0);
});
