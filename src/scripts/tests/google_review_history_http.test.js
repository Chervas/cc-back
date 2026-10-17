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
      assert.equal(options.userId, 91); assert(['read','write'].includes(options.access)); return allowed;
    } },
    '../services/marketingBulkSends.service': {
      getReviewRequestSummary: async (_scope, options) => { reads++; return { summary: {}, options }; },
      getMissingGoogleReviews: async (_scope, options) => { reads++; return { items: [], ...options }; },
      getReviewActivityReport: async (_scope, options) => { reads++; return { ...options }; },
      getReviewQueueSchedule: async () => { reads++; return {success:true}; },
      updateReviewQueueSchedule: async () => { reads++; return {success:true}; },
      getDispatchStatus: async (_scope, id, options) => { reads++; return { id, options }; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../controllers/marketingBulkSends.controller.js'), 'utf8'), {
    module, exports: module.exports, console, require: name => {
      assert(Object.hasOwn(dependencies, name), name); return dependencies[name];
    },
  });
  const req = { userData: { userId: 91 }, params:{id:'830'}, query: { clinic_id: '59', limit: '10', offset: '20' } };
  const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  return { api: module.exports, req, res, reads: () => reads };
}

for (const handler of ['getReviewRequestSummary', 'getMissingGoogleReviews', 'getReviewActivityReport', 'getReviewQueueSchedule']) {
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
  assert(source.indexOf("router.get('/review-requests/activity'") > source.indexOf('router.use(authMiddleware)'));
});

test('activity forwards only period and the authorized clinic subset', async () => {
  const f = fixture(); f.req.query.period = '7d'; f.req.query.review_group_clinic_ids = '59';
  await f.api.getReviewActivityReport(f.req, f.res);
  assert.equal(f.res.body.period, '7d'); assert.equal(f.res.body.review_group_clinic_ids, '59');
  assert.equal(f.reads(), 1);
});

test('history forwards the attribution filter without creating a synchronization request', async () => {
  const f = fixture(); f.req.query.attribution = 'high_confidence';
  await f.api.getMissingGoogleReviews(f.req, f.res);
  assert.equal(f.res.body.attribution, 'high_confidence');
  assert.equal(f.reads(), 1);
});

test('sorting is forwarded to the backend with pagination and no provider request',async()=>{
  const f=fixture();Object.assign(f.req.query,{sort_by:'rating',sort_direction:'asc'});
  await f.api.getMissingGoogleReviews(f.req,f.res);assert.equal(f.res.body.sort_by,'rating');assert.equal(f.res.body.sort_direction,'asc');
});

test('history forwards its period without synchronizing or broadening the authorized scope',async()=>{
  const f=fixture();f.req.query.period='7d';await f.api.getMissingGoogleReviews(f.req,f.res);
  assert.equal(f.res.body.period,'7d');assert.equal(f.reads(),1);
});

test('queue schedule writes require marketing write permission before any change',async()=>{
  const f=fixture({allowed:false});await f.api.updateReviewQueueSchedule(f.req,f.res);assert.equal(f.res.code,403);assert.equal(f.reads(),0);
  const allowed=fixture();await allowed.api.updateReviewQueueSchedule(allowed.req,allowed.res);assert.equal(allowed.res.code,200);assert.equal(allowed.reads(),1);
});

test('overview mode retains the same authentication and clinic permission boundary', async () => {
  const f = fixture(); f.req.query.summary_mode = 'overview';
  await f.api.getReviewRequestSummary(f.req, f.res);
  assert.equal(f.res.body.options.summary_mode, 'overview');
  assert.equal(f.reads(), 1);
});

test('periodic progress is an explicit opt-in on the existing scoped route', async () => {
  for (const [value, expected] of [['true', true], ['false', false], [undefined, false], ['true OR 1=1', false]]) {
    const f = fixture(); f.req.params = { id: '830' }; f.req.query.progress_only = value;
    await f.api.getDispatchStatus(f.req, f.res);
    assert.equal(f.res.code, 200); assert.equal(f.res.body.options.progress_only, expected);
  }
});

test('history has a database-only dependency boundary for all filters', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../services/googleReviewHistory.service.js'), 'utf8');
  assert(!/\bimport\s|\bfetch\s*\(/.test(source));
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match=>match[1]),['./reviewActivityReport.service']);
  const history = require('../../services/googleReviewHistory.service');
  let reads = 0;
  const db = { Sequelize: { QueryTypes: { SELECT: 'SELECT' } }, sequelize: { query: async query => {
    reads++;
    assert(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(query));
    return query.includes('filtered_total')
      ? [{ total: 2, linked: 1, high_confidence: 1, unattributed: 1, filtered_total: 1 }]
      : [];
  } } };
  for (const attribution of ['all', 'linked', 'high_confidence', 'unattributed']) {
    const result = await history.listMissingReviews(db, { clinicIds: [59], locationIds: [11], attribution });
    assert.equal(result.attribution, attribution);
    assert.equal(result.summary.total, 2);
  }
  assert.equal(reads, 8);
});
