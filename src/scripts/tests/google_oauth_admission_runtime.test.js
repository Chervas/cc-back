'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture,CLIENT_ID,REDIRECT,STATE,CODE } = require('./fixtures/google_first_callback.fixture');
const Returns = require('../../services/googleOAuthAdmissionReturn.contract');
const { createGoogleOAuthAdmissionRuntime,installGoogleOAuthAdmissionRuntime,createFirstSearchConsoleRevoker } = require('../../services/googleOAuthAdmissionRuntime.service');
const { initializeGoogleOAuthAdmissionHttp } = require('../../routes/googleOAuthAdmission.startup');

const env = { RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging',GOOGLE_OAUTH_FIRST_ADMISSION_INSTALLED:'true',
  GOOGLE_OAUTH_FIRST_ADMISSION_CONFIG_FILE:'/etc/fixture/google-first-crm.json' };
const config = {
  schema:'clinicaclick-google-first-admission-crm/1',environment:'staging',startsEnabled:true,
  origin:'https://google-first.example.invalid:8443/',keyId:'fictitious-crm-first-key',
  keyFile:'/etc/fixture/google-first-private-key',caFile:'/etc/fixture/google-first-ca',clientId:CLIENT_ID,redirectUri:REDIRECT,
  scopes:[{ scopeKey:'group:29',clinicIds:[66,72],services:['search_console'] }],
};

function harness(t) {
  const f = fixture(t);
  const dates = ['session_expires_at','created_at','expires_at'];
  const decode = row => row && Object.fromEntries(Object.entries(row).map(([key,value]) =>
    [key,dates.includes(key) ? new Date(value) : value]));
  f.sqlite.exec('CREATE TABLE GoogleOAuthAdmissionReturns (' + Returns.FIELDS.map(key => key + ' '
    + (key === 'actor_user_id' ? 'INTEGER' : 'TEXT') + (key === 'state_hash' ? ' PRIMARY KEY' : key === 'attempt_id' ? ' UNIQUE' : '')).join(',') + ')');
  const original = f.model.findByPk;
  f.models.GoogleOAuthAdmissionAttempt = { ...f.model, async findByPk(id,options) {
    const instance = await original(id,{ ...options,lock:f.current().LOCK.UPDATE });
    return options.raw && instance ? instance.get({ plain:true }) : instance;
  } };
  f.models.GoogleOAuthAdmissionPublication = { async findByPk() { return null; } };
  f.models.GoogleOAuthBrokerRequest = { async findAll() { return []; } };
  f.models.Usuario = { async findByPk(id) { return { id_usuario:id }; } };
  f.models.AuthSession = { async findAll() { return [{ session_id:f.state.session }]; } };
  f.models.GoogleOAuthAdmissionReturn = {
    async findByPk(key) {
      return decode(f.sqlite.prepare('SELECT * FROM GoogleOAuthAdmissionReturns WHERE state_hash=?').get(key));
    },
    async findOne({ where }) {
      return decode(f.sqlite.prepare('SELECT * FROM GoogleOAuthAdmissionReturns WHERE attempt_id=?').get(where.attempt_id));
    },
    async create(row) {
      if (f.state.failRegister) throw Error('FICTITIOUS_PRIVATE_DATABASE_DETAIL');
      f.sqlite.prepare('INSERT INTO GoogleOAuthAdmissionReturns (' + Returns.FIELDS.join(',') + ') VALUES ('
        + Returns.FIELDS.map(() => '?').join(',') + ')').run(...Returns.FIELDS.map(key => dates.includes(key) ? row[key].toISOString() : row[key]));
      return decode(f.sqlite.prepare('SELECT * FROM GoogleOAuthAdmissionReturns WHERE state_hash=?').get(row.state_hash));
    },
  };
  function options(overrides = {}) {
    const key = Buffer.from('fictitious signing material'), ca = Buffer.from('fictitious TLS CA');
    return {
      key,
      dependencies:() => ({ models:f.models,sessions:f.sessions,now:() => new Date(f.state.now),clientFactory(pin) {
        assert.equal(pin.privateKey,key);
        assert.equal(pin.ca,ca);
        assert.equal(pin.audience,'clinicaclick:google-first-oauth:staging:v1');
        assert.equal(pin.origin,config.origin);
        assert.equal(pin.keyId,config.keyId);
        return f.client;
      } }),
      readFile(name,{ config:isConfig } = {}) {
        if (isConfig) {
          assert.equal(name,env.GOOGLE_OAUTH_FIRST_ADMISSION_CONFIG_FILE);
          return Buffer.from(JSON.stringify({ ...config,...overrides }));
        }
        if (name === config.keyFile) return key;
        assert.equal(name,config.caFile);
        return ca;
      },
    };
  }
  function make(overrides) {
    const { key, ...opts } = options(overrides);
    const runtime = installGoogleOAuthAdmissionRuntime({ env,...opts });
    assert(key.every(byte => byte === 0));
    return runtime;
  }
  const rows = () => f.sqlite.prepare('SELECT * FROM GoogleOAuthAdmissionReturns').all();
  return { ...f,make,options,rows };
}

