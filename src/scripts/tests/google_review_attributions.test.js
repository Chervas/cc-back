'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const history=require('../../services/googleReviewHistory.service');
test('attribution read model is bounded, scoped, receipt based and database only',async()=>{
 const reads=[];const db={Sequelize:{QueryTypes:{SELECT:'SELECT'}},sequelize:{query:async(sql,options)=>{
  assert(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql));
  assert(sql.includes("e.event_type='google_review_matched'"));assert(sql.includes("l.objective_id='mass_sends'"));
  assert(sql.includes('mass_campaign_test_sent'));assert.deepEqual(options.replacements.clinicIds,[59]);
  reads.push(sql);return sql.includes('undated_total')?[{total:2,undated_total:1}]:[
   {attribution_id:'7',clinic_id:'59',star_rating:'5',match_confidence:'0.8',google_state:'visible'},
   {attribution_id:'8',clinic_id:'59',star_rating:'0',match_confidence:null,google_state:'unobserved'}];
 }}};
 const result=await history.listAttributedReviews(db,{clinicIds:[59],limit:999,offset:-1});
 assert.equal(reads.length,2);assert.equal(result.limit,50);assert.equal(result.offset,0);
 assert.equal(result.total,2);assert.equal(result.items[0].match_confidence,0.8);assert.equal(result.items[1].star_rating,null);
});
test('empty scope never reads and invalid filters/sorts are rejected before SQL',async()=>{
 const db={sequelize:{query:()=>{throw Error('NO_READ');}}};
 assert.equal((await history.listAttributedReviews(db,{clinicIds:[]})).total,0);
 for(const args of [{state:'__proto__'},{sort_by:'published; DROP TABLE'},{sort_direction:'DESC'},{period:'bad'}]){
  await assert.rejects(history.listAttributedReviews(db,{clinicIds:[59],...args}),{status:400});
 }
});
