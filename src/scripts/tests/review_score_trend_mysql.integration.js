'use strict';
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { readScoreTrends, providerScoreSnapshot } = require('../../services/reviewScoreTrend.service');
const { reportRange, previousReportRange } = require('../../services/reviewActivityReport.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  await sql.query(`CREATE TABLE BusinessProfileDailyMetrics (business_location_id INT,date DATE,
    metric_type VARCHAR(64),metric_subtype VARCHAR(64),value INT,
    UNIQUE KEY snapshot (business_location_id,date,metric_type,metric_subtype))`);
  const insert = (location, rating, at, type='GOOGLE_REVIEW_RATING', subtype='global_v1') => sql.query(`INSERT INTO BusinessProfileDailyMetrics
    (business_location_id,date,metric_type,metric_subtype,value) VALUES (:location,:at,:type,:subtype,:value)
    ON DUPLICATE KEY UPDATE value=VALUES(value)`, {replacements:{location,at,type,subtype,value:Math.round(rating*1000000)}});
  const range = reportRange('7d',new Date('2026-10-28T12:00:00Z')), previous = previousReportRange(range);
  const options = { locationIds:[11,11,12,13,14,15,16],range,previous };
  const db = { sequelize:sql,Sequelize };
  await insert(11,4.7,previous.to);await insert(11,4.7,range.to);await insert(11,4.8,range.to);
  await insert(11,1,'2026-10-29'); // Future cannot change this report.
  await insert(12,4.8,range.to); // No historical baseline.
  await insert(14,4.9,previous.to);await insert(14,4.8,range.to);
  await insert(15,4.81,previous.to);await insert(15,4.84,range.to); // Same visible tenth.
  await insert(16,4.8,'2026-10-10');await insert(16,4.9,range.to); // Baseline too old.
  await insert(99,1,range.to);
  await insert(11,1,range.to,'OTHER_METRIC');await insert(11,1,range.to,'GOOGLE_REVIEW_RATING','untrusted_v0');
  const rows = await readScoreTrends(db,options);
  assert.equal(rows.length,6);assert(rows.every(r=>r.basis==='google_global_rating'));
  assert.deepEqual(rows.map(r=>r.direction),['up',null,null,'down','stable',null]);
  assert.equal(rows[0].current,4.8);assert.equal(rows[0].previous,4.7);
  assert.equal(rows[0].current_observed_on,range.to);assert.equal(rows[0].previous_observed_on,previous.to);
  const oneDay=reportRange('month',new Date('2026-11-01T12:00:00Z'));
  await insert(17,4.9,'2026-10-31');
  assert.equal((await readScoreTrends(db,{locationIds:[17],range:oneDay,previous:previousReportRange(oneDay)}))[0].direction,null);
  const snapshot=providerScoreSnapshot({id:11,clinica_id:59},{averageRating:4.85,totalReviewCount:300},new Date('2026-10-28T23:30:00Z'));
  assert.equal(snapshot.date,'2026-10-29');assert.equal(snapshot.value,4850000);
  for(const payload of [{},{averageRating:null,totalReviewCount:2},{averageRating:0,totalReviewCount:0},{averageRating:6,totalReviewCount:10},{averageRating:'4.8',totalReviewCount:2}])
    assert.equal(providerScoreSnapshot({id:11,clinica_id:59},payload),null);
  assert.deepEqual(await readScoreTrends({}, {...options,locationIds:[]}),[]);
  report.checks.push('global score snapshots: scope, shared location, up/down/equal, rounding, absent/stale baseline, future exclusion, no-current observation, Madrid day and invalid provider payload passed');
}).catch(error=>{console.error(error);process.exitCode=1;});
