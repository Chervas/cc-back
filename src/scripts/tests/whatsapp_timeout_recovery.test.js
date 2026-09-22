'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('./fixtures/campaign_offline_runtime.cjs');
const { decide, deliveryKey } = require('../../lib/whatsappAppointmentTimeout');
const { state } = require('../../lib/whatsappInboxHealth');
const now = Date.parse('2026-09-22T12:00:00Z');
function input() {
  const appointment = { id_cita: 1, clinica_id: 2, inicio: '2026-09-22T17:00:00Z', estado: 'info_enviada' };
  return { now, execution: { id: 4, clinic_id: 2, trigger_entity_id: 1, wait_until: new Date(now), waiting_meta: {} },
    context: { appointment }, nextNode: { type: 'action/send_whatsapp' },
    snapshot: { version: 1, observedAt: now, clinics: [{ clinicId: 2, oldestPendingAt: null, blockingReview: 0 }] },
    loadAppointment: async () => appointment, hasReply: async () => false, hasAskedToday: async () => false };
}
test('ordinary future flows retain their planned no-response reminder', async () => {
  const i = input(); i.context.appointment.inicio = '2026-09-23T17:00:00Z';
  assert.deepEqual(await decide(i), { action: 'continue' });
});
test('receiver outage or stale heartbeat cannot send or cancel; clinic health remains isolated', async () => {
  for (const snapshot of [null, { ...input().snapshot, observedAt: now - 90001 }, { ...input().snapshot, recoveryHold: true },
    { ...input().snapshot, clinics: [{ clinicId: 2, oldestPendingAt: now - 120001, blockingReview: 0 }] },
    { ...input().snapshot, clinics: [{ clinicId: 2, oldestPendingAt: null, blockingReview: 1 }] }]) {
    assert.equal((await decide({ ...input(), snapshot })).action, 'wait');
    assert.equal((await decide({ ...input(), snapshot, nextNode: { type: 'action/change_status' } })).action, 'wait');
  }
  const snapshot = input().snapshot; snapshot.clinics.push({ clinicId: 3, oldestPendingAt: now - 1e7, blockingReview: 1 });
  assert.equal(state(snapshot, 2, now).healthy, true); assert.equal(state(snapshot, 3, now).healthy, false);
});
test('reply already imported suppresses timeout even when passive recovery did not dispatch IA', async () => {
  assert.deepEqual(await decide({ ...input(), hasReply: async () => true }), { action: 'stop', reason: 'reply_already_received' });
});
test('recovery allows at most one request today and never catches up yesterday or tomorrow', async () => {
  for (const date of ['2026-09-21T17:00:00Z', '2026-09-23T17:00:00Z']) {
    const i = input(); i.context.appointment.inicio = date; i.execution.waiting_meta.inbox_held_since = new Date(now-60000).toISOString();
    assert.equal((await decide(i)).action, 'stop');
  }
  const i = input(); i.execution.wait_until = new Date(now - 6 * 60000);
  const allowed = await decide(i); assert.equal(allowed.action, 'continue'); assert.equal(allowed.recovery.appointmentId, 1);
  assert.equal((await decide({ ...i, hasAskedToday: async () => true })).action, 'stop');
  assert.equal((await decide({ ...i, nextNode: { type: 'action/change_status', config: { status: 'cancelada' } } })).action, 'stop');
  const e = { ...i.execution, context: { whatsapp_timeout_recovery: allowed.recovery } };
  assert.equal(deliveryKey(e), deliveryKey({ ...e, id: 999 })); // Existing unique SQL key spans concurrent executions.
  assert.notEqual(deliveryKey(e), deliveryKey({ ...e, clinic_id: 9 }));
});
test('explicit recovery cut survives restart and catches a recently due timer', async () => {
  const i=input(); i.snapshot.recoveryNotBefore=new Date(now+1).toISOString();
  assert.ok((await decide(i)).recovery);
});
test('cancelled, moved, completed and past appointments never cause a timeout side effect', async () => {
  for (const change of [{ estado: 'cancelada' }, { estado: 'completada' }, { estado: 'cambio_solicitado' },
    { inicio: '2026-09-22T11:59:00Z' }, { inicio: '2026-09-22T18:00:00Z' }, { clinica_id: 3 }]) {
    const i=input(); i.loadAppointment=async()=>({...i.context.appointment,...change});
    assert.equal((await decide(i)).action, 'stop');
  }
});
