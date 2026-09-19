'use strict';
const { BrokerError, fail } = require('./errors'), { eventFor } = require('./audit');
const C = require('./meta-marketing-oauth-contract'), D = require('./meta-marketing-discovery-contract'), { GRAPH_VERSION } = require('./meta-marketing-contract');
function createMetaMarketingOAuth({ store, policy, secrets, http, now = () => Date.now(), assetDiscovery = false, onAbort = () => {} }) {
  // This table is installed only by the explicit onboarding runtime, not the generic broker.
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_oauth_flows (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL,
    state_hash TEXT NOT NULL UNIQUE, config_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, clinic_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('awaiting','exchanging','staging','staged','interrupted','aborted')),
    code_digest TEXT UNIQUE, secret_digest TEXT, credential_metadata TEXT);
    CREATE INDEX IF NOT EXISTS meta_marketing_oauth_scope ON meta_marketing_oauth_flows(connection,state,created_at);`);
  // A process may die after Meta consumed the one-use code. Keep its uncertain
  // state until an explicit abort; never replay it or mutate another owner's work at startup.
  const running = new Map(); let closed = false;
  const rowFor = id => store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(id);
  function checked(request, binding, principal) {
    const row = rowFor(request.payload.flowId || request.requestId);
    if (!row || row.tenant !== request.tenantRef || row.connection !== request.connectionRef || row.asset !== request.assetRef
      || row.config_digest !== C.fingerprint(binding)
      || !principal.id.startsWith('control:') && row.principal !== principal.id) fail('scope_denied');
    return row;
  }
  const active = (request, binding) => { if (closed) fail('connection_blocked'); store.connection(binding.connectionRef, now()); store.assertAssetActive(request); };
  function append(request, principal, action, result, reason) {
    if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
    store.appendAudit(eventFor({ ...request, requestId: request.payload.flowId || request.requestId }, principal, policy, action, result, reason, now()));
  }
  function metadata(row, binding) {
    const candidate = row.state === 'staged' ? C.metadata(JSON.parse(row.credential_metadata), binding) : null;
    return { flowId: row.id, status: row.state, connectionRef: row.connection, scopeKey: C.bindingFor(binding).scopeKey,
      expiresAt: row.expires_at, accessBlocked: true, candidate: candidate ? { versionId: row.id, digest: row.secret_digest, ...candidate } : null };
  }
  async function reconcile(request, principal, binding, signal) {
    let row = checked(request, binding, principal);
    if (row.state !== 'staging') return metadata(row, binding);
    active(request, binding); if (signal.aborted) fail('provider_timeout');
    const receipt = await secrets.candidate(binding, row, row.secret_digest, signal);
    return store.transaction(() => {
      row = checked(request, binding, principal); active(request, binding);
      if (signal.aborted) fail('provider_timeout');
      if (row.state !== 'staging') fail('oauth_flow_interrupted');
      const value = C.metadata(receipt.metadata, binding);
      if (receipt.versionId !== row.id || receipt.digest !== row.secret_digest || JSON.stringify(value) !== row.credential_metadata) fail('secret_unavailable');
      append(request, principal, 'integration.completed', 'success', 'oauth_credentials_staged');
      store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='staged',updated_at=? WHERE id=?").run(now(), row.id);
      return metadata(rowFor(row.id), binding);
    });
  }
  const service = {
    close() { closed = true; for (const controller of running.values()) controller.abort(); },
    async execute({ request, principal, binding, policy: livePolicy = policy }) {
      C.authorize({ request, principal, binding }); const b = C.bindingFor(binding);
      const name = assetDiscovery && request.operation === D.OPERATION ? 'assets' : Object.keys(C.OPERATIONS).find(k => C.OPERATIONS[k] === request.operation);
      if (!name) fail('operation_denied'); (name === 'assets' ? D.validate : C.validators[name])(request.payload);
      const id = request.payload.flowId || request.requestId;
      if (closed) fail('connection_blocked');
      if (name === 'abort') {
        // Abort is allowed while an exchange is in flight and before a delayed begin arrives.
        const result = store.transaction(() => {
          if (!rowFor(id)) {
            append(request, principal, 'integration.failed', 'denied', 'oauth_authorization_aborted');
            store.db.prepare(`INSERT INTO meta_marketing_oauth_flows(id,principal,tenant,connection,asset,state_hash,config_digest,
              scope_digest,clinic_digest,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'aborted')`)
              .run(id, principal.id.replace(/^control:/,'gateway:'), request.tenantRef, request.connectionRef, request.assetRef,
                C.hash('aborted:' + id), C.fingerprint(binding), C.hash('aborted'), C.clinicDigest(b), now(), now(), now());
          } else {
            const row = checked(request,binding,principal);
            if (row.state !== 'aborted') {
              append(request,principal,'integration.failed','denied','oauth_authorization_aborted');
              store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='aborted',updated_at=? WHERE id=?").run(now(),id);
            }
          }
          return metadata(checked(request,binding,principal),binding);
        });
        running.get(id)?.abort(); onAbort(id); return { requestId: request.requestId, data: result, replayed: false };
      }
      if (name === 'status' && running.has(id)) return { requestId: request.requestId, data: metadata(checked(request,binding,principal),binding), replayed: false };
      if (running.has(id) || running.size >= 2) fail('oauth_flow_busy');
      const controller = new AbortController(), signal = controller.signal; running.set(id,controller);
      const timer = setTimeout(() => controller.abort(),25000); timer.unref?.();
      const discoveryAudit = (action,result,reason) => {
        if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
        store.appendAudit(eventFor(request,principal,policy,action,result,reason,now()));
      };
      try {
        if (name === 'assets') {
          const authority=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey]));
          const assertCurrent = () => {
            const configured=livePolicy.principals.find(p=>p.id===principal.id);
            if(!configured?.enabled||C.hash(JSON.stringify([configured.id,configured.keyId,configured.publicKey]))!==authority)fail('scope_denied');
            require('./auth').authorize(configured,request,livePolicy);
            const currentBinding=livePolicy.connections.find(c=>c.connectionRef===binding.connectionRef);
            if(C.fingerprint(currentBinding)!==C.fingerprint(binding))fail('scope_denied');
            const row = checked(request,binding,principal); active(request,binding);
            if (signal.aborted) fail('provider_timeout');
            if (row.state !== 'staged' || row.scope_digest !== request.payload.scopeDigest) fail('scope_denied');
            const value=C.metadata(JSON.parse(row.credential_metadata),binding);
            if ([value.expiresAt,value.dataAccessExpiresAt].some(v=>v!==null && v<=now())) fail('credential_revoked');
            return row;
          };
          const row=assertCurrent();
          store.transaction(()=>{assertCurrent();if(store.backlog().pending+2>policy.maxBacklog)fail('audit_unavailable');
            discoveryAudit('integration.requested','accepted','meta_inventory_requested');});
          const assets=await secrets.withCandidate(binding,row,row.secret_digest,async context=>{
            const fresh=assertCurrent();if(JSON.stringify(context.metadata)!==fresh.credential_metadata)fail('secret_unavailable');
            return http.discover({binding,...context,signal,authorize:assertCurrent});
          },signal);
          return store.transaction(()=>{
            const fresh=assertCurrent(),metadata=C.metadata(JSON.parse(fresh.credential_metadata),binding);
            const result=D.result({assets,metadata,request,binding,row:fresh,now:now()});
            discoveryAudit('integration.completed','success','meta_inventory_verified');
            return {requestId:request.requestId,data:result,replayed:false};
          });
        }
        if (name === 'begin') {
          active(request,binding);
          const old = rowFor(id), p = request.payload;
          if (old) {
            checked(request,binding,principal);
            if (old.state !== 'awaiting' || old.expires_at <= now()) fail('oauth_flow_interrupted');
            if (old.state_hash !== C.hash(p.state) || old.scope_digest !== p.scopeDigest || old.clinic_digest !== p.clinicSetDigest || old.expires_at !== p.expiresAt) fail('idempotency_conflict');
          } else {
            if (p.expiresAt <= now() || p.expiresAt > now()+600000 || p.expiresAt > binding.expiresAt || p.clinicSetDigest !== C.clinicDigest(b)) fail('scope_denied');
            if (store.backlog().pending + 2 > policy.maxBacklog) fail('audit_unavailable');
            await secrets.preflight(binding,signal);
            store.transaction(() => {
              active(request,binding); if (signal.aborted) fail('provider_timeout');
              if (rowFor(id)) fail('oauth_flow_interrupted');
              const count = store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_oauth_flows WHERE connection=? AND created_at>?').get(binding.connectionRef,now()-3600000).n;
              if (count >= 6) fail('rate_limited');
              if (store.db.prepare("SELECT 1 FROM meta_marketing_oauth_flows WHERE connection=? AND (state IN ('exchanging','staging','staged') OR (state='awaiting' AND expires_at>?)) LIMIT 1").get(binding.connectionRef,now())) fail('oauth_flow_busy');
              append(request,principal,'integration.requested','accepted','oauth_authorization_requested');
              store.db.prepare(`INSERT INTO meta_marketing_oauth_flows(id,principal,tenant,connection,asset,state_hash,config_digest,
                scope_digest,clinic_digest,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'awaiting')`)
                .run(id,principal.id,request.tenantRef,request.connectionRef,request.assetRef,C.hash(p.state),C.fingerprint(binding),p.scopeDigest,p.clinicSetDigest,now(),p.expiresAt,now());
            });
          }
          if (signal.aborted) fail('provider_timeout');
          const params = new URLSearchParams({ client_id:b.appId,redirect_uri:b.redirectUri,response_type:'code',scope:b.scopes.join(','),state:p.state });
          return { requestId:request.requestId,data:{flowId:id,authUrl:`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`,expiresAt:p.expiresAt},replayed:!!old };
        }
        let row = checked(request,binding,principal);
        if (name === 'status') return {requestId:request.requestId,data:await reconcile(request,principal,binding,signal),replayed:false};
        active(request,binding);
        if (row.state_hash !== C.hash(request.payload.state)) fail('oauth_state_invalid');
        if (row.code_digest && row.code_digest !== C.hash(request.payload.code)) fail('idempotency_conflict');
        if (['staging','staged'].includes(row.state)) return {requestId:request.requestId,data:await reconcile(request,principal,binding,signal),replayed:true};
        if (row.state !== 'awaiting' || row.expires_at <= now()) fail('oauth_flow_interrupted');
        store.transaction(() => {
          row=checked(request,binding,principal); active(request,binding);
          if (row.state !== 'awaiting' || row.expires_at <= now()) fail('oauth_flow_interrupted');
          if (store.backlog().pending + 2 > policy.maxBacklog) fail('audit_unavailable');
          const digest=C.hash(request.payload.code);
          if (store.db.prepare('SELECT 1 FROM meta_marketing_oauth_flows WHERE code_digest=?').get(digest)) fail('oauth_state_invalid');
          store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='exchanging',code_digest=?,updated_at=? WHERE id=?").run(digest,now(),id);
        });
        const code=Buffer.from(request.payload.code);
        try {
          await secrets.withApplication(binding, appSecret => http.withExchangedToken({binding,code,appSecret,signal}, async (token, raw, exchangeSignal) => {
            const value=C.metadata(raw,binding); let encoded;
            try {
              row=checked(request,binding,principal); active(request,binding);
              if (exchangeSignal.aborted || signal.aborted) fail('provider_timeout');
              if (row.state !== 'exchanging' || row.expires_at <= now()) fail('oauth_flow_interrupted');
              if ([value.expiresAt,value.dataAccessExpiresAt].some(v=>v!==null && v<=now())) fail('credential_revoked');
              encoded=secrets.encode(binding,row,value,token);
              store.transaction(() => {
                row=checked(request,binding,principal); active(request,binding);
                if (row.state !== 'exchanging' || row.expires_at <= now()) fail('oauth_flow_interrupted');
                store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='staging',secret_digest=?,credential_metadata=?,updated_at=? WHERE id=?")
                  .run(encoded.digest,JSON.stringify(value),now(),id);
              });
              await secrets.stage(binding,row,encoded,exchangeSignal);
              return { versionId:id, digest:encoded.digest };
            } finally { encoded?.body.fill(0); }
          }),signal);
          return {requestId:request.requestId,data:await reconcile(request,principal,binding,signal),replayed:false};
        } finally { code.fill(0); }
      } catch (e) {
        const current=rowFor(id);
        if (current?.state==='exchanging') store.transaction(() => {
          append(request,principal,'integration.failed','unknown','oauth_exchange_unconfirmed');
          store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='interrupted',updated_at=? WHERE id=?").run(now(),id);
        });
        throw new BrokerError(e instanceof BrokerError ? new BrokerError(e.code).code : 'internal_error');
      } finally { clearTimeout(timer);running.delete(id); }
    },
  };
  return service;
}
function createMetaMarketingOAuthOperations(oauth, { assetDiscovery = false } = {}) {
  const operations=Object.fromEntries(Object.entries(C.OPERATIONS).map(([name,operation]) => [operation,
    {provider:C.PROVIDER,control:'meta_marketing_oauth',validate:C.validators[name],authorize:C.authorize,execute:args=>oauth.execute(args)}]));
  if(assetDiscovery)operations[D.OPERATION]={provider:C.PROVIDER,control:'meta_marketing_oauth',validate:D.validate,authorize:C.authorize,execute:args=>oauth.execute(args)};
  return operations;
}
module.exports={createMetaMarketingOAuth,createMetaMarketingOAuthOperations};
