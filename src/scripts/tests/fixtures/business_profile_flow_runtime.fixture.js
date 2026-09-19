'use strict';
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
// Actual engine/executor source, with no app bootstrap, sockets, cron or providers.
function loadSource(relative, dependencies, env) {
  const filename = require.resolve('../../../services/' + relative), actual = createRequire(filename);
  const fail = () => { throw Error('UNEXPECTED_FLOW_DEPENDENCY'); };
  const blocked = new Proxy({}, { get: () => fail });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    Buffer, Date, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone,
    process: { env }, console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name.startsWith('../lib/') || name.startsWith('../config/') || ['sequelize', 'crypto'].includes(name) ? actual(name) : blocked,
  }, { filename, timeout: 2000 });
  return module.exports;
}
module.exports = ({ models, local, requests, automation, timeoutMs = 30000, onExecutionSettled }) => {
  const env = { JOB_RUNTIME_NAMESPACE: 'staging', JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway', JOB_EXECUTOR_MAX_RUNTIME_MS: String(timeoutMs) };
  const engine = loadSource('flowEngineV2.service', { '../../models': models,
    './socket.service': { getIO: () => null }, './queue.service': {}, './jobRequests.service': requests,
    './businessProfileLocal.service': local, './businessProfileAutomation.service': automation }, env);
  const executorEngine = onExecutionSettled ? { ...engine, runExecution: async (...args) => {
    try { return await engine.runExecution(...args); } finally { onExecutionSettled(); }
  } } : engine;
  const executor = loadSource('jobExecutor.service', { '../../models': models, './flowEngineV2.service': executorEngine,
    './jobClaim.service': require('../../../services/jobClaim.service') }, env);
  return { engine, executor };
};
