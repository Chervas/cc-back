#!/usr/bin/env node
'use strict';

// Dump coverage for an adset: insights (spend/impressions) and actions by date/action_type
// Usage: node src/scripts/dump_adset_coverage.js <adset_id> [daysBack]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const adsetId = String(process.argv[2] || '').trim();
  const daysBack = parseInt(process.argv[3] || '7', 10);
  if (!adsetId) { console.error('Usage: node src/scripts/dump_adset_coverage.js <adset_id> [daysBack]'); process.exit(1); }
  const end = new Date(); end.setHours(0,0,0,0);
  const start = new Date(end); start.setDate(start.getDate() - (daysBack-1));

  console.log(`Adset: ${adsetId} | Range: ${fmt(start)}..${fmt(end)}`);

  try {
    // Child ads
    const ads = await db.SocialAdsEntity.findAll({ where: { level: 'ad', parent_id: adsetId }, raw: true });
    console.log('Child ads:', ads.map(a => ({ ad_id: a.entity_id, status: a.status, eff: a.effective_status })).slice(0, 50));

    // Insights by date (ad -> adset)
    const [ins] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT d.date, SUM(d.spend) spend, SUM(d.impressions) impressions, SUM(d.reach) reach
      FROM SocialAdsInsightsDaily d
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=d.entity_id
      WHERE ad.parent_id=:adset AND d.level='ad' AND d.date BETWEEN :s AND :e
      GROUP BY d.date
      ORDER BY d.date;
    `, { replacements: { adset: adsetId, s: fmt(start), e: fmt(end) } });
    console.log('Insights (ad->adset) by date:', ins);

    // Actions by date/action_type
    const [acts] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT a.date, a.action_type, a.action_destination, SUM(a.value) leads
      FROM SocialAdsActionsDaily a
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=a.entity_id
      WHERE ad.parent_id=:adset AND a.date BETWEEN :s AND :e
      GROUP BY a.date, a.action_type, a.action_destination
      ORDER BY a.date, leads DESC;
    `, { replacements: { adset: adsetId, s: fmt(start), e: fmt(end) } });
    console.log('Actions (all types) by date/type:', acts);

    // Distinct action types in range
    const [types] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT a.action_type, COUNT(*) cnt, SUM(a.value) total
      FROM SocialAdsActionsDaily a
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=a.entity_id
      WHERE ad.parent_id=:adset AND a.date BETWEEN :s AND :e
      GROUP BY a.action_type
      ORDER BY total DESC, cnt DESC
      LIMIT 100;
    `, { replacements: { adset: adsetId, s: fmt(start), e: fmt(end) } });
    console.log('Distinct action_types in range:', types);

    // Per active ad detail (last 7 days)
    const activeAds = ads.filter(a => String(a.effective_status||'').toUpperCase().startsWith('ACTIVE')).map(a => a.entity_id).slice(0, 5);
    for (const adId of activeAds) {
      const [adIns] = await db.SocialAdsInsightsDaily.sequelize.query(`
        SELECT date, impressions, reach, clicks, inline_link_clicks, spend
        FROM SocialAdsInsightsDaily
        WHERE entity_id=:ad AND level='ad' AND date BETWEEN :s AND :e
        ORDER BY date;
      `, { replacements: { ad: adId, s: fmt(start), e: fmt(end) } });
      const [adActs] = await db.SocialAdsInsightsDaily.sequelize.query(`
        SELECT date, action_type, action_destination, SUM(value) value
        FROM SocialAdsActionsDaily
        WHERE entity_id=:ad AND date BETWEEN :s AND :e
        GROUP BY date, action_type, action_destination
        ORDER BY date;
      `, { replacements: { ad: adId, s: fmt(start), e: fmt(end) } });
      const [[adInsRange] = []] = await db.SocialAdsInsightsDaily.sequelize.query(`
        SELECT MIN(date) min_date, MAX(date) max_date, COUNT(*) cnt
        FROM SocialAdsInsightsDaily WHERE entity_id=:ad AND level='ad';
      `, { replacements: { ad: adId } });
      const [[adActRange] = []] = await db.SocialAdsInsightsDaily.sequelize.query(`
        SELECT MIN(date) min_date, MAX(date) max_date, COUNT(*) cnt
        FROM SocialAdsActionsDaily WHERE entity_id=:ad;
      `, { replacements: { ad: adId } });
      console.log(`-- Ad ${adId} insights:`, adIns);
      console.log(`-- Ad ${adId} actions:`, adActs);
      console.log(`-- Ad ${adId} insights range:`, adInsRange, 'actions range:', adActRange);
    }
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
