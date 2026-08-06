'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeReviewSenderName,
  requireReviewSenderName,
} = require('../../lib/review-sender-policy');

test('normalizes an explicit review sender', () => {
  assert.equal(normalizeReviewSenderName('  Lidia  '), 'Lidia');
  assert.equal(requireReviewSenderName('  Lidia  '), 'Lidia');
});

test('rejects an empty review sender without a silent fallback', () => {
  assert.throws(
    () => requireReviewSenderName('   '),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.details?.reason, 'review_sender_name_missing');
      assert.deepEqual(error.details?.warnings, ['sender_name_missing']);
      return true;
    }
  );
});
