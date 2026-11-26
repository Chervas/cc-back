'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const social = require('../src/meta-marketing-social');

function fixture() {
  const scopes = [
    'pages_show_list',
    'instagram_basic',
    'pages_manage_metadata',
    'pages_read_engagement',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'pages_messaging',
  ];
  const commands = [];
  const ctx = {
    token: Buffer.from('fictional-user'),
    appSecret: Buffer.from('fictional-secret'),
    metadata: { appId: '101', scopes, granularScopes: [] },
    asset: { kind: 'facebook_page', id: '401' },
    authorize() {},
    async transport(url, options) {
      assert.equal(url.host, 'graph.facebook.com');
      const endpoint = url.pathname.split('/').slice(2).join('/');
      commands.push({
        endpoint,
        method: options.method,
        body: options.body && JSON.parse(options.body),
      });
      const replies = {
        'me/accounts': {
          data: [
            {
              id: '401',
              name: 'Clínica demo',
              access_token: 'fictional-page',
              tasks: ['MESSAGING'],
              instagram_business_account: { id: '501', username: 'demo' },
            },
          ],
        },
        debug_token: {
          data: {
            is_valid: true,
            type: 'PAGE',
            app_id: '101',
            profile_id: '401',
            expires_at: 0,
            data_access_expires_at: 0,
            scopes,
          },
        },
        '401/subscribed_apps': { data: [{ id: '101', subscribed_fields: ['leadgen', 'messages'] }] },
        '101/subscriptions': {
          data: ['page', 'instagram'].map((object) => ({
            object,
            active: true,
            fields: [{ name: 'messages' }, { name: 'comments' }],
          })),
        },
        991: {
          id: '991',
          media: { id: '881' },
          from: { id: '771' },
          timestamp: new Date().toISOString(),
        },
        881: { id: '881', owner: { id: '501' }, permalink: 'https://www.instagram.com/p/FICTICIO/' },
        771: { id: '771', username: 'persona', first_name: 'Persona', last_name: 'Demo' },
        '401/messages': { recipient_id: '771', message_id: 'mid-test' },
      };
      assert(Object.hasOwn(replies, endpoint));
      return { ok: true, json: async () => replies[endpoint] };
    },
  };
  async function call(operation, channel, kind, extra = {}) {
    const payload = {
      clinicId: 41,
      accountId: channel === 'instagram' ? '501' : '401',
      channel,
      kind,
      ...extra,
    };
    social.checks[operation](payload);
    social.authorize(
      [{ clinicId: 41, pageId: '401', accountId: payload.accountId, channel }],
      ctx.asset,
      { operation, payload },
      [41, 42],
    );
    return social.execute({ ...ctx, operation, payload });
  }
  return { ctx, commands, call };
}
test('signed broker persists a scoped Send receipt and reconciles it without a second POST', async (t) => {
  const { randomUUID } = require('node:crypto');
  const enrollment = require('../src/meta-marketing-enrollment-contract');
  const owner = require('./meta-marketing-oauth-fixture.cjs').fixture(t, {
    enrollment: true,
    leads: true,
    socialInbox: [{ clinicId: 71, channel: 'instagram', pageId: '401', accountId: '501' }],
  });
  const flow = await owner.begin(),
    staged = await owner.finish(flow),
    enrollmentId = randomUUID(),
    scopeDigest = flow.payload.scopeDigest;
  const prepared = await owner.execute(enrollment.OPERATIONS.prepare, {
    enrollmentId,
    flowId: flow.flowId,
    scopeDigest,
    candidateDigest: staged.data.candidate.digest,
    assetRefs: ['meta-facebook_page:401'],
  });
  await owner.execute(enrollment.OPERATIONS.activate, {
    enrollmentId,
    scopeDigest,
    selectionDigest: prepared.data.selectionDigest,
  });
  const f = fixture();
  t.mock.method(globalThis, 'fetch', f.ctx.transport);
  const payload = {
    clinicId: 71,
    channel: 'instagram',
    accountId: '501',
    kind: 'dm',
    recipient: '771',
    text: 'Ficticio',
    attemptId: randomUUID(),
  };
  const options = { assetRef: 'meta-facebook_page:401' };
  const sent = await owner.execute(
    social.send,
    payload,
    { ...options, requestId: payload.attemptId },
    'reader',
  );
  assert.equal(sent.data.messageId, 'mid-test');
  assert.deepEqual((await owner.execute(social.outcome, payload, options, 'reader')).data, sent.data);
  assert.equal(
    (await owner.execute(social.send, payload, { ...options, requestId: payload.attemptId }, 'reader'))
      .replayed,
    true,
  );
  assert.equal(f.commands.filter((c) => c.method === 'POST').length, 1);
  await assert.rejects(owner.execute(social.outcome, { ...payload, clinicId: 72 }, options, 'reader'), {
    code: 'scope_denied',
  });
  assert(!owner.snapshot().includes('Ficticio'));
});

test('Instagram separates comment intake from private sending and verifies post ownership', async () => {
  const f = fixture();
  f.ctx.metadata.scopes = f.ctx.metadata.scopes.filter((s) => s !== 'instagram_manage_messages');
  const comment = await f.call(social.receive, 'instagram', 'comment', {
    senderId: '771',
    postId: '881',
    commentId: '991',
  });
  assert.equal(comment.permalink, 'https://www.instagram.com/p/FICTICIO/');
  assert.equal(
    (await f.call(social.status, 'instagram', 'comment')).reason,
    'permission:instagram_manage_messages',
  );
  assert(f.commands.every((c) => c.method === 'GET'));
});
test('Instagram directs DM to IGSID and a single private reply to the comment ID', async () => {
  const f = fixture(),
    attemptId = '00000000-0000-4000-8000-000000000111';
  for (const [kind, recipient, expected] of [
    ['dm', '771', { id: '771' }],
    ['comment', '991', { comment_id: '991' }],
  ]) {
    const sent = await f.call(social.send, 'instagram', kind, { recipient, text: 'Prueba', attemptId });
    assert.equal(sent.messageId, 'mid-test');
    assert.deepEqual(f.commands.at(-1).body.recipient, expected);
  }
});
test('Messenger requires its own grants and subscription, accepts DM and denies sending', async () => {
  const f = fixture();
  const received = await f.call(social.receive, 'messenger', 'dm', {
    senderId: '771',
    postId: null,
    commentId: null,
  });
  assert.equal(received.alias, 'Persona Demo');
  await assert.rejects(
    f.call(social.send, 'messenger', 'dm', {
      recipient: '771',
      text: 'Prueba',
      attemptId: '00000000-0000-4000-8000-000000000111',
    }),
    { code: 'operation_denied' },
  );
  f.ctx.metadata.granularScopes = [{ scope: 'pages_messaging', targetIds: ['402'] }];
  assert.equal((await f.call(social.status, 'messenger', 'dm')).reason, 'permission:pages_messaging');
  f.ctx.metadata.granularScopes = [];
  const original = f.ctx.transport;
  f.ctx.transport = (u, o) =>
    u.pathname.endsWith('/subscribed_apps')
      ? { ok: true, json: () => ({ data: [{ id: '101', subscribed_fields: ['leadgen'] }] }) }
      : original(u, o);
  assert.equal((await f.call(social.status, 'messenger', 'dm')).reason, 'subscription:messages');
  assert(f.commands.every((c) => c.method === 'GET'));
});
