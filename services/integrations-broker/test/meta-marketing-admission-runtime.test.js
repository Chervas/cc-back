'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),D=require('../src/meta-marketing-discovery-contract');
const E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract');
const runtime=require('../src/meta-marketing-oauth-main');
const {allowPort,removePort}=require('./offline-guard.cjs');
const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');

async function start(t,p,admission){
  const config=structuredClone(p.f.config);
  if(admission!==undefined)config.admission=admission;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,
    '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));config.port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));allowPort(config.port);
  const filename=path.join(p.f.dir,'admission-runtime.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const sink={write:async row=>({versionId:'FICTITIOUS_AUDIT_VERSION',digest:row.digest})};
  const awsFactory=async()=>({secrets:p.aws,sink,close(){}});
  let app=await runtime.main(filename,{awsFactory,http:p.f.http});
  t.after(async()=>{if(app)await app.close();removePort(config.port);});
  const client=control=>createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+config.port,audience:config.policy.audience,
    keyId:control?'qa-control':'qa-gateway',privateKey:(control?p.f.control:p.f.gateway).privateKey.export({type:'pkcs8',format:'pem'}),
    ca:fs.readFileSync(config.tlsCertFile)});
  return {config,gateway:client(false),control:client(true),get app(){return app;},
    async restart(){await app.close();app=await runtime.main(filename,{awsFactory,http:p.f.http});}};
}

test('real TLS runtime prepares and authorizes a dynamic OAuth slot after restart with no static entry',async t=>{
  const p=admissionFixture(t),live=await start(t,p,p.settings),cmd=p.command();
  const prepared=await live.gateway.execute(cmd);
  assert.equal(prepared.data.status,'prepared');assert.equal(prepared.data.connected,false);assert.equal(p.state.creates,1);
  assert.equal(p.f.state.codes,0);assert.equal((await live.gateway.execute(cmd)).replayed,true);
  assert.equal(live.app.store.db.prepare('SELECT count(*) n FROM meta_marketing_admission_slots').get().n,1);
  assert.equal(JSON.stringify(live.config.policy),p.originalPolicy);
  await live.restart();
  const flow=p.beginCommand(cmd),begun=await live.gateway.execute(flow);
  assert.equal(begun.data.flowId,flow.requestId);assert.match(begun.data.authUrl,/^https:\/\/www\.facebook\.com\//);
  const finish={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,
    payload:{flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_TLS_ADMISSION_CODE'}};
  await assert.rejects(live.control.execute(finish),{code:'scope_denied'});assert.equal(p.f.state.codes,0);
  const staged=await live.gateway.execute(finish);assert.equal(staged.data.status,'staged');assert.equal(staged.data.accessBlocked,true);
  assert.equal(p.f.state.codes,1);assert.equal(p.f.state.puts,1);
  for(const operation of [D.OPERATION,E.OPERATIONS.prepare,M.ASSET]){
    await assert.rejects(live.gateway.execute({...cmd,requestId:randomUUID(),operation,payload:{}}),{code:'scope_denied'});
  }
  const status={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.status,payload:{flowId:flow.requestId}};
  assert.equal((await live.control.execute(status)).data.status,'staged');
  assert.equal((await live.control.execute({...status,requestId:randomUUID(),operation:C.OPERATIONS.abort})).data.status,'aborted');
  assert.equal(JSON.stringify(live.config.policy),p.originalPolicy);
});

for(const admission of [undefined,{enabled:false}])test('real TLS runtime leaves admission off without tables or AWS calls: '+(admission?'explicit':'absent'),async t=>{
  const p=admissionFixture(t),live=await start(t,p,admission),cmd=p.command();
  await assert.rejects(live.gateway.execute(cmd),{code:'scope_denied'});
  assert.equal(live.app.store.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name LIKE 'meta_marketing_admission_%'").get().n,0);
  assert.equal(p.state.calls.length,0);assert.equal(p.state.creates,0);assert.equal(p.f.state.codes,0);
});

test('runtime rejects inadmissible admission configuration before constructing AWS clients',async t=>{
  const p=admissionFixture(t),config=structuredClone(p.f.config);let aws=0;
  for(const mutate of [settings=>{settings.environment='dev';},settings=>{settings.appId='999';},
    settings=>{settings.maxConnections=62;},settings=>{settings.scopes.push('whatsapp_business_messaging');}]){
    config.admission=structuredClone(p.settings);mutate(config.admission);
    const filename=path.join(p.f.dir,'invalid-admission-runtime.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
    await assert.rejects(runtime.main(filename,{awsFactory:async()=>{aws++;assert.fail('INVALID_CONFIG_AWS');}}));
  }
  assert.equal(aws,0);
});
