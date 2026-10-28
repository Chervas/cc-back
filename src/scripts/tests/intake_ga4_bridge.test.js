'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const {ga4BridgeError,bridgeStatus}=require('../../lib/intake-ga4-bridge');
const {mergeIntakeEditorFeatures}=require('../../lib/intake-config-write-merge');
test('optional bridge requires a specific GA4 destination and consent; string booleans fail',()=>{
 a.equal(bridgeStatus({}),'not_configured');
 for(const f of [{ga4_bridge_enabled:'true'},{ga4_measurement_id:'AW-123456'},{ga4_bridge_enabled:true,ga4_measurement_id:'G-VALID123',consent_mode_enabled:false},{ga4_bridge_enabled:true,consent_mode_enabled:true}])a.ok(ga4BridgeError(f));
 a.equal(bridgeStatus({ga4_bridge_enabled:true,ga4_measurement_id:'G-VALID123',consent_mode_enabled:true,ga4_bridge_channels:['whatsapp']}),'configured');
});
test('editing bridge preserves server-owned conversion policy and a previous editor cannot erase it',()=>{
 const current={google_ads_user_data_runtime_enabled:true,ga4_bridge_enabled:true,ga4_measurement_id:'G-VALID123',ga4_bridge_channels:['whatsapp']};
 a.deepEqual(mergeIntakeEditorFeatures(current,{chat_enabled:true}),{...current,chat_enabled:true});
 a.deepEqual(mergeIntakeEditorFeatures(current,{ga4_bridge_enabled:false,google_ads_user_data_runtime_enabled:false}),{...current,ga4_bridge_enabled:false});
});
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../../controllers/intake.controller.js'),'utf8');
const start=src.indexOf('exports.upsertIntakeConfig =');const handler=src.slice(start,src.indexOf('// ======================================\n// Config secreta',start));
async function write({body={mutation_kind:'ga4_bridge',group_id:5,enabled:true,measurement_id:'G-VALID123',channels:['whatsapp']},shared=false,consent=true,allowed=true}={}){
 const saved=[];const existing={domains:['example.test'],hmac_key:'fictitious',config:{features:{consent_mode_enabled:consent,chat_enabled:true},locations:[{id:19}],google_ads:{enabled:true,policy:'preserve'}}};
 const context={exports:{},asyncHandler:f=>f,parseInteger:x=>Number(x)||null,requireIntakeConfigScopeAccess:async(req,res)=>{if(!allowed)res.status(403).json({error:'scope_denied'});return allowed;},
 resolveSharedWebGroupConfigForClinic:async()=>shared?{record:existing,groupId:5}:null,
 db:{sequelize:{transaction:async f=>f({LOCK:{UPDATE:'update'}})}},IntakeConfig:{findOne:async()=>existing,upsert:async row=>saved.push(row)},canonicalizeIntakeDomains:x=>x,
 rebuildTrustedSnippetVerification:()=>null,enqueueGoogleDataManagerControlPlaneReconciliation:async()=>{},console,
 require:name=>{a.equal(name,'../lib/intake-ga4-bridge');return {ga4BridgeError};}};
 vm.runInNewContext(handler,context);const res={code:200,status(c){this.code=c;return this;},json(value){this.body=value;return this;}};
 await context.exports.upsertIntakeConfig({params:{clinicId:shared?19:0},body,userData:{}},res);return {res,saved,existing};
}
test('narrow update preserves domain, HMAC, locations and Ads, modifying only bridge settings',async()=>{const {saved,existing,res}=await write();a.equal(res.code,200);a.equal(saved.length,1);a.deepEqual(saved[0].domains,existing.domains);a.equal(saved[0].hmac_key,existing.hmac_key);a.deepEqual(saved[0].config.google_ads,existing.config.google_ads);a.deepEqual(saved[0].config.locations,existing.config.locations);a.equal(saved[0].config.features.ga4_bridge_enabled,true);});
test('clinic cannot change shared group Analytics, and denied scope never writes',async()=>{const x=await write({shared:true,body:{mutation_kind:'ga4_bridge',enabled:true,measurement_id:'G-VALID123',channels:['whatsapp']}});a.equal(x.res.code,409);a.equal(x.saved.length,0);const y=await write({allowed:false});a.equal(y.res.code,403);a.equal(y.saved.length,0);});
test('missing consent and unexpected fields rejected before persistence',async()=>{for(const opts of [{consent:false},{body:{mutation_kind:'ga4_bridge',group_id:5,enabled:true,measurement_id:'G-VALID123',channels:['whatsapp'],hmac_key:'replace'}}]){const x=await write(opts);a.equal(x.res.code,400);a.equal(x.saved.length,0);}});

test('channel list rejects unsupported, duplicate or absent enabled selections',()=>{for(const channels of [[],['unknown'],['form','form'],'whatsapp'])a.ok(ga4BridgeError({ga4_bridge_enabled:true,ga4_measurement_id:'G-VALID123',consent_mode_enabled:true,ga4_bridge_channels:channels}));});
