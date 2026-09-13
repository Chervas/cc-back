'use strict';
const fs = require('node:fs'); const vm = require('node:vm'); const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
function loadDiscoverySource(relative, dependencies, { env = {}, logs = [] } = {}) {
  const filename = path.join(root, relative); const module = { exports: {} };
  const forbidden = () => { throw Error('UNEXPECTED_DEPENDENCY_IN_DISCOVERY_QA'); };
  const blocked = new Proxy({}, { get: () => forbidden });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URL, URLSearchParams, Date, setTimeout, clearTimeout,
    process: { env: { RUNTIME_ROLE: 'gateway', JOBS_AUTO_START: 'false', ...env } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args)])),
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : blocked,
  }, { filename, timeout: 2000 });
  return module.exports;
}
module.exports = { loadDiscoverySource };
