#!/usr/bin/env node
'use strict';

// Debug: compute CPL (48h) and list actions/spend for a given adset_id
// Usage: node src/scripts/debug_adset_cpl_48h.js <adset_id>

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const adsetId = String(process.argv[2] || '').trim();
  if (!adsetId) { console.error('Usage: node src/scripts/debug_adset_cpl_48h.js <adset_id>'); process.exit(1); }

  try {
    // List child ads and statuses
    const ads = await db.SocialAdsEntity.findAll({ where: { level: 'ad', parent_id: adsetId }, raw: true });
    console.log('Child ads:', ads.map(a => ({ ad_id: a.entity_id, status: a.status, eff: a.effective_status })).slice(0, 20));

    // Spend from insights (ad-level) last 48h aggregated to adset
    const [spRows] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT DATE(d.date) as date, SUM(d.spend) as spend, SUM(d.impressions) as impressions
      FROM SocialAdsInsightsDaily d
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=d.entity_id
      WHERE ad.parent_id=:adset AND d.level='ad' AND d.date BETWEEN DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND CURDATE()
      GROUP BY DATE(d.date)
      ORDER BY DATE(d.date);
    `, { replacements: { adset: adsetId } });
    console.log('Spend/impressions (ad->adset) last 48h by date:', spRows);

    // Leads from actions (ad-level) last 48h aggregated to adset (common action_types)
    const [leadRows] = await db.SocialAdsInsightsDaily.sequelize.query(`
      SELECT a.date, a.action_type, a.action_destination, SUM(a.value) as leads
      FROM SocialAdsActionsDaily a
      JOIN SocialAdsEntities ad ON ad.level='ad' AND ad.entity_id=a.entity_id
      WHERE ad.parent_id=:adset AND a.date BETWEEN DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND CURDATE()
        AND (
            a.action_type IN (
                'lead',
                'offsite_conversion.fb_pixel_lead',
                'onsite_conversion.lead_form',
                'leadgen.other',
                'onsite_conversion.lead_grouped'
            )
            OR a.action_type LIKE '%add_meta_leads%'
        )
      GROUP BY a.date, a.action_type, a.action_destination
      ORDER BY a.date, leads DESC;
    `, { replacements: { adset: adsetId } });
    console.log('Leads (ad->adset) last 48h by date/type:', leadRows);

    // CPL summary (48h)
    const spendTotal = spRows.reduce((s,r)=> s + (Number(r.spend)||0), 0);
    const leadsTotal = leadRows.reduce((s,r)=> s + (Number(r.leads)||0), 0);
    const cpl = leadsTotal>0 ? (spendTotal/leadsTotal) : null;
    console.log('Summary 48h:', { spendTotal, leadsTotal, cpl });
  } finally {
    await db.sequelize.close();
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
