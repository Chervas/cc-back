'use strict';const assert=require('node:assert/strict'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture'),{loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
withIsolatedCampaignMysql(async({sql,models,report})=>{
 models.sequelize=sql;models.Sequelize=S;
 for(const[name,file]of [['MarketingPatientList','marketingpatientlist'],['MarketingPatientListItem','marketingpatientlistitem'],['MarketingPatientContactEvent','marketingpatientcontactevent'],['BusinessProfileReview','businessprofilereview']]){models[name]=require('../../../models/'+file)(sql,S.DataTypes);await models[name].sync();}
 await sql.query('CREATE TABLE Pacientes (id_paciente INT PRIMARY KEY,nombre VARCHAR(100),apellidos VARCHAR(100))');
 await sql.query("INSERT INTO Pacientes VALUES(1,'TESTONLY Clara','Aurora'),(2,'TESTONLY Bruno','Brisa'),(3,'TESTONLY Clara','Aurora'),(4,'TESTONLY Clara','Aurora'),(5,'TESTONLY Clara','Aurora')");
 await models.MarketingPatientList.bulkCreate([{id:1,name:'TESTONLY own',clinica_id:31,objective_id:'mass_sends',criteria:{review_request:true}},{id:2,name:'TESTONLY foreign',clinica_id:32,objective_id:'mass_sends',criteria:{review_request:true}}]);
 await models.MarketingPatientListItem.bulkCreate([1,2,3,4].map(id=>({id,list_id:1,clinica_id:31,paciente_id:id,name:id===2?'TESTONLY Bruno Brisa':'TESTONLY Clara Aurora'})).concat([{id:5,list_id:2,clinica_id:32,paciente_id:5,name:'TESTONLY Clara Aurora'}]));
 const events=models.MarketingPatientContactEvent;
 const link=(item,at,status='sent',extra={})=>events.create({list_id:item===5?2:1,item_id:item,paciente_id:item,event_type:'review_rating_followup_sent',channel:'whatsapp',payload:{kind:'review_google_link_followup',status,...extra},occurred_at:new Date(at)});
 await link(1,'2026-10-30T08:00:00Z');await events.bulkCreate(Array.from({length:150},()=>({list_id:1,item_id:2,paciente_id:2,event_type:'review_rating_followup_sent',channel:'whatsapp',payload:{kind:'review_google_link_followup',status:'sent'},occurred_at:new Date('2026-10-30T09:00:00Z')})));
 const review=id=>models.BusinessProfileReview.create({id,clinica_id:31,business_location_id:11,review_name:'TESTONLY/reviews/'+id,reviewer_name:'TESTONLY Clara Aurora',star_rating:5,create_time:new Date('2026-10-30T10:00:00Z')});
 const matcher=loadSource('googleReviewMatch.service',{'../../models':models,'./jobRequests.service':{}},{});
 await review(1);const result=await matcher.matchBusinessProfileReview(1);assert(result.matched);assert.equal(result.paciente_id,1);assert.equal(await events.count({where:{event_type:'google_review_matched'}}),1);
 report.checks.push('a true candidate older than 150 unrelated link events remains eligible within the same 48h/profile/clinic window');
 await link(3,'2026-10-30T09:30:00Z');await review(2);const ambiguous=await matcher.matchBusinessProfileReview(2);assert.equal(ambiguous.reason,'ambiguous_candidate');assert.equal((await models.BusinessProfileReview.findByPk(2)).matched_paciente_id,null);
 await events.create({list_id:1,item_id:3,paciente_id:3,event_type:'mass_campaign_test_sent',channel:'whatsapp',payload:{},occurred_at:new Date('2026-10-30T09:00:00Z')});await link(4,'2026-10-30T09:30:00Z','failed');await link(5,'2026-10-30T09:45:00Z');
 await review(3);assert.equal((await matcher.matchBusinessProfileReview(3)).paciente_id,1);
 await review(4);const parallel=await Promise.all([matcher.matchBusinessProfileReview(4),matcher.matchBusinessProfileReview(4)]);assert.equal(parallel.filter(r=>r.matched===true).length,1);assert.equal(parallel.filter(r=>r.reason==='already_matched').length,1);assert.equal(await events.count({where:{event_type:'google_review_matched'}}),3);
 report.checks.push('distinct patient ties stay unassigned; test/failed links and sibling clinics are excluded; concurrent same-review jobs create one audited receipt');
 const old=await review(5);await old.update({create_time:new Date('2023-01-01T00:00:00Z'),update_time:new Date('2026-10-30T10:00:00Z')});assert.equal((await matcher.matchBusinessProfileReview(5)).reason,'no_candidate');
 await events.bulkCreate(Array.from({length:1000},()=>({list_id:1,item_id:2,paciente_id:2,event_type:'review_rating_followup_sent',channel:'whatsapp',payload:{kind:'review_google_link_followup',status:'sent'},occurred_at:new Date('2026-10-30T09:00:00Z')})));await review(6);assert.equal((await matcher.matchBusinessProfileReview(6)).reason,'candidate_limit');assert.equal((await models.BusinessProfileReview.findByPk(6)).matched_paciente_id,null);
 report.checks.push('old publication time is authoritative; overflow is explicit and never silently picks from a truncated pool');
 report.coverage={providerRequests:0,realPatients:0,dataWrittenOnlyToOwnedFixture:true};
}).catch(e=>{console.error(e.stack);process.exitCode=1;});
