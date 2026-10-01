'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { withoutTrailingSeparators, componentsWithoutSeparators } = require('../../../migrations/20261002003000-remove-review-request-footer-separators')._test;

test('only trailing separator lines are removed, idempotently', () => {
  for (const footer of ['\n\n--', '\n\n\u2014', '\n-\n-\n', '\r\n\r\n\u2013\u2013']) {
    assert.equal(withoutTrailingSeparators('Thank you' + footer), 'Thank you');
  }
  for (const body of ['Thank you', 'A - B\nThank you', 'Rating\n5 *****\n1 *\nThank you']) {
    assert.equal(withoutTrailingSeparators(body), body);
  }
  assert.equal(withoutTrailingSeparators(withoutTrailingSeparators('Thank you\n\n--')), 'Thank you');
});

test('image header and variable examples are preserved while empty separator footer is removed', () => {
  const header = { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['keep-existing-handle'] } };
  const example = { body_text: [['Name', 'Clinic', 'Sender', '21/05/2026']] };
  const result = componentsWithoutSeparators([header, { type: 'BODY', text: 'Thank you\n\n--', example }, { type: 'FOOTER', text: '--' }]);
  assert.deepEqual(result, [header, { type: 'BODY', text: 'Thank you', example }]);
  assert.equal(componentsWithoutSeparators([{ type: 'FOOTER', text: 'Useful notice' }]).length, 1);
});
