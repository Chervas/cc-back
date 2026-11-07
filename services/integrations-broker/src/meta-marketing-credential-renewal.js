'use strict';
const { BrokerError, fail } = require('./errors'), { eventFor } = require('./audit'), { canonical } = require('./canonical');
const C = require('./meta-marketing-oauth-contract'), E = require('./meta-marketing-enrollment-contract');
const D = require('./meta-marketing-discovery-contract'), R = require('./meta-marketing-credential-renewal-contract');
function createMetaMarketingCredentialRenewal({ store, epochs, enrollment, oauth, secrets, http, environment, now = Date.now }) {
  const roles = E.roles(environment), running = new Map(); let closed = false;
  const rowFor = id => store.db.prepare('SELECT * FROM meta_marketing_credential_renewals WHERE id=?').get(id);
  function owned(request, principal, binding, row) {
    if (row && (row.tenant !== request.tenantRef || row.connection !== request.connectionRef || row.scope !== request.assetRef
      || row.principal !== roles.gateway || ![roles.gateway, roles.control].includes(principal.id))) fail('scope_denied');
    return row;
  }
  function authority(request, binding, renewal) {
    if (closed) fail('connection_blocked');
    store.connection(binding.connectionRef, now()); store.assertAssetActive(request);
    const value = enrollment.renewalAuthority(renewal.enrollment, binding), row = value.row;
    if (row.tenant !== renewal.tenant || row.connection !== renewal.connection || row.scope !== renewal.scope
      || epochs.grantDigest(row) !== renewal.grant_digest || R.assetSetDigest(value.assets) !== renewal.asset_digest
      || row.scope_digest !== renewal.scope_digest || epochs.flowFor(row.flow).clinic_digest !== renewal.clinic_digest) fail('scope_denied');
    return value;
  }
  function view(request, principal, binding, row) {
    if (!row) return { renewalId: request.payload.renewalId, flowId: request.payload.renewalId, enrollmentId: null, status: 'not_found',
      grantDigest: null, assetSetDigest: null, effectiveCredential: null, candidate: null, activationApplied: false };
    owned(request, principal, binding, row);
    const current = authority(request, binding, row).credential;
    return { renewalId: row.id, flowId: row.id, enrollmentId: row.enrollment, status: row.state,
      grantDigest: row.grant_digest, assetSetDigest: row.asset_digest, effectiveCredential: epochs.view(current),
      candidate: ['staged', 'active'].includes(row.state) ? { versionId: row.id, digest: row.candidate_digest, metadata: JSON.parse(row.candidate_metadata) } : null,
      activationApplied: row.state === 'active' && current.versionId === row.id && current.digest === row.candidate_digest };
  }
  const expected = row => ({ expectedEpoch: row.expected_epoch, expectedVersionId: row.expected_version, expectedCandidateDigest: row.expected_digest });
  function candidateMetadata(row, binding, value, original) {
    const metadata = C.metadata(value, binding);
    if (metadata.appId !== original.metadata.appId || metadata.subjectId !== original.metadata.subjectId) fail('oauth_identity_mismatch');
    if ([metadata.expiresAt, metadata.dataAccessExpiresAt].some(v => v !== null && v <= now())) fail('credential_revoked');
    return metadata;
  }
  async function execute({ request, principal, binding, policy }) {
    R.authorize({ request, principal, binding }, environment); const name = R.validate(request.operation, request.payload), p = request.payload, id = p.renewalId;
    let row = owned(request, principal, binding, rowFor(id));
    const event = (action, result, reason) => eventFor(request, principal, policy, action, result, reason, now());
    const append = (action, result, reason) => {
      if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
      store.appendAudit(event(action, result, reason));
    };
    if (name === 'status' && !row) return { requestId: request.requestId, data: view(request, principal, binding, null), replayed: false };
    if (name !== 'begin' && !row) fail('scope_denied');
    if (name === 'abort' && row.state === 'active') return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: false };
    if (running.has(id) && name === 'status') return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: false };
    if (name !== 'abort' && (running.has(id) || running.size >= 2)) fail('oauth_flow_busy');
    const controller = new AbortController(), signal = controller.signal, previous = running.get(id);
    if (name !== 'abort') running.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 25000); timer.unref?.();
    const principalFingerprint = C.hash(JSON.stringify([principal.id, principal.keyId, principal.publicKey]));
    const check = ({ allowTerminal = false } = {}) => {
      if (signal.aborted) fail('provider_timeout');
      const currentPrincipal = policy.principals.find(value => value.id === principal.id);
      if (!currentPrincipal?.enabled || C.hash(JSON.stringify([currentPrincipal.id, currentPrincipal.keyId, currentPrincipal.publicKey])) !== principalFingerprint) fail('scope_denied');
      require('./auth').authorize(currentPrincipal, request, policy);
      const currentBinding = policy.connections.find(value => value.connectionRef === binding.connectionRef);
      if (C.fingerprint(currentBinding) !== C.fingerprint(binding)) fail('scope_denied');
      row = owned(request, principal, binding, rowFor(id));
      if (!row || !allowTerminal && ['aborted', 'rejected', 'active'].includes(row.state)) fail('oauth_flow_interrupted');
      return authority(request, binding, row);
    };
    const retainedFlowIds = () => {
      const grant = check({ allowTerminal: true }).row;
      return [grant.flow, ...store.db.prepare("SELECT id FROM meta_marketing_credential_renewals WHERE enrollment=? AND state='active'").all(grant.id).map(value => value.id)];
    };
    const callOAuth = async (family, payload) => oauth.executeRenewal({ request: { ...request, requestId: family === 'begin' ? id : request.requestId,
      operation: C.OPERATIONS[family], payload }, principal, binding, policy }, { guard: () => check({ allowTerminal: family === 'abort' }), retainedFlowIds, signal });
    const stage = metadata => store.transaction(() => {
      const original = check(); epochs.expected(original.credential, expected(row));
      const flow = epochs.flowFor(id);
      if (flow?.state !== 'staged' || !flow.secret_digest) fail('oauth_flow_interrupted');
      if (Object.hasOwn(metadata, 'versionId')) {
        if (metadata.versionId !== id || metadata.digest !== flow.secret_digest) fail('secret_unavailable');
        metadata = Object.fromEntries(['appId', 'subjectId', 'tokenType', 'scopes', 'expiresAt', 'dataAccessExpiresAt', 'granularScopes'].map(key => [key, metadata[key]]));
      }
      const value = candidateMetadata(row, binding, metadata, original.credential);
      append('integration.completed', 'success', 'meta_credential_renewal_staged');
      store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='staged',candidate_digest=?,candidate_metadata=?,updated_at=? WHERE id=?")
        .run(flow.secret_digest, JSON.stringify(value), now(), id);
      row = rowFor(id);
    });
    async function verifyCandidate() {
      const original = check(); epochs.expected(original.credential, expected(row));
      const flow = epochs.flowFor(id);
      if (flow?.state !== 'staged' || flow.secret_digest !== row.candidate_digest) fail('secret_unavailable');
      await secrets.withCandidate(binding, flow, flow.secret_digest, async borrowed => {
        const current = check(); epochs.expected(current.credential, expected(row));
        candidateMetadata(row, binding, borrowed.metadata, current.credential);
        enrollment.assertRenewalCredential(row.enrollment,binding,borrowed.metadata);
        const inventory = await http.discover({ binding, ...borrowed, signal, authorize: check });
        D.checkAssets(inventory, borrowed.metadata);
        const assets = E.assets(current.assets.map(asset => {
          const discovered = inventory.find(value => value.assetRef === asset.assetRef);
          if (!discovered) fail('scope_denied'); return E.identity(discovered);
        }));
        if (JSON.stringify(assets) !== JSON.stringify(E.assets(current.assets))) fail('scope_denied');
        enrollment.assertRenewalCredential(row.enrollment,binding,borrowed.metadata);
        check();
        return { assetSetDigest: R.assetSetDigest(assets) };
      }, signal, { requirePending: true });
      check();
      return { flow, versionId: id, digest: row.candidate_digest, metadata: JSON.parse(row.candidate_metadata) };
    }
    try {
      if (name === 'begin') {
        const grant = enrollment.renewalAuthority(p.enrollmentId, binding), original = grant.row, b = C.bindingFor(binding);
        if (original.tenant !== request.tenantRef || original.connection !== request.connectionRef || original.scope !== request.assetRef
          || p.assetSetDigest !== R.assetSetDigest(grant.assets) || p.scopeDigest !== original.scope_digest
          || p.clinicSetDigest !== C.clinicDigest(b) || p.expiresAt <= now() || p.expiresAt > now() + 600000 || p.expiresAt > binding.expiresAt) fail('scope_denied');
        epochs.expected(grant.credential, p);
        const pin = { enrollment: original.id, principal: roles.gateway, tenant: request.tenantRef, connection: request.connectionRef, scope: request.assetRef,
          expected_epoch: p.expectedEpoch, expected_version: p.expectedVersionId, expected_digest: p.expectedCandidateDigest, state_hash: C.hash(p.state),
          scope_digest: p.scopeDigest, clinic_digest: p.clinicSetDigest, asset_digest: p.assetSetDigest, grant_digest: epochs.grantDigest(original), expires_at: p.expiresAt };
        store.transaction(() => {
          const old = owned(request, principal, binding, rowFor(id));
          if (old) {
            if (Object.entries(pin).some(([key, value]) => old[key] !== value) || old.state !== 'awaiting') fail('idempotency_conflict');
          } else {
            if (store.db.prepare("SELECT 1 FROM meta_marketing_credential_renewals WHERE enrollment=? AND state IN ('awaiting','processing','staged','interrupted')").get(original.id)) fail('oauth_flow_busy');
            if (epochs.flowFor(id)) fail('idempotency_conflict');
            append('integration.requested', 'accepted', 'meta_credential_renewal_requested');
            store.db.prepare("INSERT INTO meta_marketing_credential_renewals(id,enrollment,principal,tenant,connection,scope,expected_epoch,expected_version,expected_digest,state_hash,scope_digest,clinic_digest,asset_digest,grant_digest,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting')")
              .run(id, ...Object.values(pin).slice(0, -1), now(), p.expiresAt, now());
          }
        });
        row = rowFor(id); check();
        await secrets.retentionCapacity(binding, grant.credential.retentionStage ? 1 : 2, signal);
        await epochs.protect(original, binding, grant.credential, secrets, signal); check();
        const response = await callOAuth('begin', { state: p.state, scopeDigest: p.scopeDigest, clinicSetDigest: p.clinicSetDigest, expiresAt: p.expiresAt });
        return { requestId: request.requestId, data: { renewalId: id, flowId: id, enrollmentId: original.id,
          authUrl: response.data.authUrl, expiresAt: response.data.expiresAt }, replayed: response.replayed };
      }
      check({ allowTerminal: true });
      if (name === 'abort') {
        if (row.state !== 'aborted') {
          await callOAuth('abort', { flowId: id });
          store.transaction(() => { check({ allowTerminal: true }); append('integration.failed', 'denied', 'meta_credential_renewal_aborted');
            store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='aborted',updated_at=? WHERE id=? AND state<>'active'").run(now(), id); });
        }
        previous?.abort();
      } else if (name === 'status') {
        if (['processing', 'awaiting'].includes(row.state)) {
          const flow = epochs.flowFor(id);
          if (flow?.state === 'staging') {
            const response = await callOAuth('status', { flowId: id });
            if (response.data.status === 'staged') stage(response.data.candidate);
          } else if (flow?.state === 'staged') stage(JSON.parse(flow.credential_metadata));
          else if (flow && (['exchanging', 'interrupted'].includes(flow.state) || flow.state === 'awaiting' && row.state === 'processing')) store.transaction(() => {
            check(); store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='interrupted',updated_at=? WHERE id=?").run(now(), id);
          });
        }
        if (row.state === 'staged' && row.activation_request) store.transaction(() => {
          const current = check(); epochs.expected(current.credential, expected(row));
          const command = store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(row.principal, row.activation_request);
          if (command && command.state !== 'completed') {
            append('integration.completed', 'success', 'meta_credential_activation_not_applied_observed');
            store.db.prepare('UPDATE meta_marketing_credential_renewals SET activation_reconciled_at=?,updated_at=? WHERE id=? AND state=\'staged\'')
              .run(now(), now(), id);
          }
        });
      } else if (name === 'finish') {
        check();
        if (row.state === 'staged') return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: true };
        if (row.state !== 'awaiting' || row.state_hash !== C.hash(p.state) || row.expires_at <= now()) fail('oauth_state_invalid');
        store.transaction(() => { check(); epochs.expected(authority(request, binding, row).credential, expected(row));
          store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='processing',updated_at=? WHERE id=?").run(now(), id); });
        const response = await callOAuth('finish', { flowId: id, state: p.state, code: p.code });
        if (response.data.status !== 'staged') fail('oauth_flow_interrupted');
        stage(response.data.candidate);
        await verifyCandidate();
      } else if (name === 'activate') {
        if (row.state === 'active') return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: true };
        if (row.enrollment !== p.enrollmentId || row.state !== 'staged' || row.candidate_digest !== p.candidateDigest
          || Object.entries(expected(row)).some(([key, value]) => p[key] !== value)) fail('idempotency_conflict');
        const commandDigest = C.hash(canonical({ operation: request.operation, tenantRef: request.tenantRef, connectionRef: request.connectionRef, assetRef: request.assetRef, payload: p }));
        store.transaction(() => {
          check();
          if (row.activation_request && row.activation_request !== request.requestId) fail('idempotency_conflict');
          const previousCommand = store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(principal.id, request.requestId);
          if (previousCommand && previousCommand.state !== 'completed') {
            if (previousCommand.digest !== commandDigest) fail('idempotency_conflict');
            if (!Number.isSafeInteger(row.activation_reconciled_at)) fail('outcome_unknown');
            epochs.expected(authority(request, binding, row).credential, expected(row));
            append('integration.requested', 'accepted', 'meta_credential_activation_reconciled_retry');
            store.db.prepare("UPDATE commands SET state='started' WHERE principal=? AND id=? AND digest=?")
              .run(principal.id, request.requestId, commandDigest);
          }
          store.db.prepare('UPDATE meta_marketing_credential_renewals SET activation_request=?,activation_reconciled_at=NULL WHERE id=?')
            .run(request.requestId, id);
          row = rowFor(id);
        });
        const pendingCommand = store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(principal.id, request.requestId);
        const reconciledRetry = pendingCommand?.state === 'started';
        const cached = reconciledRetry ? null : store.reserve(principal.id, request.requestId, commandDigest, event('integration.requested', 'accepted', 'meta_credential_renewal_activate_requested'), policy.maxBacklog, now());
        if (cached) return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: true };
        const candidate = await verifyCandidate(), original = check();
        await epochs.protect(original.row, binding, candidate, secrets, signal); check();
        const response = { requestId: request.requestId, data: null, replayed: false };
        store.complete(principal.id, request.requestId, response, event('integration.completed', 'success', 'meta_credential_renewal_activated'), {
          mutate: () => {
            const current = check(); epochs.expected(current.credential, expected(row));
            const epoch = current.credential.epoch + 1;
            if (current.credential.epoch === 0) store.db.prepare('INSERT INTO meta_marketing_effective_credentials VALUES (?,?,?,?,?,?,?)')
              .run(row.enrollment, epoch, id, row.candidate_digest, row.candidate_metadata, id, now());
            else {
              const changed = store.db.prepare('UPDATE meta_marketing_effective_credentials SET epoch=?,version=?,digest=?,metadata=?,renewal=?,switched_at=? WHERE enrollment=? AND epoch=? AND version=? AND digest=?')
                .run(epoch, id, row.candidate_digest, row.candidate_metadata, id, now(), row.enrollment, row.expected_epoch, row.expected_version, row.expected_digest);
              if (changed.changes !== 1) fail('secret_version_changed');
            }
            store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='active',updated_at=? WHERE id=? AND state='staged'").run(now(), id);
            row = rowFor(id); response.data = view(request, principal, binding, row);
          },
        });
        return response;
      }
      row = rowFor(id); return { requestId: request.requestId, data: view(request, principal, binding, row), replayed: false };
    } catch (error) {
      const safe = error instanceof BrokerError ? error : new BrokerError('internal_error');
      const current = rowFor(id);
      if (current && current.state !== 'active' && ['oauth_identity_mismatch', 'oauth_credentials_incomplete', 'scope_denied', 'credential_revoked', 'provider_unauthorized'].includes(safe.code)) {
        store.transaction(() => { append('integration.failed', 'denied', 'meta_credential_renewal_rejected');
          store.db.prepare("UPDATE meta_marketing_credential_renewals SET state='rejected',last_error=?,updated_at=? WHERE id=? AND state<>'active'").run(safe.code, now(), id); });
        // Reject only the fresh candidate flow, never the immutable original
        // grant/effective flow. A normal retry can then start another consent.
        try { await callOAuth('abort', {flowId:id}); } catch { /* Retain rejected history and reconcile explicitly if local abort could not be proven. */ }
      }
      throw require('./meta-marketing-graph-pacing').safeError(error, 'internal_error');
    } finally { clearTimeout(timer); if (name !== 'abort') running.delete(id); }
  }
  const operations = Object.fromEntries(Object.values(R.OPERATIONS).map(operation => [operation, {
    provider: C.PROVIDER, control: 'meta_marketing_oauth', validate: payload => R.validate(operation, payload),
    authorize: context => R.authorize(context, environment), execute,
  }]));
  return { operations, close() { closed = true; for (const controller of running.values()) controller.abort(); } };
}
module.exports = { createMetaMarketingCredentialRenewal };
