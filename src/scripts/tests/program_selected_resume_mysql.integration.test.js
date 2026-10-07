'use strict';

// OWNED mysqld only; no real DB, model bootstrap, app flags, provider or queue.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 PROGRAM_SELECTED_RESUME_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();

test('selected resume: owned SQL suffix, immutable prefix, fixed capacity, canonical locks, CAS, full rollback and replay',
  { skip: process.env.PROGRAM_SELECTED_RESUME_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const f = await createOwnedProgramResumeFixture({ sql, models: db });
      const initial = await f.book({ request_key: 'owned-initial', sessions: [
        { key: 's0', start_at: '2030-01-07T09:03:00.000Z' }, { key: 's3', start_at: '2030-01-14T09:00:00.000Z' },
      ] });
      assert.equal(initial.sessions.length, 2);
      const completed = await f.appointment('s0'), oldFuture = await f.appointment('s3');
      // New program payloads require :00 seconds. Existing appointment history
      // can carry seconds: seed that through the actual canonical edit writer,
      // including its snapshots/occupancies, before the historical completion.
      await f.move(completed.id_cita, '2030-01-07T09:03:07.000Z', '2030-01-07T09:48:07.000Z');
      await completed.reload();
      // Explicit historical fixture seed, not a tested new completion or charge.
      const movement = await db.PatientVoucherMovement.create({ voucher_id: f.voucher.id, movement_type: 'consumption', units: -1,
        appointment_id: completed.id_cita, occurred_at: '2030-01-07T09:48:07Z', created_by: 1, notes: 'Consumo histórico ficticio ya existente' });
      await completed.update({ estado: 'completada', nota: 'Texto humano anterior íntegro', import_metadata: { ...completed.import_metadata,
        human_evidence: { original_instant: '2030-01-07T09:03:07.123Z', untouched: true } } });
      await (await f.byKey('s0')).update({ consumption_movement_id: movement.id });
      await f.voucher.update({ available_units: 4 });
      const pendingPrefix = await db.PatientProgramSession.create({ voucher_id: f.voucher.id, session_key: 's1', position: 1,
        snapshot_sha256: f.frozen.sha256, snapshot: { ...f.operational.appointments[1], program_cadence: null, fixture_evidence: { remains_pending: true } } });
      await oldFuture.update({ nota: 'Nota humana de la cita futura' });
      f.advance('2030-01-08T00:00:00Z');
      const plan = await f.read();
      assert.equal(plan.resume, null); assert.equal(plan.can_schedule, true); assert.equal(plan.can_resume, true);
      assert.equal(plan.sessions[0].scheduling_status, 'completed'); assert.equal(plan.sessions[1].scheduling_status, 'pending');
      assert.equal(plan.resume_options.find(o => o.from_key === 's2').affected_count, 3);
      assert.equal(plan.resume_options.find(o => o.from_key === 's2').earlier_pending_count, 1);
      const prefix = { appointment: clone(await completed.reload()), records: clone([await (await f.byKey('s0')).reload(), await pendingPrefix.reload()]),
        occupancy: clone(await f.physical.occupancy(completed.id_cita)), movements: await f.all('PatientVoucherMovement'),
        purchase: clone(await f.voucher.reload()), budget: clone(await f.budget.reload()), version: await f.all('EconomicBudgetVersion') };
      assert.equal(iso(prefix.appointment.inicio), '2030-01-07T09:03:07.000Z');
      const mode = await f.resume('s2'), beforePreview = await f.databaseState();
      const empty = await f.propose({ ...mode, from_date: '2030-02-04', days: 1 });
      assert.deepEqual(empty.proposals.map(row => row.key), ['s2', 's3', 's4']);
      assert(empty.proposals.every(row => row.solution === null));
      assert.equal(empty.sessions.find(row => row.key === 's3').previous_appointment.start_at, '2030-01-14T09:00:00.000Z');
      assert.deepEqual(await f.databaseState(), beforePreview);
      report.checks.push('Server origin3 projects suffix3–5 only; old dates remain history, manual dates stay NULL, realized/consumed1 and pending2 unchanged');

      const manual = async (key, startLocal, fixed = [], extra = {}) => f.propose({ ...await f.resume('s2'), from_date: startLocal.slice(0, 10), days: 1,
        session_keys: [key], manual_sessions: [{ key, start_local: startLocal }], fixed_sessions: fixed, ...extra });
      const fixedPreview = await manual('s3', '2030-02-06T10:00');
      const fixedSlot = fixedPreview.proposals[0].solution; assert(fixedSlot);
      assert.equal(new Date(fixedSlot.end_at) - new Date(fixedSlot.start_at), 45 * 60000);
      assert.deepEqual(fixedSlot.phases.map(phase => iso(phase.start_at)), ['2030-02-06T09:00:00.000Z', '2030-02-06T09:15:00.000Z']);
      const fixed = [{ key: 's3', start_at: fixedSlot.start_at, selections: f.selections(fixedSlot) }];
      assert.equal((await manual('s2', '2030-02-04T10:00', fixed)).proposals[0].solution.start_at, '2030-02-04T09:00:00.000Z');
      await assert.rejects(manual('s2', '2030-02-04T10:00', [{ ...fixed[0], selections: { forged_phase: { installation_id: 101 } } }]), { code: 'program_selection_invalid' });
      await assert.rejects(manual('s2', '2030-02-04T10:00', [{ ...fixed[0], key: 's1' }]), { code: 'program_search_invalid' });
      // The chosen fixed date is revalidated physically, not trusted merely
      // because it had a successful preview a moment earlier.
      let peer = await f.peer('alias', '2030-02-06T09:00:00Z');
      assert((await f.physical.occupancy(peer.id_cita)).some(row => row.resource_key === 'installation:101'));
      await assert.rejects(manual('s2', '2030-02-04T10:00', fixed), { code: 'program_fixed_session_unavailable' }); await f.cancelPeer(peer);
      peer = await f.peer('machine', '2030-02-06T08:50:00Z');
      assert((await f.physical.occupancy(peer.id_cita)).some(row => row.resource_key === 'equipment:401' && iso(row.end_at) === '2030-02-06T09:30:00.000Z'));
      await assert.rejects(manual('s2', '2030-02-04T10:00', fixed), { code: 'program_fixed_session_unavailable' }); await f.cancelPeer(peer);
      peer = await f.peer('independent', '2030-02-06T09:00:00Z', 1);
      await assert.rejects(manual('s2', '2030-02-04T10:00', fixed), { code: 'program_fixed_session_unavailable' }); await f.cancelPeer(peer);
      report.checks.push('Fixed sessions use exact phases, staff and room; real cross-clinic alias, shared machine/turnaround10 and independent patient conflict block the preview');

      // Two nearby new choices use real virtual occupancy and turnaround;
      // their old source appointment is not an automatically retained new date.
      const near = await manual('s4', '2030-02-06T10:35', fixed);
      assert.equal(near.proposals[0].solution, null);
      assert((await manual('s2', '2030-02-04T10:00', fixed)).proposals[0].solution);
      report.checks.push('Real solver span45 and offsets0/15 survive composition; fixed chosen slots enter virtual busy and prevent contradictory new dates');

      const choices = [];
      for (const [key, local] of [['s2', '2030-02-04T10:00'], ['s3', '2030-02-06T10:00'], ['s4', '2030-02-08T10:00']]) {
        const proposal = (await manual(key, local)).proposals[0]; assert(proposal.solution);
        choices.push({ key, start_at: proposal.solution.start_at, selections: f.selections(proposal.solution) });
      }
      let request = { request_key: 'owned-selected-resume', ...await f.resume('s2'), sessions: choices };
      let before = await f.databaseState();
      await assert.rejects(f.book({ ...request, sessions: choices.slice(1) }), { code: 'program_resume_incomplete' });
      assert.deepEqual(await f.databaseState(), before);
      await assert.rejects(f.book({ ...request, sessions: [...choices, { ...choices[0], key: 's1' }] }), { code: 'program_resume_incomplete' });
      assert.deepEqual(await f.databaseState(), before);
      const prefixAppointment = await completed.reload();
      await prefixAppointment.update({ nota: 'Edición humana concurrente legítima' });
      before = await f.databaseState();
      await assert.rejects(f.book(request), { code: 'program_resume_changed' }); assert.deepEqual(await f.databaseState(), before);
      prefix.appointment = clone(await completed.reload()); // The later human change becomes the preserved baseline.
      request = { ...request, ...await f.resume('s2') };
      await f.voucher.update({ available_units: 3 }); before = await f.databaseState();
      await assert.rejects(f.book(request), { code: 'program_resume_changed' }); assert.deepEqual(await f.databaseState(), before);
      await f.voucher.update({ available_units: 4 }); request = { ...request, ...await f.resume('s2') };
      prefix.purchase = clone(await f.voucher.reload());
      report.checks.push('Full affected-set guard and complete SQL revision CAS reject missing/extra units, prefix human edit and balance change without writing any schedule');

      // A competing real physical unit is inserted AFTER all previews. This
      // failure occurs late in the suffix, after earlier writes in the same tx.
      peer = await f.peer('machine', '2030-02-08T09:00:00Z');
      before = await f.databaseState();
      await assert.rejects(f.book(request), { code: 'program_booking_unavailable' });
      assert.deepEqual(await f.databaseState(), before); await f.cancelPeer(peer);
      // Receipt persistence failure is another genuinely late SQL rollback.
      const failReceipt = rows => { if (rows.some(row => row.phase_key === 't1_p2' && iso(row.start_at) === '2030-02-08T09:15:00.000Z')) throw Error('OWNED_SUFFIX_RECEIPT_FAILURE'); };
      db.AppointmentBookingOccupancy.addHook('beforeBulkCreate', 'owned-selected-resume-failure', failReceipt);
      before = await f.databaseState();
      try { await assert.rejects(f.book(request), /OWNED_SUFFIX_RECEIPT_FAILURE/); }
      finally { db.AppointmentBookingOccupancy.removeHook('beforeBulkCreate', 'owned-selected-resume-failure'); }
      assert.deepEqual(await f.databaseState(), before);
      report.checks.push('Late physical conflict and late SQL occupancy failure atomically roll back new appointments, moved existing ID, session pointers, locks, events and request');

      const result = await f.book(request);
      assert.deepEqual(clone(result.sessions.map(row => row.action)), ['created', 'rescheduled', 'created']);
      assert.equal(result.sessions[1].appointment_id, oldFuture.id_cita);
      assert.deepEqual(clone(await completed.reload()), prefix.appointment);
      assert.deepEqual(clone([await (await f.byKey('s0')).reload(), await pendingPrefix.reload()]), prefix.records);
      assert.deepEqual(clone(await f.physical.occupancy(completed.id_cita)), prefix.occupancy);
      assert.deepEqual(await f.all('PatientVoucherMovement'), prefix.movements);
      assert.deepEqual(clone(await f.voucher.reload()), prefix.purchase); assert.deepEqual(clone(await f.budget.reload()), prefix.budget);
      assert.deepEqual(await f.all('EconomicBudgetVersion'), prefix.version);
      assert.equal((await f.read()).sessions[1].scheduling_status, 'pending'); assert.equal((await f.byKey('s1')).appointment_id, null);
      for (const created of result.sessions) {
        const row = await f.physical.read(created.appointment_id), occupancy = await f.physical.occupancy(created.appointment_id);
        assert.equal(new Date(row.fin) - new Date(row.inicio), 45 * 60000); assert.equal(row.import_metadata.booking.capacity_fully_verified, true);
        assert.deepEqual(row.import_metadata.booking.profile.phases.map(phase => phase.start_offset_minutes), [0, 15]);
        assert(occupancy.some(entry => entry.resource_key === 'equipment:401' && new Date(entry.end_at) - new Date(row.inicio) === 40 * 60000));
        assert(occupancy.some(entry => entry.phase_key === 't1_p2' && new Date(entry.start_at) - new Date(row.inicio) === 15 * 60000));
        assert.equal(row.import_metadata.automation_policy, 'hold');
      }
      assert.equal(await db.EconomicPayment.count(), 0); assert.equal(await db.ConsentDeliveryEvent.count(), 0);
      const committed = await f.databaseState();
      const replay = await f.book(request); assert.equal(replay.replayed, true); assert.deepEqual(clone(replay.sessions), clone(result.sessions));
      assert.deepEqual(await f.databaseState(), committed);
      await assert.rejects(f.book({ ...request, replan_from_key: 's3' }), { code: 'program_booking_request_conflict' });
      assert.deepEqual(await f.databaseState(), committed);
      report.checks.push('Committed suffix keeps future appointment ID; literal SQL prefix, frozen purchase/budget/consumption unchanged; each visit45 has two steps and real machine40; replay exact and no payment/messages');

      const raceMode = await f.resume('s2');
      const raceChoices = choices.map((row, index) => ({ ...row, start_at: `2030-03-${[4, 6, 8][index].toString().padStart(2, '0')}T09:00:00.000Z` }));
      const race = await Promise.allSettled(['a', 'b'].map(letter => f.book({ request_key: 'owned-resume-race-' + letter, ...raceMode, sessions: raceChoices })));
      assert.equal(race.filter(row => row.status === 'fulfilled').length, 1); assert.equal(race.find(row => row.status === 'rejected').reason.code, 'program_resume_changed');
      assert.deepEqual(clone(await completed.reload()), prefix.appointment); assert.deepEqual(clone(await pendingPrefix.reload()), prefix.records[1]);
      assert.equal(await db.PatientVoucherMovement.count(), 1); assert.equal(await db.EconomicPayment.count(), 0); assert.equal(Number((await f.voucher.reload()).available_units), 4);
      report.checks.push('Concurrent confirmations serialize on real voucher/patient/resource UPDATE locks: one suffix wins, stale competitor writes nothing, prefix and saldo still unchanged');
    });
  });
