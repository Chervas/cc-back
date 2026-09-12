'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { UUID, unpack, receiptFor } = require('../../services/platform-audit/src/event');
const { criteriaFor, cursorCodec } = require('../../services/platform-audit/src/view-contract');
function fail(code, status) { throw Object.assign(Error(code), { code, status }); }
function createView({ model, audit, reader, codec, now = () => new Date() }) {
  async function page(criteria, state) {
    const replacements = { from: new Date(criteria.from + 'T00:00:00Z'), to: new Date(Date.parse(criteria.to) + 86400000),
      snapshot: new Date(state.snapshot), action: criteria.action, userId: criteria.userId, lastAt: state.lastAt && new Date(state.lastAt), lastId: state.lastId };
    const rows = await model.sequelize.query('SELECT /*+ MAX_EXECUTION_TIME(1500) */ event_id, occurred_at, body, digest, receipt '
      + 'FROM PlatformAuditEvents WHERE state=\'delivered\' AND delivered_at <= :snapshot AND occurred_at >= :from AND occurred_at < :to '
      + (criteria.action ? "AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.action'))=:action " : '')
      + (criteria.userId ? "AND (JSON_UNQUOTE(JSON_EXTRACT(body,'$.actor.id'))=:userId OR JSON_UNQUOTE(JSON_EXTRACT(body,'$.subjectUserId'))=:userId) " : '')
      + (state.lastAt ? 'AND (occurred_at < :lastAt OR (occurred_at = :lastAt AND event_id < :lastId)) ' : '')
      + 'ORDER BY occurred_at DESC,event_id DESC LIMIT 26', { replacements, type: model.sequelize.constructor.QueryTypes.SELECT, logging: false });
    return rows;
  }
  return {
    async read({ actorId, sessionRef, query }) {
      const denied = async (reason, code, status) => {
        try { await audit.append({ version: 3, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: now().toISOString(),
          action: 'audit.records.read', stage: 'completed', outcome: 'denied', reason, actor: { type: 'user', id: String(actorId) },
          sessionRef: typeof sessionRef === 'string' && UUID.test(sessionRef) ? sessionRef : null,
          scope: { type: 'platform', id: null }, criteria: null, resultCount: 0, resultDigest: null, capturePolicy: 'audit-view-v1' }); }
        catch { fail('audit_view_unavailable', 503); }
        fail(code, status);
      };
      if (!isGlobalAdmin(actorId)) return denied('access_denied', 'technical_admin_required', 403);
      if (typeof sessionRef !== 'string' || !UUID.test(sessionRef)) return denied('access_denied', 'managed_session_required', 403);
      let criteria; let state;
      try {
        if (!query || Object.keys(query).some(key => !['from', 'to', 'action', 'userId', 'cursor'].includes(key))) throw Error();
        criteria = criteriaFor({ from: query.from, to: query.to, action: query.action || null, userId: query.userId || null });
        state = query.cursor ? codec.open(query.cursor, String(actorId), sessionRef, criteria, now().getTime())
          : { actorId: String(actorId), sessionRef, criteria, snapshot: now().toISOString(), expiresAt: now().getTime() + 600000, lastAt: null, lastId: null };
      } catch { return denied('query_invalid', 'audit_query_invalid', 400); }
      const base = { version: 3, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: now().toISOString(),
        action: 'audit.records.read', stage: 'attempted', outcome: 'unknown', reason: 'query_requested',
        actor: { type: 'user', id: String(actorId) }, sessionRef, scope: { type: 'platform', id: null }, criteria,
        resultCount: null, resultDigest: null, capturePolicy: 'audit-view-v1' };
      try {
        const health = await audit.health(now(), { includeUnresolved: false });
        if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) throw Error();
        await audit.append(base);
      } catch { fail('audit_view_unavailable', 503); }
      let rows; let verified; let nextCursor;
      try {
        const indexed = await page(criteria, state); rows = indexed.slice(0, 25);
        const refs = rows.map(row => { unpack(row); return receiptFor(row, typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt); });
        const result = refs.length ? await reader.read({ requestId: base.correlationId, mode: 'confirmed', actorId: String(actorId), sessionRef, refs }) : { results: [] };
        if (result.results.length !== refs.length) throw Error('audit_integrity_invalid');
        verified = result.results.map((v, i) => {
          if (v.status !== 'verified') throw Object.assign(Error(v.error), { code: v.error });
          if (v.body !== rows[i].body || JSON.stringify(v.receipt) !== JSON.stringify(refs[i])) throw Object.assign(Error('audit_integrity_invalid'), { code: 'audit_integrity_invalid' });
          return unpack({ body: v.body, digest: refs[i].digest }).event;
        });
        const last = rows.at(-1); nextCursor = indexed.length > 25 ? codec.seal({ ...state, lastAt: new Date(last.occurred_at).toISOString(), lastId: last.event_id }) : null;
        await audit.append({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed', outcome: 'success',
          reason: 'records_verified', resultCount: verified.length, resultDigest: createHash('sha256').update(JSON.stringify(refs)).digest('hex') });
      } catch (error) {
        try { await audit.append({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed', outcome: 'error',
          reason: error?.code === 'audit_integrity_invalid' ? 'integrity_invalid' : 'reader_unavailable', resultCount: 0, resultDigest: null }); } catch {}
        fail('audit_view_unavailable', 503);
      }
      return { version: 1, status: 'available', criteria, snapshot: state.snapshot, nextCursor,
        coverage: 'confirmed_platform_index_only', events: verified.map(v => ({ eventId: v.eventId, occurredAt: v.occurredAt,
          action: v.action, stage: v.stage, outcome: v.outcome, reason: v.reason, actorType: v.actor.type, actorId: v.actor.id,
          subjectUserId: v.subjectUserId || null, sessionRef: v.sessionRef, scopeType: v.scope.type, scopeId: v.scope.id,
          verification: 's3_version_verified' })) };
    },
  };
}
let singleton;
module.exports = { createView, async read(input) {
  if (!process.env.PLATFORM_AUDIT_VIEW_ENABLED || process.env.PLATFORM_AUDIT_VIEW_ENABLED === 'false') {
    if (!isGlobalAdmin(input.actorId)) fail('technical_admin_required', 403);
    return { version: 1, status: 'disabled', events: [], nextCursor: null };
  }
  if (process.env.PLATFORM_AUDIT_VIEW_ENABLED !== 'true') fail('audit_view_unavailable', 503);
  if (!singleton) {
    const models = require('../../models'); const reader = require('./platformAudit.readerClient');
    singleton = createView({ model: models.PlatformAuditEvent,
      audit: require('./platformAudit.repository').createRepository(models.PlatformAuditEvent), reader,
      codec: cursorCodec(reader.privateFile(process.env.PLATFORM_AUDIT_VIEW_CURSOR_KEY_FILE)) });
  }
  return singleton.read(input);
} };
