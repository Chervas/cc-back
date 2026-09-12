'use strict';
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { pack, unpack, receiptFor, fail } = require('../../services/platform-audit/src/event');
function createRepository(model) {
  const sql = model.sequelize;
  const owned = (row, now) => ({ event_id: row.event_id, digest: row.digest, lease_token: row.lease_token,
    lease_until: { [Op.gt]: now }, state: { [Op.ne]: 'delivered' } });
  return {
    async append(value, { transaction } = {}) {
      const row = pack(value);
      try {
        await model.create({ event_id: row.event.eventId, correlation_id: row.event.correlationId, stage: row.event.stage,
          occurred_at: new Date(row.event.occurredAt), body: row.body, digest: row.digest,
          next_attempt_at: new Date(row.event.occurredAt) }, { transaction });
      } catch (error) {
        if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        const existing = await model.findByPk(row.event.eventId, { transaction, raw: true });
        if (!existing || existing.body !== row.body || existing.digest !== row.digest) fail('audit_event_conflict');
      }
      return row;
    },
    async claim(now = new Date(), mode = 'pending') {
      if (!['pending', 'reconcile'].includes(mode)) fail();
      return sql.transaction(async transaction => {
        const row = await model.findOne({ where: { state: mode, next_attempt_at: { [Op.lte]: now },
          [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lte]: now } }] },
        order: [['occurred_at', 'ASC'], ['event_id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
        if (!row) return null;
        const updates = { lease_token: randomUUID(), lease_until: new Date(now.getTime() + 120000), attempts: row.attempts + 1 };
        await row.update(updates, { transaction });
        return row.get({ plain: true });
      });
    },
    async acknowledge(row, receipt, now = new Date()) {
      unpack(row); receipt = receiptFor(row, receipt);
      const [changed] = await model.update({ state: 'delivered', receipt, delivered_at: now,
        lease_token: null, lease_until: null, last_error: null }, { where: owned(row, now) });
      return changed === 1;
    },
    async retry(row, code, now = new Date()) {
      const known = new Set(['audit_unavailable', 'audit_reconciliation_required', 'audit_integrity_invalid']);
      code = known.has(code) ? code : 'audit_unavailable';
      const state = code === 'audit_reconciliation_required' || row.state === 'reconcile' ? 'reconcile' : 'pending';
      const [changed] = await model.update({ state, last_error: code, lease_token: null, lease_until: null,
        next_attempt_at: new Date(now.getTime() + Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12))) },
      { where: owned(row, now) });
      return changed === 1;
    },
    async health(now = new Date(), { includeUnresolved = true } = {}) {
      const where = { state: { [Op.ne]: 'delivered' } };
      const [pending, oldest, reconcile, unresolved] = await Promise.all([model.count({ where }), model.min('occurred_at', { where }),
        model.count({ where: { state: 'reconcile' } }), includeUnresolved ? sql.query(
          'SELECT COUNT(*) AS count, MIN(a.occurred_at) AS oldest FROM PlatformAuditEvents a '
          + 'LEFT JOIN PlatformAuditEvents b ON b.correlation_id = a.correlation_id AND b.stage = \'completed\' '
          + 'WHERE a.stage = \'attempted\' AND b.event_id IS NULL', { type: sql.constructor.QueryTypes.SELECT, logging: false }) : null]);
      const age = value => value ? Math.max(0, Math.floor((now - new Date(value)) / 1000)) : 0;
      return { pending, reconcile, oldestAgeSeconds: age(oldest), unresolvedAttempts: unresolved ? Number(unresolved[0].count) : null,
        oldestUnresolvedAgeSeconds: unresolved ? age(unresolved[0].oldest) : null };
    },
  };
}
async function drain(repository, sink, { now = () => new Date(), limit = 50, mode = 'pending' } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail();
  let delivered = 0; let failed = 0;
  for (let i = 0; i < limit; i++) {
    const row = await repository.claim(now(), mode); if (!row) break;
    try {
      unpack(row); const receipt = await sink.write(row);
      if (await repository.acknowledge(row, receipt, now())) delivered++; else failed++;
    } catch (error) { await repository.retry(row, error.code, now()); failed++; }
  }
  return { delivered, failed, ...await repository.health(now()) };
}
module.exports = { createRepository, drain };
