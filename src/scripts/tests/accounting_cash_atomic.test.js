'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { accountingService, accountingController, invoke } = require('./helpers/accounting-cash-test-loader');
const domainError = (statusCode, code, message) => Object.assign(Error(message), { statusCode, code });

test('cash close controller preserves the exact clinic capability and rejects denied, unauthenticated and portal actors before service', async () => {
  const calls = [], decisions = [];
  const accounting = { domainError, closeCash: async input => { calls.push(input); return { id: 'owned-closure' }; } };
  const controller = accountingController(accounting, { canAccess: async input => {
    decisions.push(input); return input.actorId === 7 && input.clinicId === 72 && input.featureKey === 'accounting.cash.manage';
  }, isPortal: async ({ actorId }) => actorId === 9 });
  const request = (actor, clinic = 72) => ({ userData: { userId: actor }, query: {}, body: { clinic_id: clinic, business_date: '2026-10-25', actual_cash: 50 } });
  for (const [req, code] of [[request(8), 'access_policy_forbidden'], [request(7, 73), 'access_policy_forbidden'],
    [request(9), 'accounting_portal_read_only'], [request(null), 'unauthenticated']]) {
    await assert.rejects(invoke(controller.closeCash, req), { code });
    assert.equal(calls.length, 0);
  }
  const req = request(7), response = await invoke(controller.closeCash, req);
  assert.equal(response.statusCode, 201); assert.equal(response.body.id, 'owned-closure'); assert.equal(calls.length, 1);
  assert.equal(calls[0].clinicId, 72); assert.equal(calls[0].actorId, 7); assert.equal(calls[0].payload, req.body);
  assert(decisions.every(input => input.featureKey === 'accounting.cash.manage'));
});
test('accounting fiscal read keeps exact clinic, patient and server source identity for the existing origin shortcut', async () => {
  const lookups = [], source = { type: 'payment', id: 'public-payment', applied_amount: 42 };
  const row = { public_id: 'public-document', clinic_id: '72', patient_id: '11', document_type: 'receipt', status: 'issued',
    payment_data: { source }, lines: [], totals: { total: 42 } };
  const service = accountingService({ PatientFiscalDocument: { findOne: async options => { lookups.push(options); return row; } } });
  const result = await service.getFiscalDocument({ publicId: row.public_id, clinicId: 72 });
  assert.equal(result.clinic_id, 72); assert.equal(result.patient_id, 11); assert.equal(result.id, row.public_id);
  assert.equal(result.payment_data.source, source);
  assert.deepEqual(JSON.parse(JSON.stringify(lookups)), [{ where: { public_id: 'public-document', clinic_id: 72 } }]);
});
