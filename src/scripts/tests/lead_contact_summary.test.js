'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { Op } = require('sequelize');
const { enrichContactSummary, todayCount } = require('../../services/leadContactSummary.service');
const now = new Date('2026-11-10T12:00:00Z'), start = new Date('2026-11-09T23:00:00Z');
const row = (date, extra = {}) => ({ lead_intake_id: 7, created_at: date, usuario_id: 44, canal: 'llamada', motivo: 'no_contesta', ...extra });

test('normalized calls count today even when the legacy JSON history is empty', async () => {
  let query;
  const models = { LeadContactAttempt: { findAll: async q => { query = q; return [row('2026-11-10T09:00:00Z'),row('2026-11-10T10:00:00Z')]; } } };
  const [result] = await enrichContactSummary({ models, leads: [{ id: 7, num_contactos: 3, historial_contactos: [] }], now });
  assert.equal(result.num_contactos_hoy, 2); assert.equal(result.num_contactos, 3); assert.equal(result.contactos_hoy_fecha, '2026-11-10');
  assert.equal(+query.where.created_at[Op.gte], +start); assert.equal(+query.where.created_at[Op.lte], +now);
  assert.deepEqual(query.where.lead_intake_id[Op.in], [7]); assert(!query.attributes.includes('notas'));
});
test('legacy and normalized mirrors count once despite SQL losing milliseconds', () => {
  const a = row('2026-11-10T10:00:00Z');
  assert.equal(todayCount({ historial_contactos: [{ ...a, fecha: '2026-11-10T10:00:00.384Z' }] }, [a], now, start), 1);
});
test('separate actions and repeated attempts in the same second retain multiplicity', () => {
  const a = row('2026-11-10T10:00:00Z');
  assert.equal(todayCount({ historial_contactos: [{ ...a, fecha: a.created_at }] }, [a, a], now, start), 2);
  assert.equal(todayCount({ historial_contactos: [{ ...a, usuario_id: 1, fecha: a.created_at }] }, [a], now, start), 2);
  assert.equal(todayCount({ historial_contactos: [{ ...a, canal: 'whatsapp', fecha: a.created_at }] }, [a], now, start), 2);
});
test('a failed normalized secondary write does not hide a dated legacy contact', () => {
  assert.equal(todayCount({ historial_contactos: [{ fecha: '2026-11-10 10:00:00', motivo: 'no_contesta', usuario_id: 44 }] }, [], now, start), 1);
});
test('automatic contact mirrors use the same counting rules as the lifetime total', () => {
  assert.equal(todayCount({ historial_contactos: [{ fecha: '2026-11-10T10:00:00.123Z', canal: 'whatsapp', motivo: 'lead_auto_reply', usuario_id: null }] },
    [row('2026-11-10T10:00:00Z', { canal: 'whatsapp', motivo: 'lead_auto_reply:123', usuario_id: null })], now, start), 1);
});
test('invalid, future and previous-day contacts never turn into today attempts', () => {
  const dates = ['invalid', null, '2026-11-09T22:59:59Z', '2026-11-11T09:00:00Z'];
  assert.equal(todayCount({ num_contactos: 17, historial_contactos: dates.map(fecha => ({ fecha })) }, dates.map(created_at => row(created_at)), now, start), 0);
});
test('a single read is restricted to the authorized page and the Spanish summer day', async () => {
  let calls = 0;
  const models = { LeadContactAttempt: { findAll: async q => { calls++; assert.deepEqual(q.where.lead_intake_id[Op.in], [7, 8]);
    assert.equal(q.where.created_at[Op.gte].toISOString(), '2026-06-01T22:00:00.000Z'); return [row('2026-06-01T22:00:00Z')]; } } };
  const result = await enrichContactSummary({ models, leads: [{ id: 7 }, { id: 8 }], now: new Date('2026-06-02T10:00:00Z') });
  assert.equal(calls, 1); assert.deepEqual(result.map(x => x.num_contactos_hoy), [1, 0]);
});
test('database failure stays an error rather than inventing zero contacts', async () => {
  await assert.rejects(enrichContactSummary({ models: { LeadContactAttempt: { findAll: async () => { throw Error('database_unavailable'); } } }, leads: [{ id: 7 }], now }), /database_unavailable/);
});
