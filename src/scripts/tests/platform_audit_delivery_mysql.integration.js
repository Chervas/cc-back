'use strict';
const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize'); const { Readable } = require('node:stream');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { writeBatch, WRITER_ROLE } = require('../../../services/platform-audit/src/batch');
const { createWriter, createReconciler, KEY_ARN } = require('../../../services/platform-audit/src/s3');
const sourceRoleArn = 'arn:aws:iam::137819318729:role/fictitious-audit-source';
const identity = role => ({ Account: '137819318729', Arn: `arn:aws:sts::137819318729:assumed-role/${role.split('/').at(-1)}/fixture` });
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const { createRepository } = require('../../services/platformAudit.repository');
  const { createDelivery } = require('../../services/platformAudit.delivery');
  const { createStateRepository, createMonitor } = require('../../services/platformAudit.monitor');
  const auditMigration = require('../../../migrations/20260912210000-create-platform-audit-events');
  const stateMigration = require('../../../migrations/20260912213000-create-platform-audit-delivery-states');
  const qi = sql.getQueryInterface(); await auditMigration.up(qi, DataTypes); await stateMigration.up(qi, DataTypes);
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, DataTypes);
  models.PlatformAuditDeliveryState = require('../../../models/platformauditdeliverystate')(sql, DataTypes);
  models.Notification = require('../../../models/notification')(sql, DataTypes);
  models.Usuario = sql.define('FictitiousAuditOperator', { id_usuario: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false });
  await models.Usuario.sync(); await models.Notification.sync();
  await models.Usuario.bulkCreate([{ id_usuario: 1 }, { id_usuario: 44 }, { id_usuario: 701 }]);
  const repo = createRepository(models.PlatformAuditEvent); let state = createStateRepository(models);
  let now = new Date('2026-09-12T12:00:00Z');
  const zero = () => ({ pending: 0, reconcile: 0, oldestAgeSeconds: 0, unresolvedAttempts: 0, oldestUnresolvedAgeSeconds: 0, delivered: 0, failed: 0 });
  const leases = await Promise.all(Array.from({ length: 6 }, () => state.acquire(now)));
  assert.equal(leases.filter(Boolean).length, 1); report.checks.push('six dispatchers acquire one global SQL lease across shared runtimes');
  const old = leases.find(Boolean); now = new Date(now.getTime() + 271000); state = createStateRepository(models);
  const current = await state.acquire(now); assert(current);
  assert.equal(await state.finish(old, zero(), null, now), false);
  assert.equal(await state.finish(current, zero(), null, now), true);
  assert.equal((await state.read()).summary.pending, 0);
  report.checks.push('new dispatcher instance recovers expired lease and late finisher cannot alter health');
  const failureLease = await state.acquire(now); await state.finish(failureLease, zero(), 'audit_identity_invalid', now);
  const idle = createDelivery({ repository: repo, state, now: () => now, config: () => ({ enabled: true, sourceRoleArn }),
    write: () => assert.fail('idle cycle must not call AWS') });
  await idle.run(); assert.equal((await state.read()).last_error, 'audit_identity_invalid'); assert.equal((await state.read()).last_confirmed_at, null);
  report.checks.push('empty/backoff cycle preserves the previous failure and cannot invent a confirmed delivery');
  for (let i = 0; i < 55; i++) await repo.append(fixture({ occurredAt: now.toISOString() }));
  const objects = new Map(); let loseAck = true; let putCount = 0;
  const writer = createWriter({ send: async command => {
    assert.equal(command.constructor.name, 'PutObjectCommand'); putCount++;
    if (objects.has(command.input.Key)) throw { name: 'PreconditionFailed' };
    const object = { body: command.input.Body, VersionId: randomUUID(), ChecksumSHA256: command.input.ChecksumSHA256,
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN }; objects.set(command.input.Key, object);
    if (loseAck) { loseAck = false; throw Error('fictitious lost ACK'); } return object;
  } });
  const delivery = () => createDelivery({ repository: createRepository(models.PlatformAuditEvent), state: createStateRepository(models),
    config: () => ({ enabled: true, sourceRoleArn }), now: () => now,
    write: async (_settings, rows) => writeBatch({ version: 1, sourceRoleArn, records: rows.map(({ body, digest }) => ({ body, digest })) }, {
      sourceIdentity: async () => identity(sourceRoleArn), assumeWriter: async () => ({ identity: async () => identity(WRITER_ROLE), writer, close: () => {} }),
    }) });
  const first = await delivery().run(); assert.equal(first.delivered, 49); assert.equal(first.failed, 1); assert.equal(putCount, 50);
  assert.equal(first.pending, 6); now = new Date(now.getTime() + 6000);
  const second = await delivery().run(); assert.equal(second.delivered, 5); assert.equal(second.reconcile, 1); assert.equal(objects.size, 55);
  report.checks.push('bounded worker sends 50 then six pending records; lost ACK becomes one reconciliation without duplicate objects');
  const notificationsBefore = await models.Notification.count(); assert.equal(notificationsBefore, 0);
  const health = await repo.health(now);
  await Promise.all(Array.from({ length: 6 }, () => createStateRepository(models).observe(health, now)));
  let notes = await models.Notification.findAll({ raw: true }); assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(row => row.userId).sort((a, b) => a - b), [1, 44]);
  assert(notes.every(row => row.data.code === 'audit_reconciliation_required' && !row.clinicaId));
  report.checks.push('concurrent monitors persist one panel alert per technical administrator; clinic staff excluded');
  const originalNotify = models.Notification.findOrCreate; const before = await state.read(); let calls = 0;
  models.Notification.findOrCreate = async function (...args) { if (++calls === 2) throw Error('fictitious notification failure'); return originalNotify.apply(this, args); };
  try { await assert.rejects(state.observe({ ...health, pending: 10000 }, now), /fictitious notification failure/); }
  finally { models.Notification.findOrCreate = originalNotify; }
  assert.equal(await models.Notification.count(), 2); assert.equal((await state.read()).alarm_code, before.alarm_code);
  report.checks.push('notification failure rolls back all recipients and alarm state; next monitor can retry');
  now = new Date(now.getTime() + 10000);
  const pending = await repo.claim(now, 'reconcile'); assert(pending);
  const reader = createReconciler({ send: async command => { const value = objects.get(command.input.Key);
    return { ...value, ContentLength: Buffer.byteLength(value.body), Body: Readable.from([value.body]) }; } });
  await repo.acknowledge(pending, await reader.write(pending), now);
  await repo.append(fixture({ occurredAt: now.toISOString() }));
  const healthy = await delivery().run(); assert.equal(healthy.pending, 0); assert.equal(putCount, 57);
  assert.equal(new Date((await state.read()).last_confirmed_at).toISOString(), now.toISOString());
  const monitor = createMonitor({ repository: repo, state, config: () => ({ monitorEnabled: true }), now: () => now });
  assert.equal((await monitor.run()).monitoring.level, 'healthy'); await monitor.run();
  assert.equal(await models.Notification.count(), 4);
  assert.equal((await monitor.getHealth(1)).health.pending, 0);
  await assert.rejects(monitor.getHealth(701), /technical_admin_required/);
  report.checks.push('separate reconciliation permits a single recovery notice; health reads remain technical-admin-only');
  now = new Date(now.getTime() + 301000); const stale = await monitor.run();
  assert.equal(stale.monitoring.code, 'audit_delivery_stale'); assert.equal(await models.Notification.count(), 6);
  assert.equal(stale.monitoring.externalWatchdogVerified, false);
  report.checks.push('stopped worker is detected despite an empty queue, with external-watchdog limitation explicit');
  await assert.rejects(stateMigration.down(qi), /preserve_delivery_state/);
  report.checks.push('state migration preserves alarm episodes and delivery evidence on rollback');
}).catch(() => { process.exitCode = 1; });
