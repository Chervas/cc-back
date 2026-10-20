'use strict';

// Explicit opt-in; starts and owns its own socket-only mysqld. No application
// bootstrap, existing schema, provider, credentials or shared/DEV/CRM database.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');
const clone = value => JSON.parse(JSON.stringify(value));

test('owned SQL: exact closed-clinician batch acknowledgement, stale facts, canonical occupancy, rollback and replay',
  { skip: process.env.PROGRAM_SCHEDULE_CONFIRMATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const f = await createOwnedProgramResumeFixture({ sql, models: db });
      const membership = await db.DoctorClinica.findOne({ where: { doctor_id: 1, clinica_id: 100 } });
      // This is the owned synthetic database, not an operational schedule.
      await db.DoctorHorario.destroy({ where: { doctor_clinica_id: membership.id } });
      const session = (key, date) => ({ key, start_at: `${date}T09:00:00.000Z`, selections: {
        t1_p1: { doctor_id: 1, installation_id: 101 }, t1_p2: { doctor_id: 2, installation_id: 102 },
      } });
      const request = { request_key: 'owned-closed-schedule-batch', sessions: [session('s0', '2030-02-04'), session('s1', '2030-02-11')] };
      const preview = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s0'],
        manual_sessions: [{ ...request.sessions[0], start_local: '2030-02-04T10:00' }] });
      assert.equal(preview.proposals[0].requires_schedule_confirmation, true);
      assert.match(preview.resource_options.professionals.find(row => row.id === 1)?.name || '', /^Profesional ficticio 1/);
      const before = await f.databaseState();
      let receipt;
      await assert.rejects(f.book(request), error => {
        assert.equal(error.code, 'program_schedule_confirmation_required'); receipt = error.details.schedule_acknowledgement;
        assert.deepEqual(error.details.batch_restrictions.map(row => row.key), ['s0', 's1']); return true;
      });
      assert.deepEqual(await f.databaseState(), before);
      report.checks.push('Manual exact preview exposes scoped names and closed-staff warnings; unconfirmed SQL batch rolls back with no session/appointment/occupancy/event rows');
      const budget = clone(await f.budget.reload()), purchase = clone(await f.voucher.reload());
      const accepted = await f.book({ ...request, schedule_acknowledgement: receipt });
      assert.equal(accepted.schedule_exception_confirmed, true); assert.equal(accepted.sessions.length, 2);
      for (const key of ['s0', 's1']) {
        const appointment = await f.appointment(key);
        assert.equal(appointment.import_metadata.automation_policy, 'hold');
        assert.equal(appointment.import_metadata.program_schedule_confirmation.acknowledgement, receipt);
        assert.equal(appointment.import_metadata.program_schedule_confirmation.confirmed_by, 1);
        const occupancy = await f.physical.occupancy(appointment.id_cita);
        assert(occupancy.some(row => row.resource_key === 'doctor:1'));
        assert(occupancy.some(row => row.resource_key === 'equipment:401'));
      }
      assert.deepEqual(clone(await f.budget.reload()), budget); assert.deepEqual(clone(await f.voucher.reload()), purchase);
      assert.equal((await f.book({ ...request, schedule_acknowledgement: receipt })).replayed, true);
      assert.equal(await db.CitaPaciente.count({ where: { voucher_id: f.voucher.id } }), 2);
      report.checks.push('Acknowledged SQL batch creates real staff, physical-room and machine occupancy with per-appointment audit, unchanged price/balance/budget and HOLD; replay duplicates nothing');
      const another = { request_key: 'owned-closed-schedule-stale', sessions: [session('s2', '2030-02-18')] };
      let prior;
      await assert.rejects(f.book(another), error => { prior = error.details.schedule_acknowledgement; return error.code === 'program_schedule_confirmation_required'; });
      await db.DoctorHorario.create({ doctor_clinica_id: membership.id, dia_semana: 1, hora_inicio: '07:00', hora_fin: '08:00' });
      const unchanged = await f.databaseState();
      await assert.rejects(f.book({ ...another, schedule_acknowledgement: prior }), error => error.code === 'program_schedule_confirmation_required'
        && error.details.schedule_acknowledgement !== prior);
      assert.deepEqual(await f.databaseState(), unchanged);
      report.checks.push('Changed SQL schedule facts invalidate the previous exact batch receipt and preserve all appointments and economic evidence');
    });
  });
