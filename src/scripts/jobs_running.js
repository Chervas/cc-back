#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require(path.join(__dirname, '..', '..', 'models'));

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 24*60*60*1000); // last 24h
  const running = await db.SyncLog.findAll({
    where: {
      status: 'running',
      created_at: { [db.Sequelize.Op.gte]: since }
    },
    order: [['start_time', 'DESC']],
    raw: true
  });

  if (!running.length) {
    console.log('No hay jobs en ejecución (running) en las últimas 24h.');
  } else {
    console.log(`Jobs en ejecución: ${running.length}`);
    for (const r of running) {
      console.log(`${r.id} | ${r.job_type} | started: ${r.start_time} | records: ${r.records_processed ?? 0}`);
    }
  }

  // Además, mostrar último estado de cada job conocido
  const jobs = ['metrics_sync','ads_sync','ads_backfill','web_sync','web_backfill','token_validation','data_cleanup','health_check','manual_job_execution'];
  console.log('\nÚltimos estados por tipo (últimos 10 registros):');
  for (const jt of jobs) {
    const rec = await db.SyncLog.findOne({
      where: { job_type: jt },
      order: [['created_at','DESC']],
      raw: true
    });
    if (rec) {
      console.log(`${jt}: ${rec.status} @ ${rec.created_at} (id=${rec.id})`);
    }
  }

  await db.sequelize.close();
}

main().catch(e=>{ console.error(e); process.exit(1); });

