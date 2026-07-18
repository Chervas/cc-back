'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  domainDueForReconciliation,
  reconcileDomains,
} = require('../../services/webDomains.service');

function domain(id, status, checkedAt) {
  return {
    id,
    status,
    verification: checkedAt ? { checked_at: checkedAt } : {},
    tls: {},
    updated_at: checkedAt || '2026-07-01T00:00:00.000Z',
  };
}

test('aplica cadencia corta solo a pendientes y diaria a dominios listos', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  assert.equal(domainDueForReconciliation(domain('pending', 'pending_dns', '2026-07-18T11:40:00.000Z'), now), true);
  assert.equal(domainDueForReconciliation(domain('pending-fresh', 'pending_tls', '2026-07-18T11:50:00.000Z'), now), false);
  assert.equal(domainDueForReconciliation(domain('ready-old', 'ready', '2026-07-17T11:00:00.000Z'), now), true);
  assert.equal(domainDueForReconciliation(domain('ready-fresh', 'ready', '2026-07-18T08:00:00.000Z'), now), false);
  assert.equal(domainDueForReconciliation(domain('retired', 'retired', '2026-01-01T00:00:00.000Z'), now), false);
});

test('reconcilia por el handler interno, limita el lote y no requiere actor humano', async () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const rows = [
    domain('one', 'pending_dns', '2026-07-18T11:00:00.000Z'),
    domain('two', 'ready', '2026-07-17T10:00:00.000Z'),
    domain('fresh', 'pending_tls', '2026-07-18T11:55:00.000Z'),
  ];
  const calls = [];
  const result = await reconcileDomains({
    jobRequestId: 901,
    now,
    limit: 2,
    models: { WebDomain: { findAll: async () => rows } },
    sequelize: {},
    verify: async (input) => {
      calls.push(input);
      assert.equal(input.actorId, null);
      assert.equal(await input.assertAccess(), true);
      return { id: input.domainId, status: 'ready' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.processed, 2);
  assert.deepEqual(calls.map((item) => item.domainId), ['one', 'two']);
  assert.match(calls[0].requestId, /^job:901:domain:/);
});

test('un error técnico conserva reintento durable sin filtrar el mensaje del proveedor', async () => {
  const result = await reconcileDomains({
    now: new Date('2026-07-18T12:00:00.000Z'),
    models: {
      WebDomain: {
        findAll: async () => [domain('broken', 'pending_tls', '2026-07-18T10:00:00.000Z')],
      },
    },
    sequelize: {},
    verify: async () => {
      const error = new Error('Authorization Bearer secret-must-not-leak');
      error.code = 'provider_unavailable';
      error.status = 503;
      throw error;
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(result.errors[0].code, 'provider_unavailable');
  assert.equal(JSON.stringify(result).includes('secret-must-not-leak'), false);
});
