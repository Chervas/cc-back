'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/meta-marketing-social-history');
const { events } = require('../../../src/services/socialInboxEvents');

const end = Date.now() - 10000,
  start = end - h.HOURS_72;
function fixture(kind, routes, changes = {}) {
  const payload = {
    channel: 'instagram',
    kind,
    clinicId: 72,
    accountId: '501',
    start,
    end,
    ...changes,
  };
  const context = {
    principalId: 'reader',
    tenantRef: 'clinic:72',
    binding: { connectionRef: 'connection' },
    policyVersion: 'p1',
    generation: 'g1',
  };
  return (cursor, overrides = {}) =>
    h.read({
      payload: { ...payload, cursor, ...overrides },
      context,
      asset: { id: '401' },
      appSecret: Buffer.from('test-only'),
      pageToken: 'test-page',
      graph: async (path, token, query) => {
        assert.equal(token, 'test-page');
        const route = routes[path + (query.after ? '#' + query.after : '')];
        assert.ok(route, path);
        return typeof route === 'function' ? route(query) : route;
      },
    });
}
const page = (data, next = false) => ({
  data,
  ...(next ? { paging: { next: 'do-not-follow', cursors: { after: 'older' } } } : {}),
});
test('a recent reply on an old IG post is recovered within its clinic with its original time', async () => {
  const read = fixture('comment', {
    '501/media': page([{ id: '801' }], true),
    '501/media#older': page([]),
    '801/comments': page([
      {
        id: '901',
        timestamp: new Date(start - 86400000).toISOString(),
        from: { id: '771' },
        text: 'viejo',
        replies: page([{ id: '902' }]),
      },
    ]),
    '901/replies': page([
      { id: '902', timestamp: new Date(start).toISOString(), from: { id: '771' }, text: 'INFO' },
      { id: '903', timestamp: new Date(end).toISOString(), from: { id: '771' }, text: 'fuera' },
    ]),
  });
  const root = await read(null);
  assert.deepEqual((await read(root.next)).entries, []);
  const comments = await read(root.children[0]);
  assert.equal(comments.entries.length, 0);
  const replies = await read(comments.children[0]);
  const [e] = events({ object: 'instagram', entry: replies.entries }, { history: true });
  assert.equal(e.at, new Date(start).toISOString());
  assert.equal(e.replyTo, '901');
  assert.equal(e.postId, '801');
  assert.equal(e.source, 'history');
  await assert.rejects(read(root.children[0], { clinicId: 66 }), { code: 'invalid_request' });
  await assert.rejects(read(root.children[0], { end: end - 1, start: start - 1 }), {
    code: 'invalid_request',
  });
  await assert.rejects(read('a' + root.children[0].slice(2)), { code: 'invalid_request' });
});
test('Instagram history identifies owned DMs, omissions, and the 20-message limit', async () => {
  const message = {
    id: 'mid-test',
    created_time: new Date(start + 5000).toISOString(),
    from: { id: '501' },
    to: { data: [{ id: '771' }] },
    message: 'Mensaje de prueba',
  };
  const read = fixture('dm', {
    '401/conversations': page([{ id: 't_1', updated_time: new Date(end).toISOString() }]),
    't_1/messages': page([message, { ...message, from: { id: '99' } }], true),
    't_1/messages#older': page(
      Array.from({ length: 18 }, (_, i) => ({ ...message, id: 'older-' + i })),
      true,
    ),
  });
  const root = await read(null);
  const messages = await read(root.children[0]);
  const [e] = events({ object: 'instagram', entry: messages.entries }, { history: true });
  assert.equal(e.echo, true);
  assert.equal(e.senderId, '771');
  assert.equal(messages.omitted, 1);
  assert.equal(messages.limitedThreads, 0);
  const remaining = await read(messages.next);
  assert.equal(remaining.limitedThreads, 1);
  assert.equal(remaining.next, null);
});
test('Messenger follows provider pagination and excludes conversations older than the interval', async () => {
  const read = fixture(
    'dm',
    {
      '401/conversations': page([
        { id: 't_1', updated_time: new Date(start - 1).toISOString() },
        { id: 't_2', updated_time: new Date(start).toISOString() },
      ]),
      't_2/messages': page([], true),
      't_2/messages#older': page([]),
    },
    { channel: 'messenger', accountId: '401' },
  );
  const root = await read(null);
  assert.equal(root.children.length, 1);
  const first = await read(root.children[0]);
  assert.ok(first.next);
  assert.equal((await read(first.next)).next, null);
});

test('large Instagram inboxes list one conversation per page and keep the same scope across cursors', async () => {
  const rootPage = (expectedAfter, rows, next = false) => (query) => {
    assert.equal(query.limit, '1');
    assert.equal(query.fields, 'id,updated_time');
    assert.equal(query.after, expectedAfter);
    assert.equal(query.platform, 'instagram');
    return page(rows, next);
  };
  const read = fixture('dm', {
    '401/conversations': rootPage(undefined, [{ id: 't_new', updated_time: new Date(end).toISOString() }], true),
    '401/conversations#older': rootPage('older', [{ id: 't_old', updated_time: new Date(start - 1).toISOString() }]),
  });
  const first = await read(null, { smallPages: true });
  assert.equal(first.children.length, 1);
  const second = await read(first.next);
  assert.equal(second.children.length, 0);
  assert.equal(second.next, null);
});

