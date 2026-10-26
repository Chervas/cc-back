'use strict';

// Fresh owned mysqld only. No DEV/CRM tables, application flags or providers.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 PROGRAM_AGENDA_RESUME_DRAFT_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedProgramResumeFixture } = require('./helpers/owned-program-resume-fixture');
const clone = value => JSON.parse(JSON.stringify(value));

test('shared agenda draft resumes the SQL canonical suffix with real capacity, no preview writes and the existing commit command',
  { skip: process.env.PROGRAM_AGENDA_RESUME_DRAFT_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
      const f = await createOwnedProgramResumeFixture({ sql, models: db });
      await f.book({ request_key: 'owned-draft-original', sessions: [
        { key: 's0', start_at: '2030-01-07T09:00:00.000Z' },
        { key: 's3', start_at: '2030-01-14T09:00:00.000Z' },
      ] });
      const prefix = await f.appointment('s0'), future = await f.appointment('s3');
      await prefix.update({ estado: 'completada', nota: 'Historia humana íntegra' });
      f.advance('2030-01-08T00:00:00Z');
      const preserved = { appointment: clone(await prefix.reload()), record: clone(await f.byKey('s0')),
        occupancy: clone(await f.physical.occupancy(prefix.id_cita)), voucher: clone(await f.voucher.reload()),
        budget: clone(await f.budget.reload()), versions: await f.all('EconomicBudgetVersion') };
      const mode = await f.resume('s2'), rows = ['s2', 's3', 's4'].map(key => ({ key, placed: false }));
      assert.deepEqual((await f.read()).resume_options.find(row => row.from_key === 's2').affected_keys, ['s2', 's3', 's4']);
      const before = await f.databaseState();
      const empty = await f.propose({ ...mode, from_date: '2030-01-14', days: 1, draft_strategy: { action: 'initial' } });
      assert.deepEqual(empty.resume.affected_keys, ['s2', 's3', 's4']);
      assert.deepEqual(empty.proposals.map(row => row.key), ['s2', 's3', 's4']);
      assert(empty.proposals.every(row => row.solution === null));
      assert.equal(empty.unproposed_count, 0);
      assert.equal(empty.sessions.find(row => row.key === 's3').previous_appointment.start_at, '2030-01-14T09:00:00.000Z');
      assert.deepEqual(await f.databaseState(), before);
      const at = local => f.propose({ ...mode, from_date: local.slice(0, 10), days: 1,
        draft_strategy: { action: 'cascade', pivot_key: 's2', start_local: local, sessions: rows } });
      const free = await at('2030-01-14T10:00');
      assert.equal(free.proposals[0].solution.start_at, '2030-01-14T09:00:00.000Z');
      assert(free.proposals.slice(1).every(row => row.solution === null));
      assert.deepEqual(await f.databaseState(), before);
      // The affected reservation may move, but unrelated physical aliases and
      // independent patient visits remain authoritative in the same solver.
      let peer = await f.peer('alias', '2030-02-04T09:00:00Z');
      const withAlias = await f.databaseState();
      assert.equal((await at('2030-02-04T10:00')).proposals[0].solution, null);
      assert.deepEqual(await f.databaseState(), withAlias); await f.cancelPeer(peer);
      peer = await f.peer('independent', '2030-02-04T09:00:00Z', 1);
      assert.equal((await at('2030-02-04T10:00')).proposals[0].solution, null); await f.cancelPeer(peer);
      report.checks.push('Draft uses canonical affected keys; previous dates remain history; real affected occupancy ignored, cross-clinic alias and independent patient conflicts retained; no preview SQL writes');

      const originalMetadata = clone(future.import_metadata);
      await future.update({ import_metadata: { ...originalMetadata, automation_policy: 'active' } });
      await assert.rejects(f.propose({ ...await f.resume('s2'), from_date: '2030-02-04', days: 1,
        draft_strategy: { action: 'initial' } }), { code: 'program_resume_review_required' });
      await future.update({ import_metadata: originalMetadata });
      await future.update({ nota: 'Cambio humano concurrente para comprobar la revisión' });
      await assert.rejects(f.propose({ ...mode, from_date: '2030-02-04', days: 1,
        draft_strategy: { action: 'initial' } }), { code: 'program_resume_changed' });
      await assert.rejects(f.propose({ ...await f.resume('s2'), from_date: '2030-02-04', days: 1,
        draft_strategy: { action: 'reset', sessions: [{ key: 's1', placed: false }, rows[1], rows[2]] } }), { code: 'program_draft_invalid' });
      const freshMode = await f.resume('s2');
      const choices = ['s2', 's3', 's4'].map((key, index) => ({ key, placed: true,
        start_at: `2030-02-${[4, 6, 8][index].toString().padStart(2, '0')}T09:00:00.000Z` }));
      const beforeReady = await f.databaseState();
      const ready = await f.propose({ ...freshMode, from_date: '2030-02-04', days: 1,
        draft_strategy: { action: 'reset', sessions: choices } });
      assert(ready.proposals.every(row => row.solution && row.placed));
      assert.deepEqual(await f.databaseState(), beforeReady);
      const request = { request_key: 'owned-shared-draft-resume', ...freshMode, sessions: ready.proposals.map(row => ({
        key: row.key, start_at: row.solution.start_at, selections: f.selections(row.solution),
      })) };
      await assert.rejects(f.book({ ...request, sessions: request.sessions.slice(1) }), { code: 'program_resume_incomplete' });
      assert.deepEqual(await f.databaseState(), beforeReady);
      const result = await f.book(request);
      assert.deepEqual(clone(result.sessions.map(row => row.action)), ['created', 'rescheduled', 'created']);
      assert.equal(result.sessions[1].appointment_id, future.id_cita);
      assert.deepEqual(clone(await prefix.reload()), preserved.appointment);
      assert.deepEqual(clone(await f.byKey('s0')), preserved.record);
      assert.deepEqual(clone(await f.physical.occupancy(prefix.id_cita)), preserved.occupancy);
      assert.equal((await f.read()).sessions[1].scheduling_status, 'pending');
      assert.equal(await f.byKey('s1'), null);
      assert.deepEqual(clone(await f.voucher.reload()), preserved.voucher);
      assert.deepEqual(clone(await f.budget.reload()), preserved.budget);
      assert.deepEqual(await f.all('EconomicBudgetVersion'), preserved.versions);
      assert.equal(await db.EconomicPayment.count(), 0); assert.equal(await db.ConsentDeliveryEvent.count(), 0);
      const committed = await f.databaseState();
      assert.equal((await f.book(request)).replayed, true);
      assert.deepEqual(await f.databaseState(), committed);
      report.checks.push('Reviewed full suffix commits through canonical program command; original future ID, completed/pending prefix, financial snapshots preserved; exact replay creates nothing');
    });
  });
