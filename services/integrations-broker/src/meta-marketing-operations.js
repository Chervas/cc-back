'use strict';
const C = require('./meta-marketing-contract');
const { fail } = require('./errors');
function createMetaMarketingOperations({ http, secrets }) {
  const authorize = ({ request, binding }) => C.resource(binding, request.assetRef);
  const operations = Object.fromEntries(C.OPERATIONS.map(operation => [operation, Object.freeze({
    provider: C.PROVIDER, effect: 'read', persistResult: false,
    validate: payload => C.validate(operation, payload), authorize,
    async execute({ binding, assetRef, secret, signal, assertActive }) {
      const asset = C.resource(binding, assetRef), capability = secrets.capability(secret, binding.connectionRef);
      C.assertAssetCredential(capability.metadata, asset); assertActive();
      if (operation === C.STATUS) {
        const { appId, subjectId, tokenType, expiresAt, dataAccessExpiresAt, verifiedAt } = capability.metadata;
        return { credentialValid: true, appId, subjectId, tokenType, expiresAt, dataAccessExpiresAt, verifiedAt,
          requiredScopes: C.requiredScopes(asset.kind), assetAccessVerified: false };
      }
      if (asset.kind === 'instagram_business') {
        const parent = await http({ action: 'instagram_parent', id: asset.parentPageId, token: secret, proof: capability.proof, signal });
        if (parent?.error || parent?.id !== asset.parentPageId || parent.instagram_business_account?.id !== asset.id) fail('scope_denied');
        assertActive(); secrets.capability(secret, binding.connectionRef);
      }
      const raw = await http({ action: asset.kind, id: asset.id, token: secret, proof: capability.proof, signal });
      assertActive(); secrets.capability(secret, binding.connectionRef);
      return C.projectAsset(raw, asset);
    },
    project(value) { return value; },
  })]));
  return Object.freeze({ ...operations, [C.REVOKE]: Object.freeze({ provider: C.PROVIDER, control: 'revoke_asset',
    validate: payload => C.validate(C.REVOKE, payload), authorize }) });
}
module.exports = { createMetaMarketingOperations };
