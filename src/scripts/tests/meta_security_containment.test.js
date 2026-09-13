'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
require('./fixtures/security_offline_runtime.cjs');
const transport = require('../../lib/metaQuarantineHttp');
test('Meta quarantine rejects every transport shape before loading an HTTP client, including arbitrary media URLs and alternate credentials', async () => {
  for (const client of [transport, transport.create({ baseURL: 'https://attacker.example.invalid' })]) {
    await assert.rejects(client({ url: 'https://graph.facebook.com/me', headers: { authorization: 'SENTINEL' } }), { code: 'meta_security_quarantine' });
    for (const method of ['request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      await assert.rejects(client[method]('https://arbitrary-media.example.invalid', { access_token: 'SENTINEL' }), error => {
        assert(!JSON.stringify(error).includes('SENTINEL')); assert(!error.config && !error.response); return error.code === 'meta_security_quarantine';
      });
    }
  }
  assert(Object.isFrozen(transport)); assert.throws(() => transport.get = () => {}, TypeError);
  const response = { status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  transport.middleware({}, response); assert.equal(response.code, 503); assert.equal(response.body.error, 'meta_security_quarantine');
});
test('every inventoried dedicated Meta transport uses quarantine, while the mixed OAuth module keeps separate Google and Meta clients', () => {
  const files = ['controllers/metasync.controller.js','controllers/metasync.diagnostic.js','controllers/whatsapp.controller.js',
    'lib/metaBatch.js','lib/metaClient.js','routes/metasync.service.js','routes/whatsapp-embedded.routes.js',
    'services/metaCapi.service.js','services/systemNotifications.service.js','services/whatsapp.service.js',
    'services/whatsappPhones.service.js','services/whatsappTemplates.service.js','services/metaLeadReception.service.js'];
  for (const file of files) { const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    assert(source.includes('metaQuarantineHttp'), file); assert(!source.includes("require('axios')"), file); }
  const oauth = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  assert(oauth.includes('await metaHttp.get(url, config)')); assert(oauth.includes('await metaHttp.post(url, data, { params })'));
  for (const route of ['connect','callback']) assert(oauth.includes("router.get('/meta/" + route + "', metaHttp.middleware"));
  assert(oauth.includes("router.post('/meta/map-assets', metaHttp.middleware"));
});
test('shared consumers include group primary policies even without sharing rows or group ownership', async () => {
  const { affectedClinicIdsForAsset } = require('../../lib/sharedMarketingAssetMutationAccess');
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const seen = [];
  const ids = await affectedClinicIdsForAsset({ assetType: 'meta.facebook_page', assetId: 123, ownerClinicId: 4,
    transaction, assignmentModel: { findAll: async options => { assert.equal(options.lock, 'UPDATE'); return [{ clinicaId: 5 }]; } },
    findImplicitGroupId: async () => null, findPrimaryGroupIds: async options => { assert.equal(options.transaction, transaction); return [9]; },
    findGroupClinicIds: async groupId => { seen.push(groupId); return [6, 7]; } });
  assert.deepEqual(ids, [4, 5, 6, 7]); assert.deepEqual(seen, [9]);
  assert.deepEqual(await affectedClinicIdsForAsset({ assetType: 'meta.facebook_page', assetId: '123junk' }), []);
});
