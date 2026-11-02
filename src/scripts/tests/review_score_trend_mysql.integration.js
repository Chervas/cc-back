'use strict';
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { readScoreTrends } = require('../../services/reviewScoreTrend.service');
const { reportRange, previousReportRange } = require('../../services/reviewActivityReport.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  await sql.query(`CREATE TABLE BusinessProfileReviews (id INT AUTO_INCREMENT PRIMARY KEY,business_location_id INT,
    star_rating INT,review_name VARCHAR(255) COLLATE utf8mb4_bin,create_time DATETIME,last_seen_at DATETIME,google_missing_at DATETIME)`);
  const insert = (location, name, rating, at, missing = null) => sql.query(`INSERT INTO BusinessProfileReviews
    (business_location_id,review_name,star_rating,create_time,last_seen_at,google_missing_at) VALUES (:location,:name,:rating,:at,'2026-10-28 10:00:00',:missing)`,
  { replacements: { location, name, rating, at, missing } });
  const range = reportRange('7d',new Date('2026-10-28T12:00:00Z')), previous = previousReportRange(range);
  const options = { locationIds:[11,11,12,13],range,previous };
  const db = { sequelize:sql,Sequelize };
  await insert(11,'old',3,'2026-10-14 22:00:00'); // First previous day in Madrid.
  await insert(11,'last-old',5,'2026-10-21 21:59:59');
  await insert(11,'accounts/a/reviews/first',5,'2026-10-21 22:00:00');
  await insert(11,'first',1,'2026-10-21 22:00:00','2026-10-22 00:00:00'); // Prefer visible duplicate.
  await insert(11,'second',4,'2026-10-28 22:59:59'); // Final current day after DST.
  await insert(11,'tomorrow',1,'2026-10-28 23:00:00');
  await insert(11,'too-old',1,'2026-10-14 21:59:59');
  await insert(11,'unknown-date',1,null);
  await insert(11,'invalid-score',0,'2026-10-25 12:00:00');
  await insert(11,'removed',1,'2026-10-25 12:00:00','2026-10-26 12:00:00');
  await insert(12,'current-only',2,'2026-10-25 12:00:00');
  await insert(99,'outside-scope',1,'2026-10-25 12:00:00');
  const rows = await readScoreTrends(db,options);
  assert.deepEqual(rows,[
    {business_location_id:11,current:4.5,previous:4,current_count:2,previous_count:2,change_points:0.5},
    {business_location_id:12,current:2,previous:null,current_count:1,previous_count:0,change_points:null},
    {business_location_id:13,current:null,previous:null,current_count:0,previous_count:0,change_points:null},
  ]);
  assert.deepEqual(await readScoreTrends({}, {...options,locationIds:[]}),[]);
  report.checks.push('review score periods: scope, shared location, boundaries/DST, deduplication, missing and absent baseline passed');
}).catch(error=>{console.error(error);process.exitCode=1;});
