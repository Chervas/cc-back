'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReviewGoogleLinkCopy } = require('../../lib/review-google-link-copy');
test('review link copy is translated without promising automatic publication or changing URL/team', () => {
  for (const locale of ['es_ES', 'ca', 'en_US']) {
    const body = buildReviewGoogleLinkCopy({ url: 'https://qa.invalid/review', team: 'TESTONLY', locale });
    assert(body.includes('https://qa.invalid/review')); assert(body.includes('TESTONLY'));
    assert(!body.includes('se publicará')); assert(!body.includes('🙏🙏')); assert(!body.includes('{{'));
  }
  assert(buildReviewGoogleLinkCopy({ url: 'https://qa.invalid/review' }).startsWith('*¿Puedes pinchar aquí para publicar tu opinión en Google?*'));
});
