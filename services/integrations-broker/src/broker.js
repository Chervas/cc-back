'use strict';

const { createHash } = require('node:crypto');
const contracts = require('./contracts');
const { authenticate, authorize } = require('./auth');
const { eventFor } = require('./audit');
const { OPERATIONS } = require('./operations');
const { BrokerError, fail } = require('./errors');
const { validatePolicy } = require('./policy');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
class Broker {
  constructor({ store, policy, secrets, operations = OPERATIONS, now = () => Date.now(), timeoutMs = 10000 }) {
    this.store = store; this.policy = structuredClone(validatePolicy(policy)); this.secrets = secrets;
    this.operations = operations; this.now = now; this.timeoutMs = Math.min(30000, Math.max(1, timeoutMs));
    this.active = new Map();
    for (const item of policy.connections) {
      // Main program forbids real active cohorts until their adapter and approval exist.
      store.seedConnection(item.connectionRef, { state: item.initialState || 'blocked', expiresAt: item.expiresAt ?? null });
    }
  }
  async execute(raw, headers) {
    if (!Buffer.isBuffer(raw) || raw.length > 32768) fail('invalid_request');
    let request;
    try { request = contracts.request(JSON.parse(raw.toString('utf8'))); }
    catch { fail('invalid_request'); }
    const now = this.now();
    const principal = authenticate(raw, headers, request, this.policy, now);
    this.store.acceptNonce(principal.id, request.nonce, now, Math.min(600, Math.max(1, principal.maxPerMinute || 60)));
    let operation; let binding;
    try {
      authorize(principal, request, this.policy);
      operation = this.operations[request.operation];
      if (!operation || !Object.hasOwn(this.operations, request.operation)) fail('operation_denied');
      binding = this.policy.connections.find(item => item.connectionRef === request.connectionRef);
      if (!binding || binding.provider !== operation.provider) fail('scope_denied');
      operation.validate(request.payload);
      this.store.connection(request.connectionRef, now);
    } catch (error) {
      // Authenticated denials contain only validated IDs and fixed reason codes.
      const knownGrant = this.policy.grants.find(item => item.principalId === principal.id && item.tenantRef === request.tenantRef
        && item.assetRef === request.assetRef && item.connectionRef === request.connectionRef);
      const safeRequest = knownGrant ? request : { ...request, tenantRef: 'unassigned', assetRef: 'unassigned' };
      if (this.store.backlog().pending < this.policy.maxBacklog) this.store.appendAudit(eventFor(safeRequest, principal, this.policy,
        'integration.denied', 'denied', error instanceof BrokerError ? error.code : 'invalid_request', now));
      throw error;
    }
    const digest = createHash('sha256').update(canonical({ operation: request.operation, tenantRef: request.tenantRef,
      connectionRef: request.connectionRef, assetRef: request.assetRef, payload: request.payload })).digest('hex');
    const cached = this.store.reserve(principal.id, request.requestId, digest,
      eventFor(request, principal, this.policy, 'integration.requested', 'accepted', 'authorized', now), this.policy.maxBacklog, now);
    if (cached) return { ...cached, replayed: true };
    const revision = this.store.connection(request.connectionRef, now).revision;
    const controller = new AbortController();
    const active = this.active.get(request.connectionRef) || new Set(); active.add(controller); this.active.set(request.connectionRef, active);
    let timer;
    try {
      const work = this.secrets.withSecret(binding, async secret => {
        if (controller.signal.aborted) fail('provider_timeout');
        if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
        const rawResult = await operation.execute({ payload: request.payload, binding, assetRef: request.assetRef, secret, signal: controller.signal });
        if (controller.signal.aborted) fail('provider_timeout');
        // Recheck after awaits, including blocks written by a separate local operator process.
        if (this.store.connection(request.connectionRef, this.now()).revision !== revision) fail('connection_blocked');
        const data = operation.project(rawResult);
        if (JSON.stringify(data).includes(secret.toString('utf8'))) fail('provider_failed');
        return data;
      });
      const data = await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BrokerError('provider_timeout')); }, this.timeoutMs);
      })]);
      const result = { requestId: request.requestId, data, replayed: false };
      this.store.complete(principal.id, request.requestId, result,
        eventFor(request, principal, this.policy, 'integration.completed', 'success', 'completed', this.now()));
      return result;
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : 'provider_failed';
      this.store.uncertain(principal.id, request.requestId,
        eventFor(request, principal, this.policy, 'integration.failed', 'unknown', code, this.now()));
      fail(code);
    } finally { clearTimeout(timer); active.delete(controller); if (!active.size) this.active.delete(request.connectionRef); }
  }
  block(ref, event, state = 'blocked') {
    this.store.block(ref, event, state);
    this.secrets.invalidate(ref);
    for (const controller of this.active.get(ref) || []) controller.abort();
  }
}
module.exports = { Broker, canonical };
