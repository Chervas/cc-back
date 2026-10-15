'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ allowed = true, valid = true } = {}) {
  let reads = 0;
  const scope = { scope: 'clinic', clinicIds: [59], isValid: valid };
  const module = { exports: {} };
  const dependencies = {
    '../lib/clinicScope': { resolveClinicScope: async () => scope },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async options => {
      assert.deepEqual([...options.clinicIds], [59]);
      assert.equal(options.userId, 91); assert.equal(options.access, 'read'); return allowed;
    } },
    '../services/marketingBulkSends.service': {
      getReviewRequestSummary: async () => { reads++; return { summary: {} }; },
      getMissingGoogleReviews: async (_scope, options) => { reads++; return { items: [], ...options }; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../controllers/marketingBulkSends.controller.js'), 'utf8'), {
    module, exports: module.exports, console, require: name => {
      assert(Object.hasOwn(dependencies, name), name); return dependencies[name];
    },
  });
  const req = { userData: { userId: 91 }, query: { clinic_id: '59', limit: '10', offset: '20' } };
  const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  return { api: module.exports, req, res, reads: () => reads };
}

for (const handler of ['getReviewRequestSummary', 'getMissingGoogleReviews']) {
  test(handler + ' denies a foreign clinic before any review read', async () => {
    const f = fixture({ allowed: false }); await f.api[handler](f.req, f.res);
    assert.equal(f.res.code, 403); assert.equal(f.reads(), 0);
  });
  test(handler + ' allows an authorized reader with no shared cache', async () => {
    const f = fixture(); await f.api[handler](f.req, f.res);
    assert.equal(f.res.code, 200); assert.equal(f.reads(), 1);
    assert.equal(f.res.headers['Cache-Control'], 'no-store');
  });
  test(handler + ' rejects malformed scope before any review read', async () => {
    const f = fixture({ valid: false }); await f.api[handler](f.req, f.res);
    assert.equal(f.res.code, 400); assert.equal(f.reads(), 0);
  });
}
test('history routes follow the existing session authentication boundary', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/marketing.routes.js'), 'utf8');
  assert(source.indexOf("router.get('/review-requests/missing-reviews'") > source.indexOf('router.use(authMiddleware)'));
});
