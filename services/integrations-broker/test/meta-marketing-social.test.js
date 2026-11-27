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
        fields: url.searchParams.get('fields'),
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
        881: { id: '881', owner: { id: '501' }, caption: 'Sesión informativa de la clínica', media_type: 'IMAGE', media_url: 'https://example.cdninstagram.com/post.jpg', permalink: 'https://www.instagram.com/p/FICTICIO/' },
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
    socialInbox: [
      { clinicId: 71, channel: 'instagram', pageId: '401', accountId: '501' },
      { clinicId: 71, channel: 'messenger', pageId: '401', accountId: '401' },
    ],
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
  const setup = await owner.execute(social.subscribe, {
    enrollmentId, versionId: flow.flowId, clinicId: 71, channel: 'messenger', kind: 'dm', accountId: '401',
  }, options, 'reader');
  assert.deepEqual(setup.data, { available: false, reason: 'social_consent_absent' });
  assert.equal(f.commands.length, 0);
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
  assert.deepEqual(comment.post, { mediaType: 'IMAGE', caption: 'Sesión informativa de la clínica', previewUrl: 'https://example.cdninstagram.com/post.jpg' });
  const mediaReads = f.commands.filter(command => command.endpoint === '881');
  assert.equal(mediaReads.length, 1);
  assert(mediaReads[0].fields.includes('thumbnail_url'));
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
test('the Instagram Inbox setting has a distinct reason for history and rejected sends', async () => {
  const f = fixture();
  const original = f.ctx.transport;
  let message = '(#200) The account owner has disabled access to instagram direct messages.';
  f.ctx.transport = (url, options) => /\/401\/(messages|conversations)$/.test(url.pathname)
    ? { ok: false, status: 403, json: () => ({ error: { code: 200, message } }) }
    : original(url, options);
  f.ctx.context = { generation: 'demo', policyVersion: '1' };
  const end = Date.now() - 5000;
  const interval = { cursor: null, start: end - 72 * 3600000, end };
  const send = () => f.call(social.send, 'instagram', 'dm', {
    recipient: '771', text: 'Prueba', attemptId: '00000000-0000-4000-8000-000000000111',
  });
  assert.equal((await f.call(social.history, 'instagram', 'dm', interval)).reason, 'instagram_inbox_access_disabled');
  assert.equal((await send()).reason, 'instagram_inbox_access_disabled');
  message = '(#200) Missing permission.';
  assert.equal((await send()).reason, 'provider_unauthorized');
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

const subscriptionConsent = { enrollmentId: '86eefb4d-3d64-4d4a-8e12-28ee8beceecf', versionId: 'caf92b28-db5b-4caa-8c4b-e1fd63b71dba' };
function subscriptionFixture({ tasks = ['MANAGE'], appReady = true, old = ['leadgen', 'feed'], dropAck = false, incomplete = false } = {}) {
  const f = fixture(), writes = [], before = f.ctx.transport, paced = [];
  let fields = old;
  f.ctx.subscriptionPacer = { run: async (key, _opts, work) => { paced.push(key);return work(); }, observe() {} };
  f.ctx.transport = async (url, options) => {
    const endpoint = url.pathname.split('/').slice(2).join('/');
    const ok = data => ({ ok: true, json: async () => data });
    if (endpoint === 'me/accounts') {
      const result = await (await before(url, options)).json();result.data[0].tasks = tasks;return ok(result);
    }
    if (endpoint === '101/subscriptions') return ok({ data: [{object:'page',active:appReady,fields:[{name:'messages'}]}] });
    if (endpoint === '401/subscribed_apps') {
      if (options.method === 'POST') {
        fields = JSON.parse(options.body).subscribed_fields.split(',');
        writes.push(fields);
        if (dropAck) throw Error('provider disconnected after commit');
        return ok({success:true});
      }
      return ok({ data: fields.length ? [{id:'101',subscribed_fields:[...fields]}] : [], ...(incomplete?{paging:{next:'more'}}:{}) });
    }
    return before(url, options);
  };
  return { f, writes, paced, enable: () => f.call(social.subscribe, 'messenger', 'dm', subscriptionConsent) };
}

test('explicit setup adds messages once, preserving leadgen and every other field; reading status never subscribes', async () => {
  const { f, writes, paced, enable } = subscriptionFixture();
  assert.equal((await f.call(social.status, 'messenger', 'dm')).reason, 'subscription:messages');
  assert.equal(writes.length, 0);
  assert.deepEqual(await enable(), {available:true});
  assert.deepEqual(await enable(), {available:true});
  assert.deepEqual(writes,[['feed','leadgen','messages']]);
  assert(paced.length > 1 && paced.every(key => key === 'meta-ads-app:101'));
  const first = subscriptionFixture({old:[]});await first.enable();
  assert.deepEqual(first.writes, [['messages']]);
});

test('a lost subscription acknowledgement rechecks Meta before the next POST; partial reads and lost permissions never write', async () => {
  const lost = subscriptionFixture({dropAck:true});await assert.rejects(lost.enable(),/disconnected/);
  assert.deepEqual(await lost.enable(),{available:true});assert.equal(lost.writes.length,1);
  for (const [options,reason] of [[{tasks:['MESSAGING']},'page_subscription_task'],[{appReady:false},'subscription:messages']]){
    const t = subscriptionFixture(options);assert.equal((await t.enable()).reason,reason);assert.equal(t.writes.length,0);
  }
  const bad = subscriptionFixture({incomplete:true});await assert.rejects(bad.enable(),{code:'provider_failed'});assert.equal(bad.writes.length,0);
  const missing=subscriptionFixture();missing.f.ctx.metadata.scopes=missing.f.ctx.metadata.scopes.filter(s=>s!=='pages_messaging');
  assert.equal((await missing.enable()).reason,'permission:pages_messaging');assert.equal(missing.paced.length,0);
});

test('Lead Ads and Messenger writers share an app/Page lock and reconcile the complete field set',async()=>{
  const {ensureField,pageFields}=require('../src/meta-page-subscription');
  let fields=[],unlock,started;
  const ready=new Promise(resolve=>{started=resolve;}),paused=new Promise(resolve=>{unlock=resolve;});
  const read=async()=>({subscription:pageFields({data:fields.length?[{id:'101',subscribed_fields:fields}]:[]},'101')});
  const writer=(field,delay=false)=>ensureField({appId:'101',pageId:'401',field,read,authorize(){},
    write:async desired=>{if(delay){started();await paused;}fields=desired;return {success:true};}});
  const first=writer('leadgen',true);await ready;
  await assert.rejects(writer('messages'),{code:'oauth_flow_busy'});unlock();await first;await writer('messages');
  assert.deepEqual(fields,['leadgen','messages']);
  for (const rows of [[{ id:'101' }, { id:'101' }], [{}], [null]])
    assert.throws(() => pageFields({ data:rows }, '101'), {code:'provider_failed'});
});

test('signed subscription accepts only the current consent, destination and credential version', async (t) => {
  const { randomUUID } = require('node:crypto');
  const enrollment = require('../src/meta-marketing-enrollment-contract');
  const provider = subscriptionFixture();
  const owner = require('./meta-marketing-oauth-fixture.cjs').fixture(t, {
    renewal: true, leads: true, socialConsentOnly: true,
    socialInbox: [{ clinicId: 71, channel: 'messenger', pageId: '401', accountId: '401' }],
    subscriptionPacer: provider.f.ctx.subscriptionPacer,
  });
  const flow = await owner.begin();
  const granted = new URL(flow.result.data.authUrl).searchParams.get('scope').split(',');
  assert(granted.includes('pages_messaging'));
  owner.state.afterGraph = (kind, value) => {
    if (kind === 'inspect') value.data.scopes = granted;
    return value;
  };
  const staged = await owner.finish(flow);
  const enrollmentId = randomUUID();
  const scopeDigest = flow.payload.scopeDigest;
  const prepared = await owner.execute(enrollment.OPERATIONS.prepare, {
    enrollmentId, flowId: flow.flowId, scopeDigest, candidateDigest: staged.data.candidate.digest,
    assetRefs: ['meta-facebook_page:401'],
  });
  await owner.execute(enrollment.OPERATIONS.activate, { enrollmentId, scopeDigest, selectionDigest: prepared.data.selectionDigest });
  t.mock.method(globalThis, 'fetch', provider.f.ctx.transport);
  const payload = { enrollmentId, versionId: flow.flowId, clinicId: 71, channel: 'messenger', kind: 'dm', accountId: '401' };
  const subscribe = (overrides) => owner.execute(social.subscribe, { ...payload, ...overrides }, { assetRef: 'meta-facebook_page:401' }, 'reader');
  await assert.rejects(subscribe({ clinicId: 72 }), { code: 'scope_denied' });
  await assert.rejects(subscribe({ versionId: randomUUID() }), { code: 'secret_version_changed' });
  assert.equal(provider.paced.length, 0);
  assert.deepEqual((await subscribe()).data, { available: true });
  assert.deepEqual((await subscribe()).data, { available: true });
  assert.deepEqual(provider.writes, [['feed', 'leadgen', 'messages']]);
});
