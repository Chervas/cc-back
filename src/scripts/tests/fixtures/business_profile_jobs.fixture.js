'use strict';
const fs = require('node:fs'); const vm = require('node:vm');
// Loads actual job source with an explicit dependency boundary. Importing a
// legacy service, model index, cron, Redis or provider bootstrap is impossible.
function loadBusinessProfileJobs({ models, broker, legacyHttp, matching, credentials, searchConsole, analytics, logs = [], env = {}, overrides = {} }) {
  const filename = require.resolve('../../../jobs/sync.jobs');
  const fail = () => { throw Error('UNEXPECTED_DEPENDENCY_IN_GBP_QA'); };
  const dependencies = {
    '../../models': models, sequelize: require('sequelize'), crypto: require('node:crypto'),
    'node-cron': { schedule: fail }, axios: { create: () => legacyHttp, post: fail },
    '../services/businessProfileBroker.service': broker,
    '../services/googleLegacyCredentials.service': credentials || new Proxy({}, { get: () => fail }),
    '../services/searchConsoleBroker.service': searchConsole || new Proxy({}, { get: () => fail }),
    '../services/analyticsBroker.service': analytics || new Proxy({}, { get: () => fail }),
    '../services/googleReviewMatch.service': { enqueueBusinessProfileReviewMatch: matching || fail },
    ...overrides,
  };
  const module = { exports: {} };
  const blocked = new Proxy({}, { get: () => fail });
  const sandbox = { module, exports: module.exports, Buffer, URL, URLSearchParams, Date, setTimeout, clearTimeout, setInterval: fail,
    process: { env: { RUNTIME_ROLE: 'gateway', JOBS_AUTO_START: 'false', LOCAL_SYNC_RECENT_DAYS: '1', LOCAL_SYNC_BETWEEN_LOCATIONS_SLEEP_MS: '0', ...env } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args)])),
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : blocked };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename, timeout: 2000 });
  return module.exports;
}
module.exports = { loadBusinessProfileJobs };
