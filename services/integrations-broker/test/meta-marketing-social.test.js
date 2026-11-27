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
        assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(options.body);
        assert.equal(url.searchParams.has('appsecret_proof'), false);
        assert.match(form.get('appsecret_proof'), /^[a-f0-9]{64}$/);
        fields = form.get('subscribed_fields').split(',');
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

async function singleOnboarding(t, { channels=['instagram','messenger'], selected=['meta-facebook_page:401','meta-instagram_business:501'],
    singleClinic=true, grant=true, granular, socialInbox, baseInstagram=true }={}) {
  const { randomUUID } = require('node:crypto'), E = require('../src/meta-marketing-enrollment-contract');
  const owner = require('./meta-marketing-oauth-fixture.cjs').fixture(t,{renewal:true,leads:true,singleClinic,baseInstagram,socialInbox,socialConsentOnly:true,socialInboxAdvancedChannels:channels});
  const flow=await owner.begin(), requested=new URL(flow.result.data.authUrl).searchParams.get('scope').split(',');
  owner.state.afterGraph = (kind, value) => {
    if(kind==='inspect' && grant) {
      value.data.scopes=requested;
      value.data.granular_scopes.push(...(granular || [
        {scope:'instagram_manage_messages',target_ids:['501','999']},{scope:'pages_messaging',target_ids:['401','998']},
      ]).filter(v=>requested.includes(v.scope)));
    }
    return value;
  };
  const stage=await owner.finish(flow), enrollmentId=randomUUID(), scopeDigest=flow.payload.scopeDigest;
  const prepare=await owner.execute(E.OPERATIONS.prepare,{enrollmentId,flowId:flow.flowId,scopeDigest,
    candidateDigest:stage.data.candidate.digest,assetRefs:selected});
  const activate=await owner.execute(E.OPERATIONS.activate,{enrollmentId,scopeDigest,selectionDigest:prepare.data.selectionDigest});
  const call=(operation,channel,extra={},clinicId=71)=>owner.execute(operation,{
    channel,clinicId,kind:'dm',accountId:channel==='instagram'?'501':'401',...extra},{assetRef:'meta-facebook_page:401'},'reader');
  return {owner,requested,flow,enrollmentId,grant:activate.data,call};
}

function signedIngress(t,owner) {
  const {generateKeyPairSync,createHmac}=require('node:crypto'), {Broker}=require('../src/broker');
  const id=require('../src/meta-marketing-leads-contract').ingressPrincipal('staging');
  const keys=generateKeyPairSync('ed25519');
  owner.policy.principals.push({id,keyId:id,enabled:true,maxPerMinute:50,publicKey:keys.publicKey.export({type:'spki',format:'pem'})});
  const broker=new Broker({store:owner.current.store,policy:owner.policy,secrets:owner.secrets,operations:owner.current.enrollment.operations,
    policyResolver:owner.current.enrollment,transportProfile:'meta-marketing',now:owner.now});
  return (channel,ids,secret=require('./meta-marketing-oauth-fixture.cjs').APP)=>{
    const body=Buffer.from(JSON.stringify({object:channel,entry:ids.map(id=>({id,messaging:[]}))}));
    const cmd=owner.command(social.verify,{rawBase64:body.toString('base64'),signature:'sha256='+createHmac('sha256',secret).update(body).digest('hex')},{assetRef:'meta-facebook_page:401'});
    const signed=require('../src/auth').signRequest(cmd,{keyId:id,privateKey:keys.privateKey,audience:owner.policy.audience,now:owner.now()});
    return broker.execute(signed.raw,signed.headers);
  };
}

