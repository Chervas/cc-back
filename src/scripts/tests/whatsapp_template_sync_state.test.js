'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../../lib/whatsappTemplateSyncState');
const { collect } = require('../../lib/whatsappReceptionAlerts');
const now = Date.parse('2026-10-02T06:00:00Z');

test('blocked template queries cool down without classifying transport errors as security denials', () => {
  const job = { status: 'failed', error_message: 'connection_blocked', updated_at: new Date(now - 60000) };
  assert.equal(state.deferReason(job, now), 'connection_blocked_cooldown');
  assert.equal(state.deferReason({ ...job, updated_at: new Date(now - state.BLOCKED_COOLDOWN_MS) }, now), null);
  assert.equal(state.deferReason({ ...job, active_count: 1 }, now), 'sync_in_progress');
  assert.equal(state.deferReason({ ...job, error_message: 'provider_timeout' }, now), null);
  assert.equal(state.blockedCode({ code: 'connection_blocked', message: 'secret details' }), 'connection_blocked');
  assert.equal(state.blockedCode('secret details'), null);
  assert.equal(state.deferReason({ ...job, updated_at: 'invalid' }, now), null);
});

test('durable sync state uses the actual Sequelize parser and is bounded to the current runtime and WABA', async () => {
  const { Sequelize } = require('sequelize');
  const { injectReplacements } = require('sequelize/lib/utils/sql');
  const engine = new Sequelize('synthetic', 'synthetic', 'synthetic', { dialect: 'mysql', logging: false });
  const result = await state.recentJobs({ now, namespace: 'dev', wabaIds: ['301', '301'],
    query: async (sql, options) => {
      const rendered = injectReplacements(sql, engine.dialect, options.replacements);
      assert.doesNotMatch(rendered, /:[a-zA-Z][a-zA-Z0-9_]*/);
      assert.match(rendered, /__runtime_namespace.*='dev'/);
      assert.match(rendered, /MAX_EXECUTION_TIME\(3000\)/);
      assert.deepEqual(options.replacements.wabaIds, ['301']);
      return [[{ waba_id: '301', active_count: 1 }]];
    } });
  assert.equal(result.get('301').active_count, 1);
  assert.equal((await state.recentJobs({ query: () => { throw Error('unexpected query'); }, wabaIds: [] })).size, 0);
});

test('template alerts separate blocked and disconnected accounts without claiming that Meta approval is missing', async () => {
  const rows = [
    { waba_id: '301', pending: 59, oldest_pending: new Date(now - 3600000) },
    { waba_id: '302', pending: 117 }, { waba_id: '303', pending: 113 },
    { waba_id: '304', pending: 113 }, { waba_id: '305', pending: 57 },
  ];
  const bindings = rows.map(row => ({ clinicId: 2, wabaId: row.waba_id, sendEnabled: true }));
  const alerts = await collect({ now, bindings, accountSyncEnabled: true, namespace: 'staging',
    snapshot: { version: 1, observedAt: now, clinics: [{ clinicId: 2, blockingReview: 0, oldestPendingAt: null }] },
    resolveTemplateBinding: async id => ['304', '305'].includes(id) ? null : { wabaId: id },
    query: async sql => [sql.includes('WhatsappInboxAdminSync') ? rows : sql.includes('FROM JobRequests')
      ? rows.slice(0, 3).map(row => ({ waba_id: row.waba_id, error_message: 'connection_blocked' })) : []] });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].metadata, { source: 'whatsapp_template_reconciliation', pending: 459,
    active: 0, blocked: 289, disconnected: 170, blocked_wabas: 3, disconnected_wabas: 2 });
  assert.match(alerts[0].payload.detail, /Meta ya entregó 459 avisos/);
  assert.match(alerts[0].payload.detail, /No son 459 plantillas pendientes de aprobación/);
  assert.match(alerts[0].payload.detail, /control de acceso del broker/);
  assert.doesNotMatch(JSON.stringify(alerts), /phone|contact|content|token|secret/);
});

test('deliberately disconnected accounts retain evidence without sending an operational approval alarm', async () => {
  const alerts = await collect({ now, bindings: [{ clinicId: 2, sendEnabled: false }], accountSyncEnabled: true,
    resolveTemplateBinding: async () => null,
    query: async sql => [sql.includes('WhatsappInboxAdminSync') ? [{ waba_id: '301', pending: 5 }] : []] });
  assert.deepEqual(alerts, []);
});

test('an active synchronization outage remains visible alongside disconnected historical accounts', async () => {
  const alerts = await collect({ now, bindings: [{ clinicId: 2, sendEnabled: false }], accountSyncEnabled: true,
    resolveTemplateBinding: async id => id === '301' ? { wabaId: id } : null,
    query: async sql => [sql.includes('WhatsappInboxAdminSync') ? [{ waba_id: '301', pending: 2 }, { waba_id: '302', pending: 5 }] : []] });
  assert.equal(alerts[0].metadata.active, 2);
  assert.match(alerts[0].payload.title, /sincronización|Sincronización/);
});
