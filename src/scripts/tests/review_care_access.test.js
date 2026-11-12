'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const auth = require('../../services/accessSession.service');
const { createReviewCareAccess } = require('../../services/reviewCareAccess.service');

function fixture() {
  const user = id => ({ id_usuario: id, estado_cuenta: 'activo', es_provisional: false,
    password_usuario: 'FICTITIOUS_PASSWORD_HASH_NOT_A_CREDENTIAL', email_usuario: `testonly-${id}@example.invalid` });
  const state = { users: new Map([[1, user(1)], [225, user(225)]]), clinics: new Set([1, 70, 66]),
    patients: [{ id_paciente: 11, clinica_id: 1, fecha_baja: null }, { id_paciente: 12, clinica_id: 70, fecha_baja: null },
      { id_paciente: 13, clinica_id: 1, fecha_baja: '2026-11-01' }],
    links: [{ paciente_id: 11, clinica_id: 70 }, { paciente_id: 12, clinica_id: 1 }],
    grants: new Map([1, 225].map(id => [id, new Map([1, 70].map(clinicId => [clinicId,
      new Set(['patients.view', 'patients.sensitive.view'])]))])),
    calls: [], verifies: [], revoked: false, readFailure: false, permissionFailure: false,
    claims: { userId: 225, sessionVersion: 1, jti: '22222222-2222-4222-8222-222222222222' } };
  const db = {
    Usuario: { async findByPk(id, options) {
      state.calls.push(['user', id]); assert.equal(options.logging, false);
      assert.deepEqual(options.attributes, ['id_usuario', 'estado_cuenta', 'es_provisional', 'password_usuario', 'email_usuario']);
      if (state.readFailure) throw Error('FICTITIOUS_PRIVATE_STORAGE_DETAILS');
      return state.users.get(id) ? { ...state.users.get(id) } : null;
    } },
    Clinica: { async findAll(options) {
      state.calls.push(['clinics']); assert.equal(options.logging, false); assert.deepEqual(options.attributes, ['id_clinica']);
      return options.where.id_clinica[Op.in].filter(id => state.clinics.has(id)).map(id_clinica => ({ id_clinica }));
    } },
    Paciente: { async findAll(options) {
      state.calls.push(['patients']); assert.equal(options.logging, false); assert.equal(options.where.fecha_baja, null);
      assert.deepEqual(options.attributes, ['id_paciente', 'clinica_id', 'fecha_baja']);
      return state.patients.filter(row => options.where.id_paciente[Op.in].includes(row.id_paciente)
        && row.fecha_baja === null).map(row => ({ ...row }));
    } },
    PacienteClinica: { async findAll(options) {
      state.calls.push(['links']); assert.equal(options.logging, false); assert.deepEqual(options.attributes, ['paciente_id', 'clinica_id']);
      return state.links.filter(row => options.where.paciente_id[Op.in].includes(row.paciente_id)
        && options.where.clinica_id[Op.in].includes(row.clinica_id)).map(row => ({ ...row }));
    } },
  };
  const sessions = { bearer: auth.bearer, async verify(token) {
    state.verifies.push(token);
    if (state.revoked) throw Object.assign(Error('FICTITIOUS_SESSION_REVOKED'), { name: 'JsonWebTokenError' });
    return { ...state.claims };
  } };
  const canUserAccessFeature = async input => {
    state.calls.push(['permission', { ...input }]);
    if (state.permissionFailure) throw Error('FICTITIOUS_PERMISSION_STORAGE_DETAILS');
    return state.grants.get(input.actorId)?.get(input.clinicId)?.has(input.featureKey) === true;
  };
  const service = createReviewCareAccess({ db, sessions, canUserAccessFeature });
  const req = { headers: { authorization: 'Bearer FICTITIOUS_ORIGINAL_TOKEN' }, userData: { userId: 225 },
    authSession: { id: state.claims.jti } };
  return { state, db, sessions, canUserAccessFeature, service, req };
}

const status = expected => error => error.status === expected;

