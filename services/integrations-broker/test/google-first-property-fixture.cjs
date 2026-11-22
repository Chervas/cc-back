'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const deny=()=>{throw Error('LIVE_NETWORK_FORBIDDEN_IN_FIRST_PROPERTY_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const {BrokerStore}=require('../src/store'),{createGoogleHttp}=require('../src/google-http'),J=require('../src/google-first-identity-journal');
const {createFirstGoogleProvider,requiredScopesFor}=require('../src/google-first-identity-provider');
const {createFirstGoogleCredentialVault}=require('../src/google-first-identity-vault'),{createFirstGoogleIdentityOwner}=require('../src/google-first-identity-owner');
const {createFirstGooglePublicationJournal,TABLE}=require('../src/google-first-publication-journal');
const {createFirstGooglePropertyVerifier}=require('../src/google-first-property-verifier'),SC=require('../src/google-search-console-contract');
const {oauthSecretsFixture}=require('./google-oauth-fixture.cjs');
async function fixture(t,service='search_console'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-first-property-verifier-'));fs.chmodSync(dir,0o700);const filename=path.join(dir,'owner.sqlite');
 const store=new BrokerStore(filename);let engine;t.after(()=>{engine?.close();store.close();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir));});
 store.seedConnection('preserved-google',{state:'revoked'});store.seedConnection('preserved-whatsapp',{state:'active'});
 const previous=JSON.stringify(store.db.prepare('SELECT * FROM connections ORDER BY ref').all());
 let time=Date.parse('2030-01-01T00:00:00Z');const now=()=>time,base=oauthSecretsFixture('google_'+service),baselineVersion=randomUUID(),applicationVersion=randomUUID();
 const slot={scopeKey:'group:11',service,secretArn:base.binding.secretArn.replace('fictitious-google-abcdef','google-first/'+service+'/group-11-qA123z'),clientSecretArn:base.binding.clientSecretArn,baselineVersion};
 const marker={version:1,provider:'google-first-empty-slot',connectionRef:'google-first:'+service+':group:11',scopeKey:'group:11',service};
 const versions=new Map([[baselineVersion,{body:JSON.stringify(marker),stages:new Set(['AWSCURRENT'])}]]);
 const appVersions=new Map([[applicationVersion,{body:JSON.stringify(base.app),stages:new Set(['AWSCURRENT'])}]]);
 base.state.records.set(slot.secretArn,versions);base.state.records.set(slot.clientSecretArn,appVersions);
 const resource=service==='search_console'?{siteUrl:'sc-domain:example.invalid'}:{propertyName:'properties/123'};
 const selection={scopeKey:'group:11',clinicId:31,assetRef:service==='search_console'?SC.site(resource.siteUrl).assetRef:'ga4:123'};
 const proof={attemptId:randomUUID(),bindingDigest:'e'.repeat(64),service,expiresAt:time+300000};
 const owner={principalId:'crm:staging:google-first-oauth',tenantRef:'clinic:17',connectionRef:'google-first:'+proof.attemptId,assetRef:'google-oauth:'+service+':group:11'};
 const calls=[],buffers=[];let hook=()=>{},responseHook=(_route,value)=>value;
 const request=(options,callback)=>{
  assert.equal(options.protocol,'https:');assert.equal(options.port,443);assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.2');assert.equal(options.agent,false);
  const req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true;};
  req.end=body=>queueMicrotask(async()=>{
   const route=options.hostname==='oauth2.googleapis.com'?'token':options.path==='/oauth2/v2/userinfo'?'identity':'resource';
   const params=route==='token'?new URLSearchParams(body):null;calls.push({route,host:options.hostname,path:options.path,method:options.method,grant:params?.get('grant_type')||null});
   try{
    await hook(route,options);
    if(req.destroyed)return;
    let value;
    if(route==='token'){
     assert.equal(options.method,'POST');assert.equal(params.get('client_id'),base.app.clientId);assert.equal(params.get('client_secret'),base.app.clientSecret);
     if(params.get('grant_type')==='refresh_token')assert.equal(params.get('refresh_token'),'FICTITIOUS_FIRST_REFRESH');
     value={access_token:'FICTITIOUS_FIRST_ACCESS',token_type:'Bearer',expires_in:3600,scope:requiredScopesFor(service).join(' '),
      ...(params.get('grant_type')==='authorization_code'?{refresh_token:'FICTITIOUS_FIRST_REFRESH'}:{})};
    }else{
     assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer FICTITIOUS_FIRST_ACCESS');
     value=route==='identity'?{id:'10123456789',email:'PRIVATE_FICTITIOUS_EMAIL',name:'PRIVATE_FICTITIOUS_NAME'}:
      service==='search_console'?{siteUrl:resource.siteUrl,permissionLevel:'siteOwner',privatePatient:'DO_NOT_KEEP'}:
       {name:resource.propertyName,displayName:'FICTITIOUS_PROPERTY',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/456',account:'accounts/456',privatePatient:'DO_NOT_KEEP'};
    }
    const result=responseHook(route,value);const res=new EventEmitter();res.statusCode=result?.__status||200;res.headers={'content-type':'application/json'};res.destroy=()=>{};
    callback(res);res.emit('data',Buffer.from(JSON.stringify(result)));res.emit('end');
   }catch(error){req.emit('error',error);}
  });return req;
 };
 const http=createGoogleHttp({request}),first=J.createFirstGoogleJournal({store,now}),provider=createFirstGoogleProvider({http,now});
 const vault=createFirstGoogleCredentialVault({...base.config,client:base.client,redirectUri:base.binding.oauth.redirectUri,slots:[slot],now});
 engine=createFirstGoogleIdentityOwner({journal:first,provider,vault,now});
 const begin=await engine.begin(proof,owner);const staged=await engine.finish(proof,owner,{state:new URL(begin.authorizationUrl).searchParams.get('state'),code:Buffer.from('FICTITIOUS_AUTH_CODE')});assert.equal(staged.state,'candidate_staged');
 calls.length=0;const sdkStart=base.state.calls.length;
 const ledger=createFirstGooglePublicationJournal({store,journal:first,approvedScopes:[{scopeKey:'group:11',clinicIds:[17,31],services:[service]}],now});
 const verifier=createFirstGooglePropertyVerifier({vault,ledger,http,now});
 return{dir,store,proof,owner,resource,selection,first,vault,ledger,verifier,base,versions,appVersions,slot,applicationVersion,calls,buffers,now,sdkStart,
  set hook(fn){hook=fn;},set response(fn){responseHook=fn;},advance(ms){time+=ms;},
  async verify(input=resource,p=proof,o=owner,s=selection,options){return verifier.verifyAndApprove(p,o,s,input,options);},
  approvals(){return store.db.prepare('SELECT COUNT(*) AS n FROM '+TABLE).get().n;},
  writes(){return base.state.calls.filter(c=>['PutSecretValueCommand','UpdateSecretVersionStageCommand'].includes(c.kind)).length;},
  unchanged(){assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM connections ORDER BY ref').all()),previous);},
  scan(){store.db.exec('PRAGMA wal_checkpoint(FULL)');return fs.readdirSync(dir).filter(n=>fs.statSync(path.join(dir,n)).isFile()).map(n=>fs.readFileSync(path.join(dir,n)).toString('latin1')).join('\n');}};
}

module.exports={fixture};