test('absence of installed config and gateway opt-in cause no model or credential read', () => {
  const forbid = () => assert.fail('Unexpected configuration/model load');
  assert.equal(installGoogleOAuthAdmissionRuntime({ env:{},readFile:forbid,dependencies:forbid }),null);
  assert.throws(() => installGoogleOAuthAdmissionRuntime({ env:{ ...env,RUNTIME_ROLE:'gateway' },
    readFile:forbid,dependencies:forbid }),{ status:503 });
});

test('an installed configuration error keeps the OAuth router up and denies ambiguous returns', async () => {
  const adapters = [];
  const authenticate = () => {};
  const oauth = { installGoogleOAuthAdmissionHttp(value) { adapters.push(value); } };
  const received = [];
  const createAdapter = options => { received.push(options); return options; };
  const options = { env,authenticate,createAdapter,install:() => null,warn:() => {} };
  initializeGoogleOAuthAdmissionHttp(oauth,options);
  assert.equal(adapters.length,0);
  initializeGoogleOAuthAdmissionHttp(oauth,{ ...options,install() { throw Error('FICTITIOUS_PRIVATE_FILE_PATH'); },
    warn(text) { assert.equal(text,'[google-first-admission] configured runtime unavailable'); },
  });
  assert.equal(adapters.length,1);
  assert.equal(received[0].authenticate,authenticate);
  assert.equal(received[0].returnOrigin,'https://crm.clinicaclick.com');
  await assert.rejects(received[0].runtime.callback({ state:STATE,codeBuffer:Buffer.from(CODE) }),
    error => error.status === 503 && error.message === 'google_oauth_admission_attempt_unavailable' && !error.cause);
});

test('an explicitly installed null configuration is unavailable and never treated as absent', () => {
  assert.throws(() => installGoogleOAuthAdmissionRuntime({
    env,readFile:() => Buffer.from('null'),dependencies:() => assert.fail('Unexpected dependencies load'),
  }),{ status:503 });
  for (const mismatch of [{ ...env,GOOGLE_OAUTH_FIRST_ADMISSION_CONFIG_FILE:'' },{ ...env,GOOGLE_OAUTH_FIRST_ADMISSION_INSTALLED:'false' }]) {
    assert.throws(() => installGoogleOAuthAdmissionRuntime({
      env:mismatch,readFile:() => assert.fail('Unexpected configuration read'),
    }),{ status:503 });
  }
});

test('the first SC revoker uses the control principal and the approved scope after new starts are paused', async () => {
  const requests = [];
  const key = Buffer.from('fictitious control credential');
  const revoker = createFirstSearchConsoleRevoker({
    env,readFile(filename,{ config:isConfig } = {}) {
      if (isConfig) return Buffer.from(JSON.stringify({ ...config,startsEnabled:false }));
      return filename === config.keyFile ? key : Buffer.from('fictitious TLS CA');
    },
    clientFactory(pins) {
      assert.equal(pins.keyId,config.keyId);
      assert.equal(pins.privateKey,key);
      assert.equal(pins.audience,'clinicaclick:google-first-oauth:staging:v1');
      return { execute(command,budget) { requests.push({ command,budget }); return { data:{ revoked:true } }; } };
    },
  });
  const command = { operation:'google.search_console.asset.revoke.v1',connectionRef:'google-first:search_console:group:29',
    assetRef:'sc:'+'b'.repeat(64),tenantRef:'clinic:72',payload:{} };
  assert.throws(() => revoker.execute({ ...command,tenantRef:'clinic:90' }),{ status:403 });
  assert.throws(() => revoker.execute({ ...command,operation:'google.search_console.discovery.read.v1' }),{ status:403 });
  assert.equal(requests.length,0);
  assert.deepEqual(await revoker.execute(command,{ timeoutMs:10000 }),{ data:{ revoked:true } });
  assert.deepEqual(requests,[{ command,budget:{ timeoutMs:10000 } }]);
  assert(key.every(byte => byte === 0));
});

