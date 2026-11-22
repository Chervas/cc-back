'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const Module = require('node:module');
let externalCalls = 0;
const forbidden = () => { externalCalls++; throw Error('FORBIDDEN_EXTERNAL_CALL'); };
for (const [name, method] of [['node:net', 'connect'], ['node:net', 'createConnection'], ['node:tls', 'connect'],
  ['node:http', 'request'], ['node:http', 'get'], ['node:https', 'request'], ['node:https', 'get']]) require(name)[method] = forbidden;
global.fetch = forbidden;
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request.startsWith('@aws-sdk/') || request === 'dotenv' || /(?:^|\/)models(?:\/index)?$/.test(request)) forbidden();
  return originalLoad.call(this, request, ...args);
};
const { Op } = require('sequelize');
const C = require('../../../services/googleOAuthAdmissionAttempt.contract');
const { createGoogleOAuthAdmissionAuthority } = require('../../../services/googleOAuthAdmissionAuthority.service');
const O = require('../../../services/googleOAuthAdmissionOwner.adapter');
const { createGoogleOAuthAdmissionCoordinator } = require('../../../services/googleOAuthAdmissionCoordinator.service');
const START = Date.parse('2026-11-22T18:00:00.000Z');
const CLIENT_ID = 'fictitious-first.apps.googleusercontent.com';
const REDIRECT = 'https://crm.example.invalid/oauth/google/callback';
const STATE = 'S'.repeat(43), CODE = 'FICTITIOUS_OAUTH_CODE_ONLY';
const PRIVATE = 'RAW_SQL_OR_PRIVATE_PROVIDER_DETAIL';
const fail = status => Object.assign(Error(PRIVATE), { status });
const denied = status => error => error.status === status && /^google_oauth_admission_/.test(error.code)
  && error.message === error.code && !error.cause && !JSON.stringify({ error, stack: error.stack }).includes(PRIVATE);
