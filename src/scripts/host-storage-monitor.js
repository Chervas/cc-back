#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const STATE = '/run/clinicaclick-host-storage-monitor/state.json';

async function main() {
  const { observedEnvironment } = require('./security-email-login-metadata');
  const observed = observedEnvironment('staging');
  Object.assign(process.env, observed.env, { JOBS_CRON_LEADER: 'false', JOBS_WORKER_ENABLED: 'false' });
  process.chdir(observed.root);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('host_storage_state_unreadable'); }
  const monitor = require('../lib/host-storage-monitor');
  const service = require('../services/systemNotifications.service');
  const result = await monitor.check({ stats: fs.statfsSync('/'), previous,
    notify: input => service.queueNotification(input) });
  fs.writeFileSync(STATE + '.next', JSON.stringify(result.nextState), { mode: 0o600 });
  fs.renameSync(STATE + '.next', STATE);
  process.stdout.write(JSON.stringify({ event: 'host_storage_checked', ...result }) + '\n');
}

if (require.main === module) {
  console.log = console.warn = () => {};
  main().catch(error => {
    process.stderr.write(JSON.stringify({ event: 'host_storage_check_failed',
      code: /^[a-z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'host_storage_unavailable' }) + '\n');
    process.exitCode = 1;
  }).finally(async () => {
    const models = require.cache[require.resolve('../../models')];
    if (models) await models.exports.sequelize.close();
    const queues = require.cache[require.resolve('../services/queue.service')];
    if (queues) await Promise.all(Object.values(queues.exports.queues || {}).map(queue => queue.disconnect()));
  });
}
module.exports = { main };
