'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract');
const {allowPort,removePort}=require('./offline-guard.cjs'),runtime=require('../src/meta-marketing-oauth-main');
const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient'),{drainAudit}=require('../src/audit');
test('runtime requires own environment, independent control key, empty slots and OAuth-only authority before AWS',async t=>{
  const f=fixture(t);runtime.validateConfig(f.config);let aws=0;const filename=path.join(f.dir,'bad.json');
  for(const mutate of [c=>c.enabled=false,c=>c.environment='prod',c=>c.cohort='meta-marketing-read-v1',
    c=>c.policy.principals[1].publicKey=c.policy.principals[0].publicKey,c=>c.policy.principals[0].maxPerMinute=21,
    c=>c.policy.connections[0].secretArn=c.policy.connections[0].secretArn.replace('/staging/','/dev/'),
    c=>c.policy.connections[0].clientSecretArn=c.policy.connections[0].secretArn,c=>c.policy.connections[0].googleSubject='foreign',
    c=>c.policy.connections[0].metaMarketingOAuth.scopes.push('whatsapp_business_messaging'),
    c=>c.policy.connections[0].metaMarketingOAuth.redirectUri='https://example.invalid/oauth/meta/callback',
    c=>c.policy.connections[0].metaMarketingOAuth.clinicIds.reverse(),c=>c.policy.grants[1].operations.push(C.OPERATIONS.finish),
    c=>c.policy.grants[0].operations.push('meta.marketing.asset.read.v1'),c=>c.policy.grants[0].tenantRef='clinic:72']) {
    const config=structuredClone(f.config);mutate(config);fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
    await assert.rejects(runtime.main(filename,{awsFactory:async()=>{aws++;throw Error('FORBIDDEN_AWS');}}));
  }
  assert.equal(aws,0);
});
for(const discovery of [false,true])test('signed TLS runtime stages new identity, drains audit and recovers lost ACK; discovery='+discovery,async t=>{
  const f=fixture(t,{discovery}),config=f.config;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));config.port=probe.address().port;await new Promise(r=>probe.close(r));allowPort(config.port);
  const filename=path.join(f.dir,'config.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});const events=[];
  const sink={async write(row){events.push(JSON.parse(row.event));return {versionId:'fictitious-s3-version',digest:row.digest};}};
  const awsFactory=async()=>({secrets:f.aws,sink,close(){}});let app=await runtime.main(filename,{awsFactory,http:f.http});
  t.after(async()=>{if(app)await app.close();removePort(config.port);});
  const client=isControl=>createIntegrationsBrokerClient({origin:`https://127.0.0.1:${config.port}`,audience:config.policy.audience,keyId:isControl?'qa-control':'qa-gateway',
    privateKey:(isControl?f.control:f.gateway).privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(config.tlsCertFile)});
  const gateway=client(false),control=client(true),flowId=randomUUID(),state=randomBytes(32).toString('base64url');
  const begin=f.command(C.OPERATIONS.begin,{state,expiresAt:Date.now()+590000,scopeDigest:C.hash('fictitious-full-group'),clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth)},{requestId:flowId});
  assert.equal((await gateway.execute(begin)).data.flowId,flowId);
  const before=f.state.awsCalls.length;await assert.rejects(control.execute(f.command(C.OPERATIONS.finish,{flowId,state,code:'FICTITIOUS_TLS_CODE'})),{code:'scope_denied'});assert.equal(f.state.awsCalls.length,before);
  f.state.losePut=true;await assert.rejects(gateway.execute(f.command(C.OPERATIONS.finish,{flowId,state,code:'FICTITIOUS_TLS_CODE'})),{code:'secret_unavailable'});
  assert.equal(f.state.codes,1);await app.close();app=null;app=await runtime.main(filename,{awsFactory,http:f.http});
  const result=await gateway.execute(f.command(C.OPERATIONS.status,{flowId}));assert.equal(result.data.status,'staged');assert.equal(result.data.accessBlocked,true);
  if(discovery){
    const D=require('../src/meta-marketing-discovery-contract'),command=f.command(D.OPERATION,{flowId,scopeDigest:begin.payload.scopeDigest});
    const inventory=await gateway.execute(command);assert.equal(inventory.data.assets.length,3);assert.equal(inventory.data.accessBlocked,true);
    const calls=f.state.httpCalls.length;await assert.rejects(control.execute({...command,requestId:randomUUID()}),{code:'scope_denied'});assert.equal(f.state.httpCalls.length,calls);
    assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
  }
  await drainAudit(app.store,sink);assert.equal(app.store.backlog().pending,0);assert(events.some(e=>e.reason==='oauth_credentials_staged'));
  for(const secret of [TOKEN,APP,state,'FICTITIOUS_TLS_CODE'])assert(!JSON.stringify(events).includes(secret));
  const awsCalls=f.state.awsCalls.length;assert.equal((await control.execute(f.command(C.OPERATIONS.abort,{flowId}))).data.status,'aborted');
  assert.equal(f.state.awsCalls.length,awsCalls);assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
  await app.close();app=null;
});
