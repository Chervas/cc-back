#!/usr/bin/env node
'use strict';

// Debug: list adsets with CPL growth >= threshold vs previous equal window
// Usage: node src/scripts/debug_cpl_growth.js <clinicaId> [days=7] [growth=0.3]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

function fmt(d) { const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }

async function main() {
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const days = parseInt(process.argv[3] || '7', 10);
  const growth = parseFloat(process.argv[4] || '0.3');
  const accs = await db.ClinicMetaAsset.findAll({ where: { clinicaId, isActive: true, assetType: 'ad_account' }, raw: true });
  if (!accs.length) { console.error('No ad_account for clinic', clinicaId); process.exit(2); }
  const accIds = accs.map(a => a.metaAssetId);
  const e = new Date(); e.setHours(0,0,0,0);
  e.setDate(e.getDate()); // today (aligned to DATEONLY)
  const s = new Date(e.getTime() - (days-1)*86400000);
  const pe = new Date(s.getTime() - 86400000);
  const ps = new Date(pe.getTime() - (days-1)*86400000);
  const replacements = { accs: accIds, s: fmt(s), e: fmt(e), ps: fmt(ps), pe: fmt(pe), growthM: 1+growth };
  console.log('Range:', replacements.s, '..', replacements.e, 'Prev:', replacements.ps, '..', replacements.pe);
  try {
    const [rows] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT cur.adset_id as entity_id,
             se.ad_account_id,
             se.name as adset_name, se.entity_id as adset_id,
             camp.name as campaign_name, camp.entity_id as campaign_id,
             CASE WHEN cur.leads>0 THEN cur.spend/cur.leads ELSE NULL END cpl_cur,
             CASE WHEN prev.leads>0 THEN prev.spend/prev.leads ELSE NULL END cpl_prev
      FROM (
        SELECT ad.parent_id AS adset_id, SUM(d.spend) spend, IFNULL(SUM(la.leads),0) leads
        FROM SocialAdsInsightsDaily d
        JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=d.entity_id
        LEFT JOIN (
          SELECT ad2.parent_id AS adset_id, a.date, SUM(a.value) AS leads
          FROM SocialAdsActionsDaily a
          JOIN SocialAdsEntities ad2 ON ad2.level='ad' AND ad2.entity_id=a.entity_id
          WHERE (
               a.action_type IN ('lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_form','leadgen.other','onsite_conversion.lead_grouped')
               OR a.action_type LIKE '%add_meta_leads%'
          )
          GROUP BY ad2.parent_id, a.date
        ) la ON la.adset_id=ad.parent_id AND la.date=d.date
        WHERE d.ad_account_id IN (:accs) AND d.level='ad' AND d.date BETWEEN :s AND :e
        GROUP BY ad.parent_id
      ) cur
      LEFT JOIN (
        SELECT ad.parent_id AS adset_id, SUM(d.spend) spend, IFNULL(SUM(la.leads),0) leads
        FROM SocialAdsInsightsDaily d
        JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=d.entity_id
        LEFT JOIN (
          SELECT ad2.parent_id AS adset_id, a.date, SUM(a.value) AS leads
          FROM SocialAdsActionsDaily a
          JOIN SocialAdsEntities ad2 ON ad2.level='ad' AND ad2.entity_id=a.entity_id
          WHERE (
               a.action_type IN ('lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_form','leadgen.other','onsite_conversion.lead_grouped')
               OR a.action_type LIKE '%add_meta_leads%'
          )
          GROUP BY ad2.parent_id, a.date
        ) la ON la.adset_id=ad.parent_id AND la.date=d.date
        WHERE d.ad_account_id IN (:accs) AND d.level='ad' AND d.date BETWEEN :ps AND :pe
        GROUP BY ad.parent_id
      ) prev ON prev.adset_id=cur.adset_id
      LEFT JOIN SocialAdsEntities se ON se.entity_id=cur.adset_id
      LEFT JOIN SocialAdsEntities camp ON camp.entity_id=se.parent_id
      WHERE cur.leads>0 AND prev.leads>0 AND (cur.spend/cur.leads) >= :growthM * (prev.spend/prev.leads)
      ORDER BY (cur.spend/cur.leads) DESC
      LIMIT 50;`, { replacements });
    console.log('CPL growth items:', rows);
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });

