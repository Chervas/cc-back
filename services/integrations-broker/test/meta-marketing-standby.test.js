'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract');
const runtime=require('../src/meta-marketing-oauth-main'),{BrokerStore}=require('../src/store');
const {allowPort,removePort}=require('./offline-guard.cjs');
const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');

function standby(f) {
  const config=structuredClone(f.config);
  config.standby=true;config.stateFile=path.join(f.dir,'standby.sqlite');
  config.policy.principals=[];config.policy.connections=[];config.policy.grants=[];
  return config;
}
function certificate(config) {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  fs.chmodSync(config.tlsKeyFile,0o600);fs.chmodSync(config.tlsCertFile,0o600);
}
test('standby is explicit, empty and cannot carry disabled or enabled authority',t=>{
  for(const enrollment of [false,true]) {
    const f=fixture(t,{enrollment}),config=standby(f);runtime.validateConfig(config);
    for(const mutate of [c=>delete c.standby,c=>c.standby=false,c=>c.standby='true',
      c=>c.policy.principals=[{...f.config.policy.principals[0],enabled:false}],
      c=>c.policy.principals=f.config.policy.principals,c=>c.policy.connections=f.config.policy.connections,
      c=>c.policy.grants=f.config.policy.grants,c=>c.environment='prod',c=>c.assetEnrollment='true']) {
      const changed=structuredClone(config);mutate(changed);
      assert.throws(()=>runtime.validateConfig(changed),{code:'invalid_request'});
    }
    runtime.validateConfig({...f.config,standby:false});
  }
});
test('empty TLS standby rejects signed commands, does no provider work and restarts without state',async t=>{
  const f=fixture(t,{enrollment:true}),config=standby(f);certificate(config);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  config.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));allowPort(config.port);
  const filename=path.join(f.dir,'standby.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  let app,awsStarts=0,auditWrites=0;
  const awsFactory=async()=>{awsStarts++;return {secrets:f.aws,sink:{async write(){auditWrites++;throw Error('UNEXPECTED_AUDIT');}},close(){}};};
  t.after(async()=>{if(app)await app.close();removePort(config.port);});
  const client=createIntegrationsBrokerClient({origin:`https://127.0.0.1:${config.port}`,audience:config.policy.audience,
    keyId:'qa-gateway',privateKey:f.gateway.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(config.tlsCertFile)});
  for(let run=0;run<2;run++) {
    app=await runtime.main(filename,{awsFactory,http:f.http});
    await assert.rejects(client.execute(f.command(C.OPERATIONS.status,{flowId:randomUUID()})),{code:'invalid_signature'});
    for(const {name} of app.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all())
      assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM "'+name.replace(/"/g,'""')+'"').get().n,0,name);
    await app.close();app=null;
  }
  assert.equal(awsStarts,2);assert.equal(auditWrites,0);assert.equal(f.state.awsCalls.length,0);assert.equal(f.state.httpCalls.length,0);
  // Authority appears only after an explicit validated configuration/restart.
  // Once used, this owner cannot go back to an empty installation policy.
  const active={...structuredClone(f.config),port:config.port,stateFile:config.stateFile};
  fs.writeFileSync(filename,JSON.stringify(active),{mode:0o600});
  const activeAws=async()=>{awsStarts++;return {secrets:f.aws,sink:{async write(row){return {versionId:'fictitious-standby-transition',digest:row.digest};}},close(){}};};
  app=await runtime.main(filename,{awsFactory:activeAws,http:f.http});
  const flowId=randomUUID();
  const begun=await client.execute(f.command(C.OPERATIONS.begin,{state:randomBytes(32).toString('base64url'),
    expiresAt:Date.now()+590000,scopeDigest:C.hash('FICTITIOUS_STANDBY_TRANSITION'),
    clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth)},{requestId:flowId}));
  assert.equal(begun.data.flowId,flowId);
  const before=JSON.stringify(app.store.db.prepare('SELECT * FROM meta_marketing_oauth_flows').all());
  await app.close();app=null;
  fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  await assert.rejects(runtime.main(filename,{awsFactory:activeAws,http:f.http}),{code:'invalid_request'});
  assert.equal(awsStarts,3);
  const reopened=new BrokerStore(config.stateFile);
  assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM meta_marketing_oauth_flows').all()),before);reopened.close();
  assert.equal(f.state.codes,0);assert.equal(f.state.puts,0);
});
test('standby refuses every kind of durable history before AWS and preserves its rows',async t=>{
  const f=fixture(t),config=standby(f);certificate(config);let awsStarts=0;
  const cases=[
    ['connections',store=>store.seedConnection('connection:withdrawn',{state:'revoked'})],
    ['asset_revocations',store=>store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71','connection:old','meta-facebook_page:401','old-withdrawal',1)],
    ['commands',store=>store.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run('old-principal','uncertain-command','a'.repeat(64),'pending',null,1)],
    ['audit_outbox',store=>store.db.prepare('INSERT INTO audit_outbox (id,event,digest,created_at) VALUES (?,?,?,?)').run('old-audit','{}','b'.repeat(64),1)],
    ['future " history',store=>store.db.exec('CREATE TABLE "future "" history" (id INTEGER); INSERT INTO "future "" history" VALUES (1)')],
  ];
  for(const [table,seed] of cases) {
    config.stateFile=path.join(f.dir,randomUUID()+'.sqlite');const store=new BrokerStore(config.stateFile);seed(store);
    const sql='SELECT * FROM "'+table.replace(/"/g,'""')+'"',before=JSON.stringify(store.db.prepare(sql).all());store.close();
    const filename=path.join(f.dir,'used.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
    await assert.rejects(runtime.main(filename,{awsFactory:async()=>{awsStarts++;throw Error('FORBIDDEN_AWS');}}),{code:'invalid_request'});
    const reopened=new BrokerStore(config.stateFile);assert.equal(JSON.stringify(reopened.db.prepare(sql).all()),before);reopened.close();
  }
  assert.equal(awsStarts,0);
});
