'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness({ appointment = { id_cita: 10, paciente_id: 20, clinica_id: 72 }, denied = false, prepareError = null, paperError = null, replayed = false } = {}) {
  const calls = [], writes = [], transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  let active = false;
  const db = { sequelize: { transaction: async (options, callback) => {
    const work = typeof options === 'function' ? options : callback;
    calls.push(['transaction', typeof options === 'function' ? {} : options]); active = true;
    try { const result = await work(transaction); calls.push(['commit']); return result; }
    catch (error) { writes.length = 0; calls.push(['rollback']); throw error; }
    finally { active = false; }
  } }, CitaPaciente: { findByPk: async (id, options) => {
    assert(active); assert.equal(options.transaction, transaction); assert.equal(id, 10);
    calls.push(['appointment', options]); return appointment;
  } } };
  const controller = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../controllers/appointmentPrivacy.controller'), 'utf8'), {
    exports: controller.exports, module: controller,
    require(name) {
      if (name === '../../models') return db;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async scope => {
        assert(active); calls.push(['acl', scope]);
        if (denied) throw Object.assign(new Error('access_policy_forbidden'), { status: 403 });
      } };
      if (name === '../services/consentimientos.service') return { createPatientIntakePackage: async (patientId, options) => {
        assert(active); assert.equal(options.transaction, transaction); calls.push(['prepare', patientId, options]);
        writes.push('package'); if (prepareError) throw prepareError;
        return { package_id: 1, created_count: 1 };
      } };
      if (name === '../services/appointmentPrivacyEligibility.service') return { assessPrivacyBeforeStart: async options => {
        assert(active); assert.equal(options.transaction, transaction); assert.equal(options.appointment, appointment);
        calls.push(['assess']); return { required: true, allowed: false };
      } };
      if (name === '../services/appointmentTabletStatus.service') return { appointmentTabletStatus: async options => {
        assert(active); assert.equal(options.transaction, transaction); assert.equal(options.appointment, appointment);
        calls.push(['tablet-status']); return { privacy: { state: 'not_sent' }, intake: { state: 'not_sent' } };
      } };
      if (name === '../lib/registration-privacy-paper') return { recordRegistrationPrivacyPaper: async options => {
        assert(active); assert.equal(options.transaction, transaction); assert.equal(options.appointment, appointment);
        calls.push(['paper', options]); writes.push('attestation', 'receipt');
        if (paperError) throw paperError;
        return { created: !replayed, required: true, allowed: true, reason: 'privacy_received_on_paper',
          privacy_satisfied: true, privacy_signed: false, privacy_on_paper: true };
      } };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { calls, writes, transaction, async request(method, reqPatch = {}) {
    const req = { params: { id: '10' }, userData: { userId: 7 },
      body: method === 'paper' ? { acknowledged: true } : { patientId: 999, clinicId: 66, allowLinkedClinic: false, transaction: 'forged' }, ...reqPatch };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    let nextError;
    await controller.exports[method](req, res, error => { nextError = error; });
    return { res, nextError };
  } };
}

