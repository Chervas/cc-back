'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../../..');
// Optional TEST-ONLY dependency root permits a minimal private candidate; in a
// complete repository all sources and dependencies resolve from root itself.
const dependencyRoot=process.env.GOAL_POLICY_QA_DEPENDENCY_ROOT||root;
const depRequire=createRequire(path.join(dependencyRoot,'package.json'));
const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_GOAL_POLICY_QA');};
require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const filename=relative=>fs.existsSync(path.join(root,relative))?path.join(root,relative):path.join(dependencyRoot,relative);
const read=relative=>fs.readFileSync(filename(relative),'utf8');
function load(relative,deps,suffix='',source){
 const module={exports:{}};vm.runInNewContext((source===undefined?read(relative):source)+suffix,{module,exports:module.exports,require:name=>{
  if(Object.hasOwn(deps,name))return deps[name];if(name.startsWith('node:'))return require(name);throw Error('UNEXPECTED_OFFLINE_IMPORT:'+name);
 },__dirname:path.dirname(filename(relative)),__filename:filename(relative),Buffer,URL,Date,Map,Set,console,structuredClone,process:{env:{},cwd:()=>root,pid:1}},{filename:filename(relative)});return module.exports;
}
const modules=new Map();
function contract(relative){
 if(modules.has(relative))return modules.get(relative);const deps={};
 for(const match of read(relative).matchAll(/require\(['"]([^'"]+)['"]\)/g)){
  const name=match[1];if(name.startsWith('node:'))continue;
  if(name.startsWith('./'))deps[name]=contract(path.posix.normalize(path.posix.dirname(relative)+'/'+name+'.js'));
  else if(name==='ajv')deps[name]=depRequire('ajv');else throw Error('UNEXPECTED_CONTRACT_IMPORT:'+name);
 }
 const value=load(relative,deps);modules.set(relative,value);return value;
}
const ads=contract('services/integrations-broker/src/google-ads-contract.js');
const goal=contract('services/integrations-broker/src/google-goal-policy-contract.js');
const reader=load('src/services/googleAdsBrokerReader.service.js',{'../../services/integrations-broker/src/google-ads-contract':ads});
function facade(options){
 const req=createRequire(path.join(dependencyRoot,'src/services/googleAdsBroker.service.js'));
 const deps={};for(const match of read('src/services/googleAdsBroker.service.js').matchAll(/require\(['"]([^'"]+)['"]\)/g)){
  const name=match[1];if(name.startsWith('node:')||name==='../../models')continue;
  deps[name]=name==='./googleAdsBrokerReader.service'?reader:req(name);
 }
 return load('src/services/googleAdsBroker.service.js',deps).createGoogleAdsBroker(options);
}
const customer='1234567890',connection={id:71,googleUserId:'fictitious-goal-subject'};
function fixture(){
 const state={blocked:null,checks:0,provider:0,checkedRegistries:[]};
 const raw=load('src/services/googleLegacyCredentials.service.js',{sequelize:depRequire('sequelize')});
 const names=['bindingModel','searchConsoleModel','analyticsModel','propertyRevocationModel','adsModel','adsRevocationModel','enrollmentScopeModel','enrollmentRequestModel'];
 const credentials=raw.createGoogleLegacyCredentials({connectionModel:{findByPk:async id=>({...connection,id})},...Object.fromEntries(names.map(name=>[name,{findOne:async()=>{state.checks++;state.checkedRegistries.push(name);return state.blocked===true||state.blocked===name?{google_user_id:connection.googleUserId}:null;}}]))});
 const client={googleAdsRequest:()=>{throw Error('PROVIDER_NOT_INJECTED');},normalizeCustomerId:value=>String(value||'').replace(/[^0-9]/g,'')};
 const scoped={GOOGLE_ADS_SCOPE:'https://www.googleapis.com/auth/adwords',resolveScopedGoogleAdsRuntime:()=>{throw Error('RUNTIME_NOT_INJECTED');},runtimeError:(code,_message,status)=>Object.assign(Error(code),{code,httpStatus:status})};
 const quality=load('src/services/googleAdsConnectOnlyQualityAudit.service.js',{'../lib/googleAdsClient':client,'./googleAdsScopedRuntime.service':scoped,'./googleLegacyCredentials.service':credentials,'./googleAdsBrokerReader.service':reader});
 const service=load('src/services/googleAdsClinicaclickGoalPolicy.service.js',{'../../models':{},'../lib/googleAdsClient':client,'./notifications.service':{},'../controllers/campaignOnboarding.controller':{},'./googleAdsScopedRuntime.service':scoped,'./googleAdsConnectOnlyQualityAudit.service':quality,'./googleLegacyCredentials.service':credentials,'./googleAdsBrokerReader.service':reader});
 return{state,service,credentials,names};
}
function scopedFixture(){return depRequire('./src/scripts/tests/fixtures/google_ads_broker_scope.fixture').scopeFixture();}
module.exports={root,dependencyRoot,filename,read,load,contract,ads,goal,reader,facade,fixture,scopedFixture,customer,connection,depRequire};
