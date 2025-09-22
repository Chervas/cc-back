#!/usr/bin/env node
'use strict';

// Adds columns for stored Ads account status and delivery reasons, if missing

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function ensureColumn(queryInterface, table, column, spec) {
  const desc = await queryInterface.describeTable(table);
  if (!desc[column]) {
    await queryInterface.addColumn(table, column, spec);
    console.log(`✔ Added ${table}.${column}`);
  } else {
    console.log(`• ${table}.${column} already exists`);
  }
}

async function run() {
  const qi = db.sequelize.getQueryInterface();
  // SocialAdsEntities
  await ensureColumn(qi, 'SocialAdsEntities', 'delivery_reason_text', { type: db.Sequelize.TEXT, allowNull: true });
  await ensureColumn(qi, 'SocialAdsEntities', 'delivery_status', { type: db.Sequelize.STRING(64), allowNull: true });
  await ensureColumn(qi, 'SocialAdsEntities', 'delivery_checked_at', { type: db.Sequelize.DATE, allowNull: true });

  // ClinicMetaAssets
  await ensureColumn(qi, 'ClinicMetaAssets', 'ad_account_status', { type: db.Sequelize.INTEGER, allowNull: true });
  await ensureColumn(qi, 'ClinicMetaAssets', 'ad_account_disable_reason', { type: db.Sequelize.STRING(64), allowNull: true });
  await ensureColumn(qi, 'ClinicMetaAssets', 'ad_account_spend_cap', { type: db.Sequelize.DECIMAL(18,2), allowNull: true });
  await ensureColumn(qi, 'ClinicMetaAssets', 'ad_account_amount_spent', { type: db.Sequelize.DECIMAL(18,2), allowNull: true });
  await ensureColumn(qi, 'ClinicMetaAssets', 'ad_account_refreshed_at', { type: db.Sequelize.DATE, allowNull: true });

  await db.sequelize.close();
}

run().then(()=>{ console.log('Done'); process.exit(0); }).catch(err=>{ console.error(err); process.exit(1); });
