'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createMedicalAreaApiBoundary } = require('../../middleware/medicalAreaApiBoundary');

// Real HTTP/Express routing; controllers and authentication are explicit
// fixtures. No app bootstrap, sessions, DB, providers or real webhook delivery.
async function withServer(role, run) {
  const calls = { auth: 0, controller: 0 };
  const ctrl = new Proxy({}, { get: () => (req, res) => { calls.controller++; res.json({ fixture: true }); } });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../routes/especialidades.routes.js'), 'utf8'), {
    module, exports: module.exports,
    require: name => {
      if (name === 'express') return express;
      if (name === '../controllers/especialidades.controller') return ctrl;
      if (name === '../middleware/medicalAreaApiBoundary') return { createMedicalAreaApiBoundary: () => createMedicalAreaApiBoundary(role) };
      if (name === './auth.middleware') return (req, res, next) => {
        calls.auth++; if (req.headers.authorization !== 'Bearer fixture-only') return res.sendStatus(401); next();
      };
      throw Error('Unexpected dependency: ' + name);
    },
  });
  const app = express();
  app.use('/api/especialidades', module.exports);
  app.get('/oauth/fixture', (req, res) => res.json({ external: true }));
  app.post('/api/whatsapp/webhook', (req, res) => res.json({ external: true }));
  app.get('/api/disponibilidad/fixture', (req, res) => res.json({ existing: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (route, options) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
  try { await run(request, calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('gateway refuses all area methods and nested clinic routes before controllers or authentication', async () => {
  await withServer('gateway', async (request, calls) => {
    for (const route of ['/area-contracts', '/area-contracts/nutricion', '/area-contracts/clinics',
      '/clinica/72/area-contracts/nutricion/review', '/clinica/72/area-contracts/nutricion/history',
      '/clinica/72/area-contracts/nutricion/revision']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        const response = await request('/api/especialidades' + route, { method });
        assert.equal(response.status, 404, method + ' ' + route);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (method !== 'HEAD') assert.equal((await response.json()).code, 'medical_area_api_required');
      }
    }
    assert.deepEqual(calls, { auth: 0, controller: 0 });
  });
});

test('gateway boundary ignores caller-supplied role, authorization, clinic and proxy headers', async () => {
  await withServer(' GATEWAY ', async (request, calls) => {
    const response = await request('/api/especialidades/AREA-CONTRACTS/nutricion/?runtime=api&role=admin', {
      method: 'PUT', headers: { Authorization: 'Bearer fixture-only', 'X-Runtime-Role': 'api',
        'X-Forwarded-Host': 'crm.clinicaclick.com', 'X-Clinic-Id': '72' },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, { auth: 0, controller: 0 });
  });
});

test('API role preserves authentication and dispatch for the shared area read/publication routes', async () => {
  await withServer('api', async (request, calls) => {
    for (const [method, route] of [['GET', '/area-contracts'], ['GET', '/area-contracts/nutricion'], ['PUT', '/area-contracts/nutricion']]) {
      assert.equal((await request('/api/especialidades' + route, { method })).status, 401);
      assert.equal((await request('/api/especialidades' + route, { method,
        headers: { Authorization: 'Bearer fixture-only' } })).status, 200);
    }
    assert.deepEqual(calls, { auth: 6, controller: 3 });
  });
});

test('boundary does not intercept other specialties, OAuth, webhook or availability routes', async () => {
  await withServer('gateway', async (request, calls) => {
    assert.equal((await request('/api/especialidades/sistema')).status, 200);
    assert.equal((await request('/oauth/fixture')).status, 200);
    assert.equal((await request('/api/whatsapp/webhook', { method: 'POST' })).status, 200);
    assert.equal((await request('/api/disponibilidad/fixture')).status, 200);
    assert.deepEqual(calls, { auth: 0, controller: 1 });
  });
});

test('boundary is fixed from server runtime, not request state; non-gateway keeps existing API behavior', () => {
  for (const role of ['', 'api', ' API ']) {
    let next = 0;
    createMedicalAreaApiBoundary(role)({ runtimeRole: 'gateway' }, {}, () => next++);
    assert.equal(next, 1);
  }
});
