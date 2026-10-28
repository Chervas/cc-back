'use strict';
const { randomUUID } = require('node:crypto');
const context = require('../lib/delegationAuditContext');
const { delegationEvent } = require('../../services/platform-audit/src/delegation-event');
function unavailable() { throw Object.assign(Error('delegation_audit_unavailable'), { code: 'delegation_audit_unavailable', status: 503 }); }
function createService({ repository, enabled = () => process.env.PLATFORM_AUDIT_DELEGATION_ENABLED,
  contractVersion = () => process.env.PLATFORM_AUDIT_DELEGATION_CONTRACT_VERSION, now = () => new Date() }) {
  const httpAdmissions = new WeakMap();
  const repo = () => typeof repository === 'function' ? repository() : repository;
  async function assertReady({ transaction } = {}) {
    if (enabled() !== 'true' || contractVersion() !== '27') unavailable();
    try {
      const health = await context.suppress(() => repo().health(now(), { includeUnresolved: false, transaction }));
      if (!Number.isSafeInteger(health.pending) || health.pending < 0 || !Number.isSafeInteger(health.oldestAgeSeconds)
        || health.oldestAgeSeconds < 0 || health.pending >= 10000 || health.oldestAgeSeconds >= 3600) unavailable();
    } catch { unavailable(); }
  }
  function base(authDelegation, { correlationId = randomUUID(), requestCorrelationId = correlationId, emitter = null } = {}) {
    const d = context.normalize(authDelegation);
    return { version: 27, eventId: randomUUID(), correlationId, requestCorrelationId, occurredAt: now().toISOString(),
      action: null, stage: 'completed', outcome: 'success', reason: null,
      actor: emitter || { type: 'user', id: d.adminUserId }, effectiveActor: { type: 'user', id: d.effectiveUserId },
      adminUserId: d.adminUserId, sessionRef: d.childSessionRef, parentSessionRef: d.parentSessionRef,
      delegationId: d.delegationId, expiresAt: d.expiresAt, runtimeNamespace: d.runtimeNamespace,
      scope: { type: 'platform', id: null }, http: null, socket: null, job: null, sourceEvent: null, capturePolicy: 'delegated-session-durable-v1' };
  }
  async function append(event, options) {
    try { return await context.suppress(() => repo().append(delegationEvent(event), options)); } catch { unavailable(); }
  }
  async function lifecycle(input, { transaction } = {}) {
    await assertReady({ transaction });
    const d = Object.fromEntries(['delegationId', 'adminUserId', 'effectiveUserId', 'parentSessionRef', 'childSessionRef', 'expiresAt', 'runtimeNamespace'].map(k => [k, input[k]]));
    const event = { ...base(d, { correlationId: input.correlationId,
      emitter: input.action === 'delegation.expired' ? { type: 'job', id: 'auth_delegation_expiry' } : null }),
    action: input.action, reason: input.reason, ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}) };
    return append(event, { transaction });
  }
  async function admitHttp(req, res, next) {
    if (!req.authDelegation) return next();
    const d = context.normalize(req.authDelegation), existing = httpAdmissions.get(req);
    if (existing) {
      if (JSON.stringify(existing.delegation) !== JSON.stringify(d)) unavailable();
      return context.run(d, next, { requestCorrelationId: existing.correlationId });
    }
    await assertReady();
    const correlationId = randomUUID();
    // Closed mount labels plus Express's pattern distinguish modules without
    // storing any parameter value, query string or raw URL.
    const routes = require('../lib/delegationHttpRoute');
    const initialPrefix = routes.prefixFor(req);
    const routePattern = () => routes.routeFor(req, initialPrefix);
    const event = { ...base(d, { correlationId }), action: 'delegation.http', stage: 'attempted', outcome: 'unknown', reason: 'request_admitted',
      http: { method: String(req.method || '').toUpperCase(), route: routePattern(), status: null } };
    await append(event);
    httpAdmissions.set(req, { delegation: d, correlationId });
    let finished = false;
    const complete = async (closed = false) => {
      if (finished) return; finished = true;
      await append({ ...event, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed',
        outcome: closed ? 'unknown' : 'observed', reason: closed ? 'connection_closed' : 'http_response_observed',
        http: { ...event.http, route: routePattern(), status: closed ? null : res.statusCode } });
    };
    // Persist the observed response before end; an attempt remains durable even after a process crash.
    const end = res.end;
    res.end = function (...args) {
      const response = this;
      complete().then(() => end.apply(response, args)).catch(() => {
        if (!response.headersSent) { response.statusCode = 503; response.setHeader?.('Content-Type', 'application/json');
          response.removeHeader?.('Content-Length'); return end.call(response, JSON.stringify({
            error: 'delegated_response_unconfirmed', operationMayHaveCompleted: true,
          })); }
        response.destroy?.();
      });
      return response;
    };
    res.once?.('close', () => { if (!finished) complete(true).catch(() => {}); });
    return context.run(d, next, { requestCorrelationId: correlationId });
  }
  async function runJob(payload, job, work) {
    const restored = context.restoreJob(payload, job); if (!restored) return work(payload);
    await assertReady();
    const jobRef = String(job.jobRef), type = String(job.type), correlationId = randomUUID();
    const event = { ...base(restored.delegation, { correlationId, requestCorrelationId: restored.requestCorrelationId,
      emitter: { type: 'job', id: `${job.kind}:${jobRef}` } }), action: 'delegation.job', stage: 'attempted',
    outcome: 'unknown', reason: 'job_admitted', job: { kind: job.kind, type, jobRef, enqueueRef: restored.enqueueRef,
      attempt: Number(job.attempt || 0), result: null } };
    await append(event);
    return context.run(restored.delegation, async () => {
      let result;
      try { result = await work(context.cleanPayload(payload)); } catch (error) {
        await append({ ...event, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed', outcome: 'error', reason: 'job_handler_threw', job: { ...event.job, result: 'threw' } });
        throw error;
      }
      const status = ['waiting', 'completed', 'failed'].includes(result?.status) ? result.status : 'returned';
      await append({ ...event, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed', outcome: 'observed', reason: 'job_handler_returned', job: { ...event.job, result: status } });
      return result;
    }, { requestCorrelationId: restored.requestCorrelationId, emitter: event.actor });
  }
  async function admitSocket(socket, packet, next) {
    if (!socket.authDelegation) return next();
    await assertReady();
    const d = context.normalize(socket.authDelegation), correlationId = randomUUID();
    const rawEvent = Array.isArray(packet) ? packet[0] : null;
    const eventName = typeof rawEvent === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(rawEvent) ? rawEvent : 'unrecognized';
    await append({ ...base(d, { correlationId }), action: 'delegation.socket', outcome: 'observed', reason: 'packet_admitted',
      socket: { event: eventName } });
    return context.run(d, next, { requestCorrelationId: correlationId });
  }
  async function canonicalEvent(source, { transaction } = {}) {
    const active = context.current(); if (!active || source.version === 27) return;
    if (source.actor?.type === 'user' && source.actor.id !== active.delegation.effectiveUserId) unavailable();
    await assertReady({ transaction });
    const event = { ...base(active.delegation, { requestCorrelationId: active.requestCorrelationId, emitter: active.emitter }),
      action: 'delegation.canonical', outcome: 'observed', reason: 'canonical_event_recorded',
      sourceEvent: { eventId: source.eventId, correlationId: source.correlationId, version: source.version, action: source.action } };
    if (['clinic', 'group'].includes(source.scope?.type)) event.scope = { ...source.scope };
    return append(event, { transaction });
  }
  return { assertReady, lifecycle, admitHttp, admitSocket, runJob, canonicalEvent, base };
}
let singleton;
const service = () => singleton ||= createService({ repository: () => require('./platformAudit.repository').createRepository(require('../../models').PlatformAuditEvent) });
module.exports = { createService, assertReady: (...args) => service().assertReady(...args), lifecycle: (...args) => service().lifecycle(...args),
  admitHttp: (...args) => service().admitHttp(...args), runJob: (...args) => service().runJob(...args),
  admitSocket: (...args) => service().admitSocket(...args),
  canonicalEvent: (...args) => service().canonicalEvent(...args) };
