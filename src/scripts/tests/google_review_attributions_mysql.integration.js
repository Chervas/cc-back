'use strict';
const assert=require('node:assert/strict'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const history=require('../../services/googleReviewHistory.service');
withIsolatedCampaignMysql(async({sql,models,report})=>{
 models.sequelize=sql;models.Sequelize=S;
 for(const [name,file] of [['MarketingPatientList','marketingpatientlist'],['MarketingPatientListItem','marketingpatientlistitem'],
  ['MarketingPatientContactEvent','marketingpatientcontactevent'],['BusinessProfileReview','businessprofilereview']]){
  models[name]=require('../../../models/'+file)(sql,S.DataTypes);await models[name].sync();
 }
 await sql.query('CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY,nombre VARCHAR(100),apellidos VARCHAR(100))');
 await sql.query("INSERT INTO Pacientes VALUES (1,'TESTONLY Ana','Prueba Compuesta'),(2,'TESTONLY Other','Clinic')");
 await models.MarketingPatientList.bulkCreate([
  {id:1,name:'TESTONLY own',clinica_id:59,objective_id:'mass_sends',criteria:{review_request:true}},
  {id:2,name:'TESTONLY other',clinica_id:66,objective_id:'mass_sends',criteria:{review_request:true}},
  {id:3,name:'TESTONLY unrelated',clinica_id:59,objective_id:'other'},
 ]);
 await models.MarketingPatientListItem.bulkCreate([
  {id:1,list_id:1,clinica_id:59,paciente_id:1,name:'TESTONLY Ana Prueba Compuesta'},
  {id:2,list_id:1,clinica_id:59,paciente_id:1,name:'TESTONLY sample'},
  {id:3,list_id:2,clinica_id:66,paciente_id:2,name:'TESTONLY other'},
  {id:4,list_id:3,clinica_id:59,paciente_id:1,name:'TESTONLY unrelated'},
 ]);
 const event=(type,item=1,list=1,payload={},at='2026-10-19T08:00:00Z')=>models.MarketingPatientContactEvent.create({
  list_id:list,item_id:item,paciente_id:item===3?2:1,event_type:type,channel:type==='google_review_matched'?'google':'whatsapp',
  payload,occurred_at:new Date(at),created_at:new Date(at)});
 const link=await event('review_rating_followup_sent',1,1,{kind:'review_google_link_followup',status:'sent'});
 const old=await models.BusinessProfileReview.create({id:1,clinica_id:59,business_location_id:11,review_name:'old',
  reviewer_name:'TESTONLY Ana Prueba',star_rating:5,create_time:new Date('2023-02-01T19:00:00Z'),update_time:new Date('2026-10-19T09:00:00Z')});
 const matcher=loadSource('googleReviewMatch.service',{'../../models':models,'./jobRequests.service':{}},{});
 assert(matcher.scoreNameMatch(old.reviewer_name,'TESTONLY Ana Prueba Compuesta')>=0.8);
 const match=await matcher.matchBusinessProfileReview(old.id);assert.equal(match.matched,false);assert.equal(match.reason,'no_candidate');
 await old.reload();assert.equal(old.matched_contact_event_id,null);
 report.checks.push('The unchanged native matcher rejects a pre-link 2023 review despite a compatible patient name and 2026 update/link; no attribution is fabricated.');
 const receipt=(name,item=1,list=1,location=11,confidence=0.9,published='2026-10-20T09:00:00Z')=>event('google_review_matched',item,list,{
  review_name:name,reviewer_name:'TESTONLY '+name,star_rating:5,business_location_id:location,confidence,
  followup_event_id:link.id,review_create_time:published});
 const observed=async(name,missing=false,location=11,clinic=59)=>models.BusinessProfileReview.create({clinica_id:clinic,
  business_location_id:location,review_name:name,reviewer_name:'TESTONLY '+name,star_rating:5,
  create_time:new Date('2026-10-20T09:00:00Z'),google_missing_at:missing?new Date('2026-10-21T03:00:00Z'):null});
 await receipt('accounts/a/reviews/linked');await receipt('linked');await observed('linked');
 await observed('accounts/a/reviews/linked',true);
 await receipt('missing');await observed('missing',true);
 await receipt('not-in-cache',1,1,11,'invalid',null);
 await receipt('case');await observed('case');await receipt('CASE');
 await receipt('foreign',3,2,12);await observed('foreign',false,12,66);
 await receipt('test',2);await observed('test');await event('mass_campaign_test_sent',2);
 await receipt('unrelated',4,3);await observed('unrelated');
 await observed('organic-no-receipt');
 await event('google_review_matched',1,1,{review_name:'incomplete-no-profile',reviewer_name:'TESTONLY incomplete'});
 const baseline=JSON.stringify(await models.MarketingPatientContactEvent.findAll({raw:true,order:[['id','ASC']]}));
 const args={clinicIds:[59],limit:50};const page=await history.listAttributedReviews(models,args);
 assert.equal(page.total,5);assert.equal(page.total,await history.countHistoricalMatches(models,[59]));
 assert.equal(page.items.filter(r=>r.google_state==='visible').length,2);
 assert.equal(page.items.filter(r=>r.google_state==='missing').length,1);
 assert.equal(page.items.filter(r=>r.google_state==='unobserved').length,2);
 assert(!page.items.some(r=>['TESTONLY old','TESTONLY organic-no-receipt','TESTONLY unrelated','TESTONLY test','TESTONLY foreign'].includes(r.reviewer_name)));
 assert.equal(page.items.find(r=>r.reviewer_name==='TESTONLY not-in-cache').match_confidence,null);
 assert.equal(page.items.find(r=>r.reviewer_name==='TESTONLY not-in-cache').published_at,null);
 assert(page.items.some(r=>r.patient_name==='TESTONLY Ana Prueba Compuesta'));
 assert(page.items.every(r=>r.link_sent_at));
 for(const [state,total] of [['visible',2],['missing',1],['unobserved',2]])assert.equal((await history.listAttributedReviews(models,{...args,state})).total,total);
 const finite=await history.listAttributedReviews(models,{...args,period:'7d',now:new Date('2026-10-22T10:00:00Z')});
 assert.equal(finite.total,4);assert.equal(finite.undated_total,1);
 const group=await history.listAttributedReviews(models,{clinicIds:[59,66]});assert.equal(group.total,6);
 for(const sort_by of ['author','patient','rating','link','published','confidence','state'])for(const sort_direction of ['asc','desc']){
  const full=await history.listAttributedReviews(models,{...args,sort_by,sort_direction});
  const slice=await history.listAttributedReviews(models,{...args,limit:2,offset:2,sort_by,sort_direction});
  assert.deepEqual(slice.items,full.items.slice(2,4));
 }
 assert.equal(JSON.stringify(await models.MarketingPatientContactEvent.findAll({raw:true,order:[['id','ASC']]})),baseline);
 report.checks.push('Receipt-only count equals conversion; duplicate resource names, visible reappearance, missing cache, unknown confidence/date, period/state filters, every sort/page, foreign clinic, tests and unrelated flows; no read-side writes or provider access.');
}).catch(error=>{console.error(error);process.exitCode=1;});
