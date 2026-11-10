'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../../services/managedCampaignAssociationScopes.service'),'utf8');
function service(order){const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,require:n=>n==='../../models'?{}:n==='./metaMarketingTransactionOrder.service'&&order?{createOrder:()=>order}:require(n)});return module.exports}
const mapping=()=>({id:391,clinicaId:null,grupoClinicaId:29,assignmentScope:'group',metaConnectionId:172,assetType:'ad_account',metaAssetId:'act_5651594564879938',metaAssetName:'Synthetic group account',isActive:true});
function options(s,m,assignments=[]){return s.buildAssociationOptions({groups:[{id_grupo:29,nombre_grupo:'Synthetic group'}],clinics:[{id_clinica:66,nombre_clinica:'Synthetic A',grupoClinicaId:29,estado_clinica:true},{id_clinica:72,nombre_clinica:'Synthetic B',grupoClinicaId:29,estado_clinica:true}],metaAssets:[m],metaAssignments:assignments})[0].accounts}
test('an active canonical broker account is selectable without reusing the legacy connection grant',async()=>{
 const s=service(),m=mapping(),tx={id:'synthetic-transaction'};let observed;
 await s.authorizeBrokerMetaMappings({models:{MetaMarketingBrokerBinding:{findAll:async q=>{observed=q;return[{mapping_id:391}]}}},mappings:[m],transaction:tx,
 createScope:()=>({prepare:async id=>({id}),assertContext:async()=>({kind:'ad_account',id:'5651594564879938',connectionId:172})})});
 const rows=options(s,m,[{assignmentScope:'group',grupoClinicaId:29,metaConnectionId:158,status:'active'}]);assert.equal(rows.length,1);assert.equal(rows[0].selectable,true);assert.equal(observed.transaction,tx);assert.equal(observed.attributes.join(','),'mapping_id');assert(!JSON.stringify(rows).includes('172'));
});
test('revoked, mismatched or unavailable broker authority cannot fall back to an active legacy-looking grant',async()=>{
 for(const current of [null,{kind:'facebook_page',id:'5651594564879938',connectionId:172},{kind:'ad_account',id:'999',connectionId:172},{kind:'ad_account',id:'5651594564879938',connectionId:158}]){
 const s=service(),m=mapping();await s.authorizeBrokerMetaMappings({models:{MetaMarketingBrokerBinding:{findAll:async()=>[{mapping_id:391}]}},mappings:[m],createScope:()=>({prepare:async()=>({}),assertContext:async()=>{if(!current)throw Error('asset_revoked');return current}})});
 assert.equal(options(s,m,[{assignmentScope:'group',grupoClinicaId:29,metaConnectionId:172,status:'active'}]).length,0);
 }
});
test('an account with no broker registration retains its existing scoped legacy authorization',async()=>{const s=service(),m=mapping();await s.authorizeBrokerMetaMappings({models:{MetaMarketingBrokerBinding:{findAll:async()=>[]}},mappings:[m],createScope:()=>{throw Error('must not open provider')}});assert.equal(options(s,m,[{assignmentScope:'group',grupoClinicaId:29,metaConnectionId:172,status:'active'}])[0].selectable,true)});
test('broker assignment fences its canonical enrollment before the caller transaction work',async()=>{
 const calls=[],prepared={},tx={};const s=service({prepareEnrollment:async id=>{calls.push(['prepare',id]);return prepared},lockPrepared:async(p,t)=>{assert.equal(p,prepared);assert.equal(t,tx);calls.push(['lock'])}});
 const lock=await s.prepareAssociationTransaction({models:{MetaMarketingBrokerBinding:{findAll:async q=>{assert.equal(q.where.asset_ref,'meta-ad_account:5651594564879938');return[{enrollment_id:'synthetic'}]}}},provider:'meta_ads',accountId:'act_5651594564879938'});
 assert.equal(calls.length,1);await lock(tx);assert.deepEqual(calls,[['prepare','synthetic'],['lock']]);
});
test('ambiguous authority fails closed while non-broker providers retain their existing path',async()=>{
 const s=service();await assert.rejects(s.prepareAssociationTransaction({models:{MetaMarketingBrokerBinding:{findAll:async()=>[{enrollment_id:'a'},{enrollment_id:'b'}]}},provider:'meta_ads',accountId:'1'}),e=>e.code==='workspace_meta_authority_changed');
 assert.equal(await s.prepareAssociationTransaction({models:{},provider:'google_ads',accountId:'1'}),null);
});
