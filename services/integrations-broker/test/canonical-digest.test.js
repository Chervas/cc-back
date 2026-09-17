'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { canonical } = require('../src/canonical');
const { canonicalDigest } = require('../src/canonical-digest');

test('incremental AI digests retain the existing byte encoding for persisted idempotency', () => {
  const examples = [null, true, false, 0, -0, 1e30, 1e-10, '', 'á😀\u0000\n"\\\ud800', [], {},
    { z: [{ b: 'two', a: ['one', null] }], a: { '10': 2, '2': 1, '"': 'escape' } },
    { operation: 'ai.openai.responses.create.v1', tenantRef: 'platform:staging', connectionRef: 'ai:openai:staging',
      assetRef: 'ai:accounting_ocr', payload: { body: { input: [{ content: [{ file_data: 'data:application/pdf;base64,' + Buffer.alloc(1024 * 1024, 65).toString('base64') }] }] } } },
  ];
  for (const value of examples) {
    const parsed = JSON.parse(JSON.stringify(value));
    assert.equal(canonicalDigest(parsed), createHash('sha256').update(canonical(parsed)).digest('hex'));
  }
  assert.equal(canonicalDigest({ z: 1, a: 2 }), canonicalDigest({ a: 2, z: 1 }));
  assert.notEqual(canonicalDigest([1, 2]), canonicalDigest([2, 1]));
});
