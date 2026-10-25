'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { createController } = require('../../controllers/clinicalEpisodeConsumables.controller');
test('consumable HTTP routes pass exact episode/clinic and retain typed CAS, permission and schema errors without SQL or sensitive content', async () => {
  const calls = [], controller = createController({ consumables: { read: async input => { calls.push(input); return { items: [], movements: [], next_cursor: null }; },
    products: async () => { throw Object.assign(Error('PRIVATE_SQL_MUST_NOT_LEAK'), { original: { code: 'ER_NO_SUCH_TABLE' } }); },
    save: async input => { calls.push(input); if (input.payload.expected_version !== 1) throw Object.assign(Error('El episodio ha cambiado.'), { statusCode: 409, code: 'clinical_report_version_conflict' });
      throw Object.assign(Error('Sin permiso para esta acción.'), { statusCode: 403, code: 'clinical_consumables_forbidden' }); } } });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.userData = { userId: 7 }; next(); });
  app.get('/episodes/:id/consumables', controller.read); app.get('/episodes/:id/products', controller.products); app.post('/episodes/:id/consumables', controller.save);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const read = await fetch(origin + '/episodes/owned-episode/consumables?clinic_id=72'); assert.equal(read.status, 200); assert.match(read.headers.get('cache-control'), /no-store/);
    assert.equal(calls[0].id, 'owned-episode'); assert.equal(calls[0].clinicId, '72'); assert.equal(calls[0].actorId, 7);
    for (const [expected, code, status] of [[0, 'clinical_report_version_conflict', 409], [1, 'clinical_consumables_forbidden', 403]]) {
      const response = await fetch(origin + '/episodes/owned-episode/consumables?clinic_id=72', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_version: expected }) });
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
    const missing = await fetch(origin + '/episodes/owned-episode/products?clinic_id=72'); assert.equal(missing.status, 503); const body = await missing.text(); assert(!body.includes('PRIVATE_SQL')); assert(body.includes('clinical_episode_schema_pending'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
