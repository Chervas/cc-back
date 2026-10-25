'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../../services/clinicalEpisodeServiceContext.service'), C = require('../../lib/clinical-episode-contract');
test('clinical service references accept identity only, never client titles, money or foreign context fields', () => {
  assert.deepEqual(S.reference({ kind: 'voucher', id: 'owned-voucher' }), { kind: 'voucher', id: 'owned-voucher' });
  assert.deepEqual(S.reference({ kind: 'budget_line', id: 'owned-budget', line_key: 'owned-line' }), { kind: 'budget_line', id: 'owned-budget', line_key: 'owned-line' });
  for (const value of [{ kind: 'voucher', id: 'x', title: 'Client title' }, { kind: 'voucher', id: 'x', line_key: 'line' }, { kind: 'budget_line', id: 'x' },
    { kind: 'dental_plan', id: 'x', price: 4 }, { kind: 'unknown', id: 'x' }, { kind: 'voucher', id: '../other' }]) assert.throws(() => S.reference(value), { code: 'clinical_service_context_invalid' });
  assert.equal(S.reference(null), null);
  const stored = { kind: 'voucher', id: 'owned-voucher', title: 'Server snapshot', area_key: 'estetica' };
  assert.deepEqual(S.identity(stored), { kind: 'voucher', id: 'owned-voucher' }); assert(S.same(stored, { kind: 'voucher', id: 'owned-voucher' }));
  assert.equal(C.normalizePatch({ treatment_id: null }).treatment_id, null); assert.equal(C.normalizePatch({ treatment_id: 8 }).treatment_id, 8);
  assert.equal(C.normalizePatch({ treatment_id: 8, service_ref: S.identity(stored) }, {}, { legacy: true }).service_ref, undefined);
});
