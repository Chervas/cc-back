'use strict';
const { randomBytes, createHash } = require('node:crypto'); const { fail, BrokerError } = require('./errors');
const { bindingFor, operationsFor, normalizeScopes } = require('./google-oauth-contract'); const { token } = require('./google-oauth-secrets');
const { eventFor } = require('./audit'); const { PROVIDER } = require('./google-business-profile-contract');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = (binding, policy) => hash(JSON.stringify([policy.version, binding.connectionRef, binding.secretArn, binding.clientSecretArn,
  binding.oauth.subject, binding.oauth.redirectUri, [...binding.oauth.scopes].sort(),
  ...(binding.provider === PROVIDER ? [] : [binding.provider, binding.googleSubject])]));
function createGoogleOAuth({ store, secrets, http, policy, now = () => Date.now(), onActivated = () => {} }) {
  const memory = new Map(); const running = new Map();
  const query = (sql, ...args) => store.db.prepare(sql).get(...args);
  const audit = (request, principal, action, result, reason) => eventFor({ ...request, requestId: request.payload.flowId || request.requestId }, principal, policy, action, result, reason, now());
  const append = event => { if (store.backlog().pending + 1 > policy.maxBacklog) fail('audit_unavailable'); store.appendAudit(event); };
  const change = (flow, state) => store.db.prepare('UPDATE google_oauth_flows SET state=?,updated_at=? WHERE id=?').run(state, now(), flow.id);
  function clear(id) { memory.get(id)?.verifier.fill(0); memory.delete(id); }
  function checked(request, principal, binding) {
    const flow = query('SELECT * FROM google_oauth_flows WHERE id=?', request.payload.flowId || request.requestId);
    if (!flow || flow.principal !== principal.id || flow.tenant !== request.tenantRef || flow.connection !== request.connectionRef
      || flow.asset !== request.assetRef || flow.config_digest !== fingerprint(binding, policy)) fail('scope_denied');
    return flow;
  }
  function metadata(flow, binding) {
    const connection = query('SELECT state,expires_at FROM connections WHERE ref=?', binding.connectionRef);
    const revoked = !!query('SELECT 1 FROM asset_revocations WHERE tenant=? AND connection=? AND asset=?', flow.tenant, flow.connection, flow.asset);
    return { flowId: flow.id, connectionRef: flow.connection, googleUserId: binding.oauth.subject,
      status: flow.state, secretVersion: ['staged','activating','active'].includes(flow.state) ? flow.id : null,
      accessBlocked: connection?.state !== 'active' || connection?.expires_at !== null && connection?.expires_at <= now() || revoked || flow.state === 'activating' };
  }
  function complete(flow, request, principal, state, reason) {
    store.transaction(() => {
      const current = query('SELECT state FROM google_oauth_flows WHERE id=?', flow.id);
      if (!current || !['staging','activating'].includes(current.state)) fail('oauth_flow_interrupted');
      append(audit(request, principal, 'integration.completed', 'success', reason));
      change(flow, state);
      if (state === 'active') store.db.prepare('UPDATE connections SET revision=revision+1 WHERE ref=?').run(flow.connection);
    });
    if (state === 'active') onActivated(flow.connection);
    return metadata(query('SELECT * FROM google_oauth_flows WHERE id=?', flow.id), bindingFor(policy.connections.find(b => b.connectionRef === flow.connection)));
  }
  async function reconcile(flow, request, principal, binding, signal) {
    if (!flow.secret_digest) fail('oauth_flow_interrupted');
    if (flow.state === 'staging') {
      await secrets.candidate(binding, flow.id, flow.secret_digest, signal);
      return complete(flow, request, principal, 'staged', 'oauth_credentials_staged');
    }
    if (flow.state === 'activating') {
      await secrets.activate(binding, flow.id, flow.baseline_version, flow.secret_digest, signal);
      return complete(flow, request, principal, 'active', 'oauth_credentials_activated');
    }
    return metadata(flow, binding);
  }
  return {
    close() { for (const controller of running.values()) controller.abort(); for (const id of memory.keys()) clear(id); },
    async execute({ request, principal, binding }) {
      bindingFor(binding);
      const operations = operationsFor(binding.provider);
      const name = Object.keys(operations).find(k => operations[k] === request.operation); if (!name) fail('operation_denied');
      const id = request.payload.flowId || request.requestId;
      if (running.size >= 8 || running.has(id)) fail('oauth_flow_busy');
      const controller = new AbortController(); running.set(id, controller); const timer = setTimeout(() => controller.abort(), 25000); timer.unref?.();
      const signal = controller.signal;
      try {
        for (const [key, item] of memory) if (item.expiresAt <= now()) clear(key);
        if (!['status','abort'].includes(name)) store.assertAssetActive(request);
        if (name === 'begin') {
          const old = query('SELECT * FROM google_oauth_flows WHERE id=?', id);
          if (old) {
            checked(request, principal, binding);
            if (old.state_hash !== hash(request.payload.state)) fail('idempotency_conflict');
            if (old.state !== 'awaiting' || old.expires_at <= now() || !memory.has(id)) fail('oauth_flow_interrupted');
            return { requestId: request.requestId, data: memory.get(id).authorization(request.payload.state), replayed: true };
          }
          if (memory.size >= 128 || store.backlog().pending + 2 > policy.maxBacklog) fail('audit_unavailable');
          const application = await secrets.application(binding, signal); const baseline = await secrets.baseline(binding, application.clientId, signal);
          const clientId = application.clientId;
          const needsConsent = !baseline.reusable || query('SELECT state FROM connections WHERE ref=?', binding.connectionRef)?.state === 'revoked';
          const verifier = Buffer.from(randomBytes(32).toString('base64url')); const expiresAt = now() + 600000;
          const authorization = state => {
            const params = new URLSearchParams({ client_id: clientId, redirect_uri: binding.oauth.redirectUri, response_type: 'code',
              scope: binding.oauth.scopes.join(' '), access_type: 'offline', include_granted_scopes: 'true', login_hint: binding.oauth.subject,
              state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
            if (needsConsent) params.set('prompt','consent');
            return { flowId: id, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, expiresAt };
          };
          try {
            store.transaction(() => {
              const active = query("SELECT 1 FROM google_oauth_flows WHERE connection=? AND (state IN ('exchanging','staging','staged','activating') OR (state='awaiting' AND expires_at>?)) LIMIT 1", binding.connectionRef, now());
              if (active) fail('oauth_flow_busy');
              if (query('SELECT COUNT(*) AS n FROM google_oauth_flows WHERE connection=? AND secret_digest IS NOT NULL AND updated_at>?', binding.connectionRef, now()-3600000).n >= 6) fail('rate_limited');
              if (query('SELECT COUNT(*) AS n FROM google_oauth_flows WHERE connection=? AND secret_digest IS NOT NULL AND updated_at>?', binding.connectionRef, now()-86400000).n >= 80) fail('rate_limited');
              store.assertAssetActive(request);
              append(audit(request, principal, 'integration.requested', 'accepted', 'oauth_authorization_requested'));
              store.db.prepare('INSERT INTO google_oauth_flows(id,principal,tenant,connection,asset,state_hash,config_digest,created_at,expires_at,updated_at,state,baseline_version,app_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, principal.id, request.tenantRef, request.connectionRef, request.assetRef, hash(request.payload.state), fingerprint(binding,policy), now(), expiresAt, now(), 'awaiting', baseline.version, application.secretVersion);
            });
            memory.set(id, { verifier, expiresAt, authorization });
            return { requestId: request.requestId, data: authorization(request.payload.state), replayed: false };
          } catch (error) { verifier.fill(0); throw error; }
        }
        if (name === 'abort' && !query('SELECT 1 FROM google_oauth_flows WHERE id=?', id)) {
          // A lost begin request may still arrive after the API cancels it.
          // Persist a tombstone even when begin never reached this process.
          store.transaction(() => {
            if (query('SELECT 1 FROM google_oauth_flows WHERE id=?', id)) return;
            append(audit(request, principal, 'integration.failed', 'denied', 'oauth_authorization_aborted'));
            store.db.prepare('INSERT INTO google_oauth_flows(id,principal,tenant,connection,asset,state_hash,config_digest,created_at,expires_at,updated_at,state,baseline_version,app_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(id, principal.id, request.tenantRef, request.connectionRef, request.assetRef, hash('aborted:' + id), fingerprint(binding,policy), now(), now(), now(), 'aborted', '', '');
          });
        }
        let flow = checked(request, principal, binding);
        if (name === 'abort') {
          if (['active','activating'].includes(flow.state)) fail('oauth_flow_busy');
          if (flow.state !== 'aborted') store.transaction(() => { append(audit(request,principal,'integration.failed','denied','oauth_authorization_aborted')); change(flow,'aborted'); });
          clear(id); return { requestId: request.requestId, data: metadata(checked(request,principal,binding),binding), replayed: false };
        }
        if (name === 'status') {
          const data = ['staging','activating'].includes(flow.state) ? await reconcile(flow,request,principal,binding,signal) : metadata(flow,binding);
          return { requestId: request.requestId, data, replayed: false };
        }
        if (name === 'activate') {
          if (flow.state === 'active') return { requestId: request.requestId, data: metadata(flow,binding), replayed: true };
          if (!['staged','activating'].includes(flow.state)) fail('oauth_flow_interrupted');
          if (flow.state === 'staged') store.transaction(() => {
            store.assertAssetActive(request);
            append(audit(request,principal,'integration.requested','accepted','oauth_activation_requested'));
            change(flow,'activating'); store.db.prepare('UPDATE google_oauth_flows SET activation_at=? WHERE id=?').run(now(), id);
          });
          flow = checked(request,principal,binding);
          return { requestId: request.requestId, data: await reconcile(flow,request,principal,binding,signal), replayed: false };
        }
        if (flow.state_hash !== hash(request.payload.state)) fail('oauth_state_invalid');
        if (flow.code_digest && flow.code_digest !== hash(request.payload.code)) fail('idempotency_conflict');
        if (['staging','staged','activating','active'].includes(flow.state)) {
          const data = flow.state === 'staging' ? await reconcile(flow,request,principal,binding,signal) : metadata(flow,binding);
          return { requestId: request.requestId, data, replayed: true };
        }
        const held = memory.get(id);
        if (flow.state !== 'awaiting' || flow.expires_at <= now() || !held) fail('oauth_flow_interrupted');
        store.transaction(() => {
          const current = checked(request,principal,binding); if (current.state !== 'awaiting') fail('oauth_flow_busy');
          store.assertAssetActive(request); change(flow,'exchanging');
          store.db.prepare('UPDATE google_oauth_flows SET code_digest=? WHERE id=?').run(hash(request.payload.code),id);
        });
        try {
          const app = await secrets.application(binding, signal); const baseline = await secrets.baseline(binding,app.clientId,signal);
          if (app.secretVersion !== flow.app_version || baseline.version !== flow.baseline_version) fail('secret_version_changed');
          const form = new URLSearchParams({ grant_type: 'authorization_code', code: request.payload.code, client_id: app.clientId,
            client_secret: app.clientSecret, redirect_uri: binding.oauth.redirectUri, code_verifier: held.verifier.toString() }).toString();
          const response = await http({ hostname:'oauth2.googleapis.com',path:'/token',form,signal });
          if (!token(response.access_token) || response.token_type?.toLowerCase() !== 'bearer' || !Number.isInteger(response.expires_in)
            || response.expires_in < 120 || response.expires_in > 86400 || typeof response.scope !== 'string') fail('oauth_credentials_incomplete');
          const scopes = normalizeScopes(response.scope.split(' ').filter(Boolean));
          if (binding.oauth.scopes.some(s => !scopes.includes(s))) fail('oauth_credentials_incomplete');
          const access = Buffer.from(response.access_token); let identity;
          try { identity = await http({ hostname:'www.googleapis.com',path:'/oauth2/v2/userinfo',token:access,signal }); }
          finally { access.fill(0); }
          if (identity.id !== binding.oauth.subject) fail('oauth_identity_mismatch');
          const reusable = query('SELECT state FROM connections WHERE ref=?', binding.connectionRef)?.state !== 'revoked' && baseline.reusable;
          const refreshToken = response.refresh_token || reusable?.refreshToken;
          if (!token(refreshToken)) fail('oauth_credentials_incomplete');
          const encoded = secrets.encode(binding,app.clientId,{ version:3,provider:binding.provider,connectionRef:binding.connectionRef,
            googleUserId:identity.id,clientId:app.clientId,refreshToken,scopes });
          if (signal.aborted) fail('provider_timeout');
          store.transaction(() => {
            if (checked(request,principal,binding).state !== 'exchanging') fail('oauth_flow_interrupted');
            store.assertAssetActive(request);
            store.db.prepare("UPDATE google_oauth_flows SET state='staging',secret_digest=?,updated_at=? WHERE id=?").run(encoded.digest,now(),id);
          });
          await secrets.stage(binding,id,encoded.body,signal); flow=checked(request,principal,binding);
          return { requestId:request.requestId,data:await reconcile(flow,request,principal,binding,signal),replayed:false };
        } catch (error) {
          const current=checked(request,principal,binding);
          if (current.state==='exchanging') store.transaction(() => { append(audit(request,principal,'integration.failed','unknown','oauth_exchange_unconfirmed'));change(current,'interrupted'); });
          throw error;
        } finally { clear(id); }
      } catch (error) { throw error instanceof BrokerError ? error : new BrokerError('internal_error'); }
      finally { clearTimeout(timer);running.delete(id); }
    },
  };
}
module.exports = { createGoogleOAuth };
