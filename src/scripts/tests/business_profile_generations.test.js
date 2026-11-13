'use strict';require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../../services/businessProfileBindingGeneration.service');
const H=require('../../services/businessProfileHistoryScope.service');
const id='20000000-0000-4000-8000-000000000002';
const mapping={id:70,clinica_id:72,google_connection_id:81,location_id:'locations/456',is_active:true,broker_read_connection_ref:'connection:test',broker_read_asset_ref:'gbp:123:456'};
const registry={external_location_id:'456',clinica_id:71,google_connection_id:81,connection_ref:'connection:test',asset_ref:'gbp:123:456',state:'retired',current_generation_id:id};
const generation={generation_id:id,mapping_id:70,external_location_id:'456',clinica_id:72,google_connection_id:81,connection_ref:'connection:test',asset_ref:'gbp:123:456',scope_ref:'gbp-enroll:clinic:72',state:'active',association_attempt_id:'30000000-0000-4000-8000-000000000003',source_fingerprint:'a'.repeat(64)};
test('generation authority resolves only exact stored head/mapping; legacy retirement is preserved',()=>{
 const r=G.validateResolvedBinding({mapping,registry,generation});assert.equal(r.mapping_id,70);assert.equal(r.clinica_id,72);assert.equal(registry.state,'retired');
 for(const patch of [{generation_id:'40000000-0000-4000-8000-000000000004'},{mapping_id:71},{state:'retired'},{external_location_id:'457'},{clinica_id:73},{asset_ref:'gbp:999:456'},{connection_ref:'other'}])assert.throws(()=>G.validateResolvedBinding({mapping,registry,generation:{...generation,...patch}}),{code:'broker_binding_invalid'});
 assert.throws(()=>G.validateResolvedBinding({mapping,registry,generation:null}));assert.throws(()=>G.validateResolvedBinding({mapping:{...mapping,is_active:false},registry,generation}));
});
test('global location revocation is checked before generation even when it would otherwise resolve',async()=>{
 let looked=false;const models={BusinessProfileBrokerRevocation:{findByPk:async()=>({state:'pending'})},BusinessProfileBrokerBinding:{findByPk:async()=>{looked=true;return registry;}}};
 await assert.rejects(G.resolveMappingBinding({models,mapping}),{code:'asset_revoked'});assert.equal(looked,false);
});
test('missing registry can be legacy only for fully unmarked mappings; a malformed head never downgrades',async()=>{
 const models={BusinessProfileBrokerRevocation:{findByPk:async()=>null},BusinessProfileBrokerBinding:{findByPk:async()=>null}};
 assert.equal(await G.resolveMappingBinding({models,mapping:{...mapping,broker_read_connection_ref:null,broker_read_asset_ref:null}}),null);
 await assert.rejects(G.resolveMappingBinding({models,mapping}),{code:'broker_binding_invalid'});
 models.BusinessProfileBrokerBinding.findByPk=async()=>registry;models.BusinessProfileBrokerBindingGeneration={findByPk:async()=>null};
 await assert.rejects(G.resolveMappingBinding({models,mapping}),{code:'broker_binding_invalid'});
});
test('metric projection keeps origin identity and selects current head over predecessor without summing aliases',()=>{
 const projection={lineages:[{headId:70,chain:[70,2]}]};const rows=[{id:1,business_location_id:2,date:'2026-11-01',metric_type:'CALL_CLICKS',value:9},{id:2,business_location_id:70,date:'2026-11-01',metric_type:'CALL_CLICKS',value:0},{id:3,business_location_id:2,date:'2026-10-01',metric_type:'CALL_CLICKS',value:3},{id:4,business_location_id:3,date:'2026-10-01',metric_type:'CALL_CLICKS',value:99}];
 const result=H.deduplicateMetrics(rows,projection);assert.deepEqual(result.map(r=>r.value),[0,3]);assert.deepEqual(result.map(r=>r.source_business_location_id),[70,2]);assert.equal(rows[0].business_location_id,2);
});
test('generation bound in a broker context cannot silently change to another matching generation',async()=>{
 const {createBusinessProfileBroker}=require('../../services/businessProfileBroker.service');let live={...generation},calls=0;
 const reader=createBusinessProfileBroker({enabled:()=>true,loadLocation:async()=>mapping,loadManagedBinding:async()=>({...live,mapping_id:70}),client:{execute:async command=>{calls++;assert.equal(Object.hasOwn(command,'generationId'),false);live={...live,generation_id:'40000000-0000-4000-8000-000000000004'};return {data:{}};}}});
 const context=await reader.prepare(mapping,()=>assert.fail(),new Map());await assert.rejects(reader.read(mapping,context,'details',{}),{code:'broker_binding_invalid'});assert.equal(calls,1);
});
test('scoped discovery/revoke do not hydrate an unrelated damaged generation; a requested nonhead cannot revoke globally',async()=>{
 let foreignReads=0,ownRegistry=registry;const models={ClinicBusinessLocation:{findAll:async()=>[mapping]},BusinessProfileBrokerRevocation:{findByPk:async()=>null},
  BusinessProfileBrokerBinding:{findByPk:async key=>{if(key!=='456'){foreignReads++;assert.fail('unrelated registry must not be read');}return ownRegistry;},findAll:async()=>[]},
  BusinessProfileBrokerBindingGeneration:{findByPk:async key=>{if(key!==id){foreignReads++;assert.fail('unrelated generation must not be read');}return generation;},findAll:async options=>{assert.equal(options.where.google_connection_id,81);assert.deepEqual(options.where.clinica_id[require('sequelize').Op.in],[72]);return [generation];}}};
 const input={models,clinicIds:[72],connectionId:81};assert.equal((await G.listEffectiveBindings(input))[0].mapping_id,70);assert.equal((await G.listEffectiveBindings({...input,forRevocation:true}))[0].mapping_id,70);assert.equal(foreignReads,0);
 ownRegistry={...registry,current_generation_id:'40000000-0000-4000-8000-000000000004'};models.BusinessProfileBrokerBindingGeneration.findByPk=async()=>null;
 await assert.rejects(G.listEffectiveBindings(input),{code:'broker_binding_invalid'});await assert.rejects(G.listEffectiveBindings({...input,forRevocation:true}),{code:'broker_binding_invalid'});
});