test('single-clinic ordinary OAuth with no account list projects the selected Page and IG, verifies signed ingress and checks live permissions before a send',async t=>{
  const s=await singleOnboarding(t);
  assert(s.requested.includes('pages_messaging')&&s.requested.includes('instagram_manage_messages'));
  assert.deepEqual(s.grant.quickChatSubscriptionPages,['401']);
  const record=require('../src/meta-marketing-social-consent').journal(s.owner.current.store).find(s.flow.flowId);
  assert.deepEqual(JSON.parse(record.accounts),[]);
  assert.equal(record.metadata.includes('999'),false);
  assert.deepEqual(JSON.parse(record.projection).granularScopes.find(g=>g.scope==='instagram_manage_messages').targetIds,['501']);
  assert.deepEqual(JSON.parse(record.projection).granularScopes.find(g=>g.scope==='pages_messaging').targetIds,['401']);
  assert(!record.projection.includes('998')&&!record.projection.includes('999'));
  const ingress=signedIngress(t,s.owner), graphCount=s.owner.state.httpCalls.length;
  assert.deepEqual((await ingress('page',['401','997'])).data.destinations,[{accountId:'401',clinicId:71}]);
  assert.deepEqual((await ingress('instagram',['996','501'])).data.destinations,[{accountId:'501',clinicId:71}]);
  await assert.rejects(ingress('page',['401'],'FICTITIOUS_WRONG_SECRET'),{code:'invalid_signature'});
  assert.equal(graphCount,s.owner.state.httpCalls.length);
  const provider=fixture(); t.mock.method(globalThis,'fetch',provider.ctx.transport);
  await assert.rejects(s.call(social.status,'instagram',{},72),{code:'scope_denied'});
  await assert.rejects(s.call(social.status,'instagram',{accountId:'997'}),{code:'scope_denied'});
  assert.equal(provider.commands.length,0);
  assert.equal((await s.call(social.status,'instagram')).data.available,true);
  const attemptId=require('node:crypto').randomUUID();
  const send=(object={})=>s.owner.execute(social.send,{clinicId:71,channel:'instagram',kind:'dm',accountId:'501',recipient:'771',text:'Fictitious QA',attemptId,...object},
    {requestId:attemptId,assetRef:'meta-facebook_page:401'},'reader');
  await send();
  assert.equal(provider.commands.filter(c=>c.method==='POST').length,1);
  assert(provider.commands.some(c=>c.endpoint==='debug_token'));
  await s.owner.execute(require('../src/meta-marketing-contract').REVOKE,{}, {assetRef:'meta-instagram_business:501'},'assetControl');
  await assert.rejects(s.call(social.status,'instagram'));
  await assert.rejects(ingress('instagram',['501']));
  assert.equal(provider.commands.filter(c=>c.method==='POST').length,1);
});

test('single-clinic switches cannot authorize groups, disabled channels, declined grants, or foreign granular targets',async t=>{
  for (const variant of [
    {singleClinic:false}, {channels:[]}, {channels:['messenger']}, {grant:false},
    {granular:[{scope:'instagram_manage_messages',target_ids:['777']},{scope:'instagram_manage_comments',target_ids:[]}]}
  ]){
    await t.test(JSON.stringify(variant),async t=>{
      const s=await singleOnboarding(t,variant);
      const spy=t.mock.method(globalThis,'fetch',()=>assert.fail('Unexpected Graph call'));
      await assert.rejects(s.call(social.status,'instagram'));
      assert.equal(spy.mock.callCount(),0);
      if(variant.singleClinic===false||!variant.channels?.length && variant.channels!==undefined || variant.channels?.length===1)
        assert(!s.requested.includes('instagram_manage_messages'));
    });
  }
});

