'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const G = require('../../lib/clinical-gallery-contract');
test('classification has an explicit legacy unknown state, never guessed from image MIME or filename', () => {
  for (const metadata of [null, {}, { category: 'pruebas' }, { classification: 'before' }, { classification: 'photo-old' }]) assert.equal(G.originalClassification({ metadata, content_type: 'image/png', original_filename: 'Foto.jpg' }), 'unknown');
  assert.equal(G.originalClassification({ metadata: { classification: 'test' } }), 'test');
  assert.deepEqual(G.libraryItem({ metadata: { classification: 'photo' } }), { classification: 'photo', library_status: 'active', library_version: 1 });
  assert.deepEqual(G.libraryItem({ metadata: { classification: 'photo' } }, { classification: 'test', status: 'archived', version_number: 3 }), { classification: 'test', library_status: 'archived', library_version: 3 });
  for (const value of [undefined, null, 'unknown', '', 'Photo', { category: 'photo' }]) assert.throws(() => G.classification(value, true), { code: 'clinical_attachment_classification_required' });
});
test('pair sides accept only private original identities and an optional episode, not paths, remote URLs or client snapshot data', () => {
  assert.deepEqual(G.side({ asset_id: 'cpa_original', episode_id: 'episode-1' }), { asset_id: 'cpa_original', episode_id: 'episode-1' });
  for (const side of [{ asset_id: 'https://external/photo.jpg' }, { asset_id: '../private' }, { asset_id: 'cpa_1', title: 'untrusted' }, { asset_id: 'cpa_1', version: 4 }, { asset_id: 'cpa_1', episode_id: 10 }]) assert.throws(() => G.side(side));
  assert.throws(() => G.pairInput({ before: { asset_id: 'a' }, after: { asset_id: 'b' } }, true), { code: 'clinical_episode_idempotency_required' });
  assert.throws(() => G.pairInput({ treatment_id: 10 }), { code: 'clinical_photo_pair_scope_immutable' });
  assert.throws(() => G.expected({}), { statusCode: 428 });
  for (const value of [0, -1, true, '1junk']) assert.throws(() => G.expected({ expected_version: value }));
});
