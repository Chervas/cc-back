'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const { createService } = require('../../services/appointmentHumanFollowup.service');
const hours = loadSource('clinicOpeningHours.service', { '../../models': {} });
const rows = [1, 2, 3, 4, 5].flatMap(dia_semana => [['09:00', '13:00'], ['16:00', '19:00']]
  .map(([hora_inicio, hora_fin]) => ({ dia_semana, hora_inicio, hora_fin, activo: true })));

test('30 working minutes respects split days, weekends, DST and missing hours', () => {
  const compute = now => hours.addClinicWorkingMinutes({ now: new Date(now), minutes: 30, rows, timeZone: 'Europe/Madrid' })?.toISOString();
  assert.equal(compute('2026-10-20T10:45:00Z'), '2026-10-20T14:15:00.000Z');
  assert.equal(compute('2026-10-23T16:45:00Z'), '2026-10-26T08:15:00.000Z');
  assert.equal(compute('2026-10-20T06:00:00Z'), '2026-10-20T07:30:00.000Z');
  assert.equal(hours.addClinicWorkingMinutes({ now: new Date(), minutes: 30, rows: [] }), null);
});

test('patient director receives the existing card; no duplicate, escalation email or automatic resolution', async () => {
  let updates = 0, emits = 0, answered = false;
  const notification = { id: 1, clinicaId: 1, isRead: false, data: { appointment_human_followup: true,
    human_followup_due_at: '2026-10-20T07:00:00.000Z', quickChatConversationId: 1, quickChatResponseMessageId: 10 },
    update: async function(patch) { Object.assign(this, patch); updates++; } };
  const models = { Clinica: { findByPk: async () => ({ id_clinica: 1 }) }, ClinicaHorario: { findAll: async () => rows },
    Conversation: { findByPk: async () => ({ id: 1, clinic_id: 1 }) },
    Notification: { findAll: async () => [{ id: 1 }], findByPk: async () => notification },
    sequelize: { literal: x => x, where: (...x) => x, fn: (...x) => x, col: x => x,
      transaction: async fn => { const callbacks = []; await fn({ LOCK: { UPDATE: 'UPDATE' }, afterCommit: fn => callbacks.push(fn) });
        callbacks.forEach(fn => fn()); } } };
  const service = createService({ models, openingHours: { ...hours, resolveClinicOpenState: async () => ({ open_now: true }) }, now: () => new Date('2026-10-20T08:00:00Z'),
    findHumanReply: async () => answered ? { id: 11 } : null, emitUpdated: () => emits++,
    enrichDirection: async input => input.map(row => ({ ...row, patient_direction: { director_user_id: 9 } })),
    findAssignment: async () => { throw Error('not necessary'); } });
  const prepared = await service.prepare({ clinicId: 1, conversationId: 1, minutes: 30, userIds: [2, 3] });
  assert.deepEqual(prepared.userIds, [9]);
  assert.equal(prepared.data.human_followup_due_at, '2026-10-20T08:30:00.000Z');
  answered = true; assert.equal((await service.run()).highlighted, 0);
  answered = false; notification.isRead = true; assert.equal((await service.run()).highlighted, 0);
  notification.isRead = false; assert.equal((await service.run()).highlighted, 1);
  assert.equal(notification.isRead, false); assert.equal(notification.level, 'error');
  assert.equal((await service.run()).highlighted, 0);
  assert.equal(updates, 1); assert.equal(emits, 1);
});
