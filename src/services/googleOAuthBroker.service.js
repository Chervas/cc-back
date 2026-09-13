'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { Op } = require('sequelize');
const fs = require('node:fs'); const path = require('node:path');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const { createRepository } = require('./platformAudit.repository');
const { fromFlow, ACTIONS } = require('../../services/platform-audit/src/integration-oauth-event');
const { UUID } = require('../../services/platform-audit/src/event');
const scope = require('./googleOAuthBrokerScope.service');
const C = require('./googleOAuthCohort.contract');
const STATE = /^[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const OPEN = ['begin_pending', 'awaiting', 'processing', 'activation_pending', 'abort_pending'];
const TERMINAL = ['active', 'aborted'];
const SAFE = new Set(['google_oauth_disabled', 'google_oauth_scope_conflict', 'google_oauth_scope_forbidden', 'google_oauth_consumers_pending',
  'google_oauth_flow_busy', 'google_oauth_unavailable', 'google_oauth_state_invalid', 'google_oauth_legacy_closed',
  'google_oauth_service_invalid', 'google_oauth_service_required', 'google_oauth_service_unconfigured',
  'scope_denied', 'connection_blocked', 'asset_revoked', 'secret_unavailable', 'secret_version_changed', 'oauth_state_invalid',
  'oauth_identity_mismatch', 'oauth_credentials_incomplete', 'oauth_flow_busy', 'oauth_flow_interrupted', 'broker_timeout',
  'broker_unavailable', 'broker_response_invalid', 'audit_unavailable', 'auth_invalid']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_oauth_unavailable';
const fail = (code = 'google_oauth_unavailable', status = 503) => scope.fail(code, status);
const stateFor = row => ({ mode: 'broker', authorization_status: row?.state || 'none',
  activation_confirmed: row?.state === 'active', pending: !!row && OPEN.includes(row.state) });
function createGoogleOAuthBroker({ models, client, sessions, audit = createRepository(models.PlatformAuditEvent),
  enabled = kind => process.env.GOOGLE_OAUTH_BROKER_ENABLED === 'true' && (!kind || process.env[C.COHORTS[kind]?.gate] === 'true'),
  workerEnabled = () => process.env.GOOGLE_OAUTH_BROKER_WORKER_ENABLED === 'true', now = () => new Date() }) {
  const bindings = models.GoogleOAuthBrokerBinding; const requests = models.GoogleOAuthBrokerRequest;
  const transact = fn => models.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, fn);
  const guard = row => { if (!enabled(C.cohortOf(row))) fail('google_oauth_disabled'); };
  const plain = row => row?.get ? row.get({ plain: true }) : row;
  const locked = transaction => ({ transaction, lock: transaction.LOCK.UPDATE });
  const authorization = (row, transaction) => scope.authorize({ models, binding: row, actorId: row.actor_user_id,
    requestScopeKey: row.request_scope_key || row.scope_key, sessionRef: row.session_ref,
    expiresAt: new Date(row.expires_at), expectedClinicIds: row.clinic_ids, transaction, sessions });
  async function append(row, action, stage, reason, transaction, worker = false) {
    const health = await audit.health(now(), { includeUnresolved: false, transaction });
    if (health.pending >= 9998 || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
    await audit.append(fromFlow(row, action, stage, reason, now(), worker), { transaction });
  }
  function flowBinding(row) {
    // policy_version is part of the captured binding digest, not a mutable
    // policy supplied by an HTTP caller.
    const binding = { ...plain(row), policy_version: row.policy_version || C.LEGACY_POLICY };
    if (C.digest(binding) !== row.binding_digest) fail('google_oauth_scope_conflict', 409);
    return binding;
  }
  async function call(row, name, payload = {}, timeoutMs = 10000) {
    const requestId = name === 'begin' ? row.flow_id : name === 'activate' ? row.activation_id : randomUUID();
    const result = await client.execute({ requestId, operation: C.operationsFor(flowBinding(row))[name],
      tenantRef: `clinic:${row.clinica_id}`, connectionRef: row.connection_ref, assetRef: row.asset_ref,
      payload: name === 'begin' ? payload : { flowId: row.flow_id, ...payload } }, { timeoutMs });
    if (result.requestId !== requestId || typeof result.replayed !== 'boolean' || !result.data || Array.isArray(result.data)) fail('broker_response_invalid');
    const data = result.data;
    if (name === 'begin') {
      if (Object.keys(data).sort().join(',') !== 'authUrl,expiresAt,flowId' || data.flowId !== row.flow_id
        || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now().getTime() || data.expiresAt > now().getTime() + 600000
        || typeof data.authUrl !== 'string' || data.authUrl.length > 8192) fail('broker_response_invalid');
      let url; try { url = new URL(data.authUrl); } catch { fail('broker_response_invalid'); }
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password
        || url.hash || url.searchParams.get('state') !== payload.state || url.searchParams.get('response_type') !== 'code'
        || url.searchParams.get('code_challenge_method') !== 'S256' || !STATE.test(url.searchParams.get('code_challenge'))
        || url.searchParams.get('login_hint') !== row.google_user_id) fail('broker_response_invalid');
    } else if (Object.keys(data).sort().join(',') !== 'accessBlocked,connectionRef,flowId,googleUserId,secretVersion,status'
      || data.flowId !== row.flow_id || data.connectionRef !== row.connection_ref || data.googleUserId !== row.google_user_id
      || !['awaiting', 'exchanging', 'staging', 'staged', 'activating', 'active', 'interrupted', 'aborted'].includes(data.status)
      || typeof data.accessBlocked !== 'boolean'
      || data.secretVersion !== (['staged', 'activating', 'active'].includes(data.status) ? row.flow_id : null)) fail('broker_response_invalid');
    return data;
  }
  async function cancel(row, worker = false) {
    return transact(async transaction => {
      const current = await requests.findByPk(row.flow_id, locked(transaction));
      if (!current || !['begin_pending', 'awaiting', 'processing'].includes(current.state)) return;
      await append(current, ACTIONS[0], 'completed', 'authorization_cancelled', transaction, worker);
      await current.update({ state: 'abort_pending', next_attempt_at: now(), lease_token: null, lease_until: null }, { transaction });
    });
  }
  async function stage(row, worker = false) {
    return transact(async transaction => {
      guard(row); const fresh = flowBinding(row);
      await authorization(fresh, transaction);
      const current = await requests.findByPk(row.flow_id, locked(transaction));
      if (!current || current.state !== 'processing') return;
      await append(current, ACTIONS[0], 'completed', 'credentials_staged', transaction, worker);
      await append(current, ACTIONS[1], 'attempted', 'activation_requested', transaction, worker);
      // Activation is a durable, authorized intent. No provider code or token
      // is stored here; assignment/mapping permissions remain unchanged.
      await current.update({ state: 'activation_pending', next_attempt_at: now(), lease_token: null, lease_until: null }, { transaction });
    });
  }
  const service = {
    async bindingFor(connectionId, selectedService) {
      if (selectedService !== undefined && (typeof selectedService !== 'string' || !Object.hasOwn(C.COHORTS, selectedService))) fail('google_oauth_service_invalid', 400);
      if (!C.positive(String(connectionId))) {
        if (selectedService !== undefined) fail('google_oauth_service_unconfigured', 409); return null;
      }
      const rows = await bindings.findAll({ where: { google_connection_id: Number(connectionId) }, raw: true, limit: 5, order: [['cohort', 'ASC']] });
      if (rows.length > 4 || new Set(rows.map(row => C.cohortOf(C.validate(row)))).size !== rows.length
        || new Set(rows.map(row => row.google_user_id)).size > 1) fail('google_oauth_scope_conflict', 409);
      if (selectedService !== undefined) {
        const row = rows.find(binding => C.cohortOf(binding) === selectedService);
        if (!row) fail('google_oauth_service_unconfigured', 409); return row;
      }
      if (!rows.length) return null;
      if (rows.length === 1 && rows[0].policy_version === C.LEGACY_POLICY) return rows[0];
      return { mode: 'broker_services', google_connection_id: Number(connectionId), bindings: rows };
    },
    async assertLegacyAllowed() {
      if (await bindings.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.SearchConsoleBrokerBinding.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.AnalyticsBrokerBinding.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GooglePropertyBrokerRevocation.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GoogleAdsBrokerBinding.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GoogleAdsBrokerRevocation.findOne({ attributes: ['google_user_id'], raw: true })) fail('google_oauth_legacy_closed', 409);
    },
    async assertLegacyConnection(connection) {
      if (await bindings.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.SearchConsoleBrokerBinding.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.AnalyticsBrokerBinding.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GooglePropertyBrokerRevocation.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GoogleAdsBrokerBinding.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
      if (await models.GoogleAdsBrokerRevocation.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: Number(connection?.id) || 0 }, { google_user_id: String(connection?.googleUserId || '') },
      ] }, raw: true })) fail('google_oauth_legacy_closed', 409);
    },
    async begin({ binding, scopeKey, actorId, sessionRef, sessionExpiresAt, returnTo }) {
      if (binding?.mode === 'broker_services') fail('google_oauth_service_required', 409);
      C.validate(binding); guard(binding); C.requestedScope(scopeKey);
      if (binding.policy_version === C.LEGACY_POLICY && scopeKey !== binding.scope_key || !UUID.test(sessionRef) || !Number.isSafeInteger(sessionExpiresAt)) fail('google_oauth_scope_conflict', 409);
      if (!['https://app.clinicaclick.com', 'https://crm.clinicaclick.com', 'http://localhost:4200', 'http://localhost:4203'].includes(returnTo)) fail('google_oauth_state_invalid', 400);
      const state = randomBytes(32).toString('base64url');
      const row = { ...Object.fromEntries(C.FIELDS.map(k => [k, binding[k]])), cohort: C.cohortOf(binding), request_scope_key: scopeKey,
        flow_id: randomUUID(), activation_id: randomUUID(),
        state_hash: hash(state), binding_digest: C.digest(binding), actor_user_id: Number(actorId), session_ref: sessionRef,
        return_to: returnTo, requested_at: now(), expires_at: new Date(Math.min(now().getTime() + 600000, sessionExpiresAt * 1000)),
        state: 'begin_pending', next_attempt_at: new Date(now().getTime() + 120000), lease_token: randomUUID(), lease_until: new Date(now().getTime() + 120000) };
      await transact(async transaction => {
        const authorized = await authorization(row, transaction); row.clinic_ids = authorized.clinicIds;
        const previous = await requests.findOne({ ...locked(transaction), where: { google_connection_id: row.google_connection_id, cohort: row.cohort, state: { [Op.in]: OPEN } } });
        if (previous) fail('google_oauth_flow_busy', 409);
        await requests.create(row, { transaction }); await append(row, ACTIONS[0], 'attempted', 'authorization_requested', transaction);
      });
      try {
        const result = await call(row, 'begin', { state });
        await transact(async transaction => {
          guard(row); await authorization(row, transaction);
          const current = await requests.findByPk(row.flow_id, locked(transaction));
          if (current.state !== 'begin_pending' || current.lease_token !== row.lease_token) fail('google_oauth_flow_busy', 409);
          await current.update({ state: 'awaiting', next_attempt_at: row.expires_at, lease_token: null, lease_until: null }, { transaction });
        });
        return { success: true, mode: 'broker', authUrl: result.authUrl };
      } catch (error) { await cancel(row); fail(safe(error)); }
    },
    async callback({ state, code, denied }) {
      if (typeof state !== 'string' || !STATE.test(state)) return null;
      let row = await requests.findOne({ where: { state_hash: hash(state) }, raw: true });
      if (!row) return null;
      if (row.state !== 'awaiting') return { returnTo: row.return_to, ...stateFor(row) };
      try {
        guard(row);
        if (denied || typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code)) fail('google_oauth_state_invalid', 400);
        row = await transact(async transaction => {
          await authorization(flowBinding(row), transaction);
          const current = await requests.findByPk(row.flow_id, locked(transaction));
          if (current.state !== 'awaiting') return null;
          await current.update({ state: 'processing', lease_token: randomUUID(), lease_until: new Date(now().getTime() + 120000),
            next_attempt_at: new Date(now().getTime() + 120000) }, { transaction }); return plain(current);
        });
        if (!row) return { returnTo: 'https://app.clinicaclick.com', ...stateFor({ state: 'processing' }) };
        const result = await call(row, 'finish', { state, code }, 30000);
        if (result.status !== 'staged') fail('broker_response_invalid');
        await stage(row);
      } catch (error) {
        // Ambiguous transport failures are reconciled by status, never by
        // sending the authorization code again. Local denials cancel the intent.
        if (row && ['auth_invalid', 'google_oauth_scope_conflict', 'google_oauth_scope_forbidden', 'google_oauth_consumers_pending',
          'google_oauth_state_invalid', 'google_oauth_disabled', 'oauth_identity_mismatch', 'oauth_credentials_incomplete', 'oauth_flow_interrupted'].includes(safe(error))) await cancel(row);
        else if (row) await requests.update({ last_error: safe(error) }, { where: { flow_id: row.flow_id, state: 'processing' } });
      }
      const latest = row && await requests.findByPk(row.flow_id, { raw: true });
      return { returnTo: latest?.return_to || 'https://app.clinicaclick.com', ...stateFor(latest) };
    },
    async status({ binding, scopeKey, actorId, sessionRef, sessionExpiresAt }) {
      C.requestedScope(scopeKey);
      if (binding?.mode === 'broker_services') return transact(async transaction => {
        const rows = await bindings.findAll({ ...locked(transaction), where: { google_connection_id: binding.google_connection_id }, raw: true, limit: 5, order: [['cohort', 'ASC']] });
        if (rows.length !== binding.bindings.length || JSON.stringify(rows.map(C.digest)) !== JSON.stringify(binding.bindings.map(C.digest))) fail('google_oauth_scope_conflict', 409);
        await require('./googleOAuthCohortScope.service').authorizeConnection({ models, connectionId: binding.google_connection_id,
          subject: rows[0].google_user_id, requestScopeKey: scopeKey, actorId, sessionRef, expiresAt: new Date(sessionExpiresAt * 1000), transaction, sessions });
        return { mode: 'broker_services', connected: false, services: rows.map(C.cohortOf) };
      });
      C.validate(binding); if (binding.policy_version === C.LEGACY_POLICY && scopeKey !== binding.scope_key) fail('google_oauth_scope_conflict', 409);
      return transact(async transaction => {
        const authorized = await scope.authorize({ models, binding, requestScopeKey: scopeKey, actorId, sessionRef, expiresAt: new Date(sessionExpiresAt * 1000), transaction, sessions });
        const latest = await requests.findOne({ where: { google_connection_id: binding.google_connection_id, cohort: C.cohortOf(binding), binding_digest: C.digest(binding) },
          order: [['requested_at', 'DESC'], ['flow_id', 'DESC']], raw: true, transaction });
        return { ...stateFor(latest), google_service: C.cohortOf(binding), enabled: enabled(C.cohortOf(binding)), connected: false, reason: 'broker_authorization_metadata',
          googleUserId: binding.google_user_id, confirmed_at: authorized.binding.confirmed_at || null };
      });
    },
    async run() {
      if (!enabled() || !workerEnabled()) return { status: 'completed', skipped: true, reason: 'google_oauth_worker_disabled' };
      const cohorts = Object.keys(C.COHORTS).filter(kind => enabled(kind));
      if (!cohorts.length) return { status: 'completed', skipped: true, reason: 'google_oauth_worker_disabled' };
      let confirmed = 0; let failed = 0; const deadline = now().getTime() + 30000;
      for (let n = 0; n < 10 && now().getTime() < deadline; n++) {
        const row = await transact(async transaction => {
          const current = await requests.findOne({ ...locked(transaction), skipLocked: true,
            where: { cohort: { [Op.in]: cohorts }, state: { [Op.in]: OPEN }, next_attempt_at: { [Op.lte]: now() },
              [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lte]: now() } }] }, order: [['requested_at', 'ASC'], ['flow_id', 'ASC']] });
          if (!current) return null;
          await current.update({ lease_token: randomUUID(), lease_until: new Date(now().getTime() + 120000),
            attempts: Math.min(Number(current.attempts) + 1, 1000000000) }, { transaction }); return plain(current);
        });
        if (!row) break;
        try {
          guard(row); const budget = Math.min(10000, deadline - now().getTime()); if (budget <= 0) fail('broker_timeout');
          if (['begin_pending', 'awaiting'].includes(row.state)) { await cancel(row, true); continue; }
          if (row.state === 'activation_pending') {
            const binding = await bindings.findOne({ where: C.keyFor(row), raw: true });
            if (!binding || C.digest(binding) !== row.binding_digest) fail('google_oauth_scope_conflict', 409);
          }
          const result = await call(row, row.state === 'activation_pending' ? 'activate' : row.state === 'abort_pending' ? 'abort' : 'status', {}, budget);
          if (row.state === 'processing') {
            if (result.status === 'staged') {
              try { await stage(row, true); } catch (error) {
                if (['auth_invalid', 'google_oauth_scope_conflict', 'google_oauth_scope_forbidden', 'google_oauth_consumers_pending'].includes(safe(error))) await cancel(row, true);
                else throw error;
              }
            } else if (['awaiting', 'exchanging', 'interrupted', 'aborted'].includes(result.status)) await cancel(row, true);
            else fail('broker_response_invalid');
            continue;
          }
          if (result.status !== (row.state === 'activation_pending' ? 'active' : 'aborted')) fail('broker_response_invalid');
          await transact(async transaction => {
            const binding = row.state === 'activation_pending' ? await bindings.findOne({ ...locked(transaction), where: C.keyFor(row) }) : null;
            const current = await requests.findByPk(row.flow_id, locked(transaction));
            if (!current || current.state !== row.state || current.lease_token !== row.lease_token || current.lease_until <= now()) fail();
            if (row.state === 'activation_pending') {
              if (!binding || C.digest(plain(binding)) !== row.binding_digest) fail('google_oauth_scope_conflict', 409);
              await binding.update({ secret_version: row.flow_id, confirmed_at: now() }, { transaction });
              await append(row, ACTIONS[1], 'completed', 'activation_confirmed', transaction, true);
            }
            await current.update({ state: result.status, completed_at: now(), lease_token: null, lease_until: null, last_error: null }, { transaction });
          });
          confirmed++;
        } catch (error) {
          failed++;
          await requests.update({ lease_token: null, lease_until: null, last_error: safe(error),
            next_attempt_at: new Date(now().getTime() + Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 12))) },
          { where: { flow_id: row.flow_id, lease_token: row.lease_token, state: { [Op.in]: OPEN } } });
        }
      }
      return { status: failed ? 'failed' : 'completed', retryable: false, confirmed, failed };
    },
  };
  return service;
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail();
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail();
    return fs.readFileSync(filename);
  } catch { fail(); }
}
let singleton; const clients = new Map();
function instance() {
  return singleton ||= createGoogleOAuthBroker({ models: require('../../models'), sessions: require('./accessSession.service'), client: {
    execute(command, options) {
      const kind = Object.keys(C.COHORTS).find(kind => Object.values(require('../../services/integrations-broker/src/google-oauth-contract')
        .operationsFor(C.COHORTS[kind].provider)).includes(command.operation));
      if (!kind) fail();
      if (!clients.has(kind)) {
        const prefix = kind === 'business_profile' ? 'INTEGRATIONS_BROKER' : 'GOOGLE_' + kind.toUpperCase() + '_BROKER';
        const keyPrefix = kind === 'business_profile' ? 'GOOGLE_OAUTH_BROKER' : prefix + '_OAUTH';
        clients.set(kind, createIntegrationsBrokerClient({ origin: process.env[prefix + '_ORIGIN'], audience: process.env[prefix + '_AUDIENCE'],
          keyId: process.env[keyPrefix + '_KEY_ID'], privateKey: privateFile(process.env[keyPrefix + '_KEY_FILE']),
          ca: privateFile(process.env[prefix + '_CA_FILE']), timeoutMs: 30000 }));
      }
      return clients.get(kind).execute(command, options);
    },
  } });
}
module.exports = { createGoogleOAuthBroker, safe, OPEN, TERMINAL,
  ...Object.fromEntries(['bindingFor', 'assertLegacyAllowed', 'assertLegacyConnection', 'begin', 'callback', 'status'].map(name => [name, (...args) => instance()[name](...args)])),
  run: () => process.env.GOOGLE_OAUTH_BROKER_WORKER_ENABLED === 'true' && process.env.GOOGLE_OAUTH_BROKER_ENABLED === 'true'
    ? instance().run() : Promise.resolve({ status: 'completed', skipped: true, reason: 'google_oauth_worker_disabled' }),
};