test('ordinary renewal opts in an existing single-clinic grant without explicit targets and pins the projection to the new effective token',async t=>{
  const {randomUUID,randomBytes}=require('node:crypto'),C=require('../src/meta-marketing-oauth-contract'),R=require('../src/meta-marketing-credential-renewal-contract');
  const s=await singleOnboarding(t,{grant:false}), f=s.owner, id=randomUUID(), row=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(s.enrollmentId);
  const current=f.current.epochs.current(row,f.binding);
  const p={renewalId:id,flowId:id,enrollmentId:row.id,expectedEpoch:current.epoch,expectedVersionId:current.versionId,
    expectedCandidateDigest:current.digest,scopeDigest:row.scope_digest,assetSetDigest:R.assetSetDigest(s.grant.assets),
    clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
  const start=await f.execute(R.OPERATIONS.begin,p);
  assert.equal(start.data.continuedQuickChat,true);
  const granted=new URL(start.data.authUrl).searchParams.get('scope').split(',');
  f.state.afterGraph=(kind,value)=>{if(kind==='inspect'){value.data.scopes=granted;value.data.granular_scopes.push({scope:'pages_messaging',target_ids:['401','997']});}return value;};
  const finish=await f.execute(R.OPERATIONS.finish,{renewalId:id,flowId:id,state:p.state,code:'FICTITIOUS_RENEWAL_'+id});
  await assert.rejects(s.call(social.status,'messenger'),{code:'scope_denied'});
  const activated=await f.execute(R.OPERATIONS.activate,{renewalId:id,enrollmentId:row.id,expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,
    expectedCandidateDigest:p.expectedCandidateDigest,candidateVersionId:id,candidateDigest:finish.data.candidate.digest});
  const j=require('../src/meta-marketing-social-consent').journal(f.current.store);
  assert(!j.active(row.id,{versionId:id,digest:current.digest},row.flow));
  assert.deepEqual(activated.data.quickChatSubscriptionPages,['401']);
  R.validateResponse(R.OPERATIONS.activate,activated.data,{renewalId:id,enrollmentId:row.id,expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,expectedCandidateDigest:p.expectedCandidateDigest,candidateVersionId:id,candidateDigest:finish.data.candidate.digest},f.binding);
  const projection=j.active(row.id,activated.data.effectiveCredential,row.flow);
  assert.deepEqual(JSON.parse(projection.projection).granularScopes.find(g=>g.scope==='pages_messaging').targetIds,['401']);
  const provider=fixture();t.mock.method(globalThis,'fetch',provider.ctx.transport);
  assert.equal((await s.call(social.status,'messenger')).data.available,true);
});

test('an active single-clinic route conflicting with an explicit clinic or parent Page blocks signed ingress and both destinations before reading or sending',async t=>{
  for (const conflict of [{clinicId:72, pageId:'401'},{clinicId:71, pageId:'402'}]) await t.test(JSON.stringify(conflict),async t=>{
    const s=await singleOnboarding(t,{socialInbox:[{channel:'instagram',accountId:'501',...conflict}]});
    const ingress=signedIngress(t,s.owner);
    assert.deepEqual((await ingress('instagram',['501'])).data.destinations,[]);
    assert.deepEqual((await ingress('page',['401'])).data.destinations,[{accountId:'401',clinicId:71}]);
    const spy=t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected Meta call'));
    for (const target of [{clinicId:71,pageId:'401'},conflict]) {
      const base={clinicId:target.clinicId,channel:'instagram',accountId:'501',kind:'dm'};
      const id=require('node:crypto').randomUUID(), overr={requestId:id,assetRef:'meta-facebook_page:'+target.pageId};
      await assert.rejects(s.owner.execute(social.status,base,overr,'reader'),{code:'scope_denied'});
      await assert.rejects(s.owner.execute(social.send,{...base,recipient:'771',text:'FICTITIOUS',attemptId:id},overr,'reader'),{code:'scope_denied'});
    }
    assert.equal(spy.mock.callCount(),0);
  });
});

test('a Page-only initial grant records only its linked IG from the existing selected inventory call; a later client cannot use it before the physical extension is confirmed',async t=>{
  const s=await singleOnboarding(t,{baseInstagram:false,selected:['meta-facebook_page:401']});
  assert(s.requested.includes('instagram_basic'));
  assert(!s.owner.binding.metaMarketingOAuth.scopes.includes('instagram_basic'));
  const record=require('../src/meta-marketing-social-consent').journal(s.owner.current.store).find(s.flow.flowId);
  assert.deepEqual(JSON.parse(record.projection).granularScopes.find(g=>g.scope==='instagram_manage_messages').targetIds,['501']);
  assert(!record.projection.includes('999'));
  const spy=t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected Graph call'));
  await assert.rejects(s.call(social.status,'instagram'),{code:'scope_denied'});
  assert.equal(spy.mock.callCount(),0);
});

test('ordinary renewal losing a previously granted permission on the selected Page cannot replace its working credential',async t=>{
  const {randomUUID,randomBytes}=require('node:crypto'),C=require('../src/meta-marketing-oauth-contract'),R=require('../src/meta-marketing-credential-renewal-contract');
  const s=await singleOnboarding(t,{channels:['messenger']}),f=s.owner, id=randomUUID();
  const row=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(s.enrollmentId),current=f.current.epochs.current(row,f.binding);
  const p={renewalId:id,flowId:id,enrollmentId:row.id,expectedEpoch:current.epoch,expectedVersionId:current.versionId,
    expectedCandidateDigest:current.digest,scopeDigest:row.scope_digest,assetSetDigest:R.assetSetDigest(s.grant.assets),
    clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
  await f.execute(R.OPERATIONS.begin,p);
  f.state.afterGraph=(kind,value)=>{if(kind==='inspect'){value.data.scopes=s.requested;value.data.granular_scopes.push({scope:'pages_messaging',target_ids:['999']});}return value;};
  await assert.rejects(f.execute(R.OPERATIONS.finish,{renewalId:id,flowId:id,state:p.state,code:'FICTITIOUS_RENEWAL_'+id}),{code:'oauth_credentials_incomplete'});
  assert.equal(f.current.epochs.current(row,f.binding).versionId,current.versionId);
});

test('history reports the timed-out Graph stage and preserves a real Page rate limit', async (t) => {
  const { ctx, call } = fixture();
  const original = ctx.transport, controller = new AbortController();
  const end = Date.now() - 1000, args = { start: end - 72 * 3600000, end, cursor: null, participantId: '771' };
  ctx.context = { principalId: 'reader', tenantRef: 'test', binding: { connectionRef: 'connection' }, policyVersion: 'p1', generation: 'g1' };
  ctx.signal = controller.signal;
  ctx.transport = async (url, options) => {
    if (!url.pathname.endsWith('/conversations')) return original(url, options);
    return { ok: false, status: 403, json: async () => ({ error: { code: 80006 } }) };
  };
  await assert.rejects(call(social.history, 'instagram', 'dm', args), { code: 'rate_limited' });
  ctx.transport = async (url, options) => {
    if (!url.pathname.endsWith('/conversations')) return original(url, options);
    controller.abort();
    throw Object.assign(Error('time'), { name: 'AbortError' });
  };
  await assert.rejects(call(social.history, 'instagram', 'dm', args), { code: 'provider_timeout' });
  assert.throws(() => social.checks[social.history]({ clinicId: 41, accountId: '401', channel: 'messenger', kind: 'dm', ...args }), /invalid_request/);
  const diagnostics = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (line, ...rest) => {
    if (typeof line === 'string' && line.startsWith('{"event":"meta_social_history_failed"')) {
      diagnostics.push(JSON.parse(line));
      return true;
    }
    return write(line, ...rest);
  });
  ctx.signal = new AbortController().signal;
  ctx.transport = async (url, options) => {
    if (!url.pathname.endsWith('/conversations')) return original(url, options);
    return { ok: false, status: 429, json: async () => ({ error: { code: 'sensitive-provider-text' } }) };
  };
  await assert.rejects(call(social.history, 'instagram', 'dm', args), { code: 'rate_limited' });
  assert.deepEqual(diagnostics, [{ event: 'meta_social_history_failed', channel: 'instagram', kind: 'dm', edge: 'conversations', reason: 'rate_limited', status: 429 }]);
  ctx.transport = async (url, options) => {
    if (!url.pathname.endsWith('/conversations')) return original(url, options);
    const headers = new Headers({
      'retry-after': '20',
      'x-business-use-case-usage': '{"private-business":[{"estimated_time_to_regain_access":3}]}',
    });
    return { ok: false, status: 403, headers, json: async () => ({ error: { code: 4 } }) };
  };
  await assert.rejects(call(social.history, 'instagram', 'dm', args), { code: 'rate_limited', retryAfterMs: 180000 });
  assert.equal(diagnostics.at(-1).retryAfterMs, 180000);
  assert.ok(!JSON.stringify(diagnostics).includes('private-business'));


});

test('page subscriptions keep quota headers when the response body is incomplete', async () => {
  const { f, enable } = subscriptionFixture();
  const observations = [];
  f.ctx.subscriptionPacer.observe = (scope, used) => observations.push({ scope, used });
  f.ctx.transport = async () => ({
    headers: new Headers({ 'x-app-usage': '{"call_count":95}' }),
    json: async () => { throw new SyntaxError('invalid JSON'); },
  });
  await assert.rejects(enable(), SyntaxError);
  assert.deepEqual(observations, [{ scope: 'meta-ads-app:101', used: 95 }]);
});
