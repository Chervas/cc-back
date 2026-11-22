'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{generateKeyPairSync,randomBytes,randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const {fixture}=require('./google-first-property-fixture.cjs'),{createFirstGooglePublicationOwner}=require('../src/google-first-publication-owner');
const {createFirstSearchConsoleReadOwner,TABLE}=require('../src/google-first-search-console-read-owner'),{createGoogleHttp}=require('../src/google-http');
const {cursorCodec}=require('../src/provider-cursor'),{signRequest}=require('../src/auth'),C=require('../src/google-search-console-contract'),{requiredScopesFor}=require('../src/google-first-identity-provider');
const {createSearchConsoleBroker}=require('../../../src/services/searchConsoleBroker.service');
async function setup(t,{bootstrap=true,maxBacklog=1000}={}){
 const f=await fixture(t),publisher=createFirstGooglePublicationOwner({ledger:f.ledger,vault:f.vault,verifier:f.verifier,now:f.now});
 const receipt=await publisher.publish(f.proof,f.owner,f.selection,f.resource),readerKey=generateKeyPairSync('ed25519'),controlKey=generateKeyPairSync('ed25519');
 const readerPrincipalId='crm:staging:google-first-sc-reader',controlPrincipalId='crm:staging:google-first-oauth';
 const policy={audience:'clinicaclick:google-first-oauth:staging:v1',version:'google-first-oauth:staging:v1',maxBacklog,connections:[],grants:[],principals:[
  {id:readerPrincipalId,keyId:'qa-first-reader',enabled:true,maxPerMinute:60,publicKey:readerKey.publicKey.export({type:'spki',format:'pem'})},
  {id:controlPrincipalId,keyId:'qa-first-control',enabled:true,maxPerMinute:12,publicKey:controlKey.publicKey.export({type:'spki',format:'pem'})}]};
 const before=JSON.stringify(f.store.db.prepare("SELECT * FROM connections WHERE ref IN ('preserved-google','preserved-whatsapp') ORDER BY ref").all());
 const calls=[];let hook=()=>{},response=(_route,v)=>v;
 const request=(options,callback)=>{
  assert.equal(options.protocol,'https:');assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.2');assert.equal(options.agent,false);
  const req=new EventEmitter();req.destroy=()=>{};req.end=body=>queueMicrotask(async()=>{
   const route=options.hostname==='oauth2.googleapis.com'?'refresh':options.path.includes('urlInspection')?'inspection':options.path.endsWith('/searchAnalytics/query')?'analytics':'discovery';
   calls.push({route,host:options.hostname,path:options.path,method:options.method});
   try{await hook(route);let value;
    if(route==='refresh'){
     const form=new URLSearchParams(body);assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),'FICTITIOUS_FIRST_REFRESH');
     value={access_token:'FICTITIOUS_ORDINARY_SC_ACCESS',token_type:'Bearer',expires_in:3600,scope:requiredScopesFor('search_console').join(' ')};
    }else{
     assert.equal(options.headers.authorization,'Bearer FICTITIOUS_ORDINARY_SC_ACCESS');
     if(route==='discovery'){assert.equal(options.method,'GET');value={siteUrl:f.resource.siteUrl,permissionLevel:'siteOwner'};}
     else if(route==='inspection')value={inspectionResult:{indexStatusResult:{verdict:'PASS',coverageState:'Indexed'},private:'IGNORE'}};
     else{const input=JSON.parse(body);const keys=input.dimensions[0]==='page'?['https://example.invalid/']:input.dimensions.length===3?['2030-01-01','query','https://example.invalid/']:['2030-01-01'];
      value={rows:[{keys,clicks:1,impressions:2,ctr:.5,position:3}]};}
    }
    value=response(route,value);const res=new EventEmitter();res.statusCode=value.__status||200;res.headers={'content-type':'application/json'};res.destroy=()=>{};
    callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');
   }catch(error){req.emit('error',error);}
  });return req;
 };
 const cursor=cursorCodec(randomBytes(32),f.now),options={store:f.store,ledger:f.ledger,firstJournal:f.first,vault:f.vault,client:f.base.client,http:createGoogleHttp({request}),cursor,
  policy,readerPrincipalId,controlPrincipalId,approvedScopes:[{scopeKey:'group:11',clinicIds:[17,31],services:['search_console']}],slots:[f.slot],
  redirectUri:f.base.binding.oauth.redirectUri,...f.base.config,now:f.now};
 let reader=createFirstSearchConsoleReadOwner(options);t.after(()=>reader.close());
 const command=(operation=C.PREFIX+'discovery.read.v1',payload={},overrides={})=>({requestId:randomUUID(),operation,tenantRef:'clinic:31',connectionRef:receipt.connectionRef,assetRef:receipt.assetRef,payload,...overrides});
 const execute=(cmd=command(),role='reader')=>{const keys=role==='reader'?readerKey:controlKey,keyId=role==='reader'?'qa-first-reader':'qa-first-control';
  const {raw,headers}=signRequest(cmd,{keyId,privateKey:keys.privateKey,audience:policy.audience,now:f.now()});return reader.broker.execute(raw,headers);};
 if(bootstrap)await reader.bootstrap({proof:f.proof,owner:f.owner,receipt});
 return{...f,receipt,policy,options,calls,command,execute,get reader(){return reader;},
  get hook(){return hook;},set hook(fn){hook=fn;},set response(fn){response=fn;},
  restart(){reader.close();reader=createFirstSearchConsoleReadOwner(options);},
  oldRows(){assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM connections WHERE ref IN ('preserved-google','preserved-whatsapp') ORDER BY ref").all()),before);}};
}

module.exports={setup};
