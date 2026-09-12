'use strict';
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { ACTIONS, pack, fail } = require('../../services/platform-audit/src/event');
const NOOP = Object.freeze({ complete: async () => {} });
function createService({ repository, config = () => ({}), now = () => new Date() }) {
  return {
    async begin(req, action) {
      const settings = config();
      if (!settings.enabled) return NOOP;
      if (settings.policy !== 'auth-durable-v1' || !ACTIONS.has(action)) fail('audit_configuration_invalid');
      // Proposed admission thresholds, applicable ONLY to this auth cohort when its cut is approved.
      try {
        const health = await repository.health(now(), { includeUnresolved: false });
        if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) fail('audit_backlog_exceeded');
      } catch { fail('audit_unavailable'); }
      // Until the proxy chain has been verified, preserve the socket peer as such; never infer a client from headers.
      const ip = req.socket?.remoteAddress;
      const base = { version: 1, eventId: randomUUID(), occurredAt: now().toISOString(), correlationId: randomUUID(),
        action, stage: 'attempted', outcome: 'unknown', reason: 'started', actor: { type: 'anonymous', id: null },
        effectiveActor: null, sessionRef: null, scope: { type: 'platform', id: null }, resource: { type: 'session', id: null },
        capturePolicy: settings.policy, authorizationPolicyVersion: null, origin: { kind: 'direct_peer', ip: typeof ip === 'string' && isIP(ip) ? ip : null } };
      try { await repository.append(base); } catch { fail('audit_unavailable'); }
      const completedId = randomUUID(); let completed = null;
      return {
        async complete({ outcome, reason, userId = null, sessionRef = null }) {
          const value = pack({ ...base, eventId: completedId, occurredAt: completed?.event.occurredAt || now().toISOString(),
            stage: 'completed', outcome, reason, sessionRef,
            actor: userId === null ? { type: 'anonymous', id: null } : { type: 'user', id: String(userId) } });
          if (completed && completed.digest !== value.digest) fail('audit_event_conflict');
          // Preserve the same event/digest after an ambiguous local commit; retries may not invent another outcome.
          completed = value;
          try { await repository.append(value.event); } catch { fail('audit_unavailable'); }
        },
      };
    },
  };
}
let singleton;
module.exports = { createService,
  begin(req, action) {
    // Disabled mode does not import models, query the queue, read request fields or contact any AWS service.
    if (!process.env.PLATFORM_AUDIT_AUTH_ENABLED || process.env.PLATFORM_AUDIT_AUTH_ENABLED === 'false') return Promise.resolve(NOOP);
    if (process.env.PLATFORM_AUDIT_AUTH_ENABLED !== 'true') return Promise.reject(Object.assign(Error('audit_configuration_invalid'), { code: 'audit_configuration_invalid' }));
    singleton ||= createService({ repository: require('./platformAudit.repository').createRepository(require('../../models').PlatformAuditEvent),
      config: () => ({ enabled: true, policy: process.env.PLATFORM_AUDIT_AUTH_POLICY }) });
    return singleton.begin(req, action);
  },
};