test('media listing skips only an explicitly empty comments edge, including on old posts', async () => {
  const read = fixture('comment', {
    '501/media': query => {
      assert.equal(query.fields, 'id,comments.limit(1){id}');
      return page([
        { id: '801', comments: page([]) },
        { id: '802', comments: page([], true) },
        { id: '803', comments: page([{ id: '901' }]) },
        { id: '804' },
      ]);
    },
    '802/comments': page([]),
    '803/comments': page([]),
    '804/comments': page([]),
  });
  const root = await read(null);
  assert.equal(root.children.length, 3);
  for (const cursor of root.children) assert.deepEqual((await read(cursor)).entries, []);
});

test('scoped Instagram history pins the participant across pagination and rejects unrelated messages', async () => {
  const read = fixture('dm', {
    '401/conversations': query => {
      assert.equal(query.user_id, '771');
      return page([{ id: 'th', updated_time: new Date(end).toISOString() }]);
    },
    'th/messages': page([{
      id: 'mid', created_time: new Date(start).toISOString(), message: 'fixture',
      from: { id: '775' }, to: { data: [{ id: '501' }] },
    }]),
  }, { participantId: '771' });
  const one = await read(null);
  await assert.rejects(read(one.children[0], { participantId: '775' }), { code: 'invalid_request' });
  await assert.rejects(read(one.children[0], { participantId: undefined }), { code: 'invalid_request' });
  await assert.rejects(read(one.children[0]), { code: 'scope_denied' });
  await assert.rejects(read(null, { channel: 'messenger' }), { code: 'invalid_request' });
});

test('regular Instagram conversation discovery keeps ten per page', async () => {
  const read = fixture('dm', { '401/conversations': query => {
    assert.equal(query.limit, '10');
    return page([]);
  } });
  const root = await read(null);
  assert.equal(root.next, null);
});

test('only new scoped history cursors survive a quota pause, old cursors keep their encrypted expiry', () => {
  const { cursorCodec, socialHistoryCursorCodec } = require('../src/provider-cursor');
  const key = Buffer.alloc(32, 7);
  let clock = 1000;
  const normal = cursorCodec(key, () => clock), history = socialHistoryCursorCodec(key, () => clock);
  const scope = { principalId: 'worker', tenantRef: 'clinic:72', binding: { connectionRef: 'authority' },
    assetRef: 'page', operation: 'meta.marketing.social.history.v1', policyVersion: 'credential+clinic+window' };
  const other = { ...scope, operation: 'meta.marketing.ads.actions.v1' };
  const old = normal.seal('older', scope), unrelated = normal.seal('other-op', other), resumed = history.seal('next', scope);
  assert.equal(history.open(old, scope), 'older');
  assert.throws(() => history.seal('invalid', other), { code: 'invalid_request' });
  assert.throws(() => history.open(unrelated, other), { code: 'invalid_request' });
  clock += 11 * 60000;
  assert.throws(() => normal.open(unrelated, other), { code: 'invalid_request' });
  assert.throws(() => history.open(old, scope), { code: 'invalid_request' });
  clock += 6 * 3600000;
  assert.equal(history.open(resumed, scope), 'next');
  for (const changed of [{ assetRef: 'other-page' }, { tenantRef: 'clinic:66' }, { policyVersion: 'other-credential+window' }])
    assert.throws(() => history.open(resumed, { ...scope, ...changed }), { code: 'invalid_request' });
  clock = 1000 + 24 * 3600000;
  assert.throws(() => history.open(resumed, scope), { code: 'invalid_request' });
});

test('a reduced retry checks one ID-only conversation and restores timestamp filtering on subsequent pages', async () => {
  const read = fixture('dm', {
    '401/conversations': () => ({ data: [], paging: { next: 'mock', cursors: { after: 'stalled' } } }),
    '401/conversations#stalled': q => {
      assert.equal(q.fields, 'id'); assert.equal(q.limit, '1');
      return { data: [{ id: 'thread_1' }], paging: { next: 'mock', cursors: { after: 'following' } } };
    },
    'thread_1/messages': () => ({ data: [] }),
    '401/conversations#following': q => {
      assert.equal(q.fields, 'id,updated_time');
      return { data: [{ id: 'thread_old', updated_time: new Date(start - 1000).toISOString() }] };
    },
  });
  const first = await read(null);
  const retry = await read(first.next, { smallPages: true });
  assert.equal(retry.children.length, 1);
  assert.deepEqual((await read(retry.children[0])).entries, []);
  const last = await read(retry.next, { smallPages: true });
  assert.equal(last.next, null); assert.equal(last.children.length, 0);
});
