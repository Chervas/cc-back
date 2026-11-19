'use strict';
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs');
const {BrokerStore}=require('../src/store'),{Broker}=require('../src/broker');
const {createMetaMarketingOAuth,createMetaMarketingOAuthOperations}=require('../src/meta-marketing-oauth');
const {createMetaMarketingOAuthSecrets}=require('../src/meta-marketing-oauth-secrets');
const C=require('../src/meta-marketing-oauth-contract');
const {ACCOUNT,SECRET_KEY}=require('../src/google-main');

function admissionFixture(t){
  const f=fixture(t),P=require('../src/meta-marketing-admission-contract');
  const {createMetaMarketingAdmission}=require('../src/meta-marketing-admission');
  // Three independent static authorizations remain present throughout every
  // dynamic test. Their contents are fixtures, never deployment configuration.
  for(const [scope,ids] of [['clinic:81',[81]],['group:11',[91,92]]]){
    const binding=structuredClone(f.binding),suffix=scope.replace(':','-');
    binding.connectionRef='connection:static-'+suffix;
    binding.secretArn=binding.secretArn.replace('qa-candidate','qa-candidate-'+suffix);
    binding.metaMarketingOAuth.scopeKey=scope;binding.metaMarketingOAuth.clinicIds=ids;
    f.policy.connections.push(binding);
    for(const original of f.policy.grants.slice(0,2))f.policy.grants.push({...structuredClone(original),connectionRef:binding.connectionRef,
      tenantRef:'clinic:'+ids[0],assetRef:'meta-enroll:'+scope});
  }
  const settings={enabled:true,environment:'staging',appId:f.binding.metaMarketingOAuth.appId,
    appVersionId:f.binding.metaMarketingOAuth.appVersionId,clientSecretArn:f.binding.clientSecretArn,
    redirectUri:f.binding.metaMarketingOAuth.redirectUri,scopes:[...f.binding.metaMarketingOAuth.scopes].sort(),
    scopeKeys:['clinic:123','clinic:124','clinic:125','group:12'],maxConnections:10,slotTtlMs:86400000};
  const originalPolicy=JSON.stringify(f.policy),metadata=new Map();
  const state={creates:0,loseCreate:false,denied:false,before:null,after:null,calls:[]};
  const aws={async send(command,options){
    state.calls.push(command);await state.before?.(command,options);
    if(state.denied)throw Error('FICTITIOUS_PRIVATE_IAM_DETAIL');
    const input=command.input,type=command.constructor.name;let result;
    if(type==='CreateSecretCommand'){
      if(metadata.has(input.Name))throw Object.assign(Error('FICTITIOUS_ALREADY_EXISTS'),{name:'ResourceExistsException'});
      state.creates++;assert.equal(input.KmsKeyId,SECRET_KEY);assert(C.uuid(input.ClientRequestToken));
      const ARN=P.ARN_PREFIX+input.Name+'-abcdef';
      metadata.set(input.Name,{ARN,Name:input.Name,KmsKeyId:input.KmsKeyId,Tags:input.Tags});
      f.records.set(ARN,new Map([[input.ClientRequestToken,{body:input.SecretString,stages:['AWSCURRENT']}]]));
      if(state.loseCreate){state.loseCreate=false;throw Error('FICTITIOUS_LOST_CREATE_ACK');}
      result={ARN,Name:input.Name,VersionId:input.ClientRequestToken};
    }else if(type==='DescribeSecretCommand'&&metadata.has(input.SecretId)){
      const meta=metadata.get(input.SecretId);
      if(!f.records.has(meta.ARN))throw Object.assign(Error('FICTITIOUS_NOT_FOUND'),{name:'ResourceNotFoundException'});
      result=await f.aws.send(new command.constructor({...input,SecretId:meta.ARN}),options);Object.assign(result,meta);
    }else{
      if(!f.records.has(input.SecretId))throw Object.assign(Error('FICTITIOUS_NOT_FOUND'),{name:'ResourceNotFoundException'});
      result=await f.aws.send(command,options);
      if(type==='DescribeSecretCommand')Object.assign(result,[...metadata.values()].find(value=>value.ARN===input.SecretId));
    }
    return state.after?state.after(command,result):result;
  }};
  const handles=[],filename=f.dir+'/admission.sqlite';
  function make(store=new BrokerStore(filename),chosenSettings=settings){
    const admission=createMetaMarketingAdmission({store,policy:f.policy,settings:chosenSettings,client:aws,now:f.now});
    const secrets=createMetaMarketingOAuthSecrets({client:aws,accountId:ACCOUNT,
      prefix:'/clinicaclick/integrations/prod/meta-marketing/staging/',kmsKeyArn:SECRET_KEY});
    const engine=createMetaMarketingOAuth({store,policy:f.policy,secrets,http:f.http,now:f.now});
    const broker=new Broker({store,policy:f.policy,secrets,policyResolver:admission,
      operations:createMetaMarketingOAuthOperations(engine),now:f.now});
    const handle={store,admission,engine,broker,close(){engine.close();try{store.close();}catch{}}};
    handles.push(handle);return handle;
  }
  const current=make();t.after(()=>handles.forEach(handle=>handle.close()));
  function command(scope='clinic:123',clinicIds=[123],overrides={}){
    return {requestId:randomUUID(),operation:P.OPERATION,tenantRef:'clinic:'+clinicIds[0],
      connectionRef:P.connectionRef(scope),assetRef:'meta-enroll:'+scope,payload:{scopeKey:scope,clinicIds,
        scopeDigest:C.hash('FICTITIOUS_AUTHORIZED_SCOPE'),clinicSetDigest:C.hash(JSON.stringify(clinicIds)),expiresAt:f.now()+600000},...overrides};
  }
  function prepare(value=command(),handle=current,control=false){const signed=f.signed(value,control);return handle.admission.prepare(signed.raw,signed.headers);}
  function execute(value,handle=current,control=false){const signed=f.signed(value,control);return handle.broker.execute(signed.raw,signed.headers);}
  function beginCommand(value=command()){
    return {...value,requestId:randomUUID(),operation:C.OPERATIONS.begin,payload:{state:randomBytes(32).toString('base64url'),
      scopeDigest:value.payload.scopeDigest,clinicSetDigest:value.payload.clinicSetDigest,expiresAt:f.now()+600000}};
  }
  function slots(handle=current){return handle.store.db.prepare('SELECT * FROM meta_marketing_admission_slots ORDER BY scope').all();}
  return {f,P,settings,state,metadata,aws,originalPolicy,current,make,command,prepare,execute,beginCommand,slots};
}
module.exports={admissionFixture};
