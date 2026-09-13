'use strict';
const { createHmac } = require('node:crypto'); const C = require('./whatsapp-onboarding-contract');
const { BrokerError, fail } = require('./errors'); const { eventFor } = require('./audit');
const { createWhatsappOAuthHttp } = require('./whatsapp-oauth-http');
const { verifyWhatsappGrant } = require('./whatsapp-credential-inspector'); const { createWhatsappPhoneVerifier } = require('./whatsapp-phone-verifier');
function createWhatsappOnboarding({ store, policy, secrets, http, exchangeFactory = options => createWhatsappOAuthHttp(options), now = () => Date.now() }) {
  policy = structuredClone(policy);
  const running = new Map(); let closed = false;
  const get = id => store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(id);
  const change = (id, state) => store.db.prepare('UPDATE whatsapp_onboarding_flows SET state=?,updated_at=? WHERE id=?').run(state, now(), id);
  function checked(request, principal, binding, { configuration = true } = {}) {
    const row = get(request.payload.flowId || request.requestId);
    if (!row || row.connection !== request.connectionRef || row.tenant !== request.tenantRef || row.asset !== request.assetRef
      || row.principal !== principal.id && principal.id !== 'control:whatsapp-onboarding') fail('scope_denied');
    if (configuration && row.config_digest !== C.fingerprint(binding)) fail('idempotency_conflict');
    return row;
  }
  function active(row, signal) {
    if (closed || signal?.aborted) fail('provider_timeout');
    if (row.state === 'aborted' || row.expires_at <= now()) fail('oauth_flow_interrupted');
    if (row.credential_metadata) {
      const metadata = JSON.parse(row.credential_metadata);
      if ([metadata.expiresAt, metadata.dataAccessExpiresAt].some(t => t !== null && t <= now())) fail('credential_revoked');
    }
    const binding = policy.connections.find(b => b.connectionRef === row.connection);
    if (!binding) fail('scope_denied'); const b = C.bindingFor(binding);
    for (const key of [b.scopeKey, ...b.clinicIds.map(id => 'clinic:' + id)]) if (store.db.prepare('SELECT 1 FROM whatsapp_onboarding_scope_blocks WHERE scope_key=?').get(key)) fail('asset_revoked');
    store.connection(row.connection, now()); store.assertAssetActive({ tenantRef: row.tenant, connectionRef: row.connection, assetRef: row.asset });
  }
  function record(request, principal, id, action, result, reason) {
    if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
    store.appendAudit(eventFor({ ...request, requestId: id }, principal, policy, action, result, reason, now()));
  }
  function projection(row, binding) {
    const configChanged = row.config_digest !== C.fingerprint(binding); let blocked = configChanged;
    try { active(row); } catch { blocked = true; }
    return { flowId: row.id, status: row.state, expiresAt: row.expires_at, expired: row.expires_at <= now(),
      scopeKey: row.asset.slice('wa-enroll:'.length), scopeDigest: row.scope_digest,
      clinicCount: row.clinic_count, clinicSetDigest: row.clinic_digest, configurationChanged: configChanged,
      accessBlocked: blocked, connected: false,
      candidate: row.state === 'staged' ? { versionId: row.id, ...JSON.parse(row.credential_metadata) } : null };
  }
  function knownAssets(row, metadata) {
    const waba = store.db.prepare('SELECT * FROM whatsapp_onboarding_wabas WHERE waba_id=?').get(metadata.wabaId);
    const phone = store.db.prepare('SELECT * FROM whatsapp_onboarding_assets WHERE phone_id=?').get(metadata.phoneId);
    if ([waba, phone].filter(Boolean).some(a => a.waba_id !== metadata.wabaId || a.connection !== row.connection
      || a.tenant !== row.tenant || a.asset !== row.asset || a.scope_digest !== row.scope_digest || a.clinic_digest !== row.clinic_digest)) fail('scope_denied');
    return { waba, phone };
  }
  function reserveAsset(row, metadata) {
    const { waba, phone } = knownAssets(row, metadata);
    if (!waba) store.db.prepare('INSERT INTO whatsapp_onboarding_wabas VALUES (?,?,?,?,?,?,?,?)')
      .run(metadata.wabaId, row.connection, row.tenant, row.asset, row.scope_digest, row.clinic_digest, row.id, now());
    if (!phone) store.db.prepare('INSERT INTO whatsapp_onboarding_assets VALUES (?,?,?,?,?,?,?,?,?)')
      .run(metadata.wabaId, metadata.phoneId, row.connection, row.tenant, row.asset, row.scope_digest, row.clinic_digest, row.id, now());
  }
  function checkReserved(row, metadata) {
    const { waba, phone: a } = knownAssets(row, metadata); if (!waba) fail('scope_denied');
    if (!a || a.phone_id !== metadata.phoneId || a.connection !== row.connection || a.tenant !== row.tenant || a.asset !== row.asset
      || a.scope_digest !== row.scope_digest || a.clinic_digest !== row.clinic_digest) fail('scope_denied');
  }
  function confirmed(request, principal, binding, receipt, signal) {
    if (closed || signal?.aborted) fail('provider_timeout');
    return store.transaction(() => {
      const row = checked(request, principal, binding); active(row, signal);
      const metadata = C.grantMetadata(receipt.metadata, binding); checkReserved(row, metadata);
      if (receipt.versionId !== row.id || receipt.digest !== row.secret_digest || JSON.stringify(metadata) !== row.credential_metadata) fail('secret_unavailable');
      if (row.state === 'staged') return projection(row, binding);
      if (row.state !== 'staging') fail('oauth_flow_interrupted');
      record(request, principal, row.id, 'integration.completed', 'success', 'whatsapp_candidate_stored'); change(row.id, 'staged');
      return projection(get(row.id), binding);
    });
  }
  async function dispatch(request, principal, binding, name, signal, attempt) {
    const b = C.bindingFor(binding); const id = request.payload.flowId || request.requestId;
    if (name === 'begin') return store.transaction(() => {
      const old = get(id);
      if (old) {
        const row = checked(request, principal, binding); active(row, signal);
        if (row.state_hash !== C.hash(request.payload.state) || row.scope_digest !== request.payload.scopeDigest
          || row.clinic_digest !== request.payload.clinicSetDigest || row.expires_at !== request.payload.expiresAt) fail('idempotency_conflict');
        if (row.state !== 'awaiting') fail('oauth_flow_interrupted');
        return { requestId: request.requestId, data: { ...projection(row, binding), authorization: { appId: b.appId, configId: b.configId, redirectUri: b.redirectUri } }, replayed: true };
      }
      if (request.payload.expiresAt <= now() || request.payload.expiresAt > now() + 600000 || request.payload.clinicSetDigest !== C.clinicDigest(b)) fail('invalid_request');
      const row = { id, principal: principal.id, tenant: request.tenantRef, connection: request.connectionRef, asset: request.assetRef,
        state: 'awaiting', expires_at: request.payload.expiresAt };
      active(row, signal);
      if (store.db.prepare("SELECT 1 FROM whatsapp_onboarding_flows WHERE connection=? AND (state IN ('exchanging','staging','staged') OR (state='awaiting' AND expires_at>?)) LIMIT 1")
        .get(row.connection, now())) fail('oauth_flow_busy');
      if (store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_flows WHERE connection=? AND created_at>?').get(row.connection, now() - 3600000).n >= 10) fail('rate_limited');
      record(request, principal, id, 'integration.requested', 'accepted', 'whatsapp_authorization_requested');
      store.db.prepare('INSERT INTO whatsapp_onboarding_flows(id,principal,tenant,connection,asset,state_hash,config_digest,scope_digest,clinic_digest,clinic_count,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, principal.id, row.tenant, row.connection, row.asset, C.hash(request.payload.state), C.fingerprint(binding), request.payload.scopeDigest,
          request.payload.clinicSetDigest, b.clinicIds.length, now(), row.expires_at, now(), 'awaiting');
      return { requestId: request.requestId, data: { ...projection(get(id), binding), authorization: { appId: b.appId, configId: b.configId, redirectUri: b.redirectUri } }, replayed: false };
    });
    if (name === 'abort') {
      const data = store.transaction(() => {
        let row = get(id);
        if (!row) {
          // A delayed begin can never resurrect a cancellation that arrived first.
          record(request, principal, id, 'integration.failed', 'denied', 'whatsapp_authorization_aborted');
          store.db.prepare('INSERT INTO whatsapp_onboarding_flows(id,principal,tenant,connection,asset,state_hash,config_digest,scope_digest,clinic_digest,clinic_count,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, 'gateway:whatsapp-onboarding', request.tenantRef, request.connectionRef, request.assetRef, C.hash('aborted:' + id), C.fingerprint(binding),
              C.hash('aborted-scope:' + id), C.clinicDigest(b), b.clinicIds.length, now(), now(), now(), 'aborted');
          row = get(id);
        } else {
          checked(request, principal, binding, { configuration: false });
          if (row.state !== 'aborted') { record(request, principal, id, 'integration.failed', 'denied', 'whatsapp_authorization_aborted'); change(id, 'aborted'); row = get(id); }
        }
        return projection(row, binding);
      });
      for (const controller of running.get(id) || []) if (controller.signal !== signal) controller.abort();
      return { requestId: request.requestId, data, replayed: false };
    }
    let row = checked(request, principal, binding, { configuration: name !== 'status' });
    if (name === 'status') {
      const data = projection(row, binding);
      if (row.state !== 'staging' || data.accessBlocked) return { requestId: request.requestId, data, replayed: false };
      // This is a version/digest read only. A missing response or missing version
      // never causes the original authorization code to be submitted again.
      const receipt = await secrets.candidate(binding, row, row.secret_digest, signal);
      return { requestId: request.requestId, data: confirmed(request, principal, binding, receipt, signal), replayed: false };
    }
    active(row, signal);
    if (row.state_hash !== C.hash(request.payload.state)) fail('oauth_state_invalid');
    if (row.code_digest && (row.code_digest !== C.hash(request.payload.code) || row.waba_id !== request.payload.wabaId || row.phone_id !== request.payload.phoneId)) fail('idempotency_conflict');
    if (row.state === 'staged') return { requestId: request.requestId, data: projection(row, binding), replayed: true };
    if (row.state === 'staging') {
      const receipt = await secrets.candidate(binding, row, row.secret_digest, signal);
      return { requestId: request.requestId, data: confirmed(request, principal, binding, receipt, signal), replayed: true };
    }
    if (row.state !== 'awaiting') fail('oauth_flow_interrupted');
    store.transaction(() => {
      row = checked(request, principal, binding); active(row, signal);
      if (row.state !== 'awaiting') fail('oauth_flow_busy');
      // Reject already-owned foreign assets before exchanging a code. Unknown
      // assets are reserved only after provider identity and membership proof.
      knownAssets(row, { wabaId: request.payload.wabaId, phoneId: request.payload.phoneId });
      if (store.db.prepare('SELECT 1 FROM whatsapp_onboarding_flows WHERE code_digest=? LIMIT 1').get(C.hash(request.payload.code))) fail('idempotency_conflict');
      for (const [window, max] of [[3600000, 6], [86400000, 80]]) if (store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_flows WHERE connection=? AND code_digest IS NOT NULL AND created_at>?')
        .get(row.connection, now() - window).n >= max) fail('rate_limited');
      record(request, principal, id, 'integration.requested', 'accepted', 'whatsapp_exchange_requested');
      store.db.prepare("UPDATE whatsapp_onboarding_flows SET state='exchanging',code_digest=?,waba_id=?,phone_id=?,updated_at=? WHERE id=?")
        .run(C.hash(request.payload.code), request.payload.wabaId, request.payload.phoneId, now(), id);
      row = get(id);
    });
    attempt.startedExchange = true;
    const guard = () => { if (closed || signal.aborted) fail('provider_timeout'); const current = checked(request, principal, binding); active(current, signal); return current; };
    await secrets.preflight(binding, signal); guard();
    await secrets.withApplication(binding, async appSecret => {
      guard(); const code = Buffer.from(request.payload.code); let appToken;
      try {
        return await exchangeFactory({ appId: b.appId, redirectUri: b.redirectUri, now }).withExchangedToken({ code, appSecret, signal }, async (token, info) => {
          guard(); appToken = Buffer.concat([Buffer.from(b.appId + '|'), appSecret]);
          let raw;
          try { raw = await http({ action: 'inspect', id: b.appId, token: appToken, candidate: token, signal: info.signal }); } finally { appToken.fill(0); }
          guard();
          // New accounts have no legacy MetaConnection. Learn the subject only
          // from the authenticated Meta diagnostic response, then bind it to the
          // candidate. It is observed identity, not an already approved sender.
          if (!C.id(raw?.data?.user_id)) fail('oauth_credentials_incomplete');
          const grant = verifyWhatsappGrant(raw, { appId: b.appId, subjectId: raw.data.user_id, wabaId: row.waba_id, scopes: b.scopes }, now());
          if (info.expiresAt !== null && (grant.expiresAt === null || grant.expiresAt > info.expiresAt)) fail('oauth_credentials_incomplete');
          const phone = await createWhatsappPhoneVerifier({ http })({ wabaId: row.waba_id, phoneId: row.phone_id, token,
            proof: createHmac('sha256', appSecret).update(token).digest('hex'), signal: info.signal });
          guard(); const metadata = C.grantMetadata({ ...grant, phoneId: phone.phoneId }, binding);
          const encoded = secrets.encode(binding, row, metadata, token);
          try {
            store.transaction(() => {
              const current = guard(); if (current.state !== 'exchanging') fail('oauth_flow_interrupted');
              reserveAsset(current, metadata);
              store.db.prepare("UPDATE whatsapp_onboarding_flows SET state='staging',secret_digest=?,credential_metadata=?,updated_at=? WHERE id=?")
                .run(encoded.digest, JSON.stringify(metadata), now(), id);
            });
            await secrets.stage(binding, get(id), encoded, signal); guard();
          } finally { encoded.body.fill(0); }
          return metadata;
        });
      } finally { code.fill(0); appToken?.fill(0); }
    }, signal);
    guard(); row = get(id);
    const receipt = await secrets.candidate(binding, row, row.secret_digest, signal);
    return { requestId: request.requestId, data: confirmed(request, principal, binding, receipt, signal), replayed: false };
  }
  async function execute(input) {
    if (closed) fail('provider_disabled');
    const request = structuredClone(input.request); const principal = structuredClone(input.principal); const binding = structuredClone(input.binding);
    const name = Object.keys(C.OPERATIONS).find(k => C.OPERATIONS[k] === request.operation); if (!name) fail('operation_denied');
    C.validators[name](request.payload); C.authorize({ request, principal, binding });
    const id = request.payload.flowId || request.requestId; if (!C.uuid(id)) fail('invalid_request');
    if (['begin', 'finish'].includes(name) && [...running.values()].reduce((n, set) => n + set.size, 0) >= 8) fail('rate_limited');
    const controller = new AbortController(); const set = running.get(id) || new Set(); set.add(controller); running.set(id, set);
    let timer; const attempt = { startedExchange: false };
    try {
      return await Promise.race([dispatch(request, principal, binding, name, controller.signal, attempt), new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BrokerError('provider_timeout')); }, 25000); timer.unref?.();
      })]);
    } catch (error) {
      if (!closed && name === 'finish' && attempt.startedExchange) {
        const row = get(id);
        if (row?.state === 'exchanging') store.transaction(() => {
          record(request, principal, id, 'integration.failed', 'unknown', 'whatsapp_exchange_unconfirmed'); change(id, 'interrupted');
        });
      }
      throw new BrokerError(error instanceof BrokerError ? new BrokerError(error.code).code : 'internal_error');
    } finally { clearTimeout(timer); set.delete(controller); if (!set.size) running.delete(id); }
  }
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([name, operation]) => [operation, {
    provider: C.PROVIDER, control: 'whatsapp_onboarding', validate: C.validators[name], authorize: C.authorize, execute,
  }]));
  operations[C.REVOKE] = {
    provider: C.PROVIDER, control: 'revoke_asset', validate: require('./contracts').schema({}), authorize: C.authorize,
    commitRevocation({ request, binding, now: at }) {
      const b = C.bindingFor(binding);
      for (const key of new Set([b.scopeKey, ...b.clinicIds.map(id => 'clinic:' + id)])) store.db.prepare('INSERT OR IGNORE INTO whatsapp_onboarding_scope_blocks VALUES (?,?,?,?)')
        .run(key, request.connectionRef, request.requestId, at);
    },
    onRevoked(request) {
      for (const [id, set] of running) { const row = get(id);
        if (row?.asset === request.assetRef || row?.connection === request.connectionRef) for (const controller of set) controller.abort(); }
    },
  };
  return { execute, operations, close() { closed = true; for (const set of running.values()) for (const controller of set) controller.abort(); } };
}
module.exports = { createWhatsappOnboarding };