for (const method of ['status', 'tabletStatus', 'prepare', 'paper']) {
  test(`${method}: validates actor/id before reading any appointment`, async () => {
    for (const [req, expected] of [[{ userData: null }, 401], [{ params: { id: '0' } }, 400], [{ params: { id: '10junk' } }, 400]]) {
      const h = harness(), { res, nextError } = await h.request(method, req);
      assert.equal(res.statusCode, expected); assert.equal(nextError, undefined); assert.equal(h.calls.length, 0);
    }
  });
  test(`${method}: ACL uses actual appointment clinic, never body scope, and denial performs no preparation`, async () => {
    const h = harness({ denied: true }), { res, nextError } = await h.request(method);
    assert.equal(res.statusCode, 403); assert.equal(nextError, undefined);
    const acl = h.calls.find(([name]) => name === 'acl')[1];
    assert.equal(acl.actorId, 7); assert.equal(acl.clinicId, 72);
    assert.equal(acl.featureKey, ['status', 'tabletStatus'].includes(method) ? 'consents.view' : 'consents.manage');
    assert.equal(h.writes.length, 0); assert(h.calls.some(([name]) => name === 'rollback'));
    assert(!h.calls.some(([name]) => ['prepare', 'assess', 'paper'].includes(name)));
  });
  test(`${method}: missing patient/appointment returns 404 inside the same transaction`, async () => {
    const h = harness({ appointment: null }), { res } = await h.request(method);
    assert.equal(res.statusCode, 404); assert.equal(res.body.message, 'appointment_not_found');
    assert(!h.calls.some(([name]) => name === 'acl')); assert.equal(h.writes.length, 0);
  });
}
test('prepare locks exact reservation before ACL and joins the same transaction for all package writes', async () => {
  const h = harness(), { res, nextError } = await h.request('prepare');
  assert.equal(nextError, undefined); assert.equal(res.statusCode, 201);
  assert.deepEqual(h.calls.map(([name]) => name), ['transaction', 'appointment', 'acl', 'prepare', 'commit']);
  assert.equal(h.calls.find(([name]) => name === 'appointment')[1].lock, 'UPDATE');
  const prepared = h.calls.find(([name]) => name === 'prepare');
  assert.equal(prepared[1], 20); assert.equal(prepared[2].clinicId, 72);
  assert.equal(prepared[2].createdBy, 7); assert.equal(prepared[2].allowLinkedClinic, true);
  assert.equal(prepared[2].privacyOnly, true);
  assert.equal(prepared[2].transaction, h.transaction);
});
test('prepare failure rolls back its package instead of committing an orphan before returning error', async () => {
  const error = Object.assign(new Error('patient_clinic_changed'), { statusCode: 409 });
  const h = harness({ prepareError: error }), { res, nextError } = await h.request('prepare');
  assert.equal(res.statusCode, 409); assert.equal(nextError, undefined);
  assert.equal(h.writes.length, 0); assert.equal(h.calls.at(-1)[0], 'rollback');
});
test('status reads actual reservation and assesses inside one read-only-designated consistent transaction', async () => {
  const h = harness(), { res, nextError } = await h.request('status');
  assert.equal(nextError, undefined); assert.equal(res.statusCode, 200); assert.equal(res.body.allowed, false);
  assert.deepEqual(h.calls.map(([name]) => name), ['transaction', 'appointment', 'acl', 'assess', 'commit']);
  assert.equal(h.calls[0][1].readOnly, true); assert.equal(h.calls[0][1].isolationLevel, 'REPEATABLE READ');
  assert.equal(h.writes.length, 0);
});
test('paper uses appointment ACL and lock, passes only server scope, and distinguishes creation from idempotent replay', async () => {
  for (const replayed of [false, true]) {
    const h = harness({ replayed }), { res, nextError } = await h.request('paper');
    assert.equal(nextError, undefined); assert.equal(res.statusCode, replayed ? 200 : 201);
    assert.equal(res.body.reason, 'privacy_received_on_paper'); assert.equal(res.body.privacy_signed, false);
    assert.deepEqual(h.calls.map(([name]) => name), ['transaction', 'appointment', 'acl', 'paper', 'commit']);
    assert.equal(h.calls.find(([name]) => name === 'appointment')[1].lock, 'UPDATE');
    const scope = h.calls.find(([name]) => name === 'paper')[1];
    assert.equal(scope.actorId, 7); assert.equal(scope.acknowledged, true); assert.equal(scope.appointment.paciente_id, 20);
  }
});
test('paper refuses missing acknowledgement and all caller-provided identity, source or audit overrides before reading data', async () => {
  for (const body of [null, {}, [], { acknowledged: false }, { acknowledged: 'true' },
    ...['patientId', 'paciente_id', 'clinicId', 'clinica_id', 'source', 'actorId', 'template', 'metadata', 'note']
      .map(key => ({ acknowledged: true, [key]: 'forged' }))]) {
    const h = harness(), { res, nextError } = await h.request('paper', { body });
    assert.equal(nextError, undefined); assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'appointment_consent_privacy_paper_acknowledgement_required'); assert.equal(h.calls.length, 0);
  }
});
test('paper audit failure rolls back its attestation atomically instead of authorizing care', async () => {
  const h = harness({ paperError: Object.assign(new Error('paper_audit_failed'), { statusCode: 409 }) });
  const { res, nextError } = await h.request('paper');
  assert.equal(nextError, undefined); assert.equal(res.statusCode, 409); assert.equal(h.writes.length, 0);
  assert.equal(h.calls.at(-1)[0], 'rollback');
});
test('paper endpoint is an authenticated consent route, not a public tablet signer', () => {
  const source = fs.readFileSync(require.resolve('../../routes/consentimientos.routes'), 'utf8');
  assert(source.includes("router.post('/appointments/:id/privacy-paper', require('../controllers/appointmentPrivacy.controller').paper)"));
});
