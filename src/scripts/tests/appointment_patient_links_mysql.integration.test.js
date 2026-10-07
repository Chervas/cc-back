'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
test('patient links: real SQL birth, scope, confirmed owner, atomic movement, rollback, unlink and compound exclusion',
 { skip: process.env.PATIENT_LINK_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
  await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
   const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
   Object.assign(process.env, { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' });
   const links = require('../../services/appointmentPatientLinks.service');
   const command = require('../../services/appointmentBookingCommand.service');
   const activityFile = require.resolve('../../services/appointmentActivity.service');
   require.cache[activityFile] = { id: activityFile, filename: activityFile, loaded: true, exports: { recordAppointmentStatusChange: async () => {} } };
   try {
    await require('../../../migrations/20261007170000-create-appointment-patient-links').up(sql.getQueryInterface(), S);
    db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(sql, S.DataTypes);
    db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(sql, S.DataTypes);
    const values = f.values({ tratamiento_id: 4, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' });
    const owner = await f.reserve({ appointmentValues: { ...values, estado: 'info_confirmada' } });
    const next = { ...values, inicio: '2030-01-07T10:30:00Z', fin: '2030-01-07T11:00:00Z' };
    const clinic = await db.Clinica.findByPk(100);
    await assert.rejects(links.choiceRequired(db, next, clinic), error => error.code === 'appointment_same_day_choice_required' && error.details.appointments.length === 1);
    await links.choiceRequired(db, next, clinic, { mode: 'separate' });
    await owner.reload();
    const choice = { mode: 'link', appointment_id: owner.id_cita, updated_at: owner.updated_at };
    const follower = await f.reserve({ appointmentValues: next,
      persist: async ({ values, transaction }) => {
        const row = await db.CitaPaciente.create(values, { transaction });
        await links.linkAtBirth(db, row, choice, 1, transaction); return row;
      } });
    assert.equal(follower.estado, 'info_confirmada');
    assert.equal(await links.follower(db, owner.id_cita), false); assert.equal(await links.follower(db, follower.id_cita), true);
    // Real runtime functions + actual membership SQL. Queue/provider boundaries
    // are tripwires: a follower must return before creating any execution/send.
    const runtimeFile = require.resolve('../../services/appointmentAutomationV2Runtime.service'), actualRequire = createRequire(runtimeFile);
    const runtimeModule = { exports: {} }, queued = [];
    const runtimeDb = { ...db, JobRequest: { findAll: async () => [] } };
    vm.runInNewContext(fs.readFileSync(runtimeFile, 'utf8'), { module: runtimeModule, exports: runtimeModule.exports,
      require: name => name === '../../models' ? runtimeDb : name === './appointmentVisitManaged.service'
        ? { current: () => ({ publishCita: async () => null, syncReminderIntents: async () => null }) }
        : name === './jobScheduler.service' ? { triggerImmediate: () => { queued.push('unexpected'); throw Error('unexpected scheduler'); } }
          : name === './jobRequests.service' ? { enqueueUniqueJobRequest: async () => { queued.push('unexpected'); throw Error('unexpected queue'); } }
          : actualRequire(name), console, process, Date, Map, Set, Buffer, URL, setTimeout, clearTimeout }, { filename: runtimeFile });
    for (const result of [await runtimeModule.exports.enqueueExecutionForCita(follower, { event_name: 'appointment_created' }),
      await runtimeModule.exports.enqueueExecutionForTemplate(follower, { trigger_type: 'appointment_reminder_window' }),
      await runtimeModule.exports.syncScheduledTriggersForCita(follower)]) assert.equal(result.reason, 'linked_appointment_uses_first_notice');
    assert.equal(queued.length, 0);
    const rows = await db.CitaPaciente.findAll(); await links.decorate(db, rows);
    assert.equal(rows.find(row => row.id_cita === owner.id_cita).getDataValue('appointment_link').index, 1);
    assert.equal(rows.find(row => row.id_cita === follower.id_cita).getDataValue('appointment_link').index, 2);
    await sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const group = await links.load(db, owner.id_cita, transaction, true);
      const current = await command.mutateAppointmentBooking({ db, transaction, capabilities: f.capabilities, existingAppointmentId: owner.id_cita,
        stateOnly: true, appointmentValues: { estado: 'recordatorio_confirmado' }, persist: ({ values, existing }) => existing.update(values, { transaction }) });
      assert.equal(group.rows.length, 2);
      const confirmed = await links.confirmTogether(db, current, 'recordatorio_confirmado', transaction, 1);
      assert.equal(confirmed.length, 1);
    });
    assert.equal((await f.read(follower.id_cita)).estado, 'recordatorio_confirmado');
    await sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const current = await command.mutateAppointmentBooking({ db, transaction, capabilities: f.capabilities,
        existingAppointmentId: follower.id_cita, stateOnly: true, appointmentValues: { estado: 'cambio_solicitado' },
        persist: ({ values, existing }) => existing.update(values, { transaction }) });
      const changed = await links.confirmTogether(db, current, 'cambio_solicitado', transaction, 1);
      assert.equal(changed.length, 1); assert.equal(changed[0].id_cita, owner.id_cita);
    });
    assert.equal((await f.read(owner.id_cita)).estado, 'cambio_solicitado');
    await owner.update({ care_started_at: new Date() });
    await assert.rejects(sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const current = await command.mutateAppointmentBooking({ db, transaction, capabilities: f.capabilities,
        existingAppointmentId: follower.id_cita, stateOnly: true, appointmentValues: { estado: 'cancelada' },
        persist: ({ values, existing }) => existing.update(values, { transaction }) });
      await links.confirmTogether(db, current, 'cancelada', transaction, 1);
    }), error => error.code === 'appointment_link_care_started');
    assert.equal((await f.read(follower.id_cita)).estado, 'cambio_solicitado');
    await owner.update({ care_started_at: null });
    const moved = await links.moveTogether(db, follower.id_cita, { inicio: '2030-01-07T13:30:00Z', fin: '2030-01-07T14:00:00Z',
      estado: 'reprogramada', reschedule_reason: 'administrative_error', updated_by: 1 }, {});
    assert.equal(moved.rows.length, 2); assert.equal(+new Date((await f.read(owner.id_cita)).inicio), +new Date('2030-01-07T13:00:00Z'));
    const occupancy = await f.occupancy(owner.id_cita); assert(occupancy.every(row => +new Date(row.start_at) >= +new Date('2030-01-07T13:00:00Z')));
    const before = JSON.stringify(await f.read(owner.id_cita));
    await assert.rejects(links.moveTogether(db, owner.id_cita, { inicio: '2030-01-07T23:00:00Z', fin: '2030-01-07T23:30:00Z',
      estado: 'reprogramada', updated_by: 1 }, {}));
    assert.equal(JSON.stringify(await f.read(owner.id_cita)), before);
    const beforeCount = await db.CitaPaciente.count();
    await assert.rejects(f.reserve({ appointmentValues: { ...next, paciente_id: 2, inicio: '2030-01-07T14:30:00Z', fin: '2030-01-07T15:00:00Z' },
      persist: async ({ values, transaction }) => {
        const row = await db.CitaPaciente.create(values, { transaction }); await links.linkAtBirth(db, row, choice, 1, transaction); return row;
      } }), error => error.code === 'appointment_link_invalid');
    assert.equal(await db.CitaPaciente.count(), beforeCount);
    const compound = await f.reserve({ appointmentValues: f.values({ tratamiento_id: 2, inicio: '2030-01-07T15:00:00Z', fin: '2030-01-07T15:45:00Z' }),
      durationSelection: { phase_durations: { one: 30, two: 30 } } });
    await assert.rejects(sql.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => links.linkAtBirth(db, compound,
      { mode: 'link', appointment_id: owner.id_cita, updated_at: owner.updated_at }, 1, transaction)), error => error.code === 'appointment_link_invalid');
    await links.unlink(db, follower.id_cita, 1);
    assert.equal(await links.follower(db, follower.id_cita), false);
    assert.equal(await links.membership(db, owner.id_cita), null);
    assert.equal(await db.CitaPaciente.count(), 3);
    report.checks.push('Actual canonical reservations linked transactionally: owner confirmation inherited and propagated, DTO1/2,2/2, group move from follower preserves offsets, failed move rolls back, compound cannot link/unlink, dissolving group preserves reservations');
   } finally { await f.close(); }
  });
 });
