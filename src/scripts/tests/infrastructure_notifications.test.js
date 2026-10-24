'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../lib/infrastructureNotificationProtocol');
const { createIngestor, createWorker } = require('../../lib/infrastructureNotificationIngestion');
const adapter = require('../../services/infrastructureNotificationCollector.service');
const NOW = Date.UTC(2026, 9, 24, 14);
const ARN = Object.keys(P.ALARMS)[0];
const NONCE = '28a0f1ce-becd-41fe-916d-2fe36aa76b26';
function message({ id = '22aa44bb-ffee-4455-8855-aabb66778899', state = 'ALARM', time = NOW - 10000, reason = 'provider reason never persisted', arn = ARN, patch = {} } = {}) {
 const alarm = { AlarmArn: arn, AlarmName: arn.slice(arn.indexOf(':alarm:') + 7), AWSAccountId: P.ACCOUNT, Region: 'EU (Paris)',
  NewStateValue: state, StateChangeTime: new Date(time).toISOString(), NewStateReason: reason,
  Trigger: { Namespace: 'AWS/RDS', MetricName: P.ALARMS[arn]?.metric, Dimensions: [{ name: 'DBInstanceIdentifier', value: P.DB_ID }] }, ...patch };
 return JSON.stringify({ Type: 'Notification', TopicArn: P.TOPIC_ARN, MessageId: id, Timestamp: new Date(NOW).toISOString(), Message: JSON.stringify(alarm) });
}
function rdsMessage({ id = 'bbcc44bb-ffee-4455-8855-aabb66778899', eventId = 'RDS-EVENT-0015', legacy = false, patch = {} } = {}) {
 const payload = { 'Event Source': 'db-instance', 'Event Time': new Date(NOW - 3000).toISOString().replace('T', ' ').replace('Z', ''),
  'Identifier Link': 'https://console.aws.amazon.com/rds/home', 'Source ID': P.DB_ID,
  'Event ID': 'http://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.Messages.html#' + eventId,
  'Event Message': 'Untrusted provider prose never copied into notification', ...(legacy ? {} : { 'Source ARN': P.RDS_ARN }), ...patch };
 return JSON.stringify({ Type: 'Notification', TopicArn: P.TOPIC_ARN, MessageId: id, Timestamp: new Date(NOW).toISOString(), Message: JSON.stringify(payload),
  ...(legacy ? {} : { MessageAttributes: { Resource: { Type: 'String', Value: P.RDS_ARN }, EventID: { Type: 'String', Value: eventId } } }) });
}
function fixture({ failQueue = false, commitUnknown = false, noChannels = false } = {}) {
 const receipts = new Map(), states = new Map(), notifications = [];
 let mutex = Promise.resolve(), next = 1, throwUnknown = commitUnknown;
 const unique = () => Object.assign(Error('unique'), { name: 'SequelizeUniqueConstraintError' });
 const wrapper = (map, key, tx) => ({ ...map.get(key), async update(patch, options) { assert.equal(options.transaction, tx);Object.assign(map.get(key), patch);Object.assign(this, patch); } });
 const Receipt = {
  findByPk: async key => receipts.get(key) || null,
  findOne: async ({ where }) => [...receipts.values()].find(x => x.delivery_test_nonce === where.delivery_test_nonce) || null,
  create: async (value, { transaction: tx }) => {
   if (tx.receipts.has(value.receipt_key) || value.delivery_test_nonce && [...tx.receipts.values()].some(x => x.delivery_test_nonce === value.delivery_test_nonce)) throw unique();
   tx.receipts.set(value.receipt_key, { ...value });return wrapper(tx.receipts, value.receipt_key, tx);
  },
 };
 const State = { findByPk: async (key, { transaction: tx, lock }) => { assert.equal(lock, 'UPDATE');return wrapper(tx.states, key, tx); } };
 const sequelize = {
  transaction(options, body) {
   assert.equal(options.isolationLevel, 'READ COMMITTED');assert.equal(options.retry.max, 0);
   const run = mutex.then(async () => {
    const tx = { receipts: new Map([...receipts].map(([k, v]) => [k, { ...v }])), states: new Map([...states].map(([k, v]) => [k, { ...v }])), notifications: [], LOCK: { UPDATE: 'UPDATE' } };
    const out = await body(tx);
    receipts.clear();for (const [k, v] of tx.receipts) receipts.set(k, v);
    states.clear();for (const [k, v] of tx.states) states.set(k, v);notifications.push(...tx.notifications);
    if (throwUnknown) { throwUnknown = false;throw Error('SQL_COMMIT_REPLY_UNKNOWN'); }
    return out;
   });mutex = run.catch(() => {});return run;
  },
  async query(sql, { transaction: tx, replacements: v }) {
   assert.match(sql, /^INSERT INTO InfrastructureNotificationStates/);assert.match(sql, /ON DUPLICATE KEY UPDATE alarm_key=alarm_key/);
   if (!tx.states.has(v.key)) tx.states.set(v.key, { alarm_key: v.key, alarm_arn: v.arn, state: 'UNOBSERVED', state_changed_at: null });
  },
 };
 const queueNotification = async value => {
  assert.equal(value.transaction?.LOCK.UPDATE, 'UPDATE');assert.equal(value.runtimeNamespace, 'staging');
  if (failQueue) throw Error('delivery insert failed');
  const channels = noChannels ? [] : value.allowedChannels;
  const created = channels.map(channel => ({ channel, deliveryId: next++, jobRequestId: next++ }));
  value.transaction.notifications.push({ ...value, transaction: undefined });return { created, skipped: [], channels };
 };
 const configuration = { deliveryTests: [{ nonce: NONCE, alarmArn: ARN, approvedAtEpochMs: NOW - 60000, expiresAtEpochMs: NOW + 60000 }] };
 const ingestor = createIngestor({ sequelize, Receipt, State, queueNotification, configuration, now: () => NOW });
 return { ...ingestor, receipts, states, notifications, configuration };
}
test('strict own SNS/account/region/four alarms/RDS metric/clock envelope; no URL fetching or reason projection', () => {
 const raw = message(), e = P.parseEnvelope(raw, NOW);assert.equal(e.alarmArn, ARN);assert.equal(P.notification(e).metadata.physical_database_id, P.DBI);
 assert.equal(JSON.stringify(P.notification(e)).includes('provider reason'), false);
 for (const edit of [x => x.TopicArn += ':other', x => x.Type = 'SubscriptionConfirmation', x => { const a = JSON.parse(x.Message);a.Trigger.Dimensions[0].value = 'other-db';x.Message = JSON.stringify(a); }, x => { const a = JSON.parse(x.Message);a.AlarmArn += '-foreign';x.Message = JSON.stringify(a); }]) {
  const x = JSON.parse(raw);edit(x);assert.throws(() => P.parseEnvelope(JSON.stringify(x), NOW), /^Error: infrastructure_/);
 }
 assert.throws(() => P.parseEnvelope(message({ patch: { AlarmArn: '__proto__', AlarmName: 'to__' } }), NOW), /alarm_scope/);
});
test('durable receipt and notifications commit atomically; duplicate and concurrent receipt races yield one fanout', async () => {
 const f = fixture();const result = await Promise.all([f.ingest(message()), f.ingest(message())]);
 assert.equal(result.filter(x => x.duplicate).length, 1);assert.equal(f.receipts.size, 1);assert.equal(f.notifications.length, 1);
 assert.deepEqual(f.notifications[0].allowedChannels, ['panel', 'email']);assert.equal(f.notifications[0].channelsOverride, undefined);
 assert.equal([...f.receipts.values()][0].outcome, 'QUEUED');
});
test('DB failure rolls back both receipt/state and outbox; retry cannot find a fabricated completed receipt', async () => {
 const f = fixture({ failQueue: true });await assert.rejects(() => f.ingest(message()), /delivery insert failed/);
 assert.equal(f.receipts.size, 0);assert.equal(f.states.size, 0);assert.equal(f.notifications.length, 0);
});
test('COMMIT UNKNOWN gives no acknowledgement; redelivery durable receipt resolves without second notification', async () => {
 const f = fixture({ commitUnknown: true });let ack = 0;
 const collector = { receive: async () => ({ ok: true, operation: 'receive', queueArn: P.QUEUE_ARN, identity: { accountId: P.ACCOUNT, roleArn: P.ROLE }, messages: [{ receiptHandle: 'opaque-handle', snsEnvelopeRaw: message() }] }),
  ack: async () => { ack++;return { ok: true, operation: 'ack', deleted: true }; } };
 const run = createWorker({ ingest: f.ingest, collector });const first = await run();assert.equal(first.rejected, 1);assert.equal(ack, 0);
 assert.equal(f.notifications.length, 1);const second = await run();assert.equal(second.duplicate, 1);assert.equal(second.acknowledged, 1);assert.equal(f.notifications.length, 1);
});
test('delete ACK UNKNOWN permits redelivery and a second delete, never a second notification', async () => {
 const f = fixture();let attempts = 0;
 const collector = { receive: async () => ({ ok: true, operation: 'receive', queueArn: P.QUEUE_ARN, identity: { accountId: P.ACCOUNT, roleArn: P.ROLE }, messages: [{ receiptHandle: 'opaque', snsEnvelopeRaw: message() }] }),
  ack: async () => { if (++attempts === 1) throw Error('ACK_UNKNOWN');return { ok: true, operation: 'ack', deleted: true }; } };
 const run = createWorker({ ingest: f.ingest, collector });assert.equal((await run()).unknownAcknowledgements, 1);assert.equal((await run()).duplicate, 1);assert.equal(f.notifications.length, 1);
});
test('old events cannot reopen known OK, initial OK is silent, equal clock conflicting state refuses', async () => {
 const f = fixture();await f.ingest(message({ state: 'OK', time: NOW - 20000 }));assert.equal(f.notifications.length, 0);
 await f.ingest(message({ id: '33aa44bb-ffee-4455-8855-aabb66778899', time: NOW - 30000 }));assert.equal(f.notifications.length, 0);
 assert.equal([...f.states.values()][0].state, 'OK');assert.equal([...f.receipts.values()][1].outcome, 'STALE');
 await assert.rejects(() => f.ingest(message({ id: '44aa44bb-ffee-4455-8855-aabb66778899', time: NOW - 20000 })), /same_time_conflict/);
 await f.ingest(message({ id: '55aa44bb-ffee-4455-8855-aabb66778899', time: NOW - 10000 }));
 await f.ingest(message({ id: '66aa44bb-ffee-4455-8855-aabb66778899', state: 'OK', time: NOW - 1000 }));
 assert.deepEqual(f.notifications.map(x => x.eventKey), ['infrastructure.rds_alarm', 'infrastructure.rds_recovered']);
});
test('Root test nonce/email only never changes incident state; duplicate nonce across SNS IDs sends once', async () => {
 const f = fixture();const raw = message({ reason: `CC_DELIVERY_TEST:${NONCE}` });const out = await f.ingest(raw);
 assert.equal(out.outcome, 'TESTED');assert.equal(f.states.size, 0);assert.equal(f.notifications[0].eventKey, 'system.notification_test');
 assert.deepEqual(f.notifications[0].channelsOverride, { email: true, panel: false, whatsapp: false });assert.deepEqual(f.notifications[0].allowedChannels, ['email']);
 const second = await f.ingest(message({ id: '99aa44bb-ffee-4455-8855-aabb66778899', reason: `CC_DELIVERY_TEST:${NONCE}` }));
 assert.equal(second.duplicate, true);assert.equal(f.notifications.length, 1);
 await f.ingest(message({ id: '77aa44bb-ffee-4455-8855-aabb66778899', state: 'OK' }));assert.equal(f.notifications.length, 1);
});
test('unapproved/expired/malformed delivery tests refuse; no configured email cannot fabricate test acceptance', async () => {
 for (const mutate of [f => f.configuration.deliveryTests.splice(0), f => f.configuration.deliveryTests[0].expiresAtEpochMs = NOW - 1]) {
  const f = fixture();mutate(f);await assert.rejects(() => f.ingest(message({ reason: `CC_DELIVERY_TEST:${NONCE}` })), /not_authorized/);assert.equal(f.receipts.size, 0);
 }
 await assert.rejects(() => fixture({ noChannels: true }).ingest(message({ reason: `CC_DELIVERY_TEST:${NONCE}` })), /test_email_not_queued/);
 assert.throws(() => P.parseEnvelope(message({ reason: 'CC_DELIVERY_TEST:not-a-nonce' }), NOW), /delivery_test_invalid/);
});
test('runtime and selected startup are staging-only, without enabling other cron jobs or DEV/gateway', async () => {
 const env = { INFRASTRUCTURE_NOTIFICATIONS_ENABLED: 'true', JOB_RUNTIME_NAMESPACE: 'staging' };
 assert.deepEqual(P.selectedStartupJobs(false, env), ['infrastructureNotifications']);assert.deepEqual(P.selectedStartupJobs(true, env), ['systemNotificationCheck', 'infrastructureNotifications']);
 for (const x of [{ ...env, JOB_RUNTIME_NAMESPACE: 'dev' }, { ...env, RUNTIME_ROLE: 'gateway' }, { ...env, DEV_SECURITY_PROFILE: 'isolated-security-v2' }, {}]) assert.equal(P.runtimeEnabled(x), false);
 assert.equal((await require('../../services/infrastructureNotifications.service').runJob({ env: {} })).status, 'skipped');
 const definition = require('../../config/scheduledJobCatalog').SCHEDULED_JOB_DEFINITIONS.infrastructureNotifications;
 assert.equal(definition.maxAttempts, 1);assert.equal(definition.usesIntegrationLease, false);assert.equal(definition.executorMethod, 'executeInfrastructureNotifications');
});
test('collector adapter fixed child/clean env/FD0, rejects nonzero exit and never puts handles in argv', async () => {
 const seen = [];
 const transport = adapter.createCollector({ execute(binary, argv, options, callback) {
  seen.push({ binary, argv, options });return { stdin: { on() {}, end(input) { const request = JSON.parse(input);seen.at(-1).input = request;
   queueMicrotask(() => callback(null, JSON.stringify({ ok: true, operation: request.operation, deleted: true }), '')); } } };
 } });
 await transport.ack('secret-opaque-handle', 1000);assert.equal(seen[0].binary, adapter.BINARY);assert.deepEqual(seen[0].argv, [adapter.ENTRY]);
 assert.equal(JSON.stringify(seen[0].options).includes('secret-opaque-handle'), false);assert.equal(seen[0].options.env.AWS_CONFIG_FILE, '/dev/null');
 assert.equal(seen[0].options.env.NODE_OPTIONS, undefined);assert.equal(seen[0].options.timeout, 1000);
 await assert.rejects(() => adapter.createCollector({ execute(a, b, c, callback) { queueMicrotask(() => callback(Error('process failed'), '{"ok":true}', ''));return { stdin: { on() {}, end() {} } }; } }).receive(100), /collector_unavailable/);
});
test('Root-owned configuration is readable by API group but cannot grant API control over delivery-test authority', () => {
 const bytes = Buffer.from('public pinned executable fixture'), pin = P.hash(bytes);
 const configuration = { schema: 'clinicaclick-infrastructure-notifications-config/1', physicalDbId: P.DBI,
  databaseHost: P.HOST, databaseName: 'clinicaclick', deliveryTests: [], nodeBinarySha256: pin,
  collectorSha256: pin, collectorScopeSha256: pin, collectorCredentialsSha256: pin };
 const env = { INFRASTRUCTURE_NOTIFICATIONS_CONFIG_FILE: adapter.CONFIG };
 const check = (change = {}) => {
  const directory = { uid: 0, gid: 1000, mode: 0o750, isDirectory: () => true, isSymbolicLink: () => false, ...change.directory };
  const file = { uid: 0, gid: 1000, mode: 0o640, nlink: 1, size: 1024, isFile: () => true, ...change.file };
  let opened = false, closed = false;
  const io = { lstatSync: p => p === '/etc/clinicaclick-infrastructure-alerts' ? directory
   : { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false, ...change.parent },
   realpathSync: () => change.realpath || adapter.CONFIG,
   openSync: (_p, flags) => { assert.ok(flags & fs.constants.O_NOFOLLOW);opened = true;return 41; },
   fstatSync: () => file, readFileSync: value => value === 41 ? JSON.stringify(configuration) : bytes,
   closeSync: fd => { assert.equal(fd, 41);closed = true; } };
  try { return adapter.loadConfiguration(env, io); } finally { if (opened) assert.equal(closed, true); }
 };
 assert.deepEqual(check(), configuration);
 for (const change of [{ file: { uid: 1000 } }, { file: { mode: 0o600 } }, { file: { gid: 0 } },
  { file: { nlink: 2 } }, { file: { mode: 0o660 } }, { directory: { uid: 1000 } },
  { directory: { mode: 0o770 } }, { directory: { isSymbolicLink: () => true } }, { parent: { mode: 0o777 } },
  { realpath: '/tmp/staging.json' }]) assert.throws(() => check(change), /^Error: infrastructure_/);
});
test('migration adds exactly two durable ledger tables, unique SHA receipt and unique optional test nonce; no destructive down', async () => {
 const Sequelize = require('sequelize');const migration = require('../../../migrations/20261024160000-create-infrastructure-notification-receipts');
 const tables = [];await migration.up({ createTable: async (name, fields, options) => tables.push({ name, fields, options }) }, Sequelize.DataTypes);
 assert.deepEqual(tables.map(x => x.name), ['InfrastructureNotificationReceipts', 'InfrastructureNotificationStates']);
 assert.equal(tables[0].fields.receipt_key.primaryKey, true);assert.equal(tables[0].fields.delivery_test_nonce.unique, true);
 assert.ok(tables.every(x => x.options.engine === 'InnoDB'));await assert.rejects(() => migration.down(), /requires_explicit_review/);
 const definitions = [];const fake = { define(name, fields, options) { definitions.push({ name, fields, options });return { name }; } };
 require('../../../models/infrastructurenotificationreceipt')(fake, Sequelize.DataTypes);require('../../../models/infrastructurenotificationstate')(fake, Sequelize.DataTypes);
 assert.deepEqual(definitions.map(x => x.options.tableName), tables.map(x => x.name));
});
test('genuine SystemNotifications queues deliveries and native JobRequests inside the supplied receipt transaction, preserving configured channels', async () => {
 const vm = require('node:vm');const file = path.resolve(__dirname, '../../services/systemNotifications.service.js');
 const tx = { marker: 'receipt-transaction' }, calls = [];
 let setting, throttled = false;
 const fakeDb = { sequelize: { transaction: () => { throw Error('nested transaction forbidden'); } },
  SystemNotificationSetting: { findOrCreate: async () => [setting, false] },
  SystemNotificationDelivery: { count: async () => throttled ? 1 : 0, create: async (v, o) => { assert.equal(o.transaction, tx);calls.push(v);return { ...v, id: calls.length, update: async (_p, opt) => assert.equal(opt.transaction, tx) }; } },
 };
 const jobRequests = { getCurrentRuntimeNamespace: () => 'staging', enqueueJobRequest: async (v, o) => {
  assert.equal(o.transaction, tx);assert.equal(v.type, 'system_notification_dispatch');assert.equal(v.payload.__runtime_namespace, 'staging');return { id: 400 + calls.length };
 } };
 const module = { exports: {} };
 const localRequire = id => id === '../../models' ? fakeDb : id === './jobRequests.service' ? jobRequests
  : id === '../lib/role-helpers' ? { ADMIN_USER_IDS: [1] } : ['crypto', 'sequelize'].includes(id) ? require(id) : {};
 vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(localRequire, module, module.exports);
 const service = module.exports;
 setting = { enabled: true, panel_enabled: true, email_enabled: true, whatsapp_enabled: true,
  admin_email: 'owner@example.invalid', admin_phone: null, event_rules: service.defaultEventRules(), throttle_minutes: 60 };
 const normal = P.notification(P.parseEnvelope(message(), NOW));
 const queued = await service.queueNotification({ ...normal, transaction: tx, runtimeNamespace: 'staging' });
 assert.equal(normal.force, false);
 assert.deepEqual(queued.created.map(x => x.channel), ['panel', 'email']);assert.equal(calls.some(x => x.channel === 'whatsapp'), false);
 setting.email_enabled = false;assert.deepEqual((await service.queueNotification({ ...normal, transaction: tx })).created.map(x => x.channel), ['panel']);
 throttled = true;assert.deepEqual((await service.queueNotification({ ...normal, transaction: tx })).created, []);
 const testRequest = P.notification(P.parseEnvelope(message({ reason: `CC_DELIVERY_TEST:${NONCE}` }), NOW));
 assert.equal(testRequest.force, true);
 assert.deepEqual((await service.queueNotification({ ...testRequest, transaction: tx })).created.map(x => x.channel), ['email']);
 setting.enabled = false;assert.deepEqual((await service.queueNotification({ ...normal, transaction: tx })).created, []);
});
test('worker deadline never acknowledges a transaction which completes after the budget; receipt conflicts are terminal', async () => {
 let complete, ack = 0;
 const collector = { receive: async () => ({ ok: true, operation: 'receive', queueArn: P.QUEUE_ARN, identity: { accountId: P.ACCOUNT, roleArn: P.ROLE }, messages: [{ receiptHandle: 'owned', snsEnvelopeRaw: message() }] }),
  ack: async () => { ack++;return { ok: true, operation: 'ack', deleted: true }; } };
 const run = createWorker({ ingest: () => new Promise(resolve => { complete = resolve; }), collector, budgetMs: 5 });
 assert.equal((await run()).rejected, 1);complete({ committed: true });await Promise.resolve();assert.equal(ack, 0);
 const f = fixture();await f.ingest(message());await assert.rejects(() => f.ingest(message({ state: 'OK' })), /receipt_conflict/);assert.equal(f.notifications.length, 1);
});
test('documented modern and legacy SNS RDS shapes notify significant own events without touching CloudWatch state or provider text', async () => {
 for (const legacy of [false, true]) {
  const f = fixture(), raw = rdsMessage({ legacy }), e = P.parseEnvelope(raw, NOW);assert.equal(e.kind, 'RDS_EVENT');assert.equal(e.resourceArn, P.RDS_ARN);
  assert.equal(e.changedAt, NOW - 3000);assert.equal(e.definition.category, 'failover');const out = await f.ingest(raw);
  assert.equal(out.outcome, 'QUEUED');assert.equal(f.states.size, 0);assert.equal(f.notifications[0].eventKey, 'infrastructure.rds_event');
  assert.deepEqual(f.notifications[0].allowedChannels, ['panel', 'email']);assert.equal(JSON.stringify(f.notifications).includes('Untrusted provider prose'), false);
  assert.equal([...f.receipts.values()][0].event_id, 'RDS-EVENT-0015');assert.equal((await f.ingest(raw)).duplicate, true);assert.equal(f.notifications.length, 1);
 }
});
test('valid backup and unknown RDS events persist IGNORED receipts and acknowledge instead of poison redelivery; foreign/opaque source fails', async () => {
 for (const eventId of ['RDS-EVENT-0001','RDS-EVENT-0002','RDS-EVENT-9999']) {
  const f = fixture(), raw = rdsMessage({ eventId });const out = await f.ingest(raw);assert.equal(out.outcome, 'IGNORED');assert.equal(out.committed, true);
  assert.equal(f.states.size, 0);assert.equal(f.notifications.length, 0);assert.equal([...f.receipts.values()][0].event_id, eventId);
 }
 for (const patch of [{ 'Source ARN': P.RDS_ARN + '-foreign' }, { 'Source ID': 'foreign' }, { 'Event Source': 'db-cluster' },
  { 'Event ID': 'http://169.254.169.254/#RDS-EVENT-0015' }, { 'Event Time': '2026-02-31 13:59:57.000' }]) {
  assert.throws(() => P.parseEnvelope(rdsMessage({ patch }), NOW), /^Error: infrastructure_/);
 }
 const bad = JSON.parse(rdsMessage());bad.MessageAttributes.Resource.Value += '-foreign';assert.throws(() => P.parseEnvelope(JSON.stringify(bad), NOW), /event_attributes/);
});
