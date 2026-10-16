'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { readReport } = require('../../services/reviewActivityReport.service');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = S;
  await sql.query('CREATE TABLE MarketingPatientLists (id INT PRIMARY KEY,clinica_id INT,objective_id VARCHAR(32),criteria JSON)');
  await sql.query('CREATE TABLE MarketingPatientListItems (id INT PRIMARY KEY,list_id INT,clinica_id INT,sent_at DATETIME)');
  await sql.query(`CREATE TABLE MarketingPatientContactEvents (id INT AUTO_INCREMENT PRIMARY KEY,list_id INT,item_id INT,
    event_type VARCHAR(64),occurred_at DATETIME,created_at DATETIME,payload JSON)`);
  await sql.query(`CREATE TABLE BusinessProfileReviews (id INT AUTO_INCREMENT PRIMARY KEY,clinica_id INT,business_location_id INT,
    review_name VARCHAR(255) COLLATE utf8mb4_bin,create_time DATETIME,first_seen_at DATETIME,created_at DATETIME,last_seen_at DATETIME,google_missing_at DATETIME)`);
  await sql.query(`INSERT INTO MarketingPatientLists VALUES (1,59,'mass_sends',JSON_OBJECT('review_request',true)),
    (2,66,'mass_sends',JSON_OBJECT('template_usage','solicitud_resena')),(3,59,'other',JSON_OBJECT())`);
  await sql.query(`INSERT INTO MarketingPatientListItems VALUES
    (1,1,59,'2026-10-14 22:30:00'),(2,1,NULL,'2026-10-15 22:30:00'),(3,1,59,'2026-10-16 10:00:00'),
    (4,2,66,'2026-10-16 10:00:00'),(5,3,59,'2026-10-16 10:00:00'),(6,1,66,'2026-10-16 10:00:00'),(7,2,59,NULL)`);
  const event = (type, item, list, at, payload) => sql.query(`INSERT INTO MarketingPatientContactEvents
    (event_type,item_id,list_id,occurred_at,created_at,payload) VALUES (:type,:item,:list,:at,:at,:payload)`,
    { replacements: { type, item, list, at, payload: JSON.stringify(payload) } });
  await event('mass_campaign_test_sent',3,1,'2026-10-16 10:00:00',{});
  for (const [type, item, list, rating] of [['review_rating_received',1,1,5],['review_request_rating',1,1,4],
    ['review_rating_received',2,1,0],['review_rating_received',3,1,5],['review_rating_received',4,2,5]]) {
    await event(type,item,list,'2026-10-15 22:30:00',{rating});
  }
  for (const [status, item] of [['sent',1],['failed',2],['sent',3]]) await event('review_rating_followup_sent',item,1,
    '2026-10-15 22:30:00',{ kind:'review_google_link_followup',status });
  const match = (name,item=1,list=1,location=11) => event('google_review_matched',item,list,'2026-10-15 22:30:00',{
    review_name:name,business_location_id:location,confidence:0.9 });
  await match('accounts/a/reviews/linked'); await match('linked'); await match('lost');
  await match('test',3); await match('foreign',4,2,12); await match('elsewhere',1,1,99);
  await match('other-flow',5,3); // Existing non-campaign matches still attribute the Google inventory.
  for (const [name,missing,create,location=11,clinic=59] of [
    ['linked',null,'2026-10-15 22:30:00'],['organic','2026-10-16 09:00:00','2026-10-14 22:30:00'],
    ['first-observed',null,null],['test',null,'2026-10-16 10:00:00'],['other-flow',null,'2026-10-16 10:00:00'],
    ['foreign',null,'2026-10-16 10:00:00',12,66],['accounts/a/reviews/linked','2026-10-16 10:00:00','2026-10-15 22:30:00'],
  ]) await sql.query(`INSERT INTO BusinessProfileReviews (clinica_id,business_location_id,review_name,create_time,first_seen_at,created_at,last_seen_at,google_missing_at)
    VALUES (:clinic,:location,:name,:create,'2026-10-16 10:00:00','2026-10-16 10:00:00','2026-10-16 10:00:00',:missing)`,
    {replacements:{clinic,location,name,create,missing}});
  const options = {clinicIds:[59],locationIds:[11],period:'2d',now:new Date('2026-10-16T12:00:00Z')};
  const result = await readReport(models,options);
  assert.deepEqual(result.totals,{requests_sent:2,google_links_sent:1,google_reviews_total:6,
    google_reviews_attributed:3,google_reviews_unattributed:3,google_reviews_missing:1});
  assert.equal(result.quality.missing_without_date,1); assert.equal(result.quality.reviews_with_observation_date,1);
  assert.equal(result.heatmaps.responses.all.total,1);
  assert.equal(result.heatmaps.responses.summer.series[4].data[0].y,1);
  assert.deepEqual(result.series[0].data,[{x:'2026-10-15',y:1},{x:'2026-10-16',y:1}]);
  report.checks.push('Madrid daily requests/links/ratings; test and cross-clinic exclusion; organic versus matched; dedup aliases; missing dates not invented');
  const group = await readReport(models,{...options,clinicIds:[59,66],locationIds:[11,12]});
  assert.equal(group.totals.requests_sent,4); assert.equal(group.totals.google_reviews_total,7);
  assert.equal(group.totals.google_reviews_attributed,4);
  const reappeared = await sql.query("UPDATE BusinessProfileReviews SET google_missing_at=NULL WHERE review_name='organic'");
  assert(reappeared); assert.equal((await readReport(models,options)).totals.google_reviews_missing,0);
  await assert.rejects(readReport(models,{...options,period:'all'}),{status:400});
  report.checks.push('group is the union of allowed clinics; reappearance clears current absence without fabricating historical events; bounded periods');
}).catch(error => {console.error(error);process.exitCode=1;});
