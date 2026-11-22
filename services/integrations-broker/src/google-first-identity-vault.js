'use strict';

const { fail } = require('./errors');
const { createGoogleOAuthSecrets, digest, subject, token } = require('./google-oauth-secrets');
const { bindingFor } = require('./google-oauth-contract');
const { canonical } = require('./canonical');
const { SERVICES, requiredScopesFor } = require('./google-first-identity-provider');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^(clinic|group):[1-9][0-9]{0,9}$/;
const VERSION_ID = /^[A-Za-z0-9-]{32,64}$/;
const proofKeys = 'attemptId,bindingDigest,service,scopeKey,expiresAt,slotDigest,applicationVersion';
const planKeys = proofKeys + ',version,secretDigest,googleUserId,clientId,refreshTokenExpiresAt,baselineVersion,metadataDigest';
const metadataKeys = 'version,attemptId,bindingDigest,service,provider,googleUserId,clientId,scopes,observedAt,accessExpiresAt,refreshTokenExpiresAt,connected,authorizationConfirmed';

function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
}

function sameScopes(scopes, expected) {
  return Array.isArray(scopes) && scopes.length === expected.length && scopes.every((value, index) => value === expected[index]);
}

function ttl(value) { return Number.isSafeInteger(value) && value > 0; }
function isTyped(value, pattern) { return typeof value === 'string' && pattern.test(value); }

