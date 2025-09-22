#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

function fmt(d) { return d.toISOString().slice(0,10); }

(async function(){
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const thr = parseFloat(process.argv[3] || '10');
  const acc = await db.ClinicMetaAsset.findOne({ where: { clinicaId, isActive: true, assetType: 'ad_account' }, raw: true });
  if (!acc) { console.error('No ad_account for clinic', clinicaId); process.exit(2); }
  const adAccountId = String(acc.metaAssetId).startsWith('act_') ? acc.metaAssetId : ;
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(yest.getDate()-1);
  const y = fmt(yest), t = fmt(today);

  const [rows] = await db.SocialAdsInsightsDaily.sequelize.query(, { replacements: { acc: adAccountId, y, t, thr } });

  console.log();
  if (!rows.length) console.log('No items'); else rows.forEach(r => console.log(r));
  await db.sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
