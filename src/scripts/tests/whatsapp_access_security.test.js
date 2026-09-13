'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
require('./fixtures/security_offline_runtime.cjs');
const { Op } = require('sequelize');
function fake(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
let assetQueries = [], role = 'propietario', sqlFails = false, assetRow = null;
const models = {
  UsuarioClinica: { findAll: async options => {
    if (!options.where.id_clinica) return [{ id_clinica: 4, rol_clinica: role }];
    assert(options.where[Op.or]);
    if (!options.where.rol_clinica[Op.in].includes(role)) return [];
    return options.where.id_clinica[Op.in].includes(4) ? [{ id_clinica: 4 }] : [];
  } },
  Clinica: { findAll: async options => {
    assert(options.where, 'clinic owner must never query all platform groups');
    if (options.where.grupoClinicaId) return [{ id_clinica: 4 }, { id_clinica: 999 }];
    assert.deepEqual(options.where.id_clinica[Op.in], [4]); return [];
  }, findOne: async () => ({ id_clinica: 4, grupoClinicaId: null }), findByPk: async () => ({ id_clinica: 4, grupoClinicaId: null }) },
  ClinicMetaAsset: { findAll: async options => { assetQueries.push(options); if (sqlFails) throw Error('SENTINEL_SQL_SECRET');
    return assetRow && options.where.assetType === 'whatsapp_phone_number' ? [assetRow] : []; },
    findOne: async options => { assetQueries.push(options); return null; } },
};
assert.equal(require.cache[require.resolve('../../../models')], undefined); fake('../../../models', models);
// Stub service side effects before loading the actual controller/router. The
// real permission helper and real controller remain under test.
const source = require('node:fs').readFileSync(require.resolve('../../controllers/whatsapp.controller'), 'utf8');
for (const match of source.matchAll(/require\(['"]\.\.\/services\/([^'"]+)['"]\)/g)) {
  fake('../../services/' + match[1], new Proxy({}, { get: (_target, key) => () => {
    if (['derivePaymentSnapshot', 'getOutboundUsageForPhone', 'summarizeCompliance', 'summarizeAssetHealth'].includes(key)) return {};
    throw Error('UNEXPECTED_SERVICE_SIDE_EFFECT');
  } }));
}
fake('../../routes/auth.middleware', (req, res, next) => {
  if (req.headers['x-test-auth'] !== 'yes') return res.status(401).json({ error: 'unauthorized' });
  req.userData = { userId: 123 }; next();
});
let server, agent;
test.before(async () => {
  const app = require('express')(); app.use(require('express').json()); app.use('/api/whatsapp', require('../../routes/whatsapp.routes'));
  server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
});
test.beforeEach(() => { assetQueries = []; role = 'propietario'; sqlFails = false; assetRow = null; });
test.after(async () => { agent?.destroy(); if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
function request(path, { method = 'GET', authenticated = true, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method, path: '/api/whatsapp' + path,
      headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-test-auth': 'yes' } : {}) } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }); req.on('error', reject); req.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}
test('WhatsApp status and filtered phone lists reject foreign clinics before asset/credential lookup', async () => {
  for (const path of ['/status?clinic_id=999', '/phones?clinic_id=999', '/phones?group_id=9', '/phones?routing_scope_clinic_id=999']) {
    assert.equal((await request(path)).status, 403);
  }
  assert.equal(assetQueries.length, 0);
});
test('clinic owners and admins get only their accessible phones, never all platform assets', async () => {
  for (role of ['propietario', 'personaldeclinica']) {
    const r = await request('/phones'); assert.equal(r.status, 200); assert.deepEqual(r.data.phones, []);
    const query = assetQueries.at(-1); assert.deepEqual(query.where[Op.or][0].clinicaId[Op.in], [4]);
    assert.deepEqual(query.attributes.exclude, ['waAccessToken', 'pageAccessToken']);
  }
  role = 'admin';
  assert.equal((await request('/status?clinic_id=4')).status, 403);
  assert.equal((await request('/phones')).status, 200);
  assert.deepEqual(assetQueries.at(-1).where[Op.or][0].clinicaId[Op.in], []);
});
test('strict IDs reject malformed scopes; an authorized clinic still has a historical status response', async () => {
  for (const path of ['/status?clinic_id=4junk', '/phones?clinic_id=4junk', '/phones?clinic_id=4&group_id=9', '/phones?group_id[x]=9']) {
    assert.equal((await request(path)).status, 400);
  }
  assert.equal(assetQueries.length, 0);
  const r = await request('/status?clinic_id=4'); assert.equal(r.status, 200); assert.deepEqual(r.data, { configured: false });
});
test('quarantine rejects all public WhatsApp mutations before queueing, registration or local assignment', async () => {
  for (const [method, path] of [['POST', '/messages'], ['POST', '/templates/sync'], ['POST', '/phones/222222/register'],
    ['PUT', '/phones/222222/assignment'], ['DELETE', '/phones/222222'], ['PATCH', '/phones/222222']]) {
    assert.equal((await request(path, { method, authenticated: false })).status, 401);
    const r = await request(path, { method, body: { accessToken: 'SENTINEL_TOKEN', clinic_id: 999 } });
    assert.equal(r.status, 503); assert.equal(r.data.error, 'meta_security_quarantine'); assert(!JSON.stringify(r.data).includes('SENTINEL'));
  }
  assert.equal(assetQueries.length, 0);
});
test('phone list SQL failures never return or log raw credentials', async () => {
  sqlFails = true; const logs = []; const original = console.error; console.error = (...args) => logs.push(args);
  try { const r = await request('/phones'); assert.equal(r.status, 503); assert.deepEqual(r.data, { error: 'whatsapp_phones_unavailable' }); assert.equal(logs.length, 0); }
  finally { console.error = original; }
});
test('opening a populated phone list cannot read tokens, enqueue refreshes, register phones or save metadata', async () => {
  assetRow = { id: 10, phoneNumberId: '222222', wabaId: '111111', clinicaId: 4, assignmentScope: 'clinic',
    additionalData: { businessId: '333333', whatsappBusinessHealth: { business_verification_status: 'verified' } },
    get waAccessToken() { throw Error('SENTINEL_TOKEN_READ'); }, get pageAccessToken() { throw Error('SENTINEL_TOKEN_READ'); },
    save() { throw Error('UNEXPECTED_WRITE_FROM_GET'); }, unknownToken: 'SENTINEL_TOKEN',
  };
  const r = await request('/phones'); assert.equal(r.status, 200); assert.equal(r.data.phones.length, 1);
  assert.equal(r.data.phones[0].phoneNumberId, '222222'); assert(!JSON.stringify(r.data).includes('SENTINEL'));
});
