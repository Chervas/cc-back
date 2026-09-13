'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
require('./fixtures/security_offline_runtime.cjs');
function fake(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
let allowed = false; let statsReads = 0; let assetReads = 0; let failSql = false;
const models = {
  SocialStatsDaily: { findAll: async options => { statsReads++; assert.equal(options.where.clinica_id, '4');
    if (failSql) throw Error('SENTINEL_SQL_PASSWORD');
    assert.deepEqual(options.include[0].attributes, ['id', 'metaAssetId', 'metaAssetName', 'assetType']);
    return [{ asset_type: 'facebook_page', impressions: 10, reach: 5, followers: 2,
      date: '2026-09-01', created_at: '2026-09-01', pageAccessToken: 'SENTINEL_PROVIDER_SECRET' }]; } },
  ClinicMetaAsset: { findAll: async options => { assetReads++; assert.deepEqual(options.attributes, ['id']); return [{ id: 1, pageAccessToken: 'SENTINEL' }]; } },
};
assert.equal(require.cache[require.resolve('../../../models')], undefined); fake('../../../models', models);
fake('../../lib/marketingScopeAccess', { hasMarketingClinicScopeAccess: async options => {
  assert.deepEqual(options, { userId: 123, clinicIds: [4], access: 'read' }); return allowed;
} });
fake('../../routes/auth.middleware', (req, _res, next) => { req.userData = { userId: 123 }; next(); });
fake('../../lib/role-helpers', { isGlobalAdmin: id => id === 123 });
const unused = new Proxy({}, { get: () => (_req, res) => res.status(501).json({ error: 'unused_fixture_handler' }) });
fake('../../controllers/metasync.jobs.controller', unused); fake('../../controllers/socialstats.controller', unused);
test('actual Meta HTTP router rejects foreign clinic reads, validates dates and never returns SQL/provider secrets; diagnostics stay quarantined', async () => {
  const app = require('express')(); app.use('/api/metasync', require('../../routes/metasync.routes'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const get = path => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/metasync' + path, agent }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }); req.on('error', reject);
  });
  try {
    assert.equal((await get('/metrics/4')).status, 403); assert.equal(statsReads + assetReads, 0);
    assert.equal((await get('/metrics/4junk')).status, 400); assert.equal(statsReads + assetReads, 0);
    allowed = true;
    for (const query of ['startDate=not-date','startDate=2026-02-30','startDate=2026-09-12&endDate=2026-09-01',
      'startDate=2020-01-01&endDate=2026-09-01','startDate[x]=2026-09-01']) {
      assert.equal((await get('/metrics/4?' + query)).status, 400); assert.equal(statsReads + assetReads, 0);
    }
    const metrics = await get('/metrics/4?startDate=2026-09-01&endDate=2026-09-12');
    assert.equal(metrics.status, 200); assert.equal(metrics.body.data.assetsActivos, 1);
    assert.equal(metrics.body.data.resumen.totalImpressions, 10); assert(!JSON.stringify(metrics.body).includes('SENTINEL'));
    failSql = true; const failure = await get('/metrics/4?startDate=2026-09-01&endDate=2026-09-12');
    assert.equal(failure.status, 500); assert.equal(failure.body.error, 'meta_metrics_unavailable');
    assert(!JSON.stringify(failure.body).includes('SENTINEL'));
    for (const path of ['/diagnostic/user-connection','/diagnostic/asset/1','/diagnostic/permissions',
      '/diagnostic/sample-data/1','/diagnostic/asset-details/1']) {
      const response = await get(path); assert.equal(response.status, 503); assert.equal(response.body.error, 'meta_security_quarantine');
    }
  } finally { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