test('configuration rejects the wrong namespace and untrusted origin, paths, scope and service duplicates before credential reads', () => {
  for (const value of [
    { environment:'dev' },{ origin:'http://google-first.example.invalid/' },{ origin:'https://google-first.example.invalid/path' },
    { origin:'https://who:password@google-first.example.invalid/' },{ redirectUri:'https://crm.example.invalid/return' },
    { keyFile:'key' },{ caFile:config.keyFile },{ startsEnabled:'true' },
    { scopes:[{ scopeKey:'group:29',clinicIds:[72,66],services:['search_console'] }] },
    { scopes:[{ scopeKey:'group:29',clinicIds:[66,72],services:['search_console','search_console'] }] },
    { scopes:[{ scopeKey:'clinic:66',clinicIds:[72],services:['search_console'] }] },
  ]) {
    const forbid = () => assert.fail('Unexpected credential read');
    assert.throws(() => createGoogleOAuthAdmissionRuntime({ config:{ ...config,...value },environment:'staging',readFile:forbid }),{ status:503 });
  }
});

test('capability uses the approved service and the complete normal-session clinic roster', async t => {
  const f = harness(t), runtime = f.make();
  const exact = { scopeKey:'group:29',service:'search_console' };
  assert.deepEqual(await runtime.capability(f.req(),exact),{ enabled:true });
  assert.deepEqual(await runtime.capability(f.req(),{ ...exact,service:'analytics' }),{ enabled:false });
  assert.deepEqual(await runtime.capability(f.req(),{ ...exact,scopeKey:'clinic:66' }),{ enabled:false });
  f.state.clinics.push(80);
  f.state.memberships.set(80,['propietario','aceptada']);
  assert.deepEqual(await runtime.capability(f.req(),exact),{ enabled:false });
  f.state.clinics.pop();
  f.state.memberships.delete(72);
  await assert.rejects(runtime.capability(f.req(),exact),{ status:403 });
  assert.equal(f.state.calls.length,0);
  assert.equal(f.rows().length,0);
});

test('begin commits the hashed locator and the same attempt survives pausing new starts', async t => {
  const f = harness(t), runtime = f.make(), selection = f.command({ service:'search_console' });
  const started = await runtime.begin(f.req(),selection);
  assert.equal(new URL(started.authorizationUrl).searchParams.get('state'),STATE);
  assert.equal(f.rows()[0].state_hash,Returns.stateHash(STATE));
  assert(!JSON.stringify(f.rows()).includes(STATE));
  const paused = f.make({ startsEnabled:false });
  assert.deepEqual(await paused.capability(f.req(),selection),{ enabled:false });
  await assert.rejects(paused.begin(f.req(),selection),{ status:403 });
  assert.equal((await paused.status(f.req(),selection)).authorizationState,'prepared');
  assert.deepEqual(await paused.callback({ state:'U'.repeat(43),codeBuffer:Buffer.from(CODE) }),{ recognized:false });
  for (let i=0;i<2;i++) {
    const result = await paused.callback({ state:STATE,codeBuffer:Buffer.from(CODE) });
    assert.equal(result.attemptId,selection.attemptId);
    assert.equal(result.scopeKey,selection.scopeKey);
    assert.equal(result.service,selection.service);
    assert.equal(result.connected,false);
  }
  assert.equal(f.state.exchanges,1);
});

test('failed local return registration withholds the consent URL and a retry uses the same attempt', async t => {
  const f = harness(t), runtime = f.make(), selection = f.command({ service:'search_console' });
  f.state.failRegister = true;
  await assert.rejects(runtime.begin(f.req(),selection),error => error.status === 503 && !JSON.stringify(error).includes('FICTITIOUS_PRIVATE'));
  assert.equal(f.rows().length,0);
  f.state.failRegister = false;
  assert(new URL((await runtime.begin(f.req(),selection)).authorizationUrl));
  assert.equal(f.rows().length,1);
  assert.equal(new Set(f.state.calls.filter(item => item.action === 'begin').map(item => item.requestId)).size,1);
  assert.equal(f.state.exchanges,0);
});

