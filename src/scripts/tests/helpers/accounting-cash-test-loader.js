'use strict';
// Execute the complete production module. Cash tests replace only ancillary
// storage/economics integrations; persistence and accounting logic stay real.
const fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
function load(filename, overrides) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    console, Date, Map, Set, Promise, Object, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name),
  }, { filename });
  return module.exports;
}
function accountingService(db) {
  return load(require.resolve('../../../services/accounting.service'), {
    '../../models': db, './clinicalPrivateStorage.service': {}, './patientEconomics.service': {},
  });
}
function accountingController(accounting, { canAccess, isPortal = async () => false } = {}) {
  return load(require.resolve('../../../controllers/accounting.controller'), {
    '../services/accounting.service': accounting,
    '../services/accountingFirms.service': { isPortalUser: isPortal },
    '../services/accountingIngestion.service': {}, '../services/accountingSepa.service': {}, '../services/accountingExport.service': {},
    '../lib/access-policy': { canUserAccessFeature: canAccess || (async () => false) },
  });
}
async function invoke(handler, req) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await new Promise((resolve, reject) => Promise.resolve(handler(req, response, reject)).then(resolve, reject));
  return response;
}
module.exports = { accountingService, accountingController, invoke };
