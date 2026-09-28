'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/patientEconomics.controller'), 'utf8');
function fixture({ allowed = [72], budget = { clinic_id: 72 } } = {}) {
  const calls = [], exports = {};
  const economics = {
    domainError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
    previewBudgetAcceptance: async args => { calls.push({ kind: 'preview', args }); return { accepted_amount: 105.55 }; },
  };
  vm.runInNewContext(source, { exports, require(name) {
    if (name === '../../models') return { EconomicBudget: { findOne: async query => { calls.push({ kind: 'scope', query }); return budget; } } };
    if (name === '../services/patientEconomics.service') return economics;
    if (name === '../lib/access-policy') return { getAccessibleClinicIdsForFeature: async args => { calls.push({ kind: 'permission', args }); return allowed; } };
    if (['../services/economicDocumentPdf.service', '../services/patientVoucherAppointments.service', '../services/patientProgramBooking.service'].includes(name)) return {};
    throw Error('UNEXPECTED_DEPENDENCY:' + name);
  } });
  const run = async (userId = 1) => {
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, json(value) { this.body = value; } };
    let error;
    await exports.previewBudgetAcceptance({ params: { budgetId: 'owned-budget' }, userData: { userId },
      body: { clinic_id: 999, expected_version: 1, action: 'accept' } }, response, value => { error = value; });
    return { response, error };
  };
  return { calls, run };
}
test('preview authorizes the persisted clinic with patients.edit, never the submitted clinic', async () => {
  const { run, calls } = fixture(); const { response, error } = await run();
  assert.equal(error, undefined);
  const permission = calls.find(call => call.kind === 'permission').args;
  assert.equal(permission.featureKey, 'patients.edit'); assert.deepEqual([...permission.clinicIds], [72]);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(response.body.accepted_amount, 105.55);
});
test('missing actor, unavailable scope and missing budget cannot reach the calculation', async () => {
  for (const [options, userId, code] of [[{}, null, 'unauthenticated'], [{ allowed: [999] }, 1, 'access_policy_forbidden'], [{ budget: null }, 1, 'budget_not_found']]) {
    const { run, calls } = fixture(options); const { response, error } = await run(userId);
    assert.equal(error.code, code); assert.equal(response.body, undefined);
    assert.equal(calls.some(call => call.kind === 'preview'), false);
  }
});
test('preview route is behind the same authentication middleware as budget mutations', () => {
  const routes = [], auth = () => {}, controller = new Proxy({}, { get: (_, key) => key });
  const router = new Proxy({}, { get: (_, method) => (...args) => routes.push({ method, args }) });
  vm.runInNewContext(fs.readFileSync(require.resolve('../../routes/patientEconomics.routes'), 'utf8'), {
    module: { exports: {} }, require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === './auth.middleware') return auth;
      if (name === '../controllers/patientEconomics.controller') return controller;
      throw Error(name);
    },
  });
  const guard = routes.findIndex(route => route.method === 'use' && route.args[0] === auth);
  const preview = routes.findIndex(route => route.method === 'post' && route.args[0] === '/budgets/:budgetId/acceptance-preview');
  assert.ok(guard >= 0 && preview > guard);
  assert.equal(routes[preview].args[1], 'previewBudgetAcceptance');
});