// The Owner resolves the slot from its own exact configuration. Only this
// module and the broker-owned provider helper ever handle refresh material.
function createFirstGoogleCredentialVault({ client, accountId, prefix, kmsKeyArn, redirectUri, slots, now = Date.now }) {
  const secrets = createGoogleOAuthSecrets({ client, accountId, prefix, kmsKeyArn });
  if (!Array.isArray(slots) || slots.length > 10000 || typeof now !== 'function' || typeof client?.send !== 'function') fail('invalid_request');
  const arnPrefix = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  const targets = new Map(), targetArns = new Set(), applicationArns = new Set();
  let redirect;
  try { redirect = new URL(redirectUri); } catch { fail('invalid_request'); }
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
    || redirect.port || redirect.pathname !== '/oauth/google/callback' || redirect.href !== redirectUri) fail('invalid_request');

  function arnSuffix(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(arnPrefix) || raw.length > 2048) fail('invalid_request');
    const suffix = raw.slice(arnPrefix.length);
    if (!/^[A-Za-z0-9/_+=.@-]+$/.test(suffix) || suffix.split('/').some(segment => !segment || segment === '..' || segment === '.')) fail('invalid_request');
    return suffix;
  }

  for (const item of slots) {
    if (!exact(item, 'scopeKey,service,secretArn,clientSecretArn,baselineVersion') || !isTyped(item.scopeKey, SCOPE)
      || !SERVICES.includes(item.service) || !isTyped(item.baselineVersion, VERSION_ID)) fail('invalid_request');
    const scopeName = item.scopeKey.replace(':', '-');
    const namespace = 'google-first/' + item.service + '/' + scopeName + '-';
    const name = arnSuffix(item.secretArn);
    if (!name.startsWith(namespace) || !/^[A-Za-z0-9]{6}$/.test(name.slice(namespace.length))
      || item.clientSecretArn === item.secretArn || targets.has(item.scopeKey + '/' + item.service)
      || targetArns.has(item.secretArn)) fail('invalid_request');
    arnSuffix(item.clientSecretArn);
    const connectionRef = 'google-first:' + item.service + ':' + item.scopeKey;
    const slotDigest = digest(JSON.stringify(['clinicaclick/google-first-slot/1', item.scopeKey, item.service,
      connectionRef, item.secretArn, item.clientSecretArn, item.baselineVersion, kmsKeyArn, redirectUri]));
    targetArns.add(item.secretArn);
    applicationArns.add(item.clientSecretArn);
    targets.set(item.scopeKey + '/' + item.service, Object.freeze({ ...item, connectionRef, slotDigest }));
  }
  if ([...targetArns].some(arn => applicationArns.has(arn))) fail('invalid_request');

  function targetFor({ scopeKey, service }) {
    if (!isTyped(scopeKey, SCOPE) || !SERVICES.includes(service)) fail('invalid_request');
    const result = targets.get(scopeKey + '/' + service);
    if (!result) fail('scope_denied');
    return result;
  }

  function checked(value, keys) {
    if (!exact(value, keys) || !isTyped(value.attemptId, UUID) || !isTyped(value.bindingDigest, HASH)
      || !isTyped(value.slotDigest, HASH) || !isTyped(value.applicationVersion, VERSION_ID) || !ttl(value.expiresAt)) fail('invalid_request');
    const slot = targetFor(value);
    if (slot.slotDigest !== value.slotDigest) fail('scope_denied');
    return slot;
  }

  function assertLive(value, signal) {
    const time = now();
    if (!ttl(time) || signal?.aborted || value.expiresAt <= time
      || value.refreshTokenExpiresAt != null && value.refreshTokenExpiresAt <= time) fail('oauth_flow_interrupted');
  }

  function credentialBinding(slot, googleUserId) {
    return bindingFor({ connectionRef: slot.connectionRef, secretArn: slot.secretArn, clientSecretArn: slot.clientSecretArn,
      provider: 'google_' + slot.service, googleSubject: googleUserId,
      oauth: { subject: googleUserId, redirectUri, scopes: requiredScopesFor(slot.service) } });
  }

  async function checkedApplication(slot, value, signal) {
    const app = await secrets.application(slot, signal);
    if (app.secretVersion !== value.applicationVersion || app.clientId !== value.clientId) fail('secret_version_changed');
    return app;
  }

  async function withApplication(key, run, { signal } = {}) {
    if (!exact(key, 'scopeKey,service') || typeof run !== 'function') fail('invalid_request');
    const slot = targetFor(key);
    await secrets.assertFirstSlot(slot, slot, signal);
    const app = await secrets.application(slot, signal);
    if (!isTyped(app.secretVersion, VERSION_ID)) fail('secret_unavailable');
    const clientSecret = Buffer.from(app.clientSecret, 'utf8');
    try {
      return await run({ clientId: app.clientId, clientSecret, redirectUri, applicationVersion: app.secretVersion, slotDigest: slot.slotDigest });
    } finally { clientSecret.fill(0); }
  }

  function readPlan(plan) {
    const slot = checked(plan, planKeys);
    if (plan.version !== plan.attemptId || !isTyped(plan.secretDigest, HASH) || !subject(plan.googleUserId) || !token(plan.clientId)
      || !(plan.refreshTokenExpiresAt === null || ttl(plan.refreshTokenExpiresAt)) || !isTyped(plan.metadataDigest, HASH)
      || plan.baselineVersion !== slot.baselineVersion) fail('invalid_request');
    return slot;
  }

  function stagedReceipt(plan) { return { version: plan.version, secretDigest: plan.secretDigest }; }

  async function confirmCandidate(plan, currentOnly, signal) {
    plan = Object.freeze({ ...plan });
    const slot = readPlan(plan), binding = credentialBinding(slot, plan.googleUserId);
    const candidate = await secrets.candidate(binding, plan.version, plan.secretDigest, signal, { currentOnly });
    if (!candidate.stages.some(stage => stage === 'AWSPENDING' || stage === 'AWSCURRENT')
      || candidate.value?.clientId !== plan.clientId || !sameScopes(candidate.value.scopes, binding.oauth.scopes)
      || secrets.encode(binding, plan.clientId, candidate.value).digest !== plan.secretDigest) fail('secret_unavailable');
    return stagedReceipt(plan);
  }

  function confirmStage(plan, { signal } = {}) { return confirmCandidate(plan, false, signal); }
  function confirmActivation(plan, { signal } = {}) { return confirmCandidate(plan, true, signal); }

  // First-only private access. Never loads AWSCURRENT as a fallback, returns a
  // provider token, or accepts a consumer ARN. The exact intent version/body is
  // anchored to the configured slot and original authenticated metadata.
  async function withCandidate(plan, run, { signal, assertActive } = {}) {
    plan = Object.freeze({ ...plan });
    const slot = readPlan(plan), binding = credentialBinding(slot, plan.googleUserId);
    if (typeof run !== 'function' || typeof assertActive !== 'function') fail('invalid_request');
    const active = async () => {
      assertLive(plan, signal);
      if (await assertActive() !== true) fail('scope_denied');
      assertLive(plan, signal);
    };
    const position = async () => {
      try { await secrets.assertFirstSlot(slot, slot, signal); }
      catch (error) {
        if (!['secret_version_changed', 'secret_unavailable'].includes(error?.code)) throw error;
        // A legitimately promoted exact candidate is also usable, but an
        // unrelated new current version cannot inherit this first authority.
        await confirmActivation(plan, { signal });
      }
      await active();
    };
    let clientSecret, refreshToken;
    try {
      await active();
      const app = await checkedApplication(slot, plan, signal);await active();
      await position();
      const candidate = await secrets.candidate(binding, plan.version, plan.secretDigest, signal);await active();
      if (!candidate.stages.some(stage => stage === 'AWSPENDING' || stage === 'AWSCURRENT')
        || candidate.value?.clientId !== plan.clientId || candidate.value?.googleUserId !== plan.googleUserId
        || !sameScopes(candidate.value?.scopes, binding.oauth.scopes)
        || secrets.encode(binding, plan.clientId, candidate.value).digest !== plan.secretDigest) fail('secret_unavailable');
      clientSecret = Buffer.from(app.clientSecret);refreshToken = Buffer.from(candidate.value.refreshToken);
      // The return value is deliberately discarded, matching Provider.consume.
      await run(Object.freeze({ clientId: app.clientId, clientSecret, refreshToken, googleUserId: plan.googleUserId,
        scopes: Object.freeze([...binding.oauth.scopes]) }));
      await active();await checkedApplication(slot, plan, signal);await active();
      await position();await confirmStage(plan, { signal });await active();
    } finally { clientSecret?.fill(0);refreshToken?.fill(0); }
  }

  async function stage(proof, { metadata, refreshToken }, commitStageIntent, { signal } = {}) {
    const slot = checked(proof, proofKeys);
    proof = { ...proof };
    assertLive(proof, signal);
    const allowedScopes = requiredScopesFor(proof.service);
    if (typeof commitStageIntent !== 'function' || !exact(metadata, metadataKeys) || metadata.version !== 1
      || metadata.attemptId !== proof.attemptId || metadata.bindingDigest !== proof.bindingDigest
      || metadata.service !== proof.service || metadata.provider !== 'google_' + proof.service
      || metadata.connected !== false || metadata.authorizationConfirmed !== false
      || !subject(metadata.googleUserId) || !token(metadata.clientId) || !sameScopes(metadata.scopes, allowedScopes)
      || !ttl(metadata.observedAt) || !ttl(metadata.accessExpiresAt) || metadata.observedAt > now()
      || metadata.accessExpiresAt <= now() || !(metadata.refreshTokenExpiresAt === null || ttl(metadata.refreshTokenExpiresAt))
      || !Buffer.isBuffer(refreshToken) || !token(refreshToken.toString('utf8'))) fail('invalid_request');
    const binding = credentialBinding(slot, metadata.googleUserId), encoded = secrets.encode(binding, metadata.clientId, {
      version: 3, provider: metadata.provider, connectionRef: slot.connectionRef, googleUserId: metadata.googleUserId,
      clientId: metadata.clientId, refreshToken: refreshToken.toString('utf8'), scopes: allowedScopes,
    });
    const canonicalMetadata = Object.fromEntries(metadataKeys.split(',').map(key => [key, metadata[key]]));
    const plan = Object.freeze({ ...proof, version: proof.attemptId, secretDigest: encoded.digest, baselineVersion: slot.baselineVersion,
      metadataDigest: digest(canonical(canonicalMetadata)), googleUserId: metadata.googleUserId, clientId: metadata.clientId,
      refreshTokenExpiresAt: metadata.refreshTokenExpiresAt });
    assertLive(plan, signal);
    await checkedApplication(slot, plan, signal);
    await secrets.assertFirstSlot(slot, slot, signal);
    if (await commitStageIntent(plan) !== true) fail('oauth_flow_interrupted');
    // After the durable intent, check the slot again before dispatch. A lost
    // acknowledgement is recovered from the same version/digest via confirmStage.
    await checkedApplication(slot, plan, signal);
    await secrets.assertFirstSlot(slot, slot, signal);
    assertLive(plan, signal);
    await secrets.stage(binding, plan.version, encoded.body, signal);
    return confirmStage(plan, { signal });
  }

  async function activate(plan, commitActivationIntent, { signal } = {}) {
    plan = Object.freeze({ ...plan });
    const slot = readPlan(plan), binding = credentialBinding(slot, plan.googleUserId);
    if (typeof commitActivationIntent !== 'function') fail('invalid_request');
    assertLive(plan, signal);
    await checkedApplication(slot, plan, signal);
    await confirmStage(plan, { signal });
    if (await commitActivationIntent(plan) !== true) fail('oauth_flow_interrupted');
    await checkedApplication(slot, plan, signal);
    assertLive(plan, signal);
    // Reject moving a different current version. The normal renewal writer
    // verifies the candidate digest and sends the exact previous version to AWS.
    const activated = await secrets.activate(binding, plan.version, slot.baselineVersion, plan.secretDigest, signal);
    if (activated.version !== plan.version || activated.digest !== plan.secretDigest) fail('secret_unavailable');
    return stagedReceipt(plan);
  }

  return Object.freeze({ withApplication, withCandidate, stage, confirmStage, activate, confirmActivation });
}

module.exports = { createFirstGoogleCredentialVault };
