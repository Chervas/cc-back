'use strict';

const { createHash } = require('node:crypto');
const contracts = require('./contracts');
const { authenticate, authorize } = require('./auth');
const { eventFor } = require('./audit');
const { OPERATIONS } = require('./operations');
const { BrokerError, fail } = require('./errors');
const { validatePolicy } = require('./policy');
const aiLimits = require('./ai-limits');
const emailLimits = require('./email-limits');
const publicMediaLimits = require('./public-media-limits');

const { canonical } = require('./canonical');
const { canonicalDigest } = require('./canonical-digest');
class Broker {
  constructor({ store, policy, secrets, operations = OPERATIONS, adsEnrollment, policyResolver, now = () => Date.now(), timeoutMs = 10000, transportProfile = 'default' }) {
    if (!['default', 'ai', 'email', 'public-media'].includes(transportProfile)
      || transportProfile === 'ai' && Object.keys(operations).some(op => !aiLimits.isAiOperation(op))
      || transportProfile === 'email' && Object.keys(operations).some(op => !emailLimits.isEmailOperation(op))
      || transportProfile === 'public-media' && Object.keys(operations).some(op => !publicMediaLimits.isPublicMediaOperation(op))) fail('invalid_request');
    this.store = store; this.policy = structuredClone(validatePolicy(policy)); this.secrets = secrets;
    this.transportProfile = transportProfile;
    this.maxRequestBytes = transportProfile === 'ai' ? aiLimits.MAX_REQUEST_BYTES
      : transportProfile === 'email' ? emailLimits.MAX_REQUEST_BYTES
        : transportProfile === 'public-media' ? publicMediaLimits.MAX_REQUEST_BYTES : 32768;
    this.operations = operations; this.adsEnrollment = adsEnrollment; this.policyResolver = policyResolver; this.now = now;
    this.timeoutMs = Math.min(transportProfile === 'ai' ? aiLimits.MAX_TIMEOUT_MS : 30000, Math.max(1, timeoutMs));
    this.active = new Map(); this.activeAssets = new Map();
    for (const item of policy.connections) {
      // Main program forbids real active cohorts until their adapter and approval exist.
      store.seedConnection(item.connectionRef, { state: item.initialState || 'blocked', expiresAt: item.expiresAt ?? null });
    }
  }
  async execute(raw, headers) {
    if (!Buffer.isBuffer(raw) || raw.length > this.maxRequestBytes) fail('invalid_request');
    let request;
    try { request = contracts.request(JSON.parse(raw.toString('utf8'))); }
    catch { fail('invalid_request'); }
    const now = this.now();
    const principal = authenticate(raw, headers, request, this.policy, now);
    this.store.acceptNonce(principal.id, request.nonce, now, Math.min(600, Math.max(1, principal.maxPerMinute || 60)));
    let operation; let binding; let resolved = this.policy;
    try {
      resolved = this.policyResolver?.resolve(request, principal, this.policy) || this.adsEnrollment?.resolve(request, principal, this.policy) || this.policy;
      authorize(principal, request, resolved);
      operation = this.operations[request.operation];
      if (!operation || !Object.hasOwn(this.operations, request.operation)) fail('operation_denied');
      binding = resolved.connections.find(item => item.connectionRef === request.connectionRef);
      if (!binding || binding.provider !== operation.provider) fail('scope_denied');
      operation.validate(request.payload);
      operation.authorize?.({ request, binding, principal });
      this.adsEnrollment?.assert(request, principal, this.policy);
      if (!['revoke_asset','google_oauth','whatsapp_onboarding','meta_marketing_oauth','google_ads_enrollment_status','google_ads_enrollment_revoke'].includes(operation.control)) {
        this.store.connection(request.connectionRef, now);
        this.store.assertAssetActive(request);
      }
    } catch (error) {
      // Authenticated denials contain only validated IDs and fixed reason codes.
      const knownGrant = this.policy.grants.find(item => item.principalId === principal.id && item.tenantRef === request.tenantRef
        && item.assetRef === request.assetRef && item.connectionRef === request.connectionRef);
      const safeRequest = knownGrant ? request : { ...request, tenantRef: 'unassigned', assetRef: 'unassigned' };
      if (this.store.backlog().pending < this.policy.maxBacklog) this.store.appendAudit(eventFor(safeRequest, principal, this.policy,
        'integration.denied', 'denied', error instanceof BrokerError ? error.code : 'invalid_request', now));
      throw error;
    }
    const identity = { operation: request.operation, tenantRef: request.tenantRef,
      connectionRef: request.connectionRef, assetRef: request.assetRef, payload: request.payload };
    const digest = ['ai', 'public-media'].includes(this.transportProfile) ? canonicalDigest(identity)
      : createHash('sha256').update(canonical(identity)).digest('hex');
    const assetKey = JSON.stringify([request.tenantRef, request.connectionRef, request.assetRef]);
    if (['google_oauth', 'whatsapp_onboarding', 'meta_marketing_oauth'].includes(operation.control)) {
      try { return await operation.execute({ request, principal, binding, policy: this.policy }); }
      catch (error) {
        if (this.store.backlog().pending >= this.policy.maxBacklog) fail('audit_unavailable');
        this.store.appendAudit(eventFor(request, principal, resolved, 'integration.failed', 'unknown',
          error instanceof BrokerError ? error.code : 'internal_error', this.now()));
        throw error;
      }
    }
    if (operation.control === 'revoke_asset') {
      const result = this.store.revokeAsset(principal.id, request, digest,
        eventFor(request, principal, resolved, 'integration.requested', 'accepted', 'authorized', now),
        eventFor(request, principal, resolved, 'asset.revoked', 'success', 'scope_disconnected', now), this.policy.maxBacklog, now,
        () => operation.commitRevocation?.({ request, binding, now }));
      for (const controller of this.activeAssets.get(assetKey) || []) controller.abort();
      operation.onRevoked?.(request);
      return result;
    }
    const cached = this.store.reserve(principal.id, request.requestId, digest,
      eventFor(request, principal, resolved, 'integration.requested', 'accepted', 'authorized', now), this.policy.maxBacklog, now);
    if (cached) return { ...cached, replayed: true };
    const metadataOnly = ['google_ads_enrollment_status','google_ads_enrollment_revoke'].includes(operation.control) && operation.secretless === true;
    const revision = metadataOnly ? null : this.store.connection(request.connectionRef, now).revision;
    const controller = new AbortController();
    const active = this.active.get(request.connectionRef) || new Set(); active.add(controller); this.active.set(request.connectionRef, active);
    const activeAsset = this.activeAssets.get(assetKey) || new Set(); activeAsset.add(controller); this.activeAssets.set(assetKey, activeAsset);
    let timer; let revoked = false;
    const onRevoked = () => {
      if (!revoked) {
        this.block(request.connectionRef, eventFor(request, principal, resolved, 'connection.blocked', 'success', 'credential_revoked', this.now()), 'revoked');
        revoked = true;
      }
    };
    try {
      const assertActive = () => {
        if (controller.signal.aborted) fail('provider_timeout');
        if (!metadataOnly) {
          if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
          this.store.assertAssetActive(request);
        }
        this.adsEnrollment?.assert(request, principal, this.policy);
      };
      const execute = async secret => {
        assertActive();
        const rawResult = await operation.execute({ requestId: request.requestId, payload: request.payload, binding, assetRef: request.assetRef,
          tenantRef: request.tenantRef, principalId: principal.id, policyVersion: this.policy.version, policy: this.policy, secret, signal: controller.signal, assertActive });
        if (controller.signal.aborted) fail('provider_timeout');
        // Recheck after awaits, including blocks written by a separate local operator process.
        if (!metadataOnly) {
          if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
          this.store.assertAssetActive(request);
        }
        this.adsEnrollment?.assert(request, principal, this.policy);
        const data = operation.project(rawResult);
        if (secret && JSON.stringify(data).includes(secret.toString('utf8'))) fail('provider_failed');
        return data;
      };
      // GBP receipts need no provider credential. Unlike enrollment controls,
      // they still require the active connection revision and asset throughout.
      const receiptOnly = operation.control === 'google_business_profile_status' && operation.secretless === true;
      const work = metadataOnly || receiptOnly || operation.secretless === true ? execute(null) : this.secrets.withSecret(binding, execute,
        { signal: controller.signal, onRevoked, requiredScopes: operation.requiredScopes });
      const data = await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BrokerError('provider_timeout')); }, this.timeoutMs);
      })]);
      if (controller.signal.aborted) fail('provider_timeout');
      if (!metadataOnly) {
        if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
        this.store.assertAssetActive(request);
      }
      this.adsEnrollment?.assert(request, principal, this.policy);
      const result = { requestId: request.requestId, data, replayed: false };
      const completedAudit = operation.completionAudit?.(data) || ['integration.completed', 'success', 'completed'];
      this.store.complete(principal.id, request.requestId, result,
        eventFor(request, principal, resolved, ...completedAudit, this.now()),
        { persistResult: operation.persistResult !== false, mutate: () => {
          // The final check shares the SQLite write lock with any enrollment,
          // receipt and audit changes, including revocations by another process.
          if (!metadataOnly) {
            if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
            this.store.assertAssetActive(request);
          }
          this.adsEnrollment?.assert(request, principal, this.policy);
          operation.commit?.({ request, principal, policy: this.policy, result });
        } });
      return result;
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : 'provider_failed';
      if (code === 'credential_revoked') onRevoked();
      if (code === 'provider_unauthorized') this.secrets.invalidate(request.connectionRef);
      this.store.uncertain(principal.id, request.requestId,
        eventFor(request, principal, resolved, 'integration.failed', 'unknown', code, this.now()));
      fail(code);
    } finally {
      clearTimeout(timer); active.delete(controller); if (!active.size) this.active.delete(request.connectionRef);
      activeAsset.delete(controller); if (!activeAsset.size) this.activeAssets.delete(assetKey);
    }
  }
  block(ref, event, state = 'blocked') {
    this.store.block(ref, event, state);
    this.secrets.invalidate(ref);
    for (const controller of this.active.get(ref) || []) controller.abort();
  }
}
module.exports = { Broker, canonical };
