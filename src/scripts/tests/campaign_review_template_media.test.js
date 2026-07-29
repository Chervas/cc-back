'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { matchesReviewTemplateMedia } = require('../../lib/review-template-media');

test('review templates require an image header when a photo is configured', () => {
  assert.equal(matchesReviewTemplateMedia({ hasImageHeader: false, hasPhoto: true }), false);
  assert.equal(matchesReviewTemplateMedia({ hasImageHeader: true, hasPhoto: true }), true);
});

test('review templates reject an image header when no photo is configured', () => {
  assert.equal(matchesReviewTemplateMedia({ hasImageHeader: true, hasPhoto: false }), false);
  assert.equal(matchesReviewTemplateMedia({ hasImageHeader: false, hasPhoto: false }), true);
});
