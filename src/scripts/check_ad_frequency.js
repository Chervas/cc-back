#!/usr/bin/env node
'use strict';

// Check a single Ad (entity_id) frequency in DB and summarize
// Usage: node src/scripts/check_ad_frequency.js <ad_id> [threshold]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const adId = String(process.argv[2] || '').trim();
  const threshold = parseFloat(process.argv[3] || '3');
  if (!adId) {
    console.error('Usage: node src/scripts/check_ad_frequency.js <ad_id> [threshold]');
    process.exit(1);
  }

  try {
    // Fetch entity info
    const ent = await db.SocialAdsEntity.findOne({ where: { level: 'ad', entity_id: adId }, raw: true });
    if (!ent) {
      console.log(`No SocialAdsEntity found for ad_id=${adId}`);
    } else {
      console.log('Entity:', {
        ad_account_id: ent.ad_account_id,
        ad_id: ent.entity_id,
        name: ent.name,
        status: ent.status,
        effective_status: ent.effective_status,
        updated_time: ent.updated_time
      });
    }

    // Summarize insights
    const [sum] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT COUNT(*) AS points,
             MAX(frequency) AS max_freq,
             MIN(date) AS since,
             MAX(date) AS until,
             SUM(impressions) AS impressions,
             SUM(reach) AS reach
      FROM SocialAdsInsightsDaily
      WHERE level='ad' AND entity_id = :ad
    `, { replacements: { ad: adId } });
    const agg = sum && sum[0] ? sum[0] : {};
    console.log('Aggregate:', {
      points: Number(agg.points||0),
      max_freq: agg.max_freq != null ? Number(agg.max_freq).toFixed(3) : null,
      since: agg.since || null,
      until: agg.until || null,
      impressions: Number(agg.impressions||0),
      reach: Number(agg.reach||0)
    });

    // Top rows by frequency
    const [rows] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT date, frequency, impressions, reach
      FROM SocialAdsInsightsDaily
      WHERE level='ad' AND entity_id = :ad
      ORDER BY frequency DESC, date DESC
      LIMIT 10;
    `, { replacements: { ad: adId } });
    console.log('Top by frequency (date, freq, impr, reach):');
    rows.forEach(r => console.log(`${r.date} | ${Number(r.frequency||0).toFixed(3)} | ${r.impressions} | ${r.reach}`));

    // Flag if threshold exceeded
    const maxFreq = agg.max_freq != null ? Number(agg.max_freq) : 0;
    if (maxFreq > threshold) {
      console.log(`Result: EXCEEDS threshold ${threshold}`);
    } else {
      console.log(`Result: does NOT exceed threshold ${threshold}`);
    }
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

