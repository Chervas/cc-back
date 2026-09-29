'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/consentimientos.controller'), 'utf8');
function harness(denyFeature) {
  const calls = [], module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'express-async-handler') return fn => fn;
    if (name === '../../models') return { Sequelize: { Op: {} }, PatientConsentDocument: { findOne: async () => ({ clinica_id: 121 }) } };
    if (name.includes('access-policy')) return { assertUserCanAccessFeature: async args => { calls.push(args); if (args.featureKey === denyFeature) throw Object.assign(Error('forbidden'), { statusCode: 403 }); } };
    if (name.includes('role-helpers')) return { isGlobalAdmin: () => false };
    if (name.includes('consentimientos.service')) return { signProfessionalConsentDocument: async (id, body, actor) => { calls.push({ write: true, actor }); return { ok: true }; } };
    throw Error(name);
  } });
  return { calls, async run() {
    let status = 200; const res = { status(n) { status = n; return this; }, json() {} };
    await module.exports.signProfessionalDocument({ params: { id: '1' }, body: { accepted_statement: true }, userData: { userId: 17 }, get: () => '' }, res);
    return status;
  } };
}
test('professional signing requires both consent and clinical permission in the document clinic', async () => {
  const h = harness(); assert.equal(await h.run(), 200);
  assert.deepEqual(h.calls.map(c => c.featureKey).filter(Boolean), ['consents.manage', 'clinical.reports.manage']);
  assert(h.calls.filter(c => c.featureKey).every(c => c.clinicId === 121 && c.actorId === 17));
  assert.equal(h.calls.at(-1).actor, 17);
  for (const denied of ['consents.manage', 'clinical.reports.manage']) {
    const blocked = harness(denied); assert.equal(await blocked.run(), 403);
    assert(!blocked.calls.some(c => c.write));
  }
});
