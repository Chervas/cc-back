'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFileSync,fork}=require('node:child_process'),{generateKeyPairSync,randomUUID,randomBytes}=require('node:crypto');
const {allowPort,removePort}=require('./offline-guard.cjs');
const R=require('../src/google-first-admission-main'),{OPERATIONS,clinicSetFingerprint}=require('../src/google-first-admission-rpc');
const {requiredScopesFor}=require('../src/google-first-identity-provider'),{TABLE}=require('../src/google-first-identity-journal');
const {BrokerStore}=require('../src/store'),{oauthSecretsFixture}=require('./google-oauth-fixture.cjs');
const {createIntegrationsBrokerClient}=require('../../../src/lib/integrationsBrokerClient');
async function fixture(t,{maxBacklog=1000,service='analytics',runtime=R}={}){
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
  async start(){app=await runtime.main(filename,deps);return app;},async stop(){const old=app;app=null;if(old)await old.close();},
  puts(){return base.state.calls.filter(c=>c.kind==='PutSecretValueCommand').length;}};
}

module.exports={fixture};
