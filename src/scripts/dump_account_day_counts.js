#!/usr/bin/env node
'use strict';

// Dump counts of insights/actions for a clinic's ad account on a given day
// Usage: node src/scripts/dump_account_day_counts.js <clinicaId> [yyyy-mm-dd]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const day = (process.argv[3] || new Date(Date.now()-24*3600*1000).toISOString().slice(0,10));
  const acc = await db.ClinicMetaAsset.findOne({ where: { clinicaId, isActive: true, assetType: 'ad_account' }, raw: true });
  if (!acc) { console.error('No ad_account for clinic', clinicaId); process.exit(2); }
  const adAccountId = String(acc.metaAssetId).startsWith('act_') ? acc.metaAssetId : `act_${acc.metaAssetId}`;
  console.log(`Account: ${adAccountId} | Day: ${day}`);

  try {
    const [ins] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT level, COUNT(*) cnt, SUM(spend) spend, SUM(impressions) impressions
      FROM SocialAdsInsightsDaily
      WHERE ad_account_id=:acc AND date=:day
      GROUP BY level
      ORDER BY FIELD(level,'ad','adset','campaign');
    `, { replacements: { acc: adAccountId, day } });
    console.log('Insights rows by level:', ins);

  const [acts] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT a.action_type, COUNT(*) cnt, SUM(a.value) total
      FROM SocialAdsActionsDaily a
      WHERE a.ad_account_id=:acc AND a.date=:day
      GROUP BY a.action_type
      ORDER BY total DESC, cnt DESC
      LIMIT 50;
  `, { replacements: { acc: adAccountId, day } });
  console.log('Actions by type (all):', acts);

    const [topAds] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT d.entity_id as ad_id, SUM(d.spend) spend, SUM(d.impressions) impressions,
             ad.parent_id as adset_id, ad.name as ad_name
      FROM SocialAdsInsightsDaily d
      LEFT JOIN SocialAdsEntities ad ON ad.entity_id=d.entity_id AND ad.level='ad'
      WHERE d.ad_account_id=:acc AND d.level='ad' AND d.date=:day
      GROUP BY d.entity_id, ad.parent_id, ad.name
      ORDER BY spend DESC
      LIMIT 30;
    `, { replacements: { acc: adAccountId, day } });
    console.log('Top ads by spend (with adset_id):', topAds);
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