test('HTTP authority rechecks the original authenticated actor and both central features on every phase', async () => {
  const { state, service, req } = fixture(), authority = service.httpAuthority(req);
  const before = await authority.authorize({ clinicId: 1, phase: 'before_read' });
  const after = await authority.authorize({ clinicId: '1', phase: 'before_disclosure' });
  assert.deepEqual(before, { actorId: 225, sessionRef: state.claims.jti }); assert.deepEqual(after, before);
  assert.equal(state.verifies.length, 4); assert(state.verifies.every(token => token === 'FICTITIOUS_ORIGINAL_TOKEN'));
  assert.deepEqual(state.calls.filter(row => row[0] === 'permission').map(row => row[1].featureKey),
    ['patients.view', 'patients.sensitive.view', 'patients.view', 'patients.sensitive.view']);
  assert(!state.calls.some(row => ['patients', 'links'].includes(row[0])));
});

test('changing request headers, body or userData cannot replace the captured bearer or actor', async () => {
  const { service, req, state } = fixture(), authority = service.httpAuthority(req);
  req.headers.authorization = 'Bearer FICTITIOUS_ROOT_TOKEN'; req.userData.userId = 1;
  req.body = { actorId: 1, clinicId: 70, skipPermissions: true };
  assert.equal((await authority.authorize({ clinicId: 1 })).actorId, 225);
  assert(state.verifies.every(token => token === 'FICTITIOUS_ORIGINAL_TOKEN'));
  assert(state.calls.filter(row => row[0] === 'permission').every(row => row[1].actorId === 225));
});

test('missing/invalid bearer, actor mismatch, expired or revoked session denies without reading patient data', async () => {
  const { service, req, state, sessions } = fixture();
  assert.throws(() => service.httpAuthority({ headers: {}, userData: { userId: 225 } }), status(401));
  assert.throws(() => service.httpAuthority({ headers: req.headers, userData: { userId: 0 } }), status(401));
  const authority = service.httpAuthority(req); state.claims.userId = 1;
  await assert.rejects(authority.authorize({ clinicId: 1 }), status(401));
  state.claims.userId = 225; await authority.authorize({ clinicId: 1 }); state.revoked = true;
  await assert.rejects(authority.authorize({ clinicId: 1, phase: 'after' }), status(401));
  state.revoked = false; sessions.verify = async () => { throw Object.assign(Error('TESTONLY_EXPIRED'), { name: 'TokenExpiredError' }); };
  await assert.rejects(authority.authorize({ clinicId: 1 }), status(401));
  assert(!state.calls.some(row => ['patients', 'links'].includes(row[0])));
});

test('session changes during authorization and session storage failures fail closed with sanitized errors', async () => {
  const { service, req, sessions } = fixture(), authority = service.httpAuthority(req); let count = 0;
  sessions.verify = async () => ({ userId: 225, sessionVersion: 1, jti: ++count === 1 ? 'TESTONLY_A' : 'TESTONLY_B' });
  await assert.rejects(authority.authorize({ clinicId: 1 }), status(401));
  sessions.verify = async () => { throw Error('FICTITIOUS_TOKEN_OR_PRIVATE_CONFIG'); };
  await assert.rejects(authority.authorize({ clinicId: 1 }), error => error.status === 503
    && error.message === 'review_care_access_unavailable');
});

test('legacy authenticated HTTP uses the real verifier and does not manufacture a managed session', async () => {
  const { state, service, req } = fixture(); state.claims = { userId: 225, jti: 'TESTONLY_LEGACY_JTI' };
  const result = await service.httpAuthority(req).authorize({ clinicId: 1 });
  assert.deepEqual(result, { actorId: 225, sessionRef: null });
});

test('central permission revocation or a mixed clinic scope denies instead of returning a partial scope', async () => {
  const { state, service } = fixture();
  assert.deepEqual(await service.assertActorClinics({ actorId: 225, clinicIds: [70, 1, '1'] }), { actorId: 225, clinicIds: [1, 70] });
  state.grants.get(225).get(70).delete('patients.sensitive.view');
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1, 70] }), status(403));
  await service.assertActorClinics({ actorId: 225, clinicIds: [1] });
  state.grants.get(225).get(1).delete('patients.view');
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(403));
});

test('Marketing access or a locally privileged actor ID never replaces central sensitive authorization', async () => {
  const { state, service } = fixture();
  state.grants.get(225).set(1, new Set(['marketing', 'patients.view']));
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(403));
  state.grants.get(1).get(1).delete('patients.sensitive.view');
  await assert.rejects(service.assertActorClinics({ actorId: 1, clinicIds: [1] }), status(403));
  assert(state.calls.some(row => row[0] === 'permission' && row[1].actorId === 1));
});

