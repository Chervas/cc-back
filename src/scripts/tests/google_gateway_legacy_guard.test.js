'use strict';
// Only pure source/metadata fixtures: no app bootstrap, sockets or provider.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {REGISTRIES,createGoogleLegacyOAuthGuard}=require('../../services/googleLegacyOAuthGuard.service');
function fixture(){
  const state={markers:new Set(),calls:{consume:0,issue:0,token:0,userinfo:0,writes:0,assignment:0},afterToken:null,afterUser:null,afterWrite:null,reads:[],rows:[]};
  const models=Object.fromEntries(REGISTRIES.map(([name])=>[name,{findOne:async options=>{state.reads.push(options);return state.markers.has(name)?{}:null;}}]));
  models.Clinica={findByPk:async()=>({grupoClinicaId:null})};
  const model={sequelize:{async transaction(options,work){assert.equal(options.isolationLevel,'SERIALIZABLE');const before=state.rows.map(x=>({...x}));
    try{return await work({LOCK:{SHARE:'SHARE',UPDATE:'UPDATE'}});}catch(error){state.rows=before;throw error;}}},
    findOne:async({where})=>{const row=state.rows.find(x=>Object.entries(where).every(([k,v])=>x[k]===v));return row&&{...row,async update(values){state.calls.writes++;Object.assign(row,values);await state.afterWrite?.();return row;}};},
    create:async values=>{state.calls.writes++;const row={id:81,...values};state.rows.push(row);await state.afterWrite?.();return row;}};
  const env={GOOGLE_CLIENT_ID:'FICTITIOUS_CLIENT',GOOGLE_CLIENT_SECRET:'FICTITIOUS_SECRET',GOOGLE_OAUTH_BROKER_ENABLED:'false',RUNTIME_ROLE:'gateway',JOBS_AUTO_START:'false'};
  const logs=[];const context=vm.createContext({Buffer,URL,URLSearchParams,Date,process:{env},console:Object.fromEntries(['log','warn','error'].map(k=>[k,(...a)=>logs.push(a)])),setTimeout,clearTimeout});
  const deny=()=>assert.fail('UNDECLARED_GATEWAY_TEST_DEPENDENCY');const blocked=new Proxy({},{get:()=>deny});
  function load(relative,deps){const filename=path.resolve(__dirname,'../..',relative),module={exports:{}};
    const fn=new vm.Script('(function(module,exports,require){\n'+fs.readFileSync(filename,'utf8')+'\n})',{filename}).runInContext(context,{timeout:1000});
    fn(module,module.exports,name=>Object.hasOwn(deps,name)?deps[name]:blocked);return module.exports;}
  const persistence=load('services/oauthConnectionPersistence.service.js',{'../../models':models,'./googleLegacyOAuthGuard.service':{createGoogleLegacyOAuthGuard}});
  const persist=values=>persistence.persistGoogleConnection(values,{GoogleConnectionModel:model,models,sequelize:model.sequelize});
  const handlers=new Map();const router={};for(const method of ['get','post','delete','put','patch','use'])router[method]=(route,...callbacks)=>{if(typeof route==='string')handlers.set(method+' '+route,callbacks);return router;};
  load('routes/oauth.routes.js',{
    express:{Router:()=>router},sequelize:{Op:{in:Symbol.for('in'),or:Symbol.for('or')}},'../../models':models,
    '../services/googleLegacyOAuthGuard.service':{createGoogleLegacyOAuthGuard},
    '../services/metaConnectionMetadata.service':{createMetaConnectionMetadata:()=>({handler:()=>deny}),createMetaMetadataRepository:()=>deny},
    '../services/metaMarketingAccessCheck.service':{createMetaMarketingAccessCheck:()=>({handler:()=>deny})},
    '../services/metaMarketingBrokerReader.service':{forModels:()=>({prepare:deny,read:deny})},
    './metaMarketingRevocation.routes':{createRouter:()=>deny},
    '../lib/oauthRedirect':require('../../lib/oauthRedirect'),
    '../lib/oauthMarketingScopeAccess':{marketingScopeInputFromRequest:()=>({clinicIdRaw:71,groupIdRaw:null,assignmentScopeRaw:'clinic'}),authorizeRequestedMarketingConnectionScope:async()=>({requested:true,clinicIds:[71]})},
    '../services/scopeConnectionResolver.service':{normalizeScope:async()=>({clinicId:71,assignmentScope:'clinic'}),buildSharedConnectionScope:()=>({scopeKey:'clinic:71'}),upsertGoogleAssignment:async()=>{state.calls.assignment++;}},
    '../services/oauthState.service':{consumeOAuthState:async()=>{state.calls.consume++;return{userId:7,clinicId:71,assignmentScope:'clinic',returnTo:'https://app.clinicaclick.com'};},issueOAuthState:async()=>{state.calls.issue++;return'FICTITIOUS_STATE';}},
    '../services/oauthConnectionPersistence.service':{persistGoogleConnection:persist},
    axios:{post:async()=>{state.calls.token++;await state.afterToken?.();return{data:{access_token:'FICTITIOUS_ACCESS',refresh_token:'FICTITIOUS_REFRESH',expires_in:3600}};},get:async()=>{state.calls.userinfo++;await state.afterUser?.();return{data:{id:'fictitious-subject'}};}},
  });
  async function invoke(route,query={}){const callbacks=handlers.get('get '+route);assert(callbacks);const output={headers:{},status:200};
    const res={set(k,v){output.headers[k]=v;return this;},status(value){output.status=value;return this;},json(value){output.body=value;return value;},redirect(value){output.redirect=value;return value;}};
    await callbacks[0]({query,userData:{userId:7}},res);assert(!JSON.stringify([output,logs]).includes('FICTITIOUS_SECRET'));return output;}
  return{state,env,models,persistence,model,invoke};
}
test('every managed registry closes public callback before state/provider/persistence',async()=>{
  for(const[name]of REGISTRIES){const f=fixture();f.state.markers.add(name);const r=await f.invoke('/google/callback',{state:'FICTITIOUS',code:'FICTITIOUS_CODE'});
    assert(r.redirect.includes('error='));assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['Referrer-Policy'],'no-referrer');
    assert.deepEqual(f.state.calls,{consume:0,issue:0,token:0,userinfo:0,writes:0,assignment:0});}
});
test('managed configuration with empty registries never falls through to legacy OAuth',async()=>{
  const f=fixture();f.env.GOOGLE_OAUTH_BROKER_ENABLED='true';const c=await f.invoke('/google/connect');assert.equal(c.status,503);assert.equal(c.body.error,'google_oauth_unavailable');
  await f.invoke('/google/callback',{state:'x',code:'x'});assert.equal(f.state.calls.consume+f.state.calls.issue+f.state.calls.token+f.state.calls.writes,0);
});
test('marker during exchange blocks userinfo/write; marker during userinfo blocks persistence',async()=>{
  const f=fixture();f.state.afterToken=()=>f.state.markers.add('BusinessProfileBrokerBinding');await f.invoke('/google/callback',{state:'x',code:'x'});
  assert.equal(f.state.calls.token,1);assert.equal(f.state.calls.userinfo+f.state.calls.writes+f.state.calls.assignment,0);
  const g=fixture();g.state.afterUser=()=>g.state.markers.add('SearchConsoleBrokerBinding');await g.invoke('/google/callback',{state:'x',code:'x'});
  assert.equal(g.state.calls.userinfo,1);assert.equal(g.state.calls.writes+g.state.calls.assignment,0);
});
test('transactional post-write guard rolls back Google row and cannot create assignment',async()=>{
  const f=fixture();f.state.afterWrite=()=>f.state.markers.add('BusinessProfileBrokerBinding');await f.invoke('/google/callback',{state:'x',code:'x'});
  assert.equal(f.state.calls.writes,1);assert.equal(f.state.rows.length,0);assert.equal(f.state.calls.assignment,0);
  assert(f.state.reads.some(x=>x.transaction&&x.lock==='SHARE'));
});
test('unmanaged flagsOFF and empty registries preserve one-use legacy callback without new dispatcher',async()=>{
  const f=fixture();const r=await f.invoke('/google/callback',{state:'x',code:'x'});assert(r.redirect.includes('connected=google'));
  assert.equal(f.state.calls.consume,1);assert.equal(f.state.calls.token,1);assert.equal(f.state.calls.userinfo,1);assert.equal(f.state.calls.writes,1);assert.equal(f.state.calls.assignment,1);
});
test('missing registry fails closed and provider cancellation never reflects raw error or exchanges code',async()=>{
  const f=fixture();delete f.models.BusinessProfileBrokerBinding;await f.invoke('/google/callback',{state:'x',code:'x'});assert.equal(f.state.calls.consume+f.state.calls.token,0);
  const g=fixture();const r=await g.invoke('/google/callback',{state:'x',error:'FICTITIOUS_SECRET'});assert(r.redirect.includes('google_authorization_cancelled'));assert.equal(g.state.calls.token,0);
});
test('all ten metadata-only model factories register guard columns and mandatory base contract without associations',()=>{
  const D=require('sequelize').DataTypes;
  const contract=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../ops/security/schema-contract.json'),'utf8'));
  const factories=['googleoauthbrokerbinding','searchconsolebrokerbinding','analyticsbrokerbinding','googlepropertybrokerrevocation',
    'googleadsbrokerbinding','googleadsbrokerrevocation','googleadsenrollmentscope','googleadsenrollmentrequest','businessprofilebrokerbinding','businessprofilebrokerrevocation'];
  const registered=new Map();const sql={define:(name,attributes,options)=>{const row={name,attributes,options};registered.set(name,row);return row;}};
  for(const file of factories){const model=require('../../../models/'+file)(sql,D);assert.equal(model.associate,undefined);}
  for(const[name,attribute]of REGISTRIES){const model=registered.get(name);assert(model&&model.attributes[attribute]);
    assert(contract.tables[model.options.tableName].columns.some(row=>row.COLUMN_NAME===attribute));}
  assert.equal(registered.size,10);
});
