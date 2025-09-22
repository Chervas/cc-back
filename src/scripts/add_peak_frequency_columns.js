#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function ensureColumn(qi, table, column, spec) {
  const desc = await qi.describeTable(table);
  if (!desc[column]) {
    await qi.addColumn(table, column, spec);
    console.log(`✔ Added ${table}.${column}`);
  } else {
    console.log(`• ${table}.${column} already exists`);
  }
}

async function run() {
  const qi = db.sequelize.getQueryInterface();
  await ensureColumn(qi, 'SocialAdsEntities', 'peak_frequency', { type: db.Sequelize.DECIMAL(10,3), allowNull: true });
  await ensureColumn(qi, 'SocialAdsEntities', 'peak_frequency_date', { type: db.Sequelize.DATEONLY, allowNull: true });
  await db.sequelize.close();
}

run().then(()=>{ console.log('Done'); process.exit(0); }).catch(err=>{ console.error(err); process.exit(1); });

