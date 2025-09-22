#!/usr/bin/env node
'use strict';

// List AdSets with CPL > threshold in the last 48h for a clinic's ad account
// Usage: node src/scripts/check_cpl_over_10_48h.js <clinicaId> [threshold]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const threshold = parseFloat(process.argv[3] || (process.env.ADS_HEALTH_CPL_MAX || '10'));
  const acc = await db.ClinicMetaAsset.findOne({ where: { clinicaId, isActive: true, assetType: 'ad_account' }, raw: true });
  if (!acc) { console.log('No ad account for clinic', clinicaId); return; }
  const adAccountId = String(acc.metaAssetId).startsWith('act_') ? acc.metaAssetId : `act_${acc.metaAssetId}`;
  const [rows] = await db.SocialAdsInsightsDaily.sequelize.query(`
    SELECT cur.adset_id as entity_id,
           se.ad_account_id,
           se.name as adset_name,
           CASE WHEN cur.leads>0 THEN cur.spend/cur.leads ELSE NULL END cpl,
           cur.spend, cur.leads
    FROM (
      SELECT ad.parent_id AS adset_id, SUM(d.spend) spend, IFNULL(SUM(la.leads),0) leads
      FROM SocialAdsInsightsDaily d
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=d.entity_id
      LEFT JOIN (
        SELECT ad2.parent_id AS adset_id, a.date, SUM(a.value) AS leads
        FROM SocialAdsActionsDaily a
        JOIN SocialAdsEntities ad2 ON ad2.level='ad' AND ad2.entity_id=a.entity_id
        WHERE (
            a.action_type IN (
                'lead',
                'offsite_conversion.fb_pixel_lead',
                'onsite_conversion.lead_form',
                'leadgen.other',
                'onsite_conversion.lead_grouped'
            )
            OR a.action_type LIKE '%add_meta_leads%'
        )
        GROUP BY ad2.parent_id, a.date
      ) la ON la.adset_id=ad.parent_id AND la.date=d.date
      WHERE d.ad_account_id = :acc AND d.level='ad' AND d.date BETWEEN DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND CURDATE()
      GROUP BY ad.parent_id
    ) cur
    LEFT JOIN SocialAdsEntities se ON se.entity_id=cur.adset_id
    WHERE cur.leads>0 AND (cur.spend/cur.leads) > :thr
      AND UPPER(IFNULL(se.status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')
      AND UPPER(IFNULL(se.effective_status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')
    ORDER BY cpl DESC
    LIMIT 50;
  `, { replacements: { acc: adAccountId, thr: threshold } });
  if (!rows.length) {
    console.log(`No hay adsets con CPL > ${threshold} en últimas 48h para ${adAccountId}`);
  } else {
    console.log(`Adsets con CPL > ${threshold} (últimas 48h):`);
    rows.forEach(r => console.log(`${r.entity_id} | CPL=${Number(r.cpl).toFixed(2)} | spend=${r.spend} | leads=${r.leads} | ${r.adset_name}`));
  }
  await db.sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
