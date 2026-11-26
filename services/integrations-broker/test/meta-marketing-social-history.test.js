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
        return route;
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
