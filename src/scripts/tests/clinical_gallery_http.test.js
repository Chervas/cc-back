'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { createController } = require('../../controllers/clinicalPhotoPairs.controller');
test('pair and library handlers pass authenticated scope and CAS, preserve private JSON errors and hide SQL/path details', async () => {
  const calls = [], pairs = Object.fromEntries(['list', 'get', 'create', 'save', 'archive', 'classifyAttachment', 'archiveAttachment'].map(method => [method, async input => {
    calls.push({ method, input });
    if (input.payload.fail === 'conflict') throw Object.assign(Error('La versión ha cambiado.'), { code: 'clinical_gallery_version_conflict', statusCode: 409 });
    if (input.payload.fail === 'private') throw Error('PRIVATE_SQL PRIVATE_OBJECT /private/path');
    if (input.payload.fail === 'schema') throw { original: { code: 'ER_NO_SUCH_TABLE' } };
    return { item: { id: input.id || 'pair' }, created: method === 'create' };
  }]));
  const controller = createController({ pairs }), app = express(); app.use(express.json()); app.use((req, _res, next) => { req.userData = { userId: 7 }; next(); });
  app.get('/patients/:id/pairs', controller.list); app.post('/patients/:id/pairs', controller.create); app.patch('/patients/:id/pairs/:pairId', controller.save);
  app.post('/patients/:id/attachments/:attachmentId/archive', controller.archiveAttachment);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const created = await fetch(base + '/patients/11/pairs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clinic_id: 72, idempotency_key: 'owned-create' }) });
    assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'private, no-store'); assert.equal(calls[0].input.actorId, 7); assert.equal(calls[0].input.patientIdentifier, '11');
    const archived = await fetch(base + '/patients/11/attachments/cpa_1/archive?clinic_id=72', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_version: 3 }) });
    assert.equal(archived.status, 200); assert.equal(calls.at(-1).input.id, 'cpa_1'); assert.equal(calls.at(-1).input.payload.expected_version, 3);
    for (const [fail, status, code] of [['conflict', 409, 'clinical_gallery_version_conflict'], ['private', 500, 'clinical_episode_unavailable'], ['schema', 503, 'clinical_episode_schema_pending']]) {
      const response = await fetch(base + '/patients/11/pairs/pair_1?clinic_id=72', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fail }) });
      assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'private, no-store'); const body = await response.text(); assert.equal(JSON.parse(body).error.code, code); assert(!body.includes('PRIVATE_')); assert(!body.includes('/private/'));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
