'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, options } = require('../quickchat-social-history');
const end = new Date(Date.now() - 3000).toISOString();
const args = ['staging', '72', 'instagram', '501', end];
const route = {
  channel: 'instagram',
  accountId: '501',
  clinicId: 72,
  appId: '11',
  pageId: '22',
  connectionRef: 'x',
  enrollmentId: 'e',
  tenantRef: 'clinic:72',
};
const result = {
  available: true,
  entries: [],
  children: [],
  next: null,
  omitted: 0,
  limitedThreads: 0,
};
test('scan and apply report missing permissions and preserve verified scope during intake', async () => {
  const input = options([...args, '--apply']);
  let applied = 0;
  const entry = {
    id: '501',
    messaging: [
      {
        sender: { id: '771' },
        recipient: { id: '501' },
        timestamp: input.start,
        message: { mid: 'one', text: 'Hola' },
      },
    ],
  };
  const deps = {
    routeFor: async () => route,
    provider: {
      history: async (_, kind) =>
        kind === 'comment'
          ? { available: false, reason: 'permission:instagram_manage_comments' }
          : { ...result, entries: [entry] },
    },
    accept: async (_, opts) => {
      assert.equal(opts.expectedRoute, route);
      assert.equal(opts.history, true);
      applied++;
      return { queued: 0, duplicate: 1 };
    },
  };
  const scan = await run({ ...input, apply: false }, deps);
  assert.equal(applied, 0);
  assert.equal(scan.kinds.dm.found, 1);
  const report = await run(input, deps);
  assert.equal(applied, 1);
  assert.equal(report.kinds.dm.duplicates, 1);
  assert.ok(report.kinds.dm.complete);
  assert.equal(report.kinds.comment.complete, false);
  entry.id = '999';
  const bad = await run(input, deps);
  assert.equal(bad.kinds.dm.reason, 'social_history_response_invalid');
  assert.equal(applied, 1);
  await assert.rejects(run({ ...input, clinicId: 66 }, deps), /account_unassigned/);
});
test('a changed assignment aborts before processing the next page', async () => {
  let calls = 0;
  const report = await run(options([...args, '--apply']), {
    routeFor: async () => (++calls < 3 ? route : { ...route, clinicId: 66 }),
    provider: { history: async () => ({ ...result, next: 'a'.repeat(64) }) },
  });
  assert.equal(report.kinds.dm.reason, 'social_history_route_changed');
  assert.equal(report.kinds.comment, undefined);
});

test('single thread history takes its participant from the exact clinic, channel and account', async () => {
  const input = options([...args, '--apply', '--conversation', '80']);
  assert.throws(() => options([...args, '--apply', '--conversation', '0']));
  const deps = {
    routeFor: async () => route,
    participantFor: async (id, scope) => {
      assert.equal(id, 80);
      assert.deepEqual(scope, { clinicId: 72, channel: 'instagram', accountId: '501' });
      return '771';
    },
    provider: { history: async (_r, kind, _s, _end, _cursor, participant) => {
      assert.equal(kind, 'dm');
      assert.equal(participant, '771');
      return result;
    }},
  };
  const report = await run(input, deps);
  assert.equal(report.conversationId, 80);
  assert.ok(report.kinds.dm.complete);
  assert.equal(report.kinds.comment, undefined);
  await assert.rejects(run(input, { ...deps, participantFor: async () => null }), /conversation_unassigned/);
  const unrelated = { id: '501', messaging: [{ sender: { id: '775' }, recipient: { id: '501' }, timestamp: input.start, message: { mid: 'x', text: 'fixture' } }] };
  const refused = await run(input, { ...deps, provider: { history: async () => ({ ...result, entries: [unrelated] }) }, accept: () => assert.fail() });
  assert.equal(refused.kinds.dm.reason, 'social_history_response_invalid');
});

test('only a timed-out ordinary Instagram DM read switches its subsequent pages to smaller discovery', async () => {
  const input = options([...args, '--scan']);
  const sizes = [], next = 'A'.repeat(64);
  const report = await run(input, { routeFor: async () => route, provider: {
    history: async (_, kind, start, end, cursor, participant, smallPages) => {
      if (kind === 'comment') return result;
      sizes.push(smallPages);
      if (!smallPages) throw Object.assign(Error('timeout'), { code: 'provider_timeout' });
      return { ...result, next: cursor ? null : next };
    },
  } });
  assert.deepEqual(sizes, [false, true, true]);
  assert.equal(report.kinds.dm.complete, true);
  assert.equal(report.kinds.dm.pages, 2);
});
