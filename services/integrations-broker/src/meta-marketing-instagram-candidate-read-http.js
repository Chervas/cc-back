'use strict';

const { createHmac } = require('node:crypto');
const { fail } = require('./errors');
const C = require('./meta-marketing-oauth-contract');
const D = require('./meta-marketing-discovery-contract');
const M = require('./meta-marketing-contract');
const E = require('./meta-marketing-enrollment-contract');
const { assetSetDigest } = require('./meta-marketing-credential-renewal-contract');
const { extendInstagramSelection } = require('./meta-marketing-instagram-selection');
const { createMetaMarketingHttp } = require('./meta-marketing-http');
const { safeError } = require('./meta-marketing-graph-pacing');
const { tokenText } = require('./whatsapp-secrets');

function candidateAuthority(authority, binding, candidate, input, now) {
  const { row, binding: active, assets, credential } = authority || {};
  const scopeKey = 'clinic:' + input.clinicId;
  if (row?.state !== 'active' || row.id !== input.enrollmentId || row.tenant !== scopeKey
      || row.scope !== 'meta-enroll:' + scopeKey || !active || row.connection !== active.connectionRef
      || active.connectionRef !== binding.connectionRef || active.secretArn === binding.secretArn) fail('scope_denied');
  const current = C.bindingFor(active);
  const proposed = C.bindingFor(binding);
  const required = [...new Set([...current.scopes, 'instagram_basic'])].sort();
  if (current.scopeKey !== scopeKey || proposed.scopeKey !== scopeKey || proposed.appId !== current.appId
      || proposed.appVersionId !== current.appVersionId || binding.clientSecretArn !== active.clientSecretArn
      || proposed.redirectUri !== current.redirectUri || binding.expiresAt <= now
      || JSON.stringify([...proposed.scopes].sort()) !== JSON.stringify(required)) fail('scope_denied');
  if (!credential || !Number.isSafeInteger(credential.epoch) || credential.epoch < 0
      || !C.uuid(credential.versionId) || !/^[a-f0-9]{64}$/.test(credential.digest)
      || C.metadata(credential.metadata, active).subjectId !== candidate.subjectId) fail('scope_denied');
  const selected = E.assets(assets);
  if (assetSetDigest(selected) !== input.expectedAssetSetDigest
      || !selected.some(asset => asset.kind === 'facebook_page' && asset.id === input.parentPageId)) fail('scope_denied');
  return {
    scopeKey, selected,
    pin: C.hash(JSON.stringify([row.id, C.fingerprint(active), C.fingerprint(binding),
      credential.epoch, credential.versionId, credential.digest])),
  };
}

// The future Owner operation supplies its local authority in authorize().
// This reader neither creates a consent request nor activates a candidate.
function createMetaMarketingInstagramCandidateReadHttp({ request, timeoutMs, now = Date.now, pacer } = {}) {
  return async input => {
    const { binding, metadata, token, appSecret, enrollmentId, clinicId, parentPageId, expectedAssetSetDigest, signal, authorize } = input || {};
    if (!C.uuid(enrollmentId) || !Number.isSafeInteger(clinicId) || clinicId <= 0 || !M.graphId(parentPageId)
        || !/^[a-f0-9]{64}$/.test(expectedAssetSetDigest) || typeof authorize !== 'function' || !(signal instanceof AbortSignal)
        || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8'))
        || !Buffer.isBuffer(appSecret) || !/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))) fail('invalid_request');
    const candidate = C.metadata(metadata, binding);
    const target = { enrollmentId, clinicId, parentPageId, expectedAssetSetDigest };
    const initial = candidateAuthority(authorize(), binding, candidate, target, now());
    const parent = { kind: 'instagram_business', parentPageId };
    const check = () => {
      if (signal.aborted) fail('provider_timeout');
      if (candidateAuthority(authorize(), binding, candidate, target, now()).pin !== initial.pin) fail('scope_denied');
    };
    check();
    M.assertAssetCredential(candidate, parent);
    const graph = createMetaMarketingHttp({ request, timeoutMs, pacer, now, authorize: check, appId: candidate.appId, graphVersion: M.GRAPH_VERSION });
    const ownedToken = Buffer.from(token);
    const ownedApp = Buffer.from(appSecret);
    const appToken = Buffer.concat([Buffer.from(candidate.appId + '|'), ownedApp]);
    const wipe = () => { ownedToken.fill(0); ownedApp.fill(0); appToken.fill(0); };
    signal.addEventListener('abort', wipe, { once: true });
    try {
      const verify = async () => {
        check();
        const raw = await graph({ action: 'inspect', id: candidate.appId, token: appToken, candidate: ownedToken, signal });
        check();
        const fresh = D.fresh(raw, binding, candidate, now());
        M.assertAssetCredential(fresh, parent);
        return fresh;
      };
      const observedBefore = await verify();
      const proof = createHmac('sha256', ownedApp).update(ownedToken).digest('hex');
      const fetch = (action, id) => graph({ action, id, token: ownedToken, proof, signal });
      const page = await fetch('instagram_parent', parentPageId);
      check();
      if (page.id !== parentPageId) fail('scope_denied');
      const linked = page.instagram_business_account;
      if (linked == null) {
        await verify();
        return null;
      }
      if (!C.exact(linked, 'id') || !M.graphId(linked.id)) fail('provider_failed');
      const proposal = extendInstagramSelection({ scopeKey: initial.scopeKey, selected: initial.selected,
        expectedAssetSetDigest, parentPageId, instagramId: linked.id });
      const raw = await fetch('instagram_profile', linked.id);
      check();
      const profile = M.projectAsset(raw, proposal.asset);
      const avatarUrl = D.assetAvatarUrl(raw.profile_picture_url);
      if (avatarUrl) profile.avatarUrl = avatarUrl;
      const observedAfter = await verify();
      const expiry = Math.min(binding.expiresAt, ...[observedBefore, observedAfter]
        .flatMap(observation => [observation.expiresAt, observation.dataAccessExpiresAt]).filter(deadline => deadline !== null));
      if (expiry <= now()) fail('credential_revoked');
      const result = { ...proposal, profile, expiry };
      let serialized = JSON.stringify(result);
      for (;;) {
        if ([ownedToken.toString('utf8'), ownedApp.toString('ascii'), proof].some(secret => serialized.includes(secret))) fail('provider_failed');
        // Credentials are ASCII. Decode byte escapes independently so a
        // literal percent in a display name cannot hide an escaped credential
        // elsewhere in the result. Every successful pass shortens the input.
        const decoded = serialized.replace(/%[a-f0-9]{2}/gi, escaped => String.fromCharCode(Number.parseInt(escaped.slice(1), 16)));
        if (decoded === serialized) break;
        serialized = decoded;
      }
      return result;
    } catch (error) {
      throw safeError(error);
    } finally {
      signal.removeEventListener('abort', wipe);
      wipe();
    }
  };
}

module.exports = { createMetaMarketingInstagramCandidateReadHttp };
