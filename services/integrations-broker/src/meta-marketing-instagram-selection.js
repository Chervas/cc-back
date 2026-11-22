'use strict';

const { fail } = require('./errors');
const { scopeKey: isScopeKey } = require('./meta-marketing-admission-contract');
const { assets } = require('./meta-marketing-enrollment-contract');
const { assetSetDigest } = require('./meta-marketing-credential-renewal-contract');
const { graphId } = require('./meta-marketing-contract');

function extendInstagramSelection({ scopeKey, selected, expectedAssetSetDigest, parentPageId, instagramId }) {
  if (!isScopeKey(scopeKey) || !graphId(parentPageId) || !graphId(instagramId)
      || typeof expectedAssetSetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedAssetSetDigest)) fail('invalid_request');
  if (!scopeKey.startsWith('clinic:')) fail('scope_denied');

  const current = assets(selected);
  if (assetSetDigest(current) !== expectedAssetSetDigest) fail('idempotency_conflict');
  if (!current.some(asset => asset.kind === 'facebook_page' && asset.id === parentPageId)) fail('scope_denied');
  if (current.some(asset => asset.kind === 'instagram_business' && (asset.id === instagramId || asset.parentPageId === parentPageId))) {
    fail('idempotency_conflict');
  }

  const asset = { assetRef: 'meta-instagram_business:' + instagramId, kind: 'instagram_business', id: instagramId, parentPageId };
  const extended = assets([...current, asset]);
  return { asset, selected: extended, assetSetDigest: assetSetDigest(extended) };
}

module.exports = { extendInstagramSelection };