function authUrl(service) {
  const value = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, entry] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
    scope: ['openid', 'email', 'profile', O.SCOPES[service]].join(' '), state: STATE,
    code_challenge: 'P'.repeat(43), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) value.searchParams.set(key, entry);
  return value.href;
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-google-first-crm-'));
  const db = new DatabaseSync(path.join(directory, 'attempts.sqlite'));
  const dates = ['session_expires_at', 'requested_at', 'expires_at', 'updated_at', 'completed_at'];
  const numbers = ['actor_user_id', 'clinic_count', 'revision'];
  db.exec('CREATE TABLE GoogleOAuthAdmissionAttempts (' + C.ROW_FIELDS.map(key => key + ' '
    + (numbers.includes(key) ? 'INTEGER' : 'TEXT') + (key === 'attempt_id' ? ' PRIMARY KEY' : '')).join(',') + ')');
  t.after(() => { db.close(); fs.rmSync(directory, { force: true, recursive: true }); });
  const state = { now: START, session: randomUUID(), actorId: 501, clinics: [66, 72], memberships: new Map([[66, ['propietario', 'aceptada']], [72, ['agencia', null]]]),
    authChecks: 0, references: 0, intentWrites: 0, intentReads: 0, roleReads: 0, calls: [], ownerRows: new Map(), exchanges: 0, existingMappingWrites: 0 };
  const decode = value => value && Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, dates.includes(key) && entry !== null ? new Date(entry) : entry]));
  const encode = (key, value) => dates.includes(key) && value !== null ? value.toISOString() : value;
  let current, tail = Promise.resolve(); const txContext = new AsyncLocalStorage();
  const required = options => { assert.equal(options.transaction, current); assert.equal(options.logging, false); assert(current && !current.finished); };
  const sequelize = { transaction(work) {
    const result = tail.then(async () => {
      db.exec('BEGIN IMMEDIATE'); current = { LOCK: { UPDATE: 'UPDATE' } };
      try { const value = await txContext.run(current, () => work(current)); db.exec('COMMIT'); current.finished = 'commit'; return value; }
      catch (error) { db.exec('ROLLBACK'); current.finished = 'rollback'; throw error; }
      finally { current = null; }
    }); tail = result.catch(() => {}); return result;
  } };
  const instance = id => ({ get() { return decode(db.prepare('SELECT * FROM GoogleOAuthAdmissionAttempts WHERE attempt_id=?').get(id)); },
    async update(patch, options) {
      required(options); assert.equal(options.lock, current.LOCK.UPDATE); state.intentWrites++;
      assert.deepEqual(Object.keys(patch).sort(), ['completed_at', 'revision', 'state', 'updated_at']);
      const entries = Object.entries(patch);
      db.prepare('UPDATE GoogleOAuthAdmissionAttempts SET ' + entries.map(([key]) => key + '=?').join(',') + ' WHERE attempt_id=?')
        .run(...entries.map(([key, value]) => encode(key, value)), id);
    } });
  const model = { async findByPk(id, options) { required(options); assert.equal(options.lock, current.LOCK.UPDATE); state.intentReads++;
    return db.prepare('SELECT attempt_id FROM GoogleOAuthAdmissionAttempts WHERE attempt_id=?').get(id) ? instance(id) : null; },
  async create(row, options) { required(options); state.intentWrites++;
    db.prepare('INSERT INTO GoogleOAuthAdmissionAttempts (' + C.ROW_FIELDS.join(',') + ') VALUES (' + C.ROW_FIELDS.map(() => '?').join(',') + ')')
      .run(...C.ROW_FIELDS.map(key => encode(key, row[key]))); return instance(row.attempt_id); } };
  const sessions = {
    async verifyNormal(token) {
      state.authChecks++; assert.equal(token, 'fictitious.normal.jwt'); await state.onVerify?.();
      if (state.authError) throw fail(state.authError);
      return { userId: state.actorId, jti: state.session, exp: (START + 3600000) / 1000,
        type: state.delegated ? 'cc_delegated' : 'cc_access', sessionVersion: 1 };
    },
    async verifyNormalReference(reference, options) {
      state.references++; assert.equal(options.transaction, current); assert.equal(options.requireEmail, undefined);
      assert.deepEqual(reference, { userId: state.actorId, sessionRef: state.session, expiresAt: new Date(START + 3600000) });
      if (state.sessionRevoked) throw fail(401);
    },
  };
  const noWrite = new Proxy({}, { get() { return forbidden; } });
  const models = { sequelize, Clinica: { async findAll(options) {
    required(options); assert.equal(options.lock, current.LOCK.UPDATE); assert.equal(options.limit, 1001);
    assert.deepEqual(options.attributes, ['id_clinica']);
    return state.clinics.filter(id => options.where.grupoClinicaId === 29 || options.where.id_clinica === id).map(id => ({ id_clinica: id }));
  } }, UsuarioClinica: { async findAll(options) {
    required(options); state.roleReads++; assert.equal(options.lock, current.LOCK.UPDATE);
    assert.deepEqual(options.where.rol_clinica[Op.in], ['propietario', 'agencia']);
    assert.deepEqual(options.where[Op.or], [{ estado_invitacion: null }, { estado_invitacion: 'aceptada' }]);
    return options.where.id_clinica[Op.in].filter(id => {
      const membership = state.memberships.get(id); return membership && ['propietario', 'agencia'].includes(membership[0])
        && [null, 'aceptada'].includes(membership[1]);
    }).map(id => ({ id_clinica: id }));
  } }, GoogleConnections: noWrite, GoogleConnectionAssignment: noWrite, GoogleOAuthBrokerBinding: noWrite,
  ClinicBusinessLocation: noWrite, ClinicWebAsset: noWrite, ClinicAnalyticsProperty: noWrite, ClinicGoogleAdsAccount: noWrite };
  const metadata = row => ({ ...row.proof, state: row.state, authorizationConfirmed: false, connected: false });
  const client = { async execute(command, options) {
    assert.equal(txContext.getStore(), undefined, 'No Owner network call within this request SQL transaction');
    assert.equal(options.timeoutMs, 10000);
    const action = command.operation.replace('google.oauth.admission.', '').replace('.v1', '');
    assert(['begin', 'status', 'finish', 'abort'].includes(action));
    const { requestId, operation, tenantRef, connectionRef, assetRef, payload } = command;
    assert.deepEqual(Object.keys(command).sort(), ['assetRef', 'connectionRef', 'operation', 'payload', 'requestId', 'tenantRef']);
    assert.equal(tenantRef, 'clinic:' + Math.min(...state.clinics));
    assert.equal(connectionRef, 'google-first:' + payload.attemptId);
    assert.equal(assetRef, 'google-oauth:' + payload.service + ':' + state.selectedScope);
    const proof = O.proof(Object.fromEntries(['attemptId', 'bindingDigest', 'service', 'expiresAt'].map(key => [key, payload[key]])));
    assert.deepEqual(Object.keys(payload).sort(), (action === 'finish'
      ? ['attemptId', 'bindingDigest', 'clinicSetDigest', 'code', 'expiresAt', 'service', 'state']
      : ['attemptId', 'bindingDigest', 'clinicSetDigest', 'expiresAt', 'service']).sort());
    assert.equal(payload.clinicSetDigest, createHash('sha256').update(JSON.stringify(state.clinics)).digest('hex'));
    assert(!JSON.stringify(command).includes(state.session)); assert(!JSON.stringify(command).includes('fictitious.normal.jwt'));
    // The diagnostic call record intentionally excludes the transient code.
    state.calls.push({ requestId, operation, tenantRef, connectionRef, assetRef, clinicSetDigest: payload.clinicSetDigest, proof, action });
    state.lastCommandReference = command;
    await state.beforeOwner?.(action, payload);
    let row = state.ownerRows.get(proof.attemptId);
    const refs = JSON.stringify([tenantRef, connectionRef, assetRef]);
    if (row && (JSON.stringify(row.proof) !== JSON.stringify(proof) || row.refs !== refs)) throw fail(409);
    if (action === 'begin' || action === 'abort') {
      if (!row) { row = { proof, refs, state: action === 'abort' ? 'aborted' : 'prepared' }; state.ownerRows.set(proof.attemptId, row); }
      else if (action === 'abort' && ['prepared', 'exchanging', 'candidate_ready'].includes(row.state)) row.state = 'aborted';
    }
    if (!row) throw fail(409);
    if (action === 'finish') {
      if (row.state !== 'prepared') throw fail(409);
      assert.equal(payload.state, STATE); assert.equal(payload.code, CODE);
      row.state = 'exchanging'; state.exchanges++; // Model Owner's durable burn in this wire double, not production persistence.
      if (state.unknownFinish) { row.state = 'interrupted'; throw Error(PRIVATE); }
      await state.inExchange?.();
      if (row.state === 'exchanging') row.state = 'candidate_ready';
    }
    let data = metadata(row);
    if (action === 'begin' && row.state === 'prepared') data.authorizationUrl = authUrl(proof.service);
    if (state.responseMutation) data = state.responseMutation(data, action);
    if (state.afterOwner) await state.afterOwner(action);
    if (state.unknownBegin && action === 'begin') { state.unknownBegin = false; throw Error(PRIVATE); }
    if (state.unknownAbort && action === 'abort') { state.unknownAbort = false; throw Error(PRIVATE); }
    return { requestId, replayed: false, data };
  } };
  const make = () => {
    const authority = createGoogleOAuthAdmissionAuthority({ models, sessions, now: () => new Date(state.now) });
    const owner = O.createGoogleOAuthAdmissionOwner({ client, clientId: CLIENT_ID, redirectUri: REDIRECT });
    return { authority, owner, coordinator: createGoogleOAuthAdmissionCoordinator({ model, publicationModel:{ async findByPk() { return null; } },
      sequelize, authority, owner, now: () => new Date(state.now) }) };
  };
  const req = () => ({ headers: { authorization: 'Bearer fictitious.normal.jwt' }, userData: { userId: state.actorId },
    authSession: { id: state.session, expiresAt: (START + 3600000) / 1000 } });
  const command = (extra = {}) => { const result = { attemptId: randomUUID(), scopeKey: 'group:29', service: 'business_profile', ...extra };
    state.selectedScope = result.scopeKey; return result; };
  return { sqlite: db, current: () => current, state, models, sessions, model, sequelize, make, req, command, client,
    rows: () => db.prepare('SELECT * FROM GoogleOAuthAdmissionAttempts').all(), ...make() };
}


module.exports = { fixture, START, CLIENT_ID, REDIRECT, STATE, CODE, authUrl };