test('GA4 revoker pins analytics-only canonical asset and the exact approved clinic while starts are paused',async()=>{
 const { createFirstAnalyticsRevoker }=require('../../services/googleOAuthAdmissionRuntime.service');
 const requests=[],key=Buffer.from('fictitious GA control credential');
 const revoker=createFirstAnalyticsRevoker({ env,readFile(filename,{ config:isConfig }={}) {
  if(isConfig)return Buffer.from(JSON.stringify({ ...config,startsEnabled:false,scopes:[{ scopeKey:'group:29',clinicIds:[66,72],services:['analytics'] }] }));
  return filename===config.keyFile?key:Buffer.from('fictitious TLS CA');
 },clientFactory:pins=>{assert.equal(pins.keyId,config.keyId);return { execute(command,budget){requests.push({ command,budget });return { data:{ revoked:true } };} };} });
 const command={ operation:'google.analytics.asset.revoke.v1',connectionRef:'google-first:analytics:group:29',tenantRef:'clinic:72',assetRef:'ga4:333',payload:{} };
 for(const changes of [{ tenantRef:'clinic:90' },{ operation:'google.analytics.daily.read.v1' },{ assetRef:'ga4:0333' },
  { assetRef:'sc:'+'b'.repeat(64) },{ connectionRef:'google-first:search_console:group:29' },{ payload:{ scopeKey:'group:29' } }])assert.throws(()=>revoker.execute({ ...command,...changes }),{ status:403 });
 assert.equal(requests.length,0);assert.deepEqual(await revoker.execute(command,{ timeoutMs:10000 }),{ data:{ revoked:true } });
 assert.deepEqual(requests,[{ command,budget:{ timeoutMs:10000 } }]);assert(key.every(byte=>byte===0));
});


test('new GA4 starts require installed completion and normal reader, then revalidate authority after availability',async t=>{
 const f=harness(t),selection=f.command({ service:'analytics' }),gaScopes=[{ scopeKey:'group:29',clinicIds:[66,72],services:['analytics'] }];
 const partial=f.make({ scopes:gaScopes });assert.deepEqual(await partial.capability(f.req(),selection),{ enabled:false });
 await assert.rejects(partial.begin(f.req(),selection),{ status:403 });assert.equal(f.state.calls.length,0);
 f.models.PlatformAuditEvent={ sequelize:f.models.sequelize };
 let reader=false,revoke=false;
 const publisherPath=require.resolve('../../services/googleOAuthAdmissionPublication.service'),cachedPublisher=require.cache[publisherPath];
 // This test isolates start capability. Real publication/native SQL is tested
 // in the dedicated isolated-MySQL fixture, without loading AWS packages here.
 require.cache[publisherPath]={ id:publisherPath,filename:publisherPath,loaded:true,exports:{ createGoogleOAuthAdmissionPublication:()=>({publish:()=>assert.fail('Unexpected publication'),recoverySchemaReady:async()=>true,recoveryState:async()=>null}) } };
 let complete;try{complete=createGoogleOAuthAdmissionRuntime({ config:{ ...config,publicationEnabled:true,scopes:gaScopes },environment:'staging',
  models:f.models,sessions:f.sessions,now:()=>new Date(f.state.now),readFile:()=>Buffer.from('FICTITIOUS_KEY'),clientFactory:()=>f.client,
  readAuthority:{ async available(context){assert.deepEqual(context,{ scopeKey:'group:29',service:'analytics',clinicIds:[66,72] });
    if(revoke)f.state.memberships.set(72,['personaldeclinica','aceptada']);return reader;},verify:async()=>assert.fail('Unexpected native publication') } });
 }finally{if(cachedPublisher)require.cache[publisherPath]=cachedPublisher;else delete require.cache[publisherPath];}
 assert.deepEqual(await complete.capability(f.req(),selection),{ enabled:false });await assert.rejects(complete.begin(f.req(),selection),{ status:403 });assert.equal(f.state.calls.length,0);
 reader=true;assert.deepEqual(await complete.capability(f.req(),selection),{ enabled:true });
 revoke=true;await assert.rejects(complete.begin(f.req(),selection),{ status:403 });assert.equal(f.state.calls.length,0);assert.equal(f.rows().length,0);
});


test('first recovery worker is explicit API-only opt-in and never loads an absent runtime by default',async()=>{
 const {runGoogleOAuthAdmissionRecovery}=require('../../services/googleOAuthAdmissionRuntime.service');const deny=()=>assert.fail('Unexpected config/key/model read');
 for(const env of [{},{GOOGLE_OAUTH_FIRST_RECOVERY_WORKER_ENABLED:'true',RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'staging'},
  {GOOGLE_OAUTH_FIRST_RECOVERY_WORKER_ENABLED:'false',RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging'}])assert.equal((await runGoogleOAuthAdmissionRecovery({env,install:deny})).skipped,true);
 let ran=0;const result=await runGoogleOAuthAdmissionRecovery({env:{GOOGLE_OAUTH_FIRST_RECOVERY_WORKER_ENABLED:'true',RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging'},
  install:()=>({async runRecovery(){ran++;return{status:'completed',processed:2};}})});assert.equal(ran,1);assert.equal(result.processed,2);
});
