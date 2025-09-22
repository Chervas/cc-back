#!/usr/bin/env node
'use strict';

// Find ads with MAX(frequency) > 3 for a clinic's ad accounts
// Usage: node src/scripts/find_ads_freq_gt3.js <clinicaId> [threshold]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const threshold = parseFloat(process.argv[3] || '3');
  if (!Number.isFinite(clinicaId)) {
    console.error('Usage: node src/scripts/find_ads_freq_gt3.js <clinicaId> [threshold]');
    process.exit(1);
  }
  try {
    const adAccounts = await db.ClinicMetaAsset.findAll({ where: { clinicaId, isActive: true, assetType: 'ad_account' }, raw: true });
    if (!adAccounts.length) {
      console.log(`No ad accounts for clinic ${clinicaId}`);
      return;
    }
    const ids = adAccounts.map(a => (String(a.metaAssetId).startsWith('act_') ? a.metaAssetId : `act_${a.metaAssetId}`));
    console.log(`Ad accounts for clinic ${clinicaId}:`, ids.join(', '));
    const notInactive = (alias) => `UPPER(IFNULL(${alias}.status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE') AND UPPER(IFNULL(${alias}.effective_status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')`;
    const [rows] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT se.ad_account_id,
             se.name AS ad_name,
             se.entity_id AS ad_id,
             MAX(d.frequency) AS max_freq,
             COUNT(*) AS points
      FROM SocialAdsInsightsDaily d
      JOIN SocialAdsEntities se ON se.entity_id = d.entity_id
      WHERE d.level='ad' AND se.ad_account_id IN (:accs)
        AND ${notInactive('se')}
      GROUP BY se.ad_account_id, se.name, se.entity_id
      HAVING MAX(d.frequency) > :thr
      ORDER BY max_freq DESC
      LIMIT 50;`, { replacements: { accs: ids, thr: threshold } });

    if (!rows.length) {
      console.log(`No ads found with MAX(frequency) > ${threshold}`);
    } else {
      console.log(`Found ${rows.length} ads with MAX(frequency) > ${threshold}`);
      rows.forEach(r => console.log(`${r.ad_account_id} | ${r.ad_id} | ${Number(r.max_freq).toFixed(2)} | ${r.ad_name}`));
    }
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

