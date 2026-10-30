"use strict";
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_FIRST_SC_PROPERTY_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;require('node:http').request=deny;require('node:https').request=deny;global.fetch=deny;
const root=path.resolve(__dirname,'../../../..');
const filename=path.join(root,'src/scripts/tests/google_general_connector_preparation.test.js'),source=fs.readFileSync(filename,'utf8'),marker="test('general OAuth state/callback worker";
assert(source.includes(marker));const prefix=source.slice(0,source.indexOf(marker)),moduleValue={exports:{}};
const wrapper=vm.runInThisContext('(function(module,exports,require,__filename,__dirname){\n'+prefix+'\nmodule.exports={fixture,clock,sessionRef};\n})',{filename:'PINNED_GENUINE_FIXTURE:'+filename});
wrapper(moduleValue,moduleValue.exports,createRequire(filename),filename,path.dirname(filename));const {fixture,clock,sessionRef}=moduleValue.exports;
const {createGoogleOAuthBroker}=createRequire(filename)('../../services/googleOAuthBroker.service');
const {MARKETING_WRITE_ROLES}=createRequire(filename)('../../lib/role-helpers');
async function build(kind){const f=fixture();
 if(kind!=='existing'){
  const target=72;f.state.tables.Clinica.push({id_clinica:target,grupoClinicaId:kind==='group'?5:null});
  f.state.tables.UsuarioClinica.push({id_usuario:501,id_clinica:target,rol_clinica:MARKETING_WRITE_ROLES[0],estado_invitacion:'aceptada'});
  f.state.tables.GoogleConnectionAssignment.push(kind==='group'?{scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,googleConnectionId:81,status:'active'}:{scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,googleConnectionId:81,status:'active'});
  f.input={...f.input,scopeKey:kind==='group'?'group:5':'clinic:72',clinicIds:[72]};f.entry={...f.entry,scopeKey:f.input.scopeKey,clinicId:72};f.state.descriptorEntries=[f.entry];f.payload={mappings:[{clinicaId:72,siteUrl:f.entry.siteUrl}]};
 }
 if(kind==='already_shared_clinic'){
  for(const row of f.state.tables.Clinica)row.grupoClinicaId=5;
  f.state.tables.GroupAssetClinicAssignment.push({grupoClinicaId:5,clinicaId:72,assetType:'google.search_console',assetId:11});
 }
 let authorizationState;
 // Same typed fictitious OAuth transport as the original general-connector test.
 // Real begin/callback/run factories establish the control's flow; no row is
 // inserted manually and no real consent or provider operation is performed.
 const client={execute:async request=>{
  const base={flowId:request.payload.flowId||request.requestId,connectionRef:f.binding.connection_ref,googleUserId:f.binding.google_user_id,accessBlocked:false};
  if(request.operation.endsWith('.begin.v1')){
   authorizationState=request.payload.state;const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   Object.entries({state:authorizationState,response_type:'code',code_challenge_method:'S256',code_challenge:'a'.repeat(43),login_hint:base.googleUserId}).forEach(([k,v])=>url.searchParams.set(k,v));
   return{requestId:request.requestId,replayed:false,data:{flowId:base.flowId,expiresAt:clock+600000,authUrl:url.toString()}};
  }
  const status=request.operation.endsWith('.activate.v1')?'active':'staged';
  return{requestId:request.requestId,replayed:false,data:{...base,status,secretVersion:base.flowId}};
 }};
 const broker=createGoogleOAuthBroker({models:f.models,sessions:f.sessions,client,enabled:()=>true,workerEnabled:()=>true,now:()=>new Date(clock),audit:{health:async()=>({pending:0,oldestAgeSeconds:0}),append:async()=>{}}});
 await broker.begin({binding:f.binding,scopeKey:'clinic:71',actorId:501,sessionRef,sessionExpiresAt:f.input.sessionExpiresAt/1000,returnTo:'https://app.clinicaclick.com'});
 await broker.callback({state:authorizationState,code:'FICTITIOUS_CODE',denied:false});await broker.run();
 const control=await broker.status({binding:f.binding,scopeKey:'clinic:71',actorId:501,sessionRef,sessionExpiresAt:f.input.sessionExpiresAt/1000});
 assert.equal(control.activation_confirmed,true);assert.equal(control.connected,false);
 f.state.writes=[];f.state.reads=[];
 return{f,broker};}

module.exports={build,clock,sessionRef};
