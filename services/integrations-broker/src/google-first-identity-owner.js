'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { canonical } = require('./canonical');
const { BrokerError, fail } = require('./errors');
const { requiredScopesFor } = require('./google-first-identity-provider');

const hash = value => createHash('sha256').update(value).digest('hex');
const ATTEMPT_LIMIT = 128;
const IN_FLIGHT_LIMIT = 8;
const TIMEOUT_MS = 8000;

function scopeOf(owner, proof) {
  const prefix = `google-oauth:${proof.service}:`;
  if (!owner.assetRef.startsWith(prefix)) fail('scope_denied');
  return owner.assetRef.slice(prefix.length);
}

function redirect({ state, challenge, clientId, redirectUri, service }) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: requiredScopesFor(service).join(' '), access_type: 'offline', prompt: 'consent', state,
    code_challenge_method: 'S256', code_challenge: challenge });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

// Owner-only implementation of the signed first-authorization controls. The
// durable journal burns the exchange once before Provider receives the code.
// Neither finishing nor status promotes credentials or grants resource access.
function createFirstGoogleIdentityOwner({ journal, provider, vault, now = Date.now } = {}) {
  const memory = new Map(), inFlight = new Map();
  if (typeof now !== 'function' || !journal || !provider || !vault) fail('invalid_request');

  function discard(attemptId) {
    const held = memory.get(attemptId);
    if (!held) return;
    provider.discard(held.handle);
    memory.delete(attemptId);
  }

  function removeExpired() {
    const time = now();
    for (const [id, held] of memory) if (held.expiresAt <= time) discard(id);
  }

  function readbackPlan(proof, owner, saved) {
    const intent = saved.stageIntent;
    return { ...proof, scopeKey: scopeOf(owner, proof), slotDigest: intent.slotDigest, applicationVersion: saved.applicationVersion,
      version: intent.versionId, secretDigest: intent.digest, googleUserId: saved.metadata.googleUserId,
      clientId: saved.metadata.clientId, refreshTokenExpiresAt: saved.metadata.refreshTokenExpiresAt,
      baselineVersion: intent.baselineVersion, metadataDigest: intent.metadataDigest };
  }

  function receipt(intent, saved) {
    if (!saved || saved.version !== intent.versionId || saved.secretDigest !== intent.digest) fail('secret_unavailable');
    return { ...intent, status: 'staged', accessBlocked: true };
  }

  async function exclusive(proof, work) {
    removeExpired();
    const attemptId = proof.attemptId;
    if (inFlight.size >= IN_FLIGHT_LIMIT || inFlight.has(attemptId)) fail('oauth_flow_busy');
    const controller = new AbortController();
    inFlight.set(attemptId, controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try { return await work(controller.signal); }
    finally { clearTimeout(timer); inFlight.delete(attemptId); }
  }

  async function begin(proof, owner) {
    return exclusive(proof, async signal => {
      let replay;
      try { replay = journal.read(proof, owner); }
      catch (error) { if (!(error instanceof BrokerError) || error.code !== 'scope_denied') throw error; }
      if (replay) {
        const held = memory.get(proof.attemptId);
        if (replay.state === 'prepared' && held) return { ...replay, authorizationUrl: held.authorizationUrl };
        discard(proof.attemptId);
        if (replay.state === 'prepared') return journal.interrupt(proof, owner);
        return journal.expire(proof, owner);
      }
      if (memory.size >= ATTEMPT_LIMIT) fail('rate_limited');
      if (!Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now() || proof.expiresAt > now() + 600000) fail('oauth_flow_interrupted');
      const scopeKey = scopeOf(owner, proof);
      const state = randomBytes(32).toString('base64url');
      const verifier = Buffer.from(randomBytes(32).toString('base64url'), 'ascii');
      try {
        return await vault.withApplication({ scopeKey, service: proof.service }, app => {
          if (signal.aborted) fail('provider_timeout');
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const providerContextDigest = hash(canonical({ version: 1, attemptId: proof.attemptId, bindingDigest: proof.bindingDigest,
            service: proof.service, scopeKey, challenge, slotDigest: app.slotDigest, applicationVersion: app.applicationVersion,
            clientId: app.clientId, redirectUri: app.redirectUri }));
          const prepared = journal.prepare(proof, owner, { stateHash: hash(state), providerContextDigest,
            applicationVersion: app.applicationVersion, clientId: app.clientId });
          if (prepared.state !== 'prepared') return prepared;
          const handle = provider.prepareContext(proof, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: app.redirectUri, verifier });
          const authorizationUrl = redirect({ state, challenge, clientId: app.clientId, redirectUri: app.redirectUri, service: proof.service });
          memory.set(proof.attemptId, { handle, expiresAt: proof.expiresAt, applicationVersion: app.applicationVersion,
            slotDigest: app.slotDigest, providerContextDigest, authorizationUrl });
          return { ...prepared, authorizationUrl };
        }, { signal });
      } finally { verifier.fill(0); }
    });
  }

  async function finish(proof, owner, { state, code }) {
    return exclusive(proof, async signal => {
      const held = memory.get(proof.attemptId);
      if (!held) fail('oauth_flow_interrupted');
      const permit = journal.consume(proof, owner, { state, code, providerContextDigest: held.providerContextDigest });
      let candidate, metadata, stageIntent, saved;
      try {
        try {
          candidate = await provider.exchange(held.handle, { code, signal });
          metadata = provider.describe(candidate);
        } catch (error) {
          journal.exchangeFailed(permit);
          throw error;
        }
        const ready = journal.exchangeReady(permit, metadata);
        if (ready.state !== 'candidate_ready') return ready;
        const scopeKey = scopeOf(owner, proof);
        const bound = { ...proof, scopeKey, slotDigest: held.slotDigest, applicationVersion: held.applicationVersion };
        await provider.consume(candidate, async value => {
          saved = await vault.stage(bound, value, plan => {
            const intent = Object.freeze({ stageRequestId: randomUUID(), versionId: plan.version, digest: plan.secretDigest,
              slotDigest: plan.slotDigest, baselineVersion: plan.baselineVersion, metadataDigest: plan.metadataDigest });
            const stagedIntent = journal.commitStageIntent(proof, owner, intent);
            if (stagedIntent.state !== 'stage_intent') return false;
            stageIntent = intent;
            return true;
          }, { signal });
        });
        return journal.acceptStageReceipt(proof, owner, receipt(stageIntent, saved));
      } finally {
        if (candidate) provider.discard(candidate);
        discard(proof.attemptId);
      }
    });
  }

  async function status(proof, owner) {
    removeExpired();
    const saved = journal.expire(proof, owner);
    if (inFlight.has(proof.attemptId)) return saved;
    if (saved.state === 'stage_intent') return exclusive(proof, async signal => {
      const internal = journal.getPrivateState(proof, owner);
      let observed;
      try { observed = await vault.confirmStage(readbackPlan(proof, owner, internal), { signal }); }
      catch (error) {
        if (error instanceof BrokerError && error.code === 'secret_unavailable') return journal.read(proof, owner);
        throw error;
      }
      return journal.acceptStageReceipt(proof, owner, receipt(internal.stageIntent, observed));
    });
    if (['exchanging', 'candidate_ready'].includes(saved.state) || saved.state === 'prepared' && !memory.has(proof.attemptId)) {
      return journal.interrupt(proof, owner);
    }
    return saved;
  }

  function abort(proof, owner) {
    const aborted = journal.abort(proof, owner);
    inFlight.get(proof.attemptId)?.abort();
    discard(proof.attemptId);
    return aborted;
  }

  function close() {
    for (const controller of inFlight.values()) controller.abort();
    for (const id of memory.keys()) discard(id);
  }

  return Object.freeze({ begin, finish, status, abort, close });
}

module.exports = { createFirstGoogleIdentityOwner };
