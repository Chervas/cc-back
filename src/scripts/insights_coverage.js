#!/usr/bin/env node
'use strict';

// Show coverage of SocialAdsInsightsDaily for an ad_account (level='ad')
// Usage: node src/scripts/insights_coverage.js <ad_account_id|act_...> [days]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const acc = String(process.argv[2] || '').trim();
  const days = parseInt(process.argv[3] || '60', 10);
  if (!acc) { console.error('Usage: node src/scripts/insights_coverage.js <act_...> [days]'); process.exit(1); }
  try {
    const [agg] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT COUNT(*) c, MIN(date) min_d, MAX(date) max_d
      FROM SocialAdsInsightsDaily
      WHERE ad_account_id=:acc AND level='ad';
    `, { replacements: { acc } });
    console.log('Total rows (level=ad):', agg[0].c, 'range:', agg[0].min_d, '..', agg[0].max_d);

    const [recent] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT date, COUNT(*) rows
      FROM SocialAdsInsightsDaily
      WHERE ad_account_id=:acc AND level='ad'
        AND date >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
      GROUP BY date
      ORDER BY date DESC
      LIMIT :days;
    `, { replacements: { acc, days } });
    console.log(`Rows by date (last ${days} days):`);
    recent.forEach(r => console.log(r.date, r.rows));
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });

