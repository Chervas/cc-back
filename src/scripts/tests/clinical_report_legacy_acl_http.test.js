'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const fs = require('node:fs'), vm = require('node:vm');

async function fixture(work) {
  const filename = require.resolve('../../controllers/appointmentClinicalReports.controller'), local = require('node:module').createRequire(filename);
  const module = { exports: {} }, state = { denied: null, queries: 0, checked: [] };
  const item = { id: 'owned-episode', private_notes: 'Owned private fixture', rich_document: { version: 1, sections: {} }, material_refs: [{ kind: 'drawing', id: 'owned-drawing', version: 1 }] };
  const service = { domainError: (statusCode, code, message) => Object.assign(Error(message), { statusCode, code }),
    getByAppointment: async () => { state.queries++; return item; }, listForPatient: async () => { state.queries++; return [item]; },
    save: async () => { state.queries++; return item; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: name => {
    if (name === '../../models') return { CitaPaciente: { findByPk: async () => ({ clinica_id: 72 }) } };
    if (name === '../services/appointmentClinicalReports.service') return service;
    if (name === '../lib/access-policy') return { canUserAccessFeature: async input => {
      state.checked.push(input); return input.featureKey !== state.denied;
    } };
    return local(name);
  } });
  const controller = module.exports, app = express(); app.use(express.json());
  app.use((req, res, next) => { req.userData = { userId: 7 }; next(); });
  app.get('/reports/patient/:patientId', controller.listForPatient);
  app.get('/appointments/:id/report', controller.getByAppointment);
  app.put('/appointments/:id/report', controller.save);
  app.post('/appointments/:id/report/finalize', controller.finalize);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try { await work({ state, origin: 'http://127.0.0.1:' + server.address().port }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('legacy report read/list/save/finalize cannot bypass patient view or sensitive deny overrides', async () => fixture(async ({ state, origin }) => {
  const paths = [['GET', '/appointments/123/report'], ['GET', '/reports/patient/456?clinic_id=72'],
    ['PUT', '/appointments/123/report'], ['POST', '/appointments/123/report/finalize']];
  for (const denied of ['patients.view', 'patients.sensitive.view']) for (const [method, path] of paths) {
    state.denied = denied; state.checked = []; const before = state.queries;
    const response = await fetch(origin + path, { method, ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_version: 1, summary: 'Owned edit' }) } : {}) });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'access_policy_forbidden');
    assert.equal(state.queries, before, 'no report, rich document, private note or material query after a sensitive-scope deny');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert(state.checked.some(check => check.featureKey === denied));
    assert(state.checked.every(check => check.actorId === 7 && check.clinicId === 72));
  }
}));

test('legacy endpoints retain clinical-specific permission gates and authorized DTO compatibility', async () => fixture(async ({ state, origin }) => {
  for (const [method, path, denied] of [['GET', '/appointments/123/report', 'clinical.reports.view'],
    ['GET', '/reports/patient/456?clinic_id=72', 'clinical.reports.view'],
    ['PUT', '/appointments/123/report', 'clinical.reports.manage'], ['POST', '/appointments/123/report/finalize', 'clinical.reports.manage']]) {
    state.denied = denied; const before = state.queries;
    const response = await fetch(origin + path, { method }); assert.equal(response.status, 403); assert.equal(state.queries, before);
  }
  state.denied = null;
  const read = await fetch(origin + '/appointments/123/report'); assert.equal(read.status, 200);
  const item = await read.json(); assert.equal(item.id, 'owned-episode'); assert.equal(item.private_notes, 'Owned private fixture'); assert.equal(item.material_refs[0].version, 1);
  const list = await fetch(origin + '/reports/patient/456?clinic_id=72'); assert.equal(list.status, 200); assert.equal((await list.json())[0].id, item.id);
}));
