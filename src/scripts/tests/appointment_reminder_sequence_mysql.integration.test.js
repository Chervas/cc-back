'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createAppointmentReminderSequenceService } = require('../../services/appointmentReminderSequence.service');
const migration = require('../../../migrations/20261014120000-create-appointment-reminder-sequences');

test('patient/clinic/day claims survive native SQL concurrency, pending jobs, historical duplicates and replay',
  { skip: process.env.APPOINTMENT_REMINDER_SEQUENCE_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const D = S.DataTypes;
      db.Sequelize = S;
      db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, configuracion: D.JSON }, { tableName: 'Clinicas', timestamps: false });
      db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Pacientes', timestamps: false });
      db.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
        clinic_id: D.INTEGER, patient_id: D.INTEGER }, { tableName: 'Conversations', timestamps: false });
      for (const [name, file] of [['CitaPaciente', 'citapaciente'], ['FlowExecutionV2', 'flowexecutionv2'],
        ['Message', 'message'], ['AutomationFlowTemplateV2', 'automationflowtemplatev2']]) db[name] = require('../../../models/' + file)(sql, D);
      await sql.sync();
      await migration.up(sql.getQueryInterface(), S);
      await migration.down(sql.getQueryInterface());
      await migration.up(sql.getQueryInterface(), S);
      db.AppointmentReminderSequence = require('../../../models/appointmentremindersequence')(sql, D);
      assert((await sql.getQueryInterface().showIndex('AppointmentReminderSequences')).find(index => index.name === 'ars_patient_clinic_day').unique);
      await db.Clinica.bulkCreate([{ id_clinica: 100, configuracion: { timezone: 'Europe/Madrid' } }, { id_clinica: 101 }]);
      await db.Paciente.bulkCreate(Array.from({ length: 9 }, (_, i) => ({ id_paciente: i + 1 })));
      const service = createAppointmentReminderSequenceService({ db, now: () => new Date('2030-01-01T08:00:00Z') });
      const appointment = async (id_cita, patient = 1, patch = {}) => db.CitaPaciente.create({ id_cita,
        clinica_id: 100, paciente_id: patient, inicio: '2030-01-03T09:00:00Z', fin: '2030-01-03T09:30:00Z',
        estado: 'pendiente', import_metadata: {}, ...patch });
      const execution = async (a, moment = 'day_before', patch = {}) => db.FlowExecutionV2.create({
        idempotency_key: 'owned-sequence-' + (await db.FlowExecutionV2.count()) + '-' + Math.random(), template_version_id: 1,
        trigger_type: 'appointment_reminder_window', trigger_entity_type: 'appointment', trigger_entity_id: a.id_cita,
        clinic_id: a.clinica_id, created_by: 1, status: 'running', context: { trigger: { schedule_moment: moment },
          appointment: { id_cita: a.id_cita, clinica_id: a.clinica_id, paciente_id: a.paciente_id, inicio: a.inicio.toISOString() } }, ...patch });
      const message = async (a, e, stage = 'day_before', patch = {}) => {
        const [cv] = await db.Conversation.findOrCreate({ where: { clinic_id: a.clinica_id, patient_id: a.paciente_id } });
        return db.Message.create({ conversation_id: cv.id, direction: 'outbound', message_type: 'template', status: 'pending',
          content: 'Owned fictitious fixture; never transported', metadata: { execution_id: e.id, appointment_timeout: stage === 'no_response',
            ...(stage === 'no_response' ? { appointment_timeout: true }
              : { template_name: 'clinicaclick_recordatorio_' + ({ week_before: 'semana_antes', day_before: 'dia_antes', same_day: 'mismo_dia' })[stage] }) }, ...patch });
      };
      const first = await appointment(11), second = await appointment(12, 1, { inicio: '2030-01-03T10:00:00Z', fin: '2030-01-03T10:30:00Z' });
      const original = [(await first.reload()).toJSON(), (await second.reload()).toJSON()];
      assert.equal((await service.inspectAppointment({ appointment: second })).anchor_appointment_id, 11);
      assert.equal((await service.inspectAppointment({ appointment: second })).follower, true);
      assert.equal(await db.AppointmentReminderSequence.count(), 0, 'inspect must not create ledger rights');
      report.checks.push('actual migration up/down/up supplies unique patient/clinic/day ledger; readonly inspect creates no row and works without AppointmentVisits');

      const contenders = await Promise.all(Array.from({ length: 8 }, () => execution(first)));
      const attempts = await Promise.all(contenders.map(e => service.claimExecution({ appointment: first, executionId: e.id, scheduleMoment: 'day_before' })));
      assert.equal(attempts.filter(result => result.allowed).length, 1);
      assert.equal(await db.AppointmentReminderSequence.count(), 1);
      const winner = contenders[attempts.findIndex(result => result.allowed)];
      const sameStageMessages = await Promise.all([message(first, winner), message(first, winner)]);
      const preSends = await Promise.all(sameStageMessages.map(m => service.authorizeMessage({ appointment: first, execution: winner, messageId: m.id, stageKey: 'day_before' })));
      assert.equal(preSends.filter(result => result.allowed).length, 1);
      const winningMessage = sameStageMessages[preSends.findIndex(result => result.allowed)];
      await winningMessage.update({ status: 'read', sent_at: null });
      assert.equal((await service.authorizeMessage({ appointment: first, execution: winner, messageId: winningMessage.id, stageKey: 'day_before' })).allowed, true);
      const restarted = createAppointmentReminderSequenceService({ db });
      const newExecution = await execution(first);
      assert.equal((await restarted.claimExecution({ appointment: first, executionId: newExecution.id, scheduleMoment: 'day_before' })).allowed, false);
      await first.update({ doctor_id: 19, instalacion_id: 20, estado: 'recordatorio_confirmado' });
      assert.equal((await restarted.claimExecution({ appointment: first, executionId: newExecution.id, scheduleMoment: 'day_before' })).allowed, false);
      const canceledReplay = await execution(first, 'same_day'); await canceledReplay.update({ status: 'cancelled' });
      await assert.rejects(service.claimExecution({ appointment: first, executionId: canceledReplay.id, scheduleMoment: 'same_day' }), /execution_inactive/);
      report.checks.push('8 simultaneous materializations yield one stage owner; 2 concurrent pre-sends one message; read with null sent_at, service restart, room/doctor move and confirmation never reopen delivery; canceled execution refused');

      const pendingFollower = await execution(second), pendingFollowerMessage = await message(second, pendingFollower);
      await pendingFollowerMessage.update({ status: 'sending' });
      assert.equal((await service.authorizeMessage({ appointment: second, execution: pendingFollower, messageId: pendingFollowerMessage.id, stageKey: 'day_before' })).allowed, false);
      const acknowledgement = await message(first, winner, 'day_before', { metadata: { execution_id: winner.id, template_name: 'clinicaclick_cita_confirmada' } });
      assert.equal((await service.authorizeMessage({ appointment: first, execution: winner, messageId: acknowledgement.id })).skipped, true);
      report.checks.push('existing pending follower cannot self-adopt a sending right; reminder execution acknowledgement remains outside reminder classification');

      const legacyFirst = await appointment(21, 2), legacyFollower = await appointment(22, 2, { inicio: '2030-01-03T09:15:00Z', fin: '2030-01-03T09:45:00Z' });
      const legacyExec1 = await execution(legacyFirst), legacyExec2 = await execution(legacyFollower);
      await message(legacyFirst, legacyExec1, 'day_before', { status: 'delivered', sent_at: null });
      await message(legacyFollower, legacyExec2, 'day_before', { status: 'read', sent_at: null });
      const adoptNew = await execution(legacyFirst);
      assert.equal((await service.claimExecution({ appointment: legacyFirst, executionId: adoptNew.id, scheduleMoment: 'day_before' })).allowed, false);
      const sealed = await db.AppointmentReminderSequence.findOne({ where: { patient_id: 2 } });
      assert.equal(sealed.claims.day_before.execution_id, legacyExec1.id);
      assert.equal(sealed.claims.day_before.attempted, true);
      report.checks.push('two already sent unlinked historical reminders are recognized before claim and sealed without merging/deleting appointments or generating messages');

      const followupFirst = await appointment(31, 3), followupLater = await appointment(32, 3, { inicio: '2030-01-03T10:00:00Z', fin: '2030-01-03T10:30:00Z' });
      const dayBefore = await execution(followupFirst), sameDay = await execution(followupFirst, 'same_day');
      await service.claimExecution({ appointment: followupFirst, executionId: dayBefore.id, scheduleMoment: 'day_before' });
      await service.claimExecution({ appointment: followupFirst, executionId: sameDay.id, scheduleMoment: 'same_day' });
      const followup1 = await message(followupFirst, dayBefore, 'no_response'), followup2 = await message(followupFirst, sameDay, 'no_response');
      const followupClaims = await Promise.all([[dayBefore, followup1], [sameDay, followup2]].map(([e, m]) => service.authorizeMessage({ appointment: followupFirst, execution: e, messageId: m.id, stageKey: 'no_response' })));
      assert.equal(followupClaims.filter(result => result.allowed).length, 1);
      await followupLater.update({ estado: 'recordatorio_confirmado' });
      const inspection = await service.inspectAppointment({ appointment: followupFirst });
      assert.equal(inspection.attendanceConfirmed, true); assert.equal(inspection.confirmedForReminder, true);
      assert.equal((await service.authorizeMessage({ appointment: followupFirst, execution: dayBefore, messageId: followup1.id, stageKey: 'no_response' })).allowed, false);
      await followupLater.update({ estado: 'pendiente' });
      assert.equal((await service.authorizeMessage({ appointment: followupFirst, execution: dayBefore, messageId: followup1.id, stageKey: 'no_response' })).allowed, false);
      report.checks.push('global no-response stage shared by day-before/same-day executions; confirmation on later PRP reservation permanently suppresses followup without editing first extraction state');

      const responded = await appointment(41, 4), respondedExec = await execution(responded);
      const respondedMessage = await message(responded, respondedExec, 'no_response');
      const inbound = await db.Message.create({ conversation_id: respondedMessage.conversation_id, direction: 'inbound', message_type: 'text', status: 'read', content: 'Owned fixture response' });
      await respondedExec.update({ context: { ...respondedExec.context, last_response_context: { response_message_id: inbound.id } } });
      assert.equal((await service.authorizeMessage({ appointment: responded, execution: respondedExec, messageId: respondedMessage.id, stageKey: 'no_response' })).reason, 'appointment_day_patient_already_replied');
      const responseLedger = await db.AppointmentReminderSequence.findOne({ where: { patient_id: 4 } });
      assert.equal(responseLedger.response_message_id, inbound.id);
      report.checks.push('real scoped inbound response receipt durably suppresses sequence followup; initial status confirmation is not required to recognize a patient reply');

      const timeoutTarget = await appointment(81, 8), timeoutExec = await execution(timeoutTarget);
      await timeoutExec.update({ context: { ...timeoutExec.context, whatsapp_no_response_timeout: true } });
      const strippedTimeout = await message(timeoutTarget, timeoutExec, 'no_response', {
        metadata: { execution_id: timeoutExec.id }, status: 'read' });
      const timeoutNew = await execution(timeoutTarget);
      const timeoutNewMessage = await message(timeoutTarget, timeoutNew, 'no_response');
      assert.equal((await service.authorizeMessage({ appointment: timeoutTarget, execution: timeoutNew,
        messageId: timeoutNewMessage.id, stageKey: 'no_response' })).allowed, false);
      assert.equal((await db.AppointmentReminderSequence.findOne({ where: { patient_id: 8 } })).claims.no_response.message_id, strippedTimeout.id);
      report.checks.push('authoritative timeout context seals old followup even if Message.appointment_timeout was absent; cannot reclassify as an acknowledgement or another stage');

      const weekFirst = await appointment(91, 9), weekFollower = await appointment(92, 9,
        { inicio: '2030-01-03T09:15:00Z', fin: '2030-01-03T09:45:00Z' });
      const weekExecution = await execution(weekFirst, 'week_before'), weekFollowerExecution = await execution(weekFollower, 'week_before');
      assert.equal((await service.claimExecution({ appointment: weekFirst, executionId: weekExecution.id, scheduleMoment: 'week_before' })).allowed, true);
      assert.equal((await service.claimExecution({ appointment: weekFollower, executionId: weekFollowerExecution.id, scheduleMoment: 'week_before' })).allowed, false);
      const weeklyMessage = await message(weekFirst, weekExecution, 'week_before');
      assert.equal((await service.authorizeMessage({ appointment: weekFirst, execution: weekExecution, messageId: weeklyMessage.id, stageKey: 'week_before' })).allowed, true);
      await weeklyMessage.update({ status: 'read' });
      await weekExecution.update({ context: { ...weekExecution.context, whatsapp_no_response_timeout: true } });
      const duplicateWeekly = await execution(weekFirst, 'week_before');
      assert.equal((await service.claimExecution({ appointment: weekFirst, executionId: duplicateWeekly.id, scheduleMoment: 'week_before' })).allowed, false);
      const weekDayExecution = await execution(weekFirst), weekTimeout = await message(weekFirst, weekExecution, 'no_response');
      const weekDayTimeout = await message(weekFirst, weekDayExecution, 'no_response');
      const weekTimeoutClaims = await Promise.all([[weekExecution, weekTimeout], [weekDayExecution, weekDayTimeout]].map(([e, m]) => service.authorizeMessage({
        appointment: weekFirst, execution: e, messageId: m.id, stageKey: 'no_response' })));
      assert.equal(weekTimeoutClaims.filter(result => result.allowed).length, 1);
      report.checks.push('native week-before stage preserves existing scheduler configuration: first arrival only, named historical receipt sticky after later timeout, global followup shared with day-before');

      const replaceable = await appointment(51, 5), reserved = await execution(replaceable);
      await service.claimExecution({ appointment: replaceable, executionId: reserved.id, scheduleMoment: 'day_before' });
      await reserved.update({ status: 'cancelled' });
      const replacement = await execution(replaceable);
      assert.equal((await service.claimExecution({ appointment: replaceable, executionId: replacement.id, scheduleMoment: 'day_before' })).allowed, true);
      const uncertain = await message(replaceable, replacement, 'day_before', { status: 'sending' });
      await replacement.update({ status: 'cancelled' });
      const forbiddenReplacement = await execution(replaceable);
      assert.equal((await service.claimExecution({ appointment: replaceable, executionId: forbiddenReplacement.id, scheduleMoment: 'day_before' })).allowed, false);
      assert.equal(uncertain.status, 'sending');
      report.checks.push('only definitely never-attempted canceled reservation can be replaced; canceled execution with sending uncertainty never releases its claim');

      const moved = await appointment(71, 7), originalDayExecution = await execution(moved);
      await service.claimExecution({ appointment: moved, executionId: originalDayExecution.id, scheduleMoment: 'day_before' });
      await message(moved, originalDayExecution, 'day_before', { status: 'delivered' });
      await originalDayExecution.update({ context: { ...originalDayExecution.context, whatsapp_no_response_timeout: true } });
      await moved.update({ inicio: '2030-01-04T09:00:00Z', fin: '2030-01-04T09:30:00Z' }); await moved.reload();
      const otherDayExecution = await execution(moved);
      assert.equal((await service.claimExecution({ appointment: moved, executionId: otherDayExecution.id, scheduleMoment: 'day_before' })).allowed, true);
      await message(moved, otherDayExecution, 'day_before', { status: 'read' });
      await moved.update({ inicio: '2030-01-03T09:00:00Z', fin: '2030-01-03T09:30:00Z' }); await moved.reload();
      const restoredDayExecution = await execution(moved);
      assert.equal((await service.claimExecution({ appointment: moved, executionId: restoredDayExecution.id, scheduleMoment: 'day_before' })).allowed, false);
      assert.equal(await db.AppointmentReminderSequence.count({ where: { patient_id: 7 } }), 2);
      report.checks.push('real A-to-B-to-A date movement retains separate local-day rights and return to original date cannot replay an already delivered reminder');

      const rollbackAppointment = await appointment(61, 6), rollbackExecution = await execution(rollbackAppointment, 'same_day');
      await assert.rejects(sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
        await service.claimExecution({ appointment: rollbackAppointment, executionId: rollbackExecution.id, scheduleMoment: 'same_day', transaction });
        throw Error('OWNED_SEQUENCE_ROLLBACK');
      }), /OWNED_SEQUENCE_ROLLBACK/);
      assert.equal(await db.AppointmentReminderSequence.count({ where: { patient_id: 6 } }), 0);
      await assert.rejects(migration.down(sql.getQueryInterface()), /durable delivery rights/);
      assert.equal(await db.CitaPaciente.count(), 13);
      assert.deepEqual((await second.reload()).toJSON(), original[1]);
      assert.equal(await db.CitaPaciente.count({ where: { paciente_id: 1 } }), 2);
      assert.equal((await sql.query('SHOW TABLES LIKE \'AppointmentVisit%\''))[0].length, 0);
      report.checks.push('native transaction rollback removes ledger claim atomically; populated downgrade refused; all fictitious reservations retained, no optional visit schema/provider/worker needed');
    });
  });
