'use strict';

// Load production entry points while refusing application initialization, real
// models, network clients and workers. Only explicitly allowlisted pure modules
// are required; all persistence and provider calls are local fixtures.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { createRequire } = require('node:module');

function forbidden(label) {
  return () => { throw new Error(`Offline test forbids ${label}`); };
}

function harness({ env = {}, models = {}, mocks = {} } = {}) {
  const root = path.resolve(__dirname, '../../..');
  const modelCache = {};
  const db = new Proxy({ Sequelize, sequelize: { query: forbidden('SQL'), transaction: forbidden('transaction') }, ...models }, {
    get(target, key) {
      if (key in target) return target[key];
      if (!modelCache[key]) modelCache[key] = new Proxy({}, { get: (_, method) => forbidden(`${String(key)}.${String(method)}`) });
      return modelCache[key];
    },
  });
  const cache = new Map();
  const pureFiles = new Set([
    'lib/marketingMedicalArea.js', 'lib/clinic-configuration.js',
    'services/marketingCompetitionHeatmapCache.service.js',
  ].map(file => path.join(root, file)));
  const moduleMocks = {
    '../../models': db,
    axios: { get: forbidden('HTTP GET'), post: forbidden('HTTP POST') },
    '../lib/metaClient': { metaGet: forbidden('Meta') },
    '../lib/safeHttpTarget': { publicHttpUrl: require('../../../lib/safeHttpTarget').publicHttpUrl, resolveSafeHttpTarget: forbidden('DNS') },
    './jobRequests.service': { enqueueUniqueJobRequest: forbidden('real job enqueue') },
    './jobScheduler.service': { triggerImmediate: forbidden('real worker') },
    './googleAdsTransparencyOfficial.service': {},
    './googleAdsTransparencyFast.service': {},
    './effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: forbidden('asset inventory') },
    './googleLocalProfileUrlResolver.service': { resolveGoogleLocalProfileUrl: forbidden('URL provider') },
    './aiBroker.service': { enabled: () => false },
    ...mocks,
  };
  const testProcess = { env: {
    JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway',
    OPENAI_API_KEY: 'offline-fixture', GOOGLE_PLACES_API_KEY: 'offline-fixture',
    COMPETITION_GOOGLE_PLACES_COMPETITOR_USE_ALLOWED: 'true',
    COMPETITION_GOOGLE_PLACES_COMPETITOR_STORAGE_ALLOWED: 'true',
    COMPETITION_LOCAL_RANKING_STORAGE_ALLOWED: 'true', ...env,
  } };
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const nativeRequire = createRequire(filename);
    const requireOffline = name => {
      if (Object.hasOwn(moduleMocks, name)) return moduleMocks[name];
      if (name === 'crypto' || name === 'node:crypto' || name === 'sequelize') return nativeRequire(name);
      const resolved = name.startsWith('.') ? nativeRequire.resolve(name) : name;
      if (pureFiles.has(resolved)) return nativeRequire(name);
      if (resolved === path.join(root, 'services/marketingCompetition.service.js')) return load(resolved);
      throw new Error(`Offline test refuses import ${name} from ${path.basename(filename)}`);
    };
    vm.runInThisContext(`(function(require,module,exports,process){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(requireOffline, module, module.exports, testProcess);
    return module.exports;
  }
  return { load, db, env: testProcess.env };
}

module.exports = { harness, forbidden };
