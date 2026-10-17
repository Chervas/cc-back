'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {checkStoredPublication}=require('../../services/googleReviewPublication.service');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const match=loadSource('googleReviewMatch.service',{'../../models':{},'./jobRequests.service':{}},{});
const now=new Date('2026-10-17T12:00:00Z');
function fixture(overrides={}){
  const state={link:{id:10,occurred_at:'2026-10-16T16:00:00Z',name:'Ana Prueba Apellido',paciente_id:7,nombre:'Ana',apellidos:'Prueba Apellido'},
    receipts:[],locations:[{id:11,raw_payload:{clinicaclick_reviews_complete_synced_at:'2026-10-17T11:00:00Z',clinicaclick_reviews_complete_count:0}}],reviews:[],...overrides};
  const queries=[];
  const db={Sequelize:{QueryTypes:{SELECT:'SELECT'}},sequelize:{query:async(sql,options)=>{
    assert(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql));assert.equal(options.replacements.clinicId,59);queries.push(sql);
    if(sql.includes('SELECT e.id'))return state.link?[state.link]:[];
    if(sql.includes('SELECT e.payload'))return state.receipts;
    if(sql.includes('FROM ClinicBusinessLocations'))return state.locations;
    if(sql.includes('FROM BusinessProfileReviews'))return state.reviews;
    throw Error('unexpected query');
  }}};
  return{state,queries,run:(args={})=>checkStoredPublication(db,{clinicId:59,listId:1,itemId:2,locationIds:[11],now,...args},match.scoreNameMatch)};
}
test('a recent complete local observation can report not detected without a provider request',async()=>{
  const f=fixture(),r=await f.run();assert.equal(r.state,'not_detected');assert.equal(f.queries.length,4);assert.equal(r.link_event_id,10);
});
test('a compatible review stops follow-up regardless of its star rating, without storing a new attribution',async()=>{
  for(const star_rating of [1,2,3,4,5]){
    const f=fixture({reviews:[{id:8,reviewer_name:'Ana Prueba Apellido',star_rating}]});
    const r=await f.run();assert.equal(r.state,'found');assert.equal(r.confidence,1);assert.equal(r.review_id,8);
  }
});
test('a historical receipt or patient match stops a new request even if its feed is stale',async()=>{
  const f=fixture({receipts:[{payload:{star_rating:2}}],locations:[]});assert.equal((await f.run()).state,'found');assert.equal(f.queries.length,2);
  const byPatient=fixture({locations:[],reviews:[{id:9,matched_paciente_id:7,reviewer_name:'Google alias',star_rating:1}]});
  assert.equal((await byPatient.run()).state,'found');
});
test('an old, future, incomplete, missing, partial or pre-link observation never routes to not detected',async()=>{
  const rawCases=[{}, {clinicaclick_reviews_synced_at:'2026-10-17T11:00:00Z',clinicaclick_reviews_sync_status:'completed'},
    {clinicaclick_reviews_complete_synced_at:'2026-10-17T08:00:00Z',clinicaclick_reviews_complete_count:0},
    {clinicaclick_reviews_complete_synced_at:'2026-10-17T13:00:00Z',clinicaclick_reviews_complete_count:0},
    {clinicaclick_reviews_complete_synced_at:'invalid',clinicaclick_reviews_complete_count:0},
    {clinicaclick_reviews_complete_synced_at:'2026-10-17T11:00:00Z',clinicaclick_reviews_complete_count:-1}];
  for(const raw_payload of rawCases)assert.equal((await fixture({locations:[{id:11,raw_payload}]}).run()).state,'unknown');
  const f=fixture();f.state.link.occurred_at='2026-10-17T11:30:00Z';assert.equal((await f.run()).state,'unknown');
  assert.equal((await fixture({locations:[]}).run()).state,'unknown');
});
test('ambiguity, truncation and a missing confirmed link stop the optional follow-up',async()=>{
  const partial=fixture({reviews:[{id:3,reviewer_name:'Ana Prueba Otro'}]});assert.equal((await partial.run()).state,'unknown');
  const huge=fixture({reviews:Array.from({length:1001},()=>({reviewer_name:'Other'}))});assert.equal((await huge.run()).reason,'local_candidate_limit');
  const noLink=fixture({link:null});assert.equal((await noLink.run()).reason,'no_confirmed_google_link');assert.equal(noLink.queries.length,1);
});
test('unscoped inputs and foreign mappings cannot read or borrow a different clinic observation',async()=>{
  const f=fixture();for(const args of [{clinicId:null},{listId:'1 OR 1=1'},{itemId:0},{locationIds:[]},{now:new Date('invalid')}])assert.equal((await f.run(args)).state,'unknown');
  assert.equal(f.queries.length,0);assert.equal((await fixture({locations:[]}).run()).state,'unknown');
});
test('the current V2 engine simulates all three new branches without a local read or any send',async()=>{
  let reads=0;
  const engine=loadSource('flowEngineV2.service',{'../../models':{},'./jobRequests.service':{getCurrentRuntimeNamespace:()=> 'test'},'./marketingBulkSends.service':{getGoogleReviewPublicationState:async()=>{reads++;throw Error('no_read');}}},{},10000);
  const node={id:'CHECK',type:'condition/google_review_check',config:{list_id:1,item_id:2},outputs:{on_found:'END',on_not_detected:'REMIND',on_unknown:'STOP'}};
  for(const [state,next]of [['found','END'],['not_detected','REMIND'],['unknown','STOP'],['invalid','STOP']]){
    const r=await engine._processNode(node,{simulation_inputs:{google_review_publication:state}},{simulation:true,execution:{clinic_id:59}});
    assert.equal(r.next_node_id,next);assert.equal(r.output.simulated,true);
  }
  assert.equal(reads,0);
});
test('a failed local check is contained in the unknown branch, not a global reception or AI error',async()=>{
  const engine=loadSource('flowEngineV2.service',{'../../models':{},'./jobRequests.service':{getCurrentRuntimeNamespace:()=> 'test'},'./marketingBulkSends.service':{getGoogleReviewPublicationState:async()=>{throw Error('temporary_local_failure');}}},{},10000);
  const r=await engine._processNode({id:'CHECK',type:'condition/google_review_check',config:{list_id:1,item_id:2},outputs:{on_unknown:'STOP'}},{},{execution:{clinic_id:59}});
  assert.equal(r.next_node_id,'STOP');assert.equal(r.output.reason,'local_review_check_unavailable');
});
