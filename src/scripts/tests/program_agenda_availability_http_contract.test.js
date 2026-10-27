'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync(require.resolve('../../controllers/patientEconomics.controller'), 'utf8');
const contextStart = code.indexOf('async function programContext('), contextEnd = code.indexOf('async function agendaOriginContext(', contextStart);
const handlerStart = code.indexOf('exports.getProgramAvailabilityGrid ='), handlerEnd = code.indexOf('exports.reserveProgramPlan =', handlerStart);
assert(contextStart > 0 && contextEnd > contextStart && handlerStart > 0 && handlerEnd > handlerStart);
function fixture(deny = null) {
  const calls = [], headers = {}, exports = {}, req = { userData: { userId: 7 }, params: { voucherId: 'purchased-owned' }, body: { clinic_id: 999, actor_id: 999 } };
  const sandbox = { exports, asyncHandler: fn => fn, actorId: request => request.userData.userId,
    requireVoucherFeature: async (request, feature) => { calls.push(feature); if (feature === deny) throw Object.assign(Error('denied'), { statusCode: 403 }); return 66; },
    requireClinicFeature: async (request, feature, clinic) => { assert.equal(clinic, 66); calls.push(feature); if (feature === deny) throw Object.assign(Error('denied'), { statusCode: 403 }); },
    programBooking: { availabilityGrid: async input => { calls.push('grid'); assert.equal(input.clinicId, 66); assert.equal(input.actorId, 7);
      assert.equal(input.publicId, req.params.voucherId); assert.equal(input.payload, req.body); return { rows: [], active_key: 'owned-session' }; } } };
  vm.runInNewContext(code.slice(contextStart, contextEnd) + code.slice(handlerStart, handlerEnd), sandbox);
  const res = { set: (name, value) => { headers[name] = value; }, json: value => { res.body = value; } };
  return { calls, headers, res, run: () => exports.getProgramAvailabilityGrid(req, res) };
}
test('program-grid handler derives clinic/actor from purchase and session, keeps sensitive/calendar view ACL and private no-store', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ['patients.view', 'patients.sensitive.view', 'appointments.view', 'grid']);
  assert.equal(f.headers['Cache-Control'], 'private, no-store'); assert.equal(f.res.body.active_key, 'owned-session');
});
test('program-grid never reads a plan when purchase, sensitive-patient or calendar access is denied', async () => {
  for (const feature of ['patients.view', 'patients.sensitive.view', 'appointments.view']) {
    const f = fixture(feature); await assert.rejects(f.run(), { statusCode: 403 }); assert(!f.calls.includes('grid'));
  }
});
test('all three authenticated plan-grid routes dispatch their scoped canonical handlers', () => {
  const routes = fs.readFileSync(require.resolve('../../routes/patientEconomics.routes'), 'utf8');
  for (const route of ['/vouchers/:voucherId/program-availability-grid', '/vouchers/:voucherId/agenda-availability-grid',
    '/budgets/:budgetId/concepts/:lineKey/agenda-availability-grid']) {
    const position = routes.indexOf("router.post('" + route + "'"); assert(position > routes.indexOf('router.use(authMiddleware)'));
  }
});
test('origin grid with a closed booking gate cannot read calendars or announce a slot', async () => {
  const source = fs.readFileSync(require.resolve('../../services/appointmentAgendaOrigin.service'), 'utf8');
  const start = source.indexOf('  async function availabilityGrid('), end = source.indexOf('  function seriesPayload(', start);
  let reads = 0;
  const method = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    bookingCapabilities: () => ({ simple: false }), load: async () => { reads++; },
    fail: (code, message, statusCode) => { throw Object.assign(Error(message), { code, statusCode }); },
  });
  await assert.rejects(method({}), { statusCode: 503, code: 'booking_profile_runtime_unavailable' }); assert.equal(reads, 0);
});
