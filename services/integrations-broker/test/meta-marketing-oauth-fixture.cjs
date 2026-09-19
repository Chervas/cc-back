'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto'); const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { BrokerStore } = require('../src/store'); const { Broker } = require('../src/broker'); const { signRequest } = require('../src/auth');
const { createMetaMarketingOAuth, createMetaMarketingOAuthOperations } = require('../src/meta-marketing-oauth'); const { createMetaMarketingOAuthSecrets } = require('../src/meta-marketing-oauth-secrets');
const { createMetaMarketingOAuthHttp } = require('../src/meta-marketing-oauth-http'); const C = require('../src/meta-marketing-oauth-contract'); const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
const TOKEN = 'FICTITIOUS_META_OAUTH_TOKEN'; const APP = '0123456789abcdef'.repeat(2);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-meta-oauth-qa-')); fs.chmodSync(dir, 0o700);
  const filename = path.join(dir, 'state.sqlite'); const gateway = generateKeyPairSync('ed25519'); const control = generateKeyPairSync('ed25519');
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/meta-marketing/staging/`;
  const binding = { connectionRef: 'connection:meta-enroll-qa', provider: C.PROVIDER, initialState: 'active', expiresAt: Date.now() + 86400000,
    secretArn: prefix + 'qa-candidate-abcdef', clientSecretArn: prefix + 'qa-app-abcdef', metaMarketingOAuth: {
      appId: '101', redirectUri: 'https://app.example.invalid/oauth/meta/marketing/callback', appVersionId: 'a'.repeat(32), slotVersionId: 's'.repeat(32),
      scopeKey: 'group:9', clinicIds: [71, 72], scopes: ['public_profile', 'ads_read', 'pages_read_engagement', 'instagram_basic'],
    } };
  const principal = (id, keyId, key) => ({ id, keyId, enabled: true, maxPerMinute: 20, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  const grant = { connectionRef: binding.connectionRef, tenantRef: 'clinic:71', assetRef: 'meta-enroll:group:9' };
  const policy = { audience: 'broker:meta-oauth-qa', version: 'meta-oauth-qa-v1', maxBacklog: 100,
    principals: [principal('gateway:staging:meta-marketing-oauth', 'qa-gateway', gateway), principal('control:staging:meta-marketing-oauth', 'qa-control', control)],
    connections: [binding], grants: [{ ...grant, principalId: 'gateway:staging:meta-marketing-oauth', operations: Object.values(C.OPERATIONS) },
      { ...grant, principalId: 'control:staging:meta-marketing-oauth', operations: [C.OPERATIONS.status, C.OPERATIONS.abort] }] };
  const records = new Map();
  const seed = (arn, version, value) => records.set(arn, new Map([[version, { body: JSON.stringify(value), stages: ['AWSCURRENT'] }]]));
  seed(binding.secretArn, binding.metaMarketingOAuth.slotVersionId, { version: 1, provider: 'meta-marketing-oauth-slot', connectionRef: binding.connectionRef, scopeKey: 'group:9', clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), appId: '101' });
  seed(binding.clientSecretArn, binding.metaMarketingOAuth.appVersionId, { version: 1, provider: 'meta-app', appId: '101', appSecret: APP });
  const state = { clock: Date.now(), awsCalls: [], httpCalls: [], codes: 0, puts: 0, heldTokens: [], records,
    beforeAws: null, afterAws: null, beforeCode: null, afterGraph: null, failPut: false, losePut: false };
  const now = () => state.clock;
  const aws = { async send(command, options) {
    state.awsCalls.push(command); await state.beforeAws?.(command, options);
    const name = command.constructor.name; const input = command.input; const versions = records.get(input.SecretId);
    if (!versions) throw Error('FICTITIOUS_MISSING_SECRET'); let result;
    if (name === 'DescribeSecretCommand') result = { ARN: input.SecretId, KmsKeyId: SECRET_KEY, VersionIdsToStages: Object.fromEntries([...versions].map(([id, v]) => [id, [...v.stages]])) };
    else if (name === 'ListSecretVersionIdsCommand') {
      assert.equal(input.IncludeDeprecated, true); assert.equal(input.MaxResults, 100);
      result = { ARN: input.SecretId, Versions: [...versions.keys()].slice(0, 100).map(VersionId => ({ VersionId })), ...(versions.size > 100 ? { NextToken: 'more' } : {}) };
    } else if (name === 'GetSecretValueCommand') {
      const v = versions.get(input.VersionId); if (!v || input.VersionStage && !v.stages.includes(input.VersionStage)) throw Error('FICTITIOUS_MISSING_VERSION');
      result = { ARN: input.SecretId, VersionId: input.VersionId, VersionStages: [...v.stages], SecretString: v.body };
    } else if (name === 'PutSecretValueCommand') {
      state.puts++; assert.notEqual(input.SecretId, binding.clientSecretArn); assert.deepEqual(input.VersionStages, ['AWSPENDING']); assert(C.uuid(input.ClientRequestToken));
      if (state.failPut) throw Error('FICTITIOUS_WRITE_FAILED');
      if (versions.has(input.ClientRequestToken)) assert.equal(versions.get(input.ClientRequestToken).body, input.SecretString);
      else { for (const v of versions.values()) v.stages = v.stages.filter(s => s !== 'AWSPENDING'); versions.set(input.ClientRequestToken, { body: input.SecretString, stages: ['AWSPENDING'] }); }
      if (state.losePut) { state.losePut = false; throw Error('FICTITIOUS_ACK_LOST'); }
      result = { ARN: input.SecretId, VersionId: input.ClientRequestToken, VersionStages: [...versions.get(input.ClientRequestToken).stages] };
    } else assert.fail('Unexpected AWS operation ' + name);
    return state.afterAws ? state.afterAws(command, result) : result;
  } };
  const request = (settings, callback) => {
    const req = new EventEmitter(); let destroyed=false; req.destroy = () => {destroyed=true;}; req.end = () => {
      const url=new URL('https://graph.facebook.com'+settings.path);
      assert.equal(settings.hostname,'graph.facebook.com'); assert.equal(settings.method,'GET');
      const kind=url.pathname.endsWith('/debug_token')?'inspect':url.searchParams.has('code')?'code':'extend';
      state.httpCalls.push({kind}); if(kind==='code')state.codes++;
      queueMicrotask(async()=>{
        try {
          if(kind==='code')await state.beforeCode?.();
          if(destroyed)return;
          let response;
          if(kind==='inspect') {
            assert.equal(settings.headers.authorization,'Bearer 101|'+APP);assert.equal(url.searchParams.get('input_token'),TOKEN);
            response={data:{app_id:'101',user_id:'201',type:'USER',is_valid:true,expires_at:Math.floor(now()/1000)+3600,data_access_expires_at:0,
              scopes:[...binding.metaMarketingOAuth.scopes],granular_scopes:[{scope:'ads_read',target_ids:['301']}]}};
          } else {
            assert.equal(url.pathname,'/v24.0/oauth/access_token');assert.equal(url.searchParams.get('client_secret'),APP);
            if(kind==='code')assert.equal(url.searchParams.get('redirect_uri'),binding.metaMarketingOAuth.redirectUri);
            else {assert.equal(url.searchParams.get('grant_type'),'fb_exchange_token');assert.equal(url.searchParams.get('fb_exchange_token'),'FICTITIOUS_META_SHORT_TOKEN');}
            response={access_token:kind==='code'?'FICTITIOUS_META_SHORT_TOKEN':TOKEN,token_type:'bearer',expires_in:3600};
          }
          if(state.afterGraph)response=await state.afterGraph(kind,response);
          const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify(response));
        } catch(e) {req.emit('error',e);}
      });
    };return req;
  };
  const http=createMetaMarketingOAuthHttp({request,now});
  const secrets = createMetaMarketingOAuthSecrets({ client: aws, accountId: ACCOUNT, prefix: '/clinicaclick/integrations/prod/meta-marketing/staging/', kmsKeyArn: SECRET_KEY });
  const stores = []; const engines = [];
  function make(target = new BrokerStore(filename), chosenPolicy = policy) {
    stores.push(target); const engine = createMetaMarketingOAuth({ store: target, policy: chosenPolicy, secrets, http, now }); engines.push(engine);
    return { store: target, engine, broker: new Broker({ store: target, policy: chosenPolicy, secrets, operations: createMetaMarketingOAuthOperations(engine), now }) };
  }
  let current = make();
  const command = (operation, payload, overrides = {}) => ({ requestId: randomUUID(), ...grant, operation, payload, ...overrides });
  const signed = (value, isControl = false) => signRequest(value, { keyId: isControl ? 'qa-control' : 'qa-gateway', privateKey: (isControl ? control : gateway).privateKey, audience: policy.audience, now: now() });
  const execute = (operation, payload, overrides = {}, isControl = false, instance = current) => { const s = signed(command(operation, payload, overrides), isControl); return instance.broker.execute(s.raw, s.headers); };
  const begin = async (overrides = {}, instance = current) => {
    const flowId = randomUUID(); const payload = { state: randomBytes(32).toString('base64url'), expiresAt: now() + 600000,
      scopeDigest: C.hash('fictitious-group-snapshot'), clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), ...overrides };
    const result = await execute(C.OPERATIONS.begin, payload, { requestId: flowId }, false, instance); return { flowId, payload, result, code: 'FICTITIOUS_META_CODE_' + flowId };
  };
  const finish = (flow, changes = {}, instance = current) => execute(C.OPERATIONS.finish, { flowId: flow.flowId, state: flow.payload.state, code: flow.code, ...changes }, {}, false, instance);
  const status = (flow, instance = current) => execute(C.OPERATIONS.status, { flowId: flow.flowId }, {}, false, instance);
  const abort = (flow, instance = current, isControl = false) => execute(C.OPERATIONS.abort, { flowId: flow.flowId }, {}, isControl, instance);
  const snapshot = (instance = current) => JSON.stringify(['meta_marketing_oauth_flows','audit_outbox','commands']
    .map(table=>instance.store.db.prepare('SELECT * FROM '+table).all()));
  const config={cohort:C.COHORT,enabled:true,environment:'staging',listenAddress:'127.0.0.1',port:19093,
    stateFile:path.join(dir,'runtime.sqlite'),tlsCertFile:path.join(dir,'tls.crt'),tlsKeyFile:path.join(dir,'tls.key'),policy};
  t.after(() => { for (const engine of engines) engine.close(); for (const store of stores) try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, binding, policy, state, records, secrets, aws, http, request, config, now, make, command, signed, execute,
    begin, finish, status, abort, snapshot, gateway, control, get current() { return current; }, restart() { current.engine.close(); current.store.close(); current = make(); return current; } };
}
module.exports = { fixture, TOKEN, APP };
