'use strict';
// Controller-only native HTTP fixture. Stub service, ephemeral loopback server;
// no app/models, database, storage object, patient data or provider is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const asyncHandler = require('express-async-handler');
const filename = require.resolve('../../controllers/patientClinicalAttachments.controller');

function controller(service) {
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, Buffer, require: name => {
    if (name === 'express-async-handler') return asyncHandler;
    if (name === '../services/patientClinicalAttachments.service') return service;
    throw Error('UNEXPECTED_DEPENDENCY');
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return module.exports;
}

async function fixture(run) {
  const state = { error: null, actor: 7, args: [], globalErrors: 0, filename: 'fictitious.pdf' };
  const service = {
    listPatientClinicalAttachments: async (...args) => { state.args.push(args); if (state.error) throw state.error; return { items: [], summary: { total: 0 } }; },
    readPatientClinicalAttachment: async (...args) => { state.args.push(args); if (state.error) throw state.error;
      return { asset: { id: 1 }, buffer: Buffer.from('FICTITIOUS_BINARY'), contentType: 'application/pdf', filename: state.filename }; },
  };
  const c = controller(service), app = express();
  app.use((req, res, next) => { req.userData = state.actor === null ? {} : { userId: state.actor }; next(); });
  app.get('/patients/:id/attachments', c.listPatientClinicalAttachments);
  app.get('/patients/:id/attachments/:attachmentId', c.getPatientClinicalAttachment);
  app.use((error, req, res, next) => { state.globalErrors++; res.status(500).type('html').send('UNEXPECTED_HTML_STACK'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run({ state, origin: `http://127.0.0.1:${server.address().port}` }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function privateHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('successful list and binary stay private and use only authenticated actor', async () => {
  await fixture(async ({ state, origin }) => {
    const list = await fetch(origin + '/patients/OWNED-FICTITIOUS/attachments?actorUserId=999&clinic_id=72');
    assert.equal(list.status, 200); privateHeaders(list); assert.match(list.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await list.json(), { items: [], summary: { total: 0 } });
    const file = await fetch(origin + '/patients/OWNED-FICTITIOUS/attachments/OWNED-ASSET');
    assert.equal(file.status, 200); privateHeaders(file); assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(await file.text(), 'FICTITIOUS_BINARY');
    assert.deepEqual(Array.from(state.args[0]), ['OWNED-FICTITIOUS', 7]);
    assert.deepEqual(Array.from(state.args[1]), ['OWNED-FICTITIOUS', 'OWNED-ASSET', 7]);
    assert.equal(state.globalErrors, 0);
  });
});

test('auth/permission/not-found/filesystem/unknown errors are safe JSON and never HTML on both reads', async () => {
  await fixture(async ({ state, origin }) => {
    const cases = [
      [Object.assign(Error('SECRET_AUTH_PATH'), { status: 401 }), 401, 'auth_failed'],
      [Object.assign(Error('SECRET_PERMISSION_PATH'), { status: 403, details: { secret: 'PRIVATE_DETAIL' } }), 403, 'access_policy_forbidden'],
      [Object.assign(Error('SECRET_NOT_FOUND_PATH'), { status: 404 }), 404, 'clinical_attachment_not_found'],
      [Object.assign(Error('ENOENT open /private/PRIVATE_FILENAME'), { code: 'ENOENT', path: '/private/PRIVATE_FILENAME' }), 404, 'clinical_attachment_not_found'],
      [Object.assign(Error('EACCES open /private/PRIVATE_FILENAME'), { code: 'EACCES', path: '/private/PRIVATE_FILENAME' }), 500, 'clinical_attachment_unavailable'],
      [Error('clinical_private_asset_checksum_mismatch'), 500, 'clinical_attachment_unavailable'],
      [Object.assign(Error('PRIVATE_PROVIDER_CONFIG'), { status: 503 }), 503, 'clinical_attachment_unavailable'],
      [Object.assign(Error('SQL PRIVATE_SELECT_VALUE'), { details: { secret: 'PRIVATE_DETAIL' } }), 500, 'clinical_attachment_unavailable'],
    ];
    for (const suffix of ['', '/OWNED-ASSET']) for (const [error, status, code] of cases) {
      state.error = error;
      const response = await fetch(origin + '/patients/OWNED-FICTITIOUS/attachments' + suffix);
      assert.equal(response.status, status); privateHeaders(response); assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json(); assert.equal(body.code, code);
      assert(!/SECRET|PRIVATE_|SQL|stack|\/private|checksum/i.test(JSON.stringify(body)));
      assert.equal(body.details, undefined);
    }
    assert.equal(state.globalErrors, 0);
  });
});

test('missing actor is private JSON401 before service lookup, without trusting query identity', async () => {
  await fixture(async ({ state, origin }) => {
    state.actor = null;
    for (const suffix of ['', '/OWNED-ASSET']) {
      const response = await fetch(origin + '/patients/OWNED-FICTITIOUS/attachments' + suffix + '?actorUserId=999');
      assert.equal(response.status, 401); privateHeaders(response);
      assert.equal((await response.json()).code, 'auth_failed');
    }
    assert.equal(state.args.length, 0); assert.equal(state.globalErrors, 0);
  });
});

test('binary header failure resets type/disposition/length and returns private JSON500', async () => {
  await fixture(async ({ state, origin }) => {
    state.filename = 'PRIVATE_FILENAME\r\nInvalid-Header';
    const response = await fetch(origin + '/patients/OWNED-FICTITIOUS/attachments/OWNED-ASSET');
    assert.equal(response.status, 500); privateHeaders(response);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('content-disposition'), null);
    const body = await response.json(); assert.equal(body.code, 'clinical_attachment_unavailable');
    assert(!JSON.stringify(body).includes('PRIVATE_FILENAME'));
    assert.equal(state.globalErrors, 0);
  });
});
