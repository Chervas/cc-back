#!/usr/bin/env node
'use strict';

// One-off: sync a clinic's ad account for a custom date range via syncAdAccountMetrics
// Usage: node src/scripts/run_sync_account_range.js <clinicaId> <daysBack>

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));
const { syncAdAccountMetrics } = require('../controllers/metasync.controller');

async function main() {
  const clinicaId = parseInt(process.argv[2] || '19', 10);
  const daysBack = parseInt(process.argv[3] || '90', 10);
  const end = new Date(); end.setHours(0,0,0,0); end.setDate(end.getDate()-1);
  const start = new Date(end); start.setDate(start.getDate() - (daysBack-1));

  const asset = await db.ClinicMetaAsset.findOne({
    where: { clinicaId, isActive: true, assetType: 'ad_account' },
    include: [{ model: db.MetaConnection, as: 'metaConnection' }]
  });
  if (!asset) { console.error('No ad_account for clinic', clinicaId); process.exit(2); }
  const token = asset.pageAccessToken || asset.metaConnection?.accessToken;
  if (!token) { console.error('Asset without token'); process.exit(3); }

  console.log(`Running syncAdAccountMetrics for ${asset.metaAssetId} ${start.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}`);
  const res = await syncAdAccountMetrics(asset, token, start, end);
  console.log('Result:', res);
  await db.sequelize.close();
}

main().catch(e=>{ console.error(e); process.exit(1); });