test('workers require an active current account but do not require an online interactive session', async () => {
  const { state, service } = fixture(); state.revoked = true;
  await service.assertActorClinics({ actorId: 225, clinicIds: [1] }); assert.equal(state.verifies.length, 0);
  for (const changes of [{ estado_cuenta: 'suspendido' }, { es_provisional: true }, { password_usuario: '' },
    { email_usuario: 'user@example.com' }]) {
    const original = { ...state.users.get(225) }; Object.assign(state.users.get(225), changes);
    await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(403));
    state.users.set(225, original);
  }
  state.users.delete(225); await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(403));
});

test('account suspension while central authorization waits prevents a worker result', async () => {
  const { state, db, sessions, canUserAccessFeature } = fixture();
  const service = createReviewCareAccess({ db, sessions, canUserAccessFeature: async input => {
    const result = await canUserAccessFeature(input); state.users.get(225).estado_cuenta = 'suspendido'; return result;
  } });
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(403));
});

test('pair authority accepts direct ownership or a real linked clinic, never a group-level union', async () => {
  const { service } = fixture();
  assert.deepEqual(await service.assertPatientPairs({ pairs: [
    { patientId: 11, clinicId: 70 }, { patientId: '11', clinicId: '1' }, { patientId: 11, clinicId: 70 },
  ] }), [{ patientId: 11, clinicId: 1 }, { patientId: 11, clinicId: 70 }]);
  await assert.rejects(service.assertPatientPairs({ pairs: [{ patientId: 11, clinicId: 66 }] }), status(403));
  await assert.rejects(service.assertPatientPairs({ pairs: [{ patientId: 11, clinicId: 1 }, { patientId: 12, clinicId: 66 }] }), status(403));
});

test('revoking one patient-clinic link is not hidden by another surviving clinic in the same request', async () => {
  const { state, service } = fixture(), pairs = [{ patientId: 11, clinicId: 1 }, { patientId: 11, clinicId: 70 }];
  await service.assertPatientPairs({ pairs }); state.links = [];
  await assert.rejects(service.assertPatientPairs({ pairs }), status(403));
  assert.deepEqual(await service.assertPatientPairs({ pairs: [pairs[0]] }), [pairs[0]]);
});

test('inactive/missing patients or nonexistent clinics return the same content-free denial', async () => {
  const { service } = fixture();
  for (const pair of [{ patientId: 13, clinicId: 1 }, { patientId: 99, clinicId: 1 }, { patientId: 11, clinicId: 999 }]) {
    await assert.rejects(service.assertPatientPairs({ pairs: [pair] }), error => error.status === 403 && error.message === 'review_care_forbidden');
  }
});

test('malformed IDs, excessive scopes or unexpected pair keys are rejected before any repository read', async () => {
  const { state, service } = fixture();
  for (const clinicIds of [[], ['1junk'], [0], [NaN], [true], Array(101).fill(1)]) {
    await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds }), status(400));
  }
  for (const pairs of [null, [{ patientId: 11, clinicId: '70junk' }], [{ patientId: 11, clinicId: 1, skip: true }],
    Array(1001).fill({ patientId: 11, clinicId: 1 })]) await assert.rejects(service.assertPatientPairs({ pairs }), status(400));
  assert.deepEqual(await service.assertPatientPairs({ pairs: [] }), []); assert.equal(state.calls.length, 0);
});

test('unavailable repositories and policy storage return a sanitized 503 and never permit access', async () => {
  const { state, service } = fixture(); state.readFailure = true;
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), error => error.status === 503
    && error.message === 'review_care_access_unavailable');
  state.readFailure = false; state.permissionFailure = true;
  await assert.rejects(service.assertActorClinics({ actorId: 225, clinicIds: [1] }), status(503));
});

test('a factory without explicit authentication or central authorization dependencies fails closed', () => {
  const { db, sessions, canUserAccessFeature } = fixture();
  for (const input of [{}, { db, sessions }, { db, canUserAccessFeature }, { sessions, canUserAccessFeature }]) {
    assert.throws(() => createReviewCareAccess(input), status(503));
  }
});
