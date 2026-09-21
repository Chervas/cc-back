'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = require.resolve('../../services/consentimientos.service');
const source = fs.readFileSync(servicePath, 'utf8');
const start = source.indexOf('function summarizeDocuments(');
const end = source.indexOf('\nasync function getConsentSummaryForAppointment', start);
const sandbox = { require: createRequire(servicePath), getPlain: value => value,
  DOCUMENT_PENDING_STATUSES: new Set(['pending', 'sent', 'viewed']) };
vm.runInNewContext(source.slice(start, end), sandbox);
const summarize = sandbox.summarizeDocuments;
const document = { required: true, blocking_policy: 'hard', purpose: 'clinical', status: 'signed', signed_at: '2026-01-01T08:00:00Z' };
test('appointment summary never reports rejected, revoked or expired required consent as complete', () => {
  for (const change of [{ status: 'rejected' }, { status: 'revoked' }, { status: 'expired' }, { expires_at: '2026-01-02' },
    { revoked_at: '2026-01-02' }, { snapshot_json: { template: { requires_professional_signature: true } } }]) {
    const summary = summarize([{ ...document, ...change }]);
    assert.equal(summary.status, 'pending'); assert.equal(summary.signed_required, 0); assert.equal(summary.blocking_pending, 1);
  }
});
test('only hard clinical requirements are blocking, including missing templates not yet packaged', () => {
  for (const change of [{ purpose: 'commercial_communications' }, { purpose: 'data_protection' }, { blocking_policy: 'soft' }]) {
    const summary = summarize([{ ...document, ...change, status: 'pending' }], 1, 0, 0);
    assert.equal(summary.has_pending, true); assert.equal(summary.blocking_pending, 0);
  }
  assert.equal(summarize([], 1, 0, 1).blocking_pending, 1);
  assert.equal(summarize([document]).status, 'ok');
});
