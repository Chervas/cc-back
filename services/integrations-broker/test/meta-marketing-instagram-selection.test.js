'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assetSetDigest } = require('../src/meta-marketing-credential-renewal-contract');
const { extendInstagramSelection } = require('../src/meta-marketing-instagram-selection');

const adAccount = Object.freeze({ assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null });
const facebookPage = Object.freeze({ assetRef: 'meta-facebook_page:401', kind: 'facebook_page', id: '401', parentPageId: null });
const selected = Object.freeze([facebookPage, adAccount]);
const input = Object.freeze({
  scopeKey: 'clinic:77', selected, expectedAssetSetDigest: assetSetDigest(selected), parentPageId: '401', instagramId: '501',
});

test('the proposal retains both existing assets and appends only the linked Instagram account', () => {
  const proposal = extendInstagramSelection(input);
  assert.deepEqual(proposal.asset, { assetRef: 'meta-instagram_business:501', kind: 'instagram_business', id: '501', parentPageId: '401' });
  assert.deepEqual(proposal.selected, [adAccount, facebookPage, proposal.asset]);
  assert.deepEqual(selected, [facebookPage, adAccount]);
  assert.equal(proposal.assetSetDigest, assetSetDigest(proposal.selected));
});

test('a group proposal preserves both pages and adds only the profile of the selected page', () => {
  const secondPage = { ...facebookPage, id: '402', assetRef: 'meta-facebook_page:402' };
  const current = [...selected, secondPage];
  const proposed = extendInstagramSelection({ ...input, scopeKey: 'group:28', selected: current,
    expectedAssetSetDigest: assetSetDigest(current), parentPageId: '402' });
  assert.equal(proposed.asset.parentPageId, '402');
  assert.deepEqual(proposed.selected.filter(asset => asset.kind !== 'instagram_business'), [adAccount, facebookPage, secondPage]);
});

test('rejects a page outside the grant or a stale selection for either scope', () => {
  for (const patch of [{ scopeKey: 'group:28', parentPageId: '402' }, { parentPageId: '402' }]) {
    assert.throws(() => extendInstagramSelection({ ...input, ...patch }), { code: 'scope_denied' });
  }
  for (const patch of [{ selected: [facebookPage] }, { expectedAssetSetDigest: 'a'.repeat(64) }]) {
    assert.throws(() => extendInstagramSelection({ ...input, ...patch }), { code: 'idempotency_conflict' });
  }
});

test('rejects implicit replacement and reuse of an Instagram account linked to another page', () => {
  for (const [instagramId, parentPageId] of [['502', '401'], ['501', '402']]) {
    const current = [...selected, { assetRef: 'meta-instagram_business:' + instagramId, kind: 'instagram_business', id: instagramId, parentPageId }];
    assert.throws(() => extendInstagramSelection({ ...input, selected: current, expectedAssetSetDigest: assetSetDigest(current) }),
      { code: 'idempotency_conflict' });
  }
});
