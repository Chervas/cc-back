'use strict';

const { fail } = require('./errors');
const { eventFor } = require('./audit');
const C = require('./meta-marketing-oauth-contract');
const I = require('./meta-marketing-instagram-extension-contract');
const { assetSetDigest, retentionStage } = require('./meta-marketing-credential-renewal-contract');

function createInstagramExtension({ store, settings: configured, autoSlot, environment, oauth, secrets, enrollment, readCandidate, resolveBinding, resolvePolicy, now = Date.now }) {
  const targets = Array.isArray(configured) ? configured : configured ? [configured] : [];
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_instagram_extensions (
    id TEXT PRIMARY KEY, enrollment TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, page TEXT NOT NULL,
    base_digest TEXT NOT NULL, candidate_binding_digest TEXT NOT NULL, scope_digest TEXT NOT NULL,
    asset_digest TEXT NOT NULL, epoch INTEGER NOT NULL, credential_version TEXT NOT NULL, credential_digest TEXT NOT NULL,
    state_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
    candidate_digest TEXT, instagram_id TEXT, selection_digest TEXT, credential_expires_at INTEGER,
    CHECK(state IN ('awaiting','staged','active','aborted')));
    CREATE UNIQUE INDEX IF NOT EXISTS meta_instagram_extension_physical ON meta_marketing_instagram_extensions(instagram_id)
      WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS meta_marketing_instagram_extension_cancellations (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, connection TEXT NOT NULL);`);
  store.transaction(() => {
    store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS meta_instagram_extension_page_live
      ON meta_marketing_instagram_extensions(connection,page) WHERE state <> 'aborted';
      DROP INDEX IF EXISTS meta_instagram_extension_live;`);
  });
  const running = new Map();
  let closed = false;
  const get = id => store.db.prepare('SELECT * FROM meta_marketing_instagram_extensions WHERE id=?').get(id);
  const flow = id => store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(id);
  const tombstone = id => store.db.prepare('SELECT * FROM meta_marketing_instagram_extension_cancellations WHERE id=?').get(id);

  function authorize(context) {
    const scopeKey = C.bindingFor(context.binding).scopeKey;
    const enabled = autoSlot || targets.some(target => target.scopeKey === scopeKey);
    if (!enabled) fail('scope_denied');
    I.authorize(context, environment, { scopeKey });
  }

  async function execute({ request, binding, principal, policy }) {
    const operation = Object.keys(I.OPERATIONS).find(name => I.OPERATIONS[name] === request.operation);
    if (!operation) fail('operation_denied');
    const p = request.payload;
    I.validators[operation](p);
    const id = operation === 'begin' ? request.requestId : p.flowId;
    let row = get(id);
    const scopeKey = C.bindingFor(binding).scopeKey;
    const page = operation === 'begin' ? p.parentPageId : row?.page;
    let settings = targets.find(target => target.scopeKey === scopeKey && (!page || target.parentPageId === page));
    authorize({ request, binding, principal });
    if (row && (row.tenant !== request.tenantRef || row.connection !== request.connectionRef)) fail('scope_denied');
    if (!row && operation === 'status') {
      const cancelled = tombstone(id);
      if (cancelled && (cancelled.tenant !== request.tenantRef || cancelled.connection !== request.connectionRef)) fail('scope_denied');
      return { requestId: request.requestId, replayed: false, data: {
        flowId: id, status: cancelled ? 'aborted' : 'not_found', candidate: null } };
    }
    if (!row && !['begin','abort'].includes(operation)) fail('scope_denied');
    if (closed) fail('connection_blocked');
    const getBase = () => resolveBinding(request.connectionRef);
    const base = getBase();
    if (!settings && autoSlot && page) {
      const authorizeNewSlot = () => {
        const live = enrollment.renewalAuthority(p.enrollmentId, base);
        store.connection(request.connectionRef, now());
        store.assertAssetActive(request);
        if (closed || C.fingerprint(getBase()) !== C.fingerprint(base)
            || live.row.state !== 'active' || live.row.scope !== request.assetRef || live.row.connection !== request.connectionRef
            || live.row.tenant !== request.tenantRef || live.credential.metadata.tokenType !== 'USER'
            || live.credential.epoch !== p.epoch || live.credential.versionId !== p.versionId || live.credential.digest !== p.credentialDigest
            || assetSetDigest(live.assets) !== p.assetSetDigest || !live.assets.some(asset => asset.kind === 'facebook_page' && asset.id === page)
            || targets.some(target => target.parentPageId === page && target.scopeKey !== scopeKey)
            || !C.bindingFor(base).scopes.includes('pages_read_engagement')
            || p.expiresAt <= now() || p.expiresAt > Math.min(now()+600000, base.expiresAt)
            || [live.credential.metadata.expiresAt,live.credential.metadata.dataAccessExpiresAt].some(expiry => expiry !== null && expiry <= now())
            || flow(id) || tombstone(id) || store.backlog().pending >= policy.maxBacklog) fail('scope_denied');
      };
      if (operation === 'begin' && !row) authorizeNewSlot();
      const auditAllocation = () => store.appendAudit(eventFor(request, principal, resolvePolicy(request,principal,policy),
        'integration.requested','accepted','meta_instagram_slot_preparation',now()));
      settings = await autoSlot(base,page,operation === 'begin' && !row ? authorizeNewSlot : null,auditAllocation);
    }
    if (!row && operation === 'abort') {
      // Cancellation can overtake a delayed begin. Bind the tombstone to the caller's actual connection.
      store.transaction(() => {
        if (flow(id)) fail('scope_denied');
        const earlier=tombstone(id);
        if (earlier && (earlier.tenant !== request.tenantRef || earlier.connection !== request.connectionRef)) fail('scope_denied');
        if (!earlier) {
          if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
          store.appendAudit(eventFor(request,principal,resolvePolicy(request,principal,policy),'integration.completed','denied','meta_instagram_extension_cancelled',now()));
          store.db.prepare('INSERT INTO meta_marketing_instagram_extension_cancellations(id,tenant,connection) VALUES (?,?,?)')
            .run(id, request.tenantRef, request.connectionRef);
        }
      });
      return {requestId:request.requestId,replayed:false,data:{flowId:id,status:'aborted',candidate:null}};
    }
    if (!settings) fail('scope_denied');
    const candidateBinding = I.derive(base, settings);
    const baseDigest = C.fingerprint(base), candidateBindingDigest = C.fingerprint(candidateBinding);
    const previous = running.get(id);
    if (operation !== 'abort' && (previous || running.size)) fail('oauth_flow_busy');
    if (operation === 'abort') previous?.abort();
    const controller = new AbortController(), signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 29000);
    timer.unref?.();
    if (operation !== 'abort') running.set(id, controller);

    const response = data => ({ requestId: request.requestId, replayed: false, data });
    const log = (action, result, reason) => {
      if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
      store.appendAudit(eventFor(request, principal, resolvePolicy(request, principal, policy), action, result, reason, now()));
    };

    function current(pin, enforceExpiry = true) {
      if (closed || signal.aborted) fail('provider_timeout');
      if (C.fingerprint(getBase()) !== baseDigest || pin.base_digest !== baseDigest
          || pin.candidate_binding_digest !== candidateBindingDigest || pin.page !== settings.parentPageId) fail('scope_denied');
      store.connection(request.connectionRef, now());
      store.assertAssetActive(request);
      const live = enrollment.renewalAuthority(pin.enrollment, base);
      if (live.row.tenant !== pin.tenant || live.row.connection !== pin.connection || live.row.scope !== request.assetRef
          || live.credential.metadata.tokenType !== 'USER'
          || (pin.state !== 'active' && (live.credential.epoch !== pin.epoch
            || live.credential.versionId !== pin.credential_version || live.credential.digest !== pin.credential_digest))
          || [live.credential.metadata.expiresAt, live.credential.metadata.dataAccessExpiresAt].some(deadline => deadline !== null && deadline <= now())
          || assetSetDigest(live.assets) !== pin.asset_digest
          || !live.assets.some(asset => asset.kind === 'facebook_page' && asset.id === pin.page)) fail('scope_denied');
      if (enforceExpiry && pin.expires_at <= now()) fail('oauth_flow_interrupted');
      return live;
    }

    // The existing Owner adapter protects OAuth state and its single-use
    // provider code. Only the extension's distinct candidate slot is passed.
    const call = (name, payload) => oauth.executeRenewal({ request: { ...request,
      requestId: name === 'begin' ? id : request.requestId, operation: C.OPERATIONS[name], payload },
      principal, binding: candidateBinding, policy }, { signal, lane: 'instagram_extension', guard: () => {
      if (C.fingerprint(getBase()) !== baseDigest) fail('scope_denied');
      const persisted = get(id);
      if (name !== 'abort') {
        if (!persisted || persisted.state === 'aborted') fail('oauth_flow_interrupted');
        current(persisted);
      }
    }, retainedFlowIds: () => {
      const live = current(row);
      return [live.row.flow, live.credential.versionId];
    } });

    function availableInstagram(instagramId) {
      const ref = 'meta-instagram_business:' + instagramId;
      if (store.db.prepare('SELECT 1 FROM asset_revocations WHERE asset=?').get(ref)) fail('asset_revoked');
      if (store.db.prepare('SELECT 1 FROM meta_marketing_enrollment_claims WHERE asset=?').get(ref)
          || store.db.prepare("SELECT 1 FROM meta_marketing_instagram_extensions WHERE state='active' AND instagram_id=? AND id<>?").get(instagramId, id)) {
        fail('scope_denied');
      }
    }

    async function verify(pin) {
      const active = pin.state === 'active';
      const authorize = () => {
        const saved = get(id);
        if (!saved || saved.state !== pin.state || saved.candidate_binding_digest !== candidateBindingDigest) fail('oauth_flow_interrupted');
        return current(saved, !active);
      };
      authorize();
      const candidate = flow(id);
      if (candidate?.state !== 'staged' || !candidate.secret_digest
          || (pin.candidate_digest && pin.candidate_digest !== candidate.secret_digest)) fail('secret_unavailable');
      const label = retentionStage(pin.enrollment, id);
      const proof = await secrets.withCandidate(candidateBinding, candidate, candidate.secret_digest, async borrowed => {
        authorize();
        const result = await readCandidate({ ...borrowed, binding: candidateBinding, enrollmentId: pin.enrollment,
          clinicId: I.clinicId(pin.tenant), scopeKey, parentPageId: pin.page, expectedAssetSetDigest: pin.asset_digest, signal, authorize });
        authorize();
        if (!result) fail('scope_denied');
        availableInstagram(result.asset.id);
        const expiry = [borrowed.metadata.expiresAt, borrowed.metadata.dataAccessExpiresAt, result.expiry].filter(Number.isSafeInteger);
        return { ...result, expiry: Math.min(candidateBinding.expiresAt, ...expiry) };
      }, signal, active ? { retentionStage: label } : { requirePending: true });
      authorize();
      if (pin.instagram_id && (profileId(proof) !== pin.instagram_id || proof.assetSetDigest !== pin.selection_digest)) fail('scope_denied');
      return { proof, candidate, label };
    }
    const profileId = result => result.asset.id;
    const publicCandidate = ({ proof, candidate }) => ({ profile: proof.profile, digest: candidate.secret_digest, expiresAt: proof.expiry });

    try {
      if (operation === 'begin') {
        if (p.parentPageId !== settings.parentPageId || p.expiresAt <= now() || p.expiresAt > now() + 600000
            || p.expiresAt > candidateBinding.expiresAt) fail('scope_denied');
        const pins = { enrollment: p.enrollmentId, tenant: request.tenantRef, connection: request.connectionRef, page: p.parentPageId,
          base_digest: baseDigest, candidate_binding_digest: candidateBindingDigest, asset_digest: p.assetSetDigest, epoch: p.epoch,
          credential_version: p.versionId, credential_digest: p.credentialDigest, state_hash: C.hash(p.state), expires_at: p.expiresAt };
        current(pins);
        // Scope/asset details persist only as fixed metadata, never OAuth state,
        // a code or provider token. Insert the guard before returning any URL.
        row = store.transaction(() => {
          const previous = get(id);
          if (previous) {
            if (previous.state !== 'awaiting' || Object.entries(pins).some(([key, value]) => previous[key] !== value)) fail('idempotency_conflict');
            return previous;
          }
          if (flow(id) || tombstone(id)) fail('idempotency_conflict');
          if (store.db.prepare("SELECT 1 FROM meta_marketing_instagram_extensions WHERE connection=? AND page=? AND state<>'aborted'").get(pins.connection, pins.page)) fail('oauth_flow_busy');
          log('integration.requested', 'accepted', 'meta_instagram_extension_requested');
          const scopeDigest = C.hash(JSON.stringify(['meta-instagram-extension', id, pins]));
          const values = { id, ...pins, scope_digest: scopeDigest, state: 'awaiting' };
          const fields = Object.keys(values);
          store.db.prepare(`INSERT INTO meta_marketing_instagram_extensions(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
            .run(...Object.values(values));
          return get(id);
        });
        const remote = await call('begin', { state: p.state, scopeDigest: row.scope_digest,
          clinicSetDigest: C.clinicDigest(C.bindingFor(candidateBinding)), expiresAt: p.expiresAt });
        return response({ ...remote.data, status: 'awaiting' });
      }

      if (operation === 'abort') {
        const exists = store.transaction(() => {
          const saved = get(id);
          const localFlow = flow(id);
          if (localFlow && (localFlow.lane !== 'instagram_extension' || localFlow.config_digest !== candidateBindingDigest)) fail('scope_denied');
          if (!saved) fail('oauth_flow_interrupted');
          if (saved.state === 'aborted') return true;
          log('integration.completed', 'denied', 'meta_instagram_extension_cancelled');
          store.db.prepare("UPDATE meta_marketing_instagram_extensions SET state='aborted' WHERE id=?").run(id);
          return true;
        });
        // Only this extension's flow can be aborted. Abort does not revoke
        // the shared Facebook app or touch the original enrollment/credential.
        if (exists) await call('abort', { flowId: id });
        return response({ flowId: id, status: 'aborted', candidate: null });
      }
      if (row.state === 'aborted') return response({ flowId: id, status: 'aborted', candidate: null });
      current(row, row.state !== 'active');

      if (operation === 'finish') {
        if (row.state !== 'awaiting' || row.state_hash !== C.hash(p.state)) fail('oauth_state_invalid');
        await call('finish', { flowId: id, state: p.state, code: p.code });
      }
      if (row.state === 'awaiting' && operation === 'status' && flow(id)?.state === 'staging') {
        await call('status', { flowId: id });
      }
      if (row.state === 'awaiting' && (operation === 'confirm' || flow(id)?.state !== 'staged')) {
        if (operation === 'confirm') fail('idempotency_conflict');
        const interrupted = ['interrupted','aborted'].includes(flow(id)?.state);
        return response({ flowId: id, status: interrupted ? 'interrupted' : 'awaiting', candidate: null });
      }
      if (operation === 'confirm' && (p.instagramId !== row.instagram_id || p.candidateDigest !== row.candidate_digest)) {
        fail('idempotency_conflict');
      }
      const verified = await verify(row);
      if (operation === 'confirm') {
        if (verified.proof.expiry <= now()) fail('idempotency_conflict');
        if (row.state === 'staged') {
          await secrets.retainCandidate(candidateBinding, verified.candidate, row.candidate_digest, verified.label, signal);
          store.transaction(() => {
            const saved = get(id);
            current(saved);
            if (saved.state !== 'staged' || saved.instagram_id !== p.instagramId || saved.candidate_digest !== p.candidateDigest
                || saved.credential_expires_at <= now()) fail('idempotency_conflict');
            availableInstagram(saved.instagram_id);
            log('integration.completed', 'success', 'meta_instagram_extension_confirmed');
            store.db.prepare("UPDATE meta_marketing_instagram_extensions SET state='active' WHERE id=? AND state='staged'").run(id);
          });
        }
        return response({ flowId: id, status: 'active', candidate: publicCandidate(verified) });
      }
      if (row.state === 'awaiting') {
        store.transaction(() => {
          const saved = get(id);
          current(saved);
          if (saved.state !== 'awaiting') fail('idempotency_conflict');
          log('integration.completed', 'success', 'meta_instagram_extension_staged');
          store.db.prepare("UPDATE meta_marketing_instagram_extensions SET state='staged',candidate_digest=?,instagram_id=?,selection_digest=?,credential_expires_at=? WHERE id=?")
            .run(verified.candidate.secret_digest, verified.proof.asset.id, verified.proof.assetSetDigest, verified.proof.expiry, id);
        });
        row = get(id);
      }
      return response({ flowId: id, status: row.state, candidate: publicCandidate(verified) });
    } finally {
      clearTimeout(timer);
      if (running.get(id) === controller) running.delete(id);
    }
  }
  const operations = Object.fromEntries(Object.entries(I.OPERATIONS).map(([name, operation]) => [operation, {
    provider: C.PROVIDER, control: 'meta_marketing_oauth', validate: I.validators[name],
    authorize, execute,
  }]));
  return { operations, close() { closed = true; for (const controller of running.values()) controller.abort(); } };
}

module.exports = { createInstagramExtension };
