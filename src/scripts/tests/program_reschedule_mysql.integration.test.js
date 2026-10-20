'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');

test('owned SQL reschedule: only existing future reservations, civil DST shift, exact atomic batch, stale/occupied rollback and replay',
  { skip: process.env.PROGRAM_RESCHEDULE_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const f = await createOwnedProgramResumeFixture({ sql, models: db });
      await f.book({ request_key: 'owned-before-reschedule', sessions: [
        { key: 's0', start_at: '2030-03-18T09:00:00.000Z' }, { key: 's2', start_at: '2030-03-25T09:00:00.000Z' }, { key: 's4', start_at: '2030-04-01T08:00:00.000Z' },
      ] });
      const baseline = await f.databaseState(), originalIds = [await f.appointment('s0'), await f.appointment('s2'), await f.appointment('s4')].map(row => row.id_cita);
      await assert.rejects(f.move(originalIds[1], '2030-03-26T09:00:00.000Z', '2030-03-26T09:45:00.000Z'), error => error.code === 'program_reschedule_required');
      assert.deepEqual(await f.databaseState(), baseline);
      const plan = await f.read(), base = { mode: 'reschedule', reschedule_scope: 'following', replan_from_key: 's2', expected_plan_revision: plan.plan_revision };
      const preview = await f.propose({ ...base, reschedule_start_local: '2030-04-01T12:00' });
      assert.deepEqual(preview.reschedule.affected_keys, ['s2', 's4']); assert.equal(preview.reschedule.source_appointment_id, originalIds[1]);
      assert.deepEqual(preview.proposals.map(row => row.requested_start_local), ['2030-04-01T12:00', '2030-04-08T12:00']);
      assert.deepEqual(preview.proposals.map(row => row.solution?.start_at), ['2030-04-01T10:00:00.000Z', '2030-04-08T10:00:00.000Z']);
      assert.equal(preview.proposals[0].selections.t1_p1.installation_id, 101); assert.equal(preview.proposals[0].selections.t1_p1.doctor_id, 1);
      assert.deepEqual(await f.databaseState(), baseline);
      const payload = { ...base, request_key: 'owned-move-following-reserved', sessions: preview.proposals.map(row => ({ key: row.key,
        start_at: row.solution.start_at, selections: row.selections, priority_acknowledged: row.priority_acknowledged })) };
      for (const bad of [
        { ...payload, sessions: payload.sessions.slice(0, 1) },
        { ...payload, sessions: [...payload.sessions, { key: 's3', start_at: '2030-04-06T10:00:00.000Z' }] },
        { ...payload, sessions: payload.sessions.map(row => row.key === 's4' ? { ...row, start_at: '2030-04-08T11:00:00.000Z' } : row) },
      ]) { await assert.rejects(f.book(bad)); assert.deepEqual(await f.databaseState(), baseline); }
      const moved = await f.book(payload); assert.equal(moved.sessions.length, 2); assert(moved.sessions.every(row => row.action === 'rescheduled'));
      assert.deepEqual(Array.from(moved.sessions, row => row.appointment_id), originalIds.slice(1));
      assert.equal(await db.CitaPaciente.count(), 3); assert.equal(await db.PatientProgramSession.count(), 3);
      assert.equal(await f.byKey('s1'), null); assert.equal(await f.byKey('s3'), null);
      assert.equal(new Date((await f.appointment('s0')).inicio).toISOString(), '2030-03-18T09:00:00.000Z');
      assert.equal((await f.book(payload)).replayed, true);
      const after = await f.databaseState();
      for (const table of ['PatientVoucher', 'PatientVoucherMovement', 'EconomicBudget', 'EconomicBudgetVersion', 'EconomicPayment', 'ConsentDeliveryEvent']) {
        assert.deepEqual(after[table], baseline[table]);
      }
      for (const key of ['s2', 's4']) {
        const row = await f.appointment(key); assert.equal(row.import_metadata.automation_policy, 'hold');
        assert.deepEqual(row.import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
        assert((await f.physical.occupancy(row.id_cita)).some(item => item.resource_key === 'equipment:401'));
      }
      await assert.rejects(f.book({ ...payload, request_key: 'owned-stale-reschedule-key' }), error => error.code === 'program_resume_changed');
      assert.deepEqual(await f.databaseState(), after);
      report.checks.push('Real SQL following reschedule shifts only existing reservations by identical clinic civil delta across DST; keeps earlier and never-booked sessions untouched, preserves IDs/resources/equipment/HOLD/finances, rejects missing/extra/unequal dates atomically and replays one receipt');

      const singlePlan = await f.read(), single = { mode: 'reschedule', reschedule_scope: 'single', replan_from_key: 's2', expected_plan_revision: singlePlan.plan_revision };
      const singlePreview = await f.propose({ ...single, reschedule_start_local: '2030-04-02T12:00' });
      assert.deepEqual(singlePreview.reschedule.affected_keys, ['s2']);
      const singlePayload = { ...single, request_key: 'owned-single-reschedule-key', sessions: singlePreview.proposals.map(row => ({ key: row.key,
        start_at: row.solution.start_at, selections: row.selections, priority_acknowledged: row.priority_acknowledged })) };
      await f.book(singlePayload); assert.equal(new Date((await f.appointment('s4')).inicio).toISOString(), '2030-04-08T10:00:00.000Z');
      const peer = await f.peer('alias', '2030-04-03T10:00:00.000Z');
      const busyPlan = await f.read(), busy = { ...single, expected_plan_revision: busyPlan.plan_revision };
      const unavailable = await f.propose({ ...busy, reschedule_start_local: '2030-04-03T12:00' });
      assert.equal(unavailable.proposals[0].solution, null); assert.equal(unavailable.proposals[0].requested_start_local, '2030-04-03T12:00');
      assert.equal(unavailable.proposals[0].requested_start_at, '2030-04-03T10:00:00.000Z'); assert(unavailable.proposals[0].selections.t1_p1);
      const beforeBusy = await f.databaseState();
      await assert.rejects(f.book({ ...busy, request_key: 'owned-busy-reschedule-key', sessions: [{ key: 's2', start_at: '2030-04-03T10:00:00.000Z', selections: unavailable.proposals[0].selections }] }), error => error.code === 'program_booking_unavailable');
      assert.deepEqual(await f.databaseState(), beforeBusy);
      assert(peer.id_cita);
      report.checks.push('Single reschedule uses the same canonical receipt/transaction and leaves all following dates fixed; an actually busy shared room is never silently moved or overridden, yet preview retains exact requested dates/resources for UI');
      await f.cancelPeer(peer);
      const member = await db.DoctorClinica.findOne({ where: { doctor_id: 1, clinica_id: 100 } });
      await db.DoctorHorario.destroy({ where: { doctor_clinica_id: member.id } });
      const closedPlan = await f.read(), closed = { ...single, expected_plan_revision: closedPlan.plan_revision };
      const closedPreview = await f.propose({ ...closed, reschedule_start_local: '2030-04-04T12:00' });
      assert.equal(closedPreview.proposals[0].requires_schedule_confirmation, true);
      const closedRequest = { ...closed, request_key: 'owned-closed-reschedule-key', sessions: closedPreview.proposals.map(row => ({ key: row.key,
        start_at: row.solution.start_at, selections: row.selections, priority_acknowledged: row.priority_acknowledged })) };
      const beforeClosed = await f.databaseState(); let acknowledgement;
      await assert.rejects(f.book(closedRequest), error => { acknowledgement = error.details.schedule_acknowledgement; return error.code === 'program_schedule_confirmation_required'; });
      assert.deepEqual(await f.databaseState(), beforeClosed);
      await assert.rejects(f.service.book({ ...f.options, actorId: 2, payload: { ...closedRequest, snapshot_sha256: f.frozen.sha256,
        schedule_acknowledgement: acknowledgement } }), error => error.code === 'program_schedule_confirmation_required');
      assert.deepEqual(await f.databaseState(), beforeClosed);
      const confirmed = await f.book({ ...closedRequest, schedule_acknowledgement: acknowledgement });
      assert.equal(confirmed.schedule_exception_confirmed, true); assert.equal(confirmed.sessions[0].appointment_id, originalIds[1]);
      const afterClosed = await f.databaseState();
      assert.equal((await f.book({ ...closedRequest, schedule_acknowledgement: acknowledgement })).replayed, true);
      assert.deepEqual(await f.databaseState(), afterClosed);
      await f.budget.update({ status: 'presented' });
      const notAccepted = await f.read();
      await assert.rejects(f.book({ ...closedRequest, request_key: 'owned-budget-no-bypass-key', expected_plan_revision: notAccepted.plan_revision }), error => error.code === 'program_purchase_not_schedulable');
      report.checks.push('A staff-hours-only reschedule requires the exact actor-bound batch acknowledgement and reuses the same appointment/receipt; absent acknowledgement or another actor changes no rows, replay is inert, and a pending budget still cannot be bypassed');
    });
  });
