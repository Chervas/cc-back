'use strict';
const { randomUUID } = require('node:crypto');
const { UUID } = require('../../services/platform-audit/src/event');
function createCapture({ repository, enabled = () => process.env.PLATFORM_AUDIT_REALTIME_ENABLED, now = () => new Date() }) {
  return { async run(actor, operation, work) {
    const flag = enabled(); if (![undefined, '', 'false', 'true'].includes(flag)) throw Error('realtime_unavailable');
    if (flag !== 'true') return work();
    const repo = typeof repository === 'function' ? repository() : repository;
    const health = await repo.health(now(), { includeUnresolved: false });
    if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) throw Error('realtime_unavailable');
    const base = { version: 5, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: now().toISOString(),
      ...operation, actor: { type: 'user', id: String(actor.userId) },
      sessionRef: actor.sessionVersion === 1 && typeof actor.jti === 'string' && UUID.test(actor.jti) ? actor.jti : null,
      stage: 'attempted', outcome: 'unknown', reason: 'request_received', clinicIds: [], authorizationPolicyVersion: 'realtime-scope-v1', capturePolicy: 'realtime-durable-v1' };
    await repo.append(base);
    let result;
    try { result = await work(); } catch {
      await repo.append({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed', outcome: 'error', reason: 'operation_unconfirmed' });
      throw Error('realtime_unavailable');
    }
    await repo.append({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed',
      outcome: result.allowed ? 'success' : 'denied', reason: result.allowed
        ? operation.action === 'realtime.subscribe' ? 'subscription_prepared' : 'packet_prepared' : result.invalid ? 'request_invalid' : 'access_denied',
      scope: result.scope || base.scope, clinicIds: result.allowed ? result.clinicIds.map(String) : [] });
    return result;
  } };
}
let instance;
module.exports = { createCapture, run(...args) {
  instance ||= createCapture({ repository: () => require('./platformAudit.repository').createRepository(require('../../models').PlatformAuditEvent) });
  return instance.run(...args);
} };
