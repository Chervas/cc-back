'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFileSync,fork}=require('node:child_process'),{createHash,generateKeyPairSync,randomUUID,randomBytes}=require('node:crypto');
const {allowPort,removePort}=require('./offline-guard.cjs');
const R=require('../src/google-first-admission-main'),{OPERATIONS,clinicSetFingerprint}=require('../src/google-first-admission-rpc');
const {requiredScopesFor}=require('../src/google-first-identity-provider'),{TABLE}=require('../src/google-first-identity-journal');
const {BrokerStore}=require('../src/store'),{oauthSecretsFixture}=require('./google-oauth-fixture.cjs');
const {canonical}=require('../src/canonical');
const receiptDigest=receipt=>createHash('sha256').update(canonical(receipt)).digest('hex');

const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');
async function fixture(t,{maxBacklog=1000,service='analytics'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-google-first-runtime-'));fs.chmodSync(dir,0o700);const file=n=>path.join(dir,n);
 let app,port;t.after(async()=>{if(app)await app.close();if(port)removePort(port);fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir));});
 const openssl=args=>execFileSync('openssl',args,{stdio:'ignore'});
 fs.writeFileSync(file('ca.cnf'),'[req]\ndistinguished_name=dn\n[dn]\n');
 openssl(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-config',file('ca.cnf'),'-keyout',file('ca.key'),'-out',file('ca.crt'),'-days','30','-subj','/CN=FICTITIOUS_GOOGLE_FIRST_CA','-addext','basicConstraints=critical,CA:TRUE']);
 openssl(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',file('server.key'),'-out',file('server.csr'),'-subj','/CN=FICTITIOUS_GOOGLE_FIRST_SERVER']);
 fs.writeFileSync(file('extensions'),'basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
 openssl(['x509','-req','-in',file('server.csr'),'-CA',file('ca.crt'),'-CAkey',file('ca.key'),'-set_serial','1','-out',file('server.crt'),'-days','10','-extfile',file('extensions')]);
 for(const n of fs.readdirSync(dir))fs.chmodSync(file(n),0o600);
 const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});port=probe.address().port;await new Promise(r=>probe.close(r));allowPort(port);
 const keys=generateKeyPairSync('ed25519'),base=oauthSecretsFixture('google_'+service),baselineVersion=randomUUID(),applicationVersion=randomUUID();
 const slot={scopeKey:'group:11',service,secretArn:base.binding.secretArn.replace('fictitious-google-abcdef','google-first/'+service+'/group-11-qA123z'),clientSecretArn:base.binding.clientSecretArn,baselineVersion};
 const empty={version:1,provider:'google-first-empty-slot',connectionRef:'google-first:'+service+':group:11',scopeKey:'group:11',service};
 const versions=new Map([[baselineVersion,{body:JSON.stringify(empty),stages:new Set(['AWSCURRENT'])}]]);base.state.records.set(slot.secretArn,versions);
 base.state.records.set(slot.clientSecretArn,new Map([[applicationVersion,{body:JSON.stringify(base.app),stages:new Set(['AWSCURRENT'])}]]));
 const policy={audience:'clinicaclick:google-first-oauth:staging:v1',version:'google-first-oauth:staging:v1',maxBacklog,connections:[],grants:[],
  principals:[{id:'crm:staging:google-first-oauth',keyId:'qa-google-first-key',enabled:true,maxPerMinute:12,publicKey:keys.publicKey.export({type:'spki',format:'pem'})}]};
 const config={cohort:R.COHORT,purpose:R.PURPOSE,enabled:true,environment:'staging',listenAddress:'127.0.0.1',port,stateFile:file('first.sqlite'),
  tlsCertFile:file('server.crt'),tlsKeyFile:file('server.key'),tlsRenewal:{issuerCaFile:file('ca.crt')},policy,
  scopes:[{scopeKey:'group:11',clinicIds:[17,31],services:[service]}],slots:[slot],redirectUri:base.binding.oauth.redirectUri};
 const filename=file('config.json'),save=()=>fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});save();
 let factories=0,closed=0,sinkFail=false;const events=[],httpCalls=[];
 const deps={awsFactory:async()=>{factories++;return{secrets:base.client,sink:{async write(row){if(sinkFail)throw Error('FICTITIOUS_AUDIT_OUTAGE');events.push(JSON.parse(row.event));return{versionId:randomUUID(),digest:row.digest};}},close(){closed++;}};},
  http:async input=>{httpCalls.push(input);return input.hostname==='oauth2.googleapis.com'
   ?{access_token:'FICTITIOUS_RUNTIME_ACCESS',refresh_token:'FICTITIOUS_RUNTIME_REFRESH',token_type:'bearer',expires_in:3600,scope:requiredScopesFor(service).join(' ')}:{id:'10123456789'};}};
 const client=createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+port,audience:policy.audience,keyId:policy.principals[0].keyId,
  privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(file('ca.crt'))});
 const proof={attemptId:randomUUID(),bindingDigest:'f'.repeat(64),service,expiresAt:Date.now()+300000},clinicSetDigest=clinicSetFingerprint([17,31]);
 const call=(action,extra={},overrides={})=>client.execute({requestId:action==='begin'?extra.attemptId||proof.attemptId:randomUUID(),operation:OPERATIONS[action],tenantRef:'clinic:17',
  connectionRef:'google-first:'+(extra.attemptId||proof.attemptId),assetRef:'google-oauth:'+service+':group:11',payload:{...proof,clinicSetDigest,...extra},...overrides});
 return{dir,file,config,filename,save,base,slot,versions,applicationVersion,events,httpCalls,proof,deps,call,client,
  get app(){return app;},get factories(){return factories;},get closed(){return closed;},set sinkFail(v){sinkFail=v;},
  async start(){app=await R.main(filename,deps);return app;},async stop(){const old=app;app=null;if(old)await old.close();},
  puts(){return base.state.calls.filter(c=>c.kind==='PutSecretValueCommand').length;}};
}
test('dedicated TLS startup uses the actual signed transport and stages exactly one blocked first identity with atomic transition audit',async t=>{
 const f=await fixture(t);await f.start();assert.equal(f.app.server.maxConnections,8);assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);
 const begin=(await f.call('begin')).data,url=new URL(begin.authorizationUrl);assert.equal(begin.connected,false);assert.equal(url.hostname,'accounts.google.com');
 assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 const done=(await f.call('finish',{state:url.searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'})).data;
 assert.equal(done.state,'candidate_staged');assert.equal(done.connected,false);assert.equal(f.httpCalls.length,2);assert.equal(f.puts(),1);
 assert.equal((await f.call('status')).data.state,'candidate_staged');
 const events=f.app.store.db.prepare('SELECT event FROM audit_outbox').all().map(r=>JSON.parse(r.event)).concat(f.events);
 for(const reason of ['prepared','exchange_burned','provider_identity_received','candidate_stage_intended','candidate_stage_readback_confirmed'])assert(events.some(e=>e.reason==='google_first_'+reason));
 assert(events.every(e=>e.connectionRef==='google-first:'+f.proof.attemptId));
 const tables=['connections','google_oauth_flows','google_ads_enrollments','google_business_profile_enrollments','whatsapp_onboarding_flows'];
 for(const name of tables)assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM '+name).get().n,0);
 const disk=JSON.stringify(f.app.store.db.prepare('SELECT * FROM '+TABLE).all())+JSON.stringify(events);
 for(const secret of ['FICTITIOUS_RUNTIME_CODE','FICTITIOUS_RUNTIME_ACCESS','FICTITIOUS_RUNTIME_REFRESH',f.base.app.clientSecret,url.searchParams.get('state')])assert(!disk.includes(secret));
});

test('first GA4 consent through signed catalogue, confirmation and native scoped report survives restart and revokes once', async t => {
 const { BrokerError } = require('../src/errors');
 const { METRICS,REVOKE_OPERATION } = require('../src/google-analytics-contract');
 const { GA_OPERATION,firstAnalyticsSubjectDigest } = require('../src/google-property-discovery-contract');
 const { TABLE: publicationTable } = require('../src/google-first-publication-journal');
 const f = await fixture(t);
 const keys = generateKeyPairSync('ed25519');
 const readerPin = {
  id:'crm:staging:google-first-ga4-reader',keyId:'qa-google-first-ga4-reader-key',enabled:true,maxPerMinute:12,
  publicKey:keys.publicKey.export({type:'spki',format:'pem'}),
 };
 f.config.analyticsReaderPrincipal = readerPin;
 f.config.analyticsCursorKeyFile = f.file('analytics-cursor.key');
 fs.writeFileSync(f.config.analyticsCursorKeyFile,randomBytes(32),{mode:0o600});
 f.config.publicationResources = [
  { scopeKey:'group:11',service:'analytics',clinicId:31,resource:{ propertyName:'properties/321' } },
  { scopeKey:'group:11',service:'analytics',clinicId:17,resource:{ propertyName:'properties/654' } },
 ];
 const existingHttp = f.deps.http;
 let reports = 0;
 f.deps.http = async request => {
  if (request.hostname === 'analyticsdata.googleapis.com') {
   assert.equal(request.path,'/v1beta/properties/321:runReport');
   assert.deepEqual(request.json.dateRanges,[{startDate:'2026-11-16',endDate:'2026-11-16'}]);
   reports++;
   return {dimensionHeaders:[{name:'date'}],metricHeaders:METRICS.map((name,index) => ({
    name,type:index === 4 ? 'TYPE_CURRENCY' : 'TYPE_INTEGER',
   })),metadata:{currencyCode:'EUR',timeZone:'Europe/Madrid'},rowCount:1,
   rows:[{dimensionValues:[{value:'20261116'}],metricValues:[{value:'4'},{value:'3'},{value:'2'},{value:'1'},{value:'0'}]}]};
  }
  if (request.hostname !== 'analyticsadmin.googleapis.com') return existingHttp(request);
  if (request.path === '/v1beta/properties/654') throw new BrokerError('provider_unauthorized');
  assert.equal(request.path,'/v1beta/properties/321');
  f.httpCalls.push(request);
  return {name:'properties/321',displayName:'Fictitious\u202e Property',propertyType:'PROPERTY_TYPE_ORDINARY',
   parent:'accounts/17',account:'accounts/17'};
 };
 const reader = createIntegrationsBrokerClient({
  origin:'https://127.0.0.1:'+f.config.port,audience:f.config.policy.audience,keyId:readerPin.keyId,
  privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(f.file('ca.crt')),
 });
 const command = {operation:GA_OPERATION,connectionRef:'google-first:analytics:group:11',
  assetRef:'ga4:321',tenantRef:'clinic:31',payload:{}};
 f.save();
 await f.start();
 const {authorizationUrl} = (await f.call('begin')).data;
 await f.call('finish',{ state:new URL(authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE' });
 assert.equal((await f.call('catalogueReady')).data.canChooseAssets,true);
 assert.deepEqual((await f.call('catalogue')).data,{attemptId:f.proof.attemptId,scopeKey:'group:11',service:'analytics',
  assets:[{assetRef:'ga4:321',propertyName:'properties/321',displayName:'Fictitious Property',clinicIds:[31]}]});
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM '+publicationTable).get().n,0);
 await assert.rejects(reader.execute(command),{code:'scope_denied'});
 const providerBefore = f.httpCalls.length, commandsBefore = f.base.state.calls.length;
 const preview = (await f.call('identityPreview')).data;
 assert.deepEqual(preview,{attemptId:f.proof.attemptId,scopeKey:'group:11',service:'analytics',
  googleUserId:'10123456789',subjectDigest:firstAnalyticsSubjectDigest('10123456789')});
 assert.equal(f.httpCalls.length,providerBefore);
 assert.equal(f.base.state.calls.length,commandsBefore);
 const selection = {clinicId:31,selectedAssetRef:'ga4:321',expectedSubjectDigest:preview.subjectDigest,crmIntentId:randomUUID()};
 await assert.rejects(f.call('publication',{...selection,expectedSubjectDigest:firstAnalyticsSubjectDigest('different-fictitious-subject')}),
  {code:'oauth_identity_mismatch'});
 assert.equal(f.httpCalls.length,providerBefore);
 assert.equal(f.base.state.calls.length,commandsBefore);
 assert(!f.versions.get(f.proof.attemptId).stages.has('AWSCURRENT'));
 const first = (await f.call('publication',selection)).data;
 // Exercise the real CRM routing and certificate client against the same
 // signed Owner socket before the atomic API writer consumes the proof.
 const {createAnalyticsFirstReader} = require('../../../src/services/analyticsBroker.service');
 const signingFile = f.file('analytics-reader.pem');
 fs.writeFileSync(signingFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const crm = createAnalyticsFirstReader({env:{
  RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging',GOOGLE_ANALYTICS_BROKER_ENABLED:'true',GOOGLE_ANALYTICS_FIRST_READER_ENABLED:'true',
  GOOGLE_ANALYTICS_FIRST_READER_ORIGIN:'https://127.0.0.1:'+f.config.port,GOOGLE_ANALYTICS_FIRST_READER_KEY_ID:readerPin.keyId,
  GOOGLE_ANALYTICS_FIRST_READER_KEY_FILE:signingFile,GOOGLE_ANALYTICS_FIRST_READER_CA_FILE:f.file('ca.crt'),
 }});
 assert.equal((await crm.verify({receipt:first,
  context:{attemptId:f.proof.attemptId,scopeKey:'group:11',service:'analytics',clinicIds:[17,31]}})).displayName,'Fictitious Property');
 assert.equal(first.assetRef,'ga4:321');
 assert.equal(first.clinicId,31);
 assert.equal(first.secretVersion,f.proof.attemptId);
 assert.equal(Object.hasOwn(first,'resource'),false);
 assert(f.versions.get(f.proof.attemptId).stages.has('AWSCURRENT'));
 const reportCommand={...command,operation:'google.analytics.daily.read.v1',
  payload:{startDate:'2026-11-16',endDate:'2026-11-16',pageToken:null}};
 await assert.rejects(reader.execute(command),{code:'scope_denied'});
 await assert.rejects(reader.execute(reportCommand),{code:'scope_denied'});
 assert.equal(reports,0);
 const ack={...selection,receiptId:first.receiptId,receiptDigest:receiptDigest(first)};
 const observed=(await f.call('recoveryObserve',selection)).data;
 assert.equal(observed.state,'confirmed_current');
 assert.deepEqual(observed.receipt,first);
 const publication=(await f.call('recoveryAck',ack)).data;
 assert.equal(publication.state,'published');
 assert.equal(publication.receipt,null);
 assert.equal(publication.receiptDigest,observed.receiptDigest);
 assert.equal((await reader.execute(command)).data.name,'properties/321');
 await assert.rejects(reader.execute({...command,tenantRef:'clinic:17'}),{code:'scope_denied'});
 await assert.rejects(reader.execute({...command,assetRef:'ga4:654'}),{code:'scope_denied'});
 await assert.rejects(reader.execute({...command,operation:REVOKE_OPERATION}),{code:'scope_denied'});
 const report=await reader.execute(reportCommand);
 assert.equal(report.data.rows[0].metricValues[0].value,'4');
 assert.equal(reports,1);
 await f.stop();
 await f.start();
 const replay=(await f.call('recoveryAck',ack)).data;
 assert.deepEqual(replay,publication);
 assert.equal((await reader.execute(command)).data.name,'properties/321');
 assert.equal(f.base.state.calls.filter(call => call.kind === 'UpdateSecretVersionStageCommand').length,1);
 const events = f.app.store.db.prepare('SELECT event FROM audit_outbox').all().map(row => JSON.parse(row.event)).concat(f.events);
 assert(events.some(event => event.operation === OPERATIONS.publication && event.reason === 'google_first_publication_receipt_confirmed'));
 assert(events.some(event => event.operation === GA_OPERATION && event.reason === 'first_ga4_read_authority_installed'));
 assert.equal(new Set(events.filter(event=>event.reason==='google_first_analytics_sql_acknowledged').map(event=>event.eventId)).size,1);
 assert.equal((await f.client.execute({...command,operation:REVOKE_OPERATION})).data.revoked,true);
 await assert.rejects(reader.execute(command),{code:'asset_revoked'});
 await f.stop();
 await f.start();
 const providerCalls = f.httpCalls.length;
 await assert.rejects(reader.execute(command),{code:'asset_revoked'});
 await assert.rejects(f.call('publication',selection),{code:'asset_revoked'});
 assert.equal(f.httpCalls.length,providerCalls);
 assert.equal(f.base.state.calls.filter(call => call.kind === 'UpdateSecretVersionStageCommand').length,1);
});

test('first Analytics OAuth stays staged if a native reader was never installed', async t => {
 const f = await fixture(t);
 f.config.publicationResources = [{scopeKey:'group:11',service:'analytics',clinicId:31,resource:{propertyName:'properties/321'}}];
 f.save();
 await f.start();
 const {authorizationUrl} = (await f.call('begin')).data;
 await f.call('finish',{state:new URL(authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'});
 assert.equal((await f.call('status')).data.state,'candidate_staged');
 await assert.rejects(f.call('catalogueReady'));
 await assert.rejects(f.call('publication',{clinicId:31,selectedAssetRef:'ga4:321',expectedSubjectDigest:'e'.repeat(64),crmIntentId:randomUUID()}));
 assert.equal(f.base.state.calls.filter(call => call.kind === 'UpdateSecretVersionStageCommand').length,0);
});

async function recoveryFixture(t) {
 const {firstAnalyticsSubjectDigest}=require('../src/google-property-discovery-contract');
 const f=await fixture(t),keys=generateKeyPairSync('ed25519');
 const readerPin={id:'crm:staging:google-first-ga4-reader',keyId:'qa-ga4-recovery-reader',enabled:true,maxPerMinute:12,
  publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
 f.config.analyticsReaderPrincipal=readerPin;
 f.config.analyticsCursorKeyFile=f.file('analytics-recovery-cursor.key');
 fs.writeFileSync(f.config.analyticsCursorKeyFile,randomBytes(32),{mode:0o600});
 f.config.publicationResources=[
  {scopeKey:'group:11',service:'analytics',clinicId:31,resource:{propertyName:'properties/321'}},
  {scopeKey:'group:11',service:'analytics',clinicId:17,resource:{propertyName:'properties/654'}},
 ];
 const previousHttp=f.deps.http;
 f.deps.http=async input=>{
  if(input.hostname!=='analyticsadmin.googleapis.com')return previousHttp(input);
  f.httpCalls.push(input);
  const name=input.path.slice('/v1beta/'.length);
  return{name,displayName:'Fictitious property',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/17',account:'accounts/17'};
 };
 const reader=createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+f.config.port,audience:f.config.policy.audience,
  keyId:readerPin.keyId,privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(f.file('ca.crt'))});
 const selection={clinicId:31,selectedAssetRef:'ga4:321',expectedSubjectDigest:firstAnalyticsSubjectDigest('10123456789'),crmIntentId:randomUUID()};
 const command={operation:require('../src/google-property-discovery-contract').GA_ADMISSION_PROOF,
  connectionRef:'google-first:analytics:group:11',tenantRef:'clinic:31',assetRef:'ga4:321',payload:{}};
 f.save();
 await f.start();
 const {authorizationUrl}=(await f.call('begin')).data;
 await f.call('finish',{state:new URL(authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'});
 return {f,selection,reader,command};
}

test('lost activation acknowledgement is recovered after original expiry and quarantined without bootstrap',async t=>{
 const {f,selection,reader,command}=await recoveryFixture(t);
 const {BrokerError}=require('../src/errors');
 const {TABLE:publications}=require('../src/google-first-publication-journal');
 const send=f.base.client.send.bind(f.base.client);
 let lost=false;
 f.base.client.send=async(request,options)=>{
  const value=await send(request,options);
  if(!lost&&request.constructor.name==='UpdateSecretVersionStageCommand'){lost=true;throw new BrokerError('secret_unavailable');}
  return value;
 };
 await assert.rejects(f.call('publication',selection));
 assert.equal(lost,true);
 const intent=f.app.store.db.prepare('SELECT * FROM '+publications+' WHERE attempt_id=?').get(f.proof.attemptId);
 assert.equal(intent.state,'activation_intent');
 assert.equal(intent.receipt,null);
 assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM google_first_ga4_read_authorities_v1').get().n,0);
 assert(f.versions.get(f.proof.attemptId).stages.has('AWSCURRENT'));
 // Move the two test signing clocks beyond both approval and original proof.
 const realNow=Date.now,timed=realNow(); Date.now=()=>timed+600001;
 try {
  await f.stop();await f.start();
  const providerCalls=f.httpCalls.length;
  const observed=(await f.call('recoveryObserve',selection)).data;
  assert.equal(observed.state,'confirmed_current');
  assert.equal(observed.receipt,null);
  assert.equal(f.httpCalls.length,providerCalls);
  const mismatched={...selection,crmIntentId:randomUUID()};
  await assert.rejects(f.call('recoveryQuarantine',mismatched),{code:'idempotency_conflict'});
  const quarantined=(await f.call('recoveryQuarantine',selection)).data;
  assert.equal(quarantined.state,'quarantined');
  assert.equal(f.httpCalls.length,providerCalls);
  assert.deepEqual(f.app.store.db.prepare('SELECT tenant,connection,asset FROM asset_revocations').all().map(row=>({...row})),[
   {tenant:'clinic:31',connection:'google-first:analytics:group:11',asset:'ga4:321'},
  ]);
  await f.stop();await f.start();
  const secretCalls=f.base.state.calls.length;
  assert.deepEqual((await f.call('recoveryObserve',selection)).data,quarantined);
  assert.deepEqual((await f.call('recoveryQuarantine',selection)).data,quarantined);
  await assert.rejects(reader.execute(command));
  await assert.rejects(f.call('publication',selection));
  assert.equal(f.httpCalls.length,providerCalls);
  assert.equal(f.base.state.calls.length,secretCalls);
  assert.equal(f.base.state.calls.filter(call=>call.kind==='UpdateSecretVersionStageCommand').length,1);
 } finally { Date.now=realNow; }
});

test('quarantine wins before the original publication dispatch and fences delayed work',async t=>{
 const {f,selection,reader,command}=await recoveryFixture(t);
 const providerCalls=f.httpCalls.length,secretCalls=f.base.state.calls.length;
 assert.equal((await f.call('recoveryObserve',selection)).data.state,'unknown');
 assert.equal((await f.call('recoveryQuarantine',selection)).data.state,'quarantined');
 await assert.rejects(f.call('publication',selection),{code:'asset_revoked'});
 await assert.rejects(f.call('publication',{...selection,clinicId:17,selectedAssetRef:'ga4:654'}),{code:'idempotency_conflict'});
 await assert.rejects(reader.execute(command));
 assert.equal(f.httpCalls.length,providerCalls);
 assert.equal(f.base.state.calls.length,secretCalls);
 assert(f.versions.get(f.slot.baselineVersion).stages.has('AWSCURRENT'));
});

test('lost SQL ACK can reconcile the original expired receipt without Google or relabelling secrets',async t=>{
 const {f,selection,reader,command}=await recoveryFixture(t);
 const receipt=(await f.call('publication',selection)).data;
 const ack={...selection,receiptId:receipt.receiptId,receiptDigest:receiptDigest(receipt)};
 await assert.rejects(reader.execute({...command,operation:'google.analytics.discovery.read.v1'}),{code:'scope_denied'});
 const realNow=Date.now,timed=realNow(); Date.now=()=>timed+600001;
 try {
  await f.stop();await f.start();
  const providerCalls=f.httpCalls.length;
  const observed=(await f.call('recoveryObserve',selection)).data;
  assert.equal(observed.state,'confirmed_current');
  assert.deepEqual(observed.receipt,receipt);
  assert(observed.receipt.validUntil<Date.now());
  await assert.rejects(f.call('recoveryAck',{...ack,receiptDigest:'0'.repeat(64)}),{code:'idempotency_conflict'});
  const acknowledged=(await f.call('recoveryAck',ack)).data;
  assert.equal(acknowledged.state,'published');
  assert.equal(acknowledged.receipt,null);
  assert.equal(f.httpCalls.length,providerCalls);
  await assert.rejects(f.call('recoveryQuarantine',selection),{code:'idempotency_conflict'});
  await f.stop();await f.start();
  assert.deepEqual((await f.call('recoveryAck',ack)).data,acknowledged);
  assert.equal(f.httpCalls.length,providerCalls);
  assert.equal((await reader.execute({...command,operation:'google.analytics.discovery.read.v1'})).data.name,'properties/321');
  assert.equal(f.base.state.calls.filter(call=>call.kind==='UpdateSecretVersionStageCommand').length,1);
 } finally { Date.now=realNow; }
});

test('a receipt saved before reader bootstrap never authorizes ACK on its own',async t=>{
 const {f,selection}=await recoveryFixture(t);
 const {BrokerError}=require('../src/errors');
 const {TABLE:publications}=require('../src/google-first-publication-journal');
 const send=f.base.client.send.bind(f.base.client);
 let lost=false;
 f.base.client.send=async(request,options)=>{
  if(!lost&&request.constructor.name==='GetSecretValueCommand'
   &&f.app.store.db.prepare('SELECT state FROM '+publications+' WHERE attempt_id=?').get(f.proof.attemptId)?.state==='confirmed'){
   lost=true;throw new BrokerError('secret_unavailable');
  }
  return send(request,options);
 };
 await assert.rejects(f.call('publication',selection));
 assert.equal(lost,true);
 assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM google_first_ga4_read_authorities_v1').get().n,0);
 const result=(await f.call('recoveryObserve',selection)).data;
 assert.equal(result.state,'confirmed_current');
 assert(result.receipt);
 const before=f.base.state.calls.length;
 await assert.rejects(f.call('recoveryAck',{...selection,receiptId:result.receiptId,receiptDigest:result.receiptDigest}),{code:'scope_denied'});
 assert.equal(f.base.state.calls.length,before);
 assert.equal((await f.call('recoveryQuarantine',selection)).data.state,'quarantined');
 assert.equal(f.base.state.calls.length,before);
});

test('an earlier quarantine wins over an ACK whose exact readback is in flight',async t=>{
 const {f,selection,reader,command}=await recoveryFixture(t);
 const receipt=(await f.call('publication',selection)).data;
 const ack={...selection,receiptId:receipt.receiptId,receiptDigest:receiptDigest(receipt)};
 const send=f.base.client.send.bind(f.base.client);
 let unblock,entered,start=true;
 const stopped=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
 f.base.client.send=async(request,options)=>{
  if(start&&request.constructor.name==='GetSecretValueCommand'&&request.input.SecretId===f.slot.secretArn){
   start=false;entered();await gate;
  }
  return send(request,options);
 };
 const accepting=assert.rejects(f.call('recoveryAck',ack),{code:'asset_revoked'});
 try{
  await Promise.race([stopped,accepting.then(()=>assert.fail('ACK did not wait for exact readback'))]);
  const providerCalls=f.httpCalls.length;
  assert.equal((await f.call('recoveryQuarantine',selection)).data.state,'quarantined');
  await assert.rejects(reader.execute(command));
  assert.equal(f.httpCalls.length,providerCalls);
 }finally{unblock();}
 await accepting;
 assert.equal(f.base.state.calls.filter(call=>call.kind==='UpdateSecretVersionStageCommand').length,1);
});

test('readback with a different app version or current secret body cannot acknowledge a historical receipt',async t=>{
 const {f,selection}=await recoveryFixture(t);
 const receipt=(await f.call('publication',selection)).data;
 const ack={...selection,receiptId:receipt.receiptId,receiptDigest:receiptDigest(receipt)};
 const providerCalls=f.httpCalls.length;
 const apps=f.base.state.records.get(f.slot.clientSecretArn),previous=apps.get(f.applicationVersion),newVersion=randomUUID();
 previous.stages.delete('AWSCURRENT');
 apps.set(newVersion,{body:previous.body,stages:new Set(['AWSCURRENT'])});
 assert.equal((await f.call('recoveryObserve',selection)).data.state,'unknown');
 await assert.rejects(f.call('recoveryAck',ack),{code:'secret_version_changed'});
 apps.delete(newVersion);previous.stages.add('AWSCURRENT');
 const secret=f.versions.get(f.proof.attemptId);
 const original=secret.body;
 secret.body=secret.body.replace('FICTITIOUS_RUNTIME_REFRESH','FICTITIOUS_WRONG_REFRESH');
 assert.notEqual(secret.body,original);
 assert.equal((await f.call('recoveryObserve',selection)).data.state,'unknown');
 await assert.rejects(f.call('recoveryAck',ack));
 assert.equal(f.httpCalls.length,providerCalls);
 assert.equal(f.base.state.calls.filter(call=>call.kind==='UpdateSecretVersionStageCommand').length,1);
 secret.body=original;
 assert.equal((await f.call('recoveryAck',ack)).data.state,'published');
});

test('the signed Search Console catalogue checks provider access once per property and preserves exact destination clinics', async t => {
 const { BrokerError } = require('../src/errors');
 const { site } = require('../src/google-search-console-contract');
 const { TABLE: publicationTable } = require('../src/google-first-publication-journal');
 const f = await fixture(t,{ service:'search_console' });
 const shared = site('sc-domain:fictitious-shared.example');
 const denied = site('sc-domain:fictitious-denied.example');
 f.config.publicationResources = [
  { scopeKey:'group:11',service:'search_console',clinicId:31,resource:{ siteUrl:shared.siteUrl } },
  { scopeKey:'group:11',service:'search_console',clinicId:17,resource:{ siteUrl:shared.siteUrl } },
  { scopeKey:'group:11',service:'search_console',clinicId:31,resource:{ siteUrl:denied.siteUrl } },
 ];
 const existingHttp = f.deps.http;
 const properties = [];
 let temporary = false;
 f.deps.http = async request => {
  if (!request.path.startsWith('/webmasters/v3/sites/')) return existingHttp(request);
  const canonical = decodeURIComponent(request.path.split('/').at(-1));
  properties.push(canonical);
  if (canonical === denied.siteUrl) throw new BrokerError(temporary ? 'provider_timeout' : 'provider_unauthorized');
  assert.equal(canonical,shared.siteUrl);
  return { siteUrl:shared.siteUrl,permissionLevel:'siteOwner' };
 };
 f.save();
 await f.start();
 const { authorizationUrl } = (await f.call('begin')).data;
 assert.equal((await f.call('catalogueReady')).data.canChooseAssets,false);
 await f.call('finish',{ state:new URL(authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE' });
 assert.equal((await f.call('catalogueReady')).data.canChooseAssets,true);
 await assert.rejects(f.call('catalogue',{ clinicSetDigest:'a'.repeat(64) }));
 assert.deepEqual(properties,[]);
 assert.deepEqual((await f.call('catalogue')).data,{
  attemptId:f.proof.attemptId,scopeKey:'group:11',service:'search_console',
  assets:[{ assetRef:shared.assetRef,siteUrl:shared.siteUrl,clinicIds:[17,31] }],
 });
 assert.deepEqual(properties,[shared.siteUrl,denied.siteUrl]);
 temporary=true;
 await assert.rejects(f.call('catalogue'),{ code:'provider_timeout' });
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM '+publicationTable).get().n,0);
 assert.equal(f.base.state.calls.filter(call => call.kind === 'UpdateSecretVersionStageCommand').length,0);
});

test('a publication installs only its exact native Search Console reader and can be revoked by the control principal', async t => {
 const { site,REVOKE_OPERATION } = require('../src/google-search-console-contract');
 const { SC_OPERATION } = require('../src/google-property-discovery-contract');
 const f = await fixture(t,{ service:'search_console' });
 const selected = site('sc-domain:fictitious-native.example');
 const keys = generateKeyPairSync('ed25519');
 const readerPin = {
  id:'crm:staging:google-first-sc-reader',keyId:'qa-google-first-reader-key',enabled:true,maxPerMinute:12,
  publicKey:keys.publicKey.export({ type:'spki',format:'pem' }),
 };
 const keyFile = f.file('reader-cursor.key');
 fs.writeFileSync(keyFile,randomBytes(32),{ mode:0o600 });
 f.config.publicationResources = [
  { scopeKey:'group:11',service:'search_console',clinicId:17,resource:{ siteUrl:selected.siteUrl } },
  { scopeKey:'group:11',service:'search_console',clinicId:31,resource:{ siteUrl:selected.siteUrl } },
 ];
 f.config.searchConsoleReaderPrincipal = readerPin;
 f.config.searchConsoleCursorKeyFile = keyFile;
 const oldHttp = f.deps.http;
 f.deps.http = async request => {
  if (request.hostname === 'www.googleapis.com' && request.path === '/webmasters/v3/sites/'+encodeURIComponent(selected.siteUrl)) {
   f.httpCalls.push(request);
   return { siteUrl:selected.siteUrl,permissionLevel:'siteOwner' };
  }
  return oldHttp(request);
 };
 const reader = createIntegrationsBrokerClient({
  origin:'https://127.0.0.1:'+f.config.port,audience:f.config.policy.audience,keyId:readerPin.keyId,
  privateKey:keys.privateKey.export({ type:'pkcs8',format:'pem' }),ca:fs.readFileSync(f.file('ca.crt')),
 });
 const command = { operation:SC_OPERATION,connectionRef:'google-first:search_console:group:11',
  assetRef:selected.assetRef,tenantRef:'clinic:31',payload:{} };
 f.save();
 await f.start();
 const { authorizationUrl } = (await f.call('begin')).data;
 await f.call('finish',{ state:new URL(authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE' });
 await assert.rejects(reader.execute(command));
 await assert.rejects(f.client.execute(command));
 const published = (await f.call('publication',{ clinicId:31,selectedAssetRef:selected.assetRef })).data;
 assert.equal(published.clinicId,31);
 assert.deepEqual((await reader.execute(command)).data,published.resource);
 await assert.rejects(reader.execute({ ...command,tenantRef:'clinic:17' }));
 await assert.rejects(reader.execute({ ...command,operation:REVOKE_OPERATION }));
 await f.stop();
 await f.start();
 assert.deepEqual((await reader.execute(command)).data,published.resource);
 assert.equal((await f.client.execute({ ...command,operation:REVOKE_OPERATION })).data.revoked,true);
 await assert.rejects(reader.execute(command));
 assert.equal(f.base.state.calls.filter(call => call.kind === 'UpdateSecretVersionStageCommand').length,1);
});

test('restart closes prepared PKCE-lost contexts and keeps signed status available without any provider call',async t=>{
 const f=await fixture(t);await f.start();await f.call('begin');await f.stop();assert(fs.existsSync(f.config.stateFile+'.owner.lock'));
 await f.start();const status=(await f.call('status')).data;assert.equal(status.state,'interrupted');assert.equal(status.connected,false);
 assert.equal((await f.call('begin')).data.authorizationUrl,undefined);assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);assert.equal(f.factories,2);
});
test('restart preserves pending and genuinely promoted slots without requiring an empty marker or changing current again',async t=>{
 const f=await fixture(t);await f.start();const begin=(await f.call('begin')).data;
 await f.call('finish',{state:new URL(begin.authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'});await f.stop();
 await f.start();assert.equal((await f.call('status')).data.state,'candidate_staged');await f.stop();
 for(const row of f.versions.values())row.stages.delete('AWSCURRENT');f.versions.get(f.proof.attemptId).stages.add('AWSCURRENT');
 await f.start();assert.equal((await f.call('status')).data.state,'candidate_staged');assert.equal(f.puts(),1);
 assert.equal(f.base.state.calls.filter(c=>c.kind==='UpdateSecretVersionStageCommand').length,0);assert.equal(f.httpCalls.length,2);
});
test('one kernel lock excludes a second runtime and an unlocked persistent file never needs PID or unlink recovery',async t=>{
 const f=await fixture(t);await f.start();const before=f.factories;await assert.rejects(R.main(f.filename,f.deps),{code:'oauth_flow_busy'});assert.equal(f.factories,before);
 assert.equal((await f.call('begin')).data.state,'prepared');await f.stop();fs.writeFileSync(f.config.stateFile+'.owner.lock','FICTITIOUS_OLD_PID_NOT_AUTHORITY',{mode:0o600});
 await f.start();assert.equal(f.factories,before+1);assert.equal((await f.call('status')).data.state,'interrupted');
});
test('wrong purpose, old principal, broad rate, resource grants or mismatched slots fail closed before AWS',async t=>{
 const f=await fixture(t);for(const mutation of [c=>c.purpose='existing-google',c=>c.policy.principals[0].id='gateway:staging:google-first-oauth',
  c=>c.policy.principals[0].maxPerMinute=13,c=>c.slots=[],c=>c.scopes[0].services.push('ads'),c=>c.extra=true,c=>c.listenAddress='0.0.0.0']){
  const copy=structuredClone(f.config);mutation(copy);fs.writeFileSync(f.filename,JSON.stringify(copy));await assert.rejects(R.main(f.filename,f.deps));assert.equal(f.factories,0);
 }
});
test('private configuration and symlink checks happen before AWS or state creation',async t=>{
 const f=await fixture(t);fs.chmodSync(f.filename,0o644);await assert.rejects(R.main(f.filename,f.deps));assert.equal(f.factories,0);fs.chmodSync(f.filename,0o600);
 const link=f.file('linked-config.json');fs.symlinkSync(f.filename,link);await assert.rejects(R.main(link,f.deps));assert.equal(f.factories,0);assert(!fs.existsSync(f.config.stateFile));
});
test('existing unrelated broker state and changed authority configuration cannot be adopted by this runtime',async t=>{
 const f=await fixture(t),old=new BrokerStore(f.config.stateFile);old.seedConnection('preserved-whatsapp',{state:'revoked'});old.close();
 const before=fs.readFileSync(f.config.stateFile);await assert.rejects(R.main(f.filename,f.deps),{code:'scope_denied'});assert.deepEqual(fs.readFileSync(f.config.stateFile),before);assert.equal(f.factories,0);
 const g=await fixture(t);await g.start();await g.call('begin');await g.stop();g.config.scopes[0].clinicIds=[17,32];g.save();
 await assert.rejects(R.main(g.filename,g.deps),{code:'scope_denied'});assert.equal(g.factories,1);
});
test('a full audit backlog rolls back the exchange burn and prevents provider I/O or secret staging',async t=>{
 const f=await fixture(t,{maxBacklog:2});f.sinkFail=true;await f.start();const begin=(await f.call('begin')).data;
 const row=f.app.store.db.prepare('SELECT event FROM audit_outbox LIMIT 1').get();const copy=JSON.parse(row.event);copy.eventId=randomUUID();f.app.store.appendAudit(copy);
 await assert.rejects(f.call('finish',{state:new URL(begin.authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'}),{code:'audit_unavailable'});
 const saved=f.app.store.db.prepare('SELECT state,code_digest FROM '+TABLE).get();assert.equal(saved.state,'prepared');assert.equal(saved.code_digest,null);assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);
});
test('persisted principal quota limits signed controls, without any provider traffic or reader grant',async t=>{
 const f=await fixture(t);await f.start();await f.call('begin');for(let i=0;i<11;i++)await f.call('status');
 await assert.rejects(f.call('status'),{code:'rate_limited'});assert.equal(f.httpCalls.length,0);assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM connections').get().n,0);
});
test('TLS identity mismatch is rejected before the state database or AWS startup',async t=>{
 const f=await fixture(t);fs.copyFileSync(f.file('ca.key'),f.config.tlsKeyFile);await assert.rejects(R.main(f.filename,f.deps));
 assert.equal(f.factories,0);assert(!fs.existsSync(f.config.stateFile));assert(fs.existsSync(f.config.stateFile+'.owner.lock'));
});
test('transport keeps at most two executing controls, including slow metadata requests',async t=>{
 const f=await fixture(t);await f.start();let release,entered;const gate=new Promise(r=>release=r),both=new Promise(r=>entered=r);let count=0;
 const send=f.base.client.send.bind(f.base.client);f.base.client.send=async command=>{
  if(command.constructor.name==='GetSecretValueCommand'&&command.input.SecretId===f.slot.clientSecretArn){if(++count===2)entered();await gate;}
  return send(command);
 };
 const one=f.call('begin'),two=f.call('begin',{attemptId:randomUUID(),bindingDigest:'e'.repeat(64)});
 await both;await assert.rejects(f.call('status'),{code:'rate_limited'});release();const results=await Promise.allSettled([one,two]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='idempotency_conflict').length,1);
 assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);
});
test('restart reconciles an exact lost stage acknowledgement without another code exchange or write',async t=>{
 const f=await fixture(t);await f.start();const begin=(await f.call('begin')).data;f.base.state.lostStage=true;
 await assert.rejects(f.call('finish',{state:new URL(begin.authorizationUrl).searchParams.get('state'),code:'FICTITIOUS_RUNTIME_CODE'}),{code:'secret_unavailable'});
 assert.equal(f.app.store.db.prepare('SELECT state FROM '+TABLE).get().state,'stage_intent');await f.stop();await f.start();
 assert.equal((await f.call('status')).data.state,'candidate_staged');assert.equal(f.puts(),1);assert.equal(f.httpCalls.length,2);
});
test('SIGKILL releases the inherited kernel lock and exact TLS restart closes the lost prepared PKCE context',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.file('fictitious-application.json'),JSON.stringify({applicationVersion:f.applicationVersion,app:f.base.app}),{mode:0o600});
 const child=fork(path.join(__dirname,'google-first-admission-runtime-child.cjs'),[f.filename,f.file('fictitious-application.json')],
  {execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc'],env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FICTITIOUS_CHILD_START_TIMEOUT')),8000);
  child.once('message',m=>{clearTimeout(timer);m?.ready===true?resolve():reject(Error('FICTITIOUS_CHILD_FAILED'));});
  child.once('exit',()=>{clearTimeout(timer);reject(Error('FICTITIOUS_CHILD_EXITED:'+stderr.slice(-200)));});});
 const begin=(await f.call('begin')).data;assert.equal(begin.state,'prepared');assert(begin.authorizationUrl);
 const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
 assert(fs.existsSync(f.config.stateFile+'.owner.lock'));await f.start();assert.equal((await f.call('status')).data.state,'interrupted');
 assert.equal((await f.call('begin')).data.authorizationUrl,undefined);assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);
});
