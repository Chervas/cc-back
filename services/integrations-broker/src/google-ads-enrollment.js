'use strict';
const { createHash, randomUUID } = require('node:crypto');
const contract = require('./google-ads-enrollment-contract');
const ads = require('./google-ads-contract');
const { fail } = require('./errors');

function createGoogleAdsEnrollment({ store, http, cursor, withDeveloperSecret, now = Date.now }) {
  const pages = new Map(); let bytes = 0;
  const get = (sql, ...args) => store.db.prepare(sql).get(...args);
  const revoked = asset => !!get('SELECT 1 FROM asset_revocations WHERE asset=? LIMIT 1', asset);
  const drop = id => { const p = pages.get(id); if (p) { bytes -= p.bytes; pages.delete(id); } };
  const isOperation = operation => Object.values(contract.OPERATIONS).includes(operation) || operation === contract.REVOKE_OPERATION;
  function scope(request, policy) {
    const binding = policy.connections.find(c => c.connectionRef === request.connectionRef);
    return { binding, scope: contract.scopeFor(binding, request.assetRef, request.tenantRef) };
  }
  function owned(request, principal) {
    const cancellation = get('SELECT * FROM google_ads_enrollment_cancellations WHERE id=?', request.payload.enrollmentId);
    const row = cancellation ? { ...cancellation, asset: 'ads:' + cancellation.customer, state: 'revoked' }
      : get('SELECT * FROM google_ads_enrollments WHERE id=?', request.payload.enrollmentId);
    if (row && (row.principal !== principal.id || row.tenant !== request.tenantRef
      || row.connection !== request.connectionRef || row.scope !== request.assetRef)) fail('scope_denied');
    return row;
  }
  function assertCandidate(request, principal, policy) {
    const { binding, scope: s } = scope(request, policy); const p = request.payload;
    if (!ads.customer(p.customerId) || p.customerId === s.rootCustomerId
      || s.assetRef.startsWith('ads-enroll:clinic:') && p.clinicCount !== 1) fail('invalid_request');
    const asset = 'ads:' + p.customerId;
    if (get('SELECT 1 FROM google_ads_enrollment_cancellations WHERE tenant=? AND connection=? AND customer=?', request.tenantRef, request.connectionRef, p.customerId)) fail('asset_revoked');
    if (revoked(asset)) fail('asset_revoked');
    if (policy.connections.some(c => c.googleAdsAccounts?.some(a => a.customerId === p.customerId))) fail('scope_denied');
    const row = owned(request, principal); const byAsset = get('SELECT id FROM google_ads_enrollments WHERE asset=?', asset);
    if (byAsset && byAsset.id !== p.enrollmentId) fail('scope_denied');
    if (row && (row.asset !== asset || row.clinic_count !== p.clinicCount || row.clinic_digest !== p.clinicSetDigest
      || row.config_digest !== contract.digestFor(binding, s))) fail('idempotency_conflict');
    if (!row && request.operation === contract.OPERATIONS.activate) fail('scope_denied');
    if (!row && (get('SELECT COUNT(*) AS n FROM google_ads_enrollments WHERE connection=? AND scope=?', binding.connectionRef, s.assetRef).n >= s.maxAssets
      || get('SELECT COUNT(*) AS n FROM google_ads_enrollments WHERE connection=?', binding.connectionRef).n
        + (binding.googleAdsAccounts?.length || 0) >= 1000)) fail('rate_limited');
    return { row, binding, scope: s };
  }
  function assertRevoke(request, principal, policy) {
    const { binding, scope: s } = scope(request, policy); const p = request.payload;
    if (principal.id !== s.controlPrincipalId) fail('scope_denied');
    if (!ads.customer(p.customerId) || p.customerId === s.rootCustomerId
      || s.assetRef.startsWith('ads-enroll:clinic:') && p.clinicCount !== 1) fail('invalid_request');
    if (policy.connections.some(c => c.googleAdsAccounts?.some(a => a.customerId === p.customerId))) fail('scope_denied');
    const owner = contract.ownerFor(policy, binding, s);
    const row = owned(request, { id: owner });
    const cancelled = get('SELECT id FROM google_ads_enrollment_cancellations WHERE tenant=? AND connection=? AND customer=?', request.tenantRef, request.connectionRef, p.customerId);
    if (cancelled && cancelled.id !== p.enrollmentId) fail('scope_denied');
    const byAsset = get('SELECT id FROM google_ads_enrollments WHERE asset=?', 'ads:' + p.customerId);
    if (byAsset && byAsset.id !== p.enrollmentId) fail('scope_denied');
    if (row && (row.customer !== p.customerId || row.clinic_count !== p.clinicCount || row.clinic_digest !== p.clinicSetDigest)) fail('idempotency_conflict');
    return { row, binding, scope: s, owner };
  }
  function resolve(request, principal, policy) {
    if (isOperation(request.operation) || !request.assetRef.startsWith('ads:')) return policy;
    if (request.operation !== ads.REVOKE_OPERATION && get('SELECT 1 FROM google_ads_enrollment_cancellations WHERE tenant=? AND connection=? AND customer=?',
      request.tenantRef, request.connectionRef, request.assetRef.slice(4))) fail('asset_revoked');
    const row = get('SELECT * FROM google_ads_enrollments WHERE asset=?', request.assetRef);
    if (!row) return policy;
    if (row.tenant !== request.tenantRef || row.connection !== request.connectionRef) fail('scope_denied');
    const binding = policy.connections.find(c => c.connectionRef === row.connection);
    const s = contract.scopeFor(binding, row.scope, row.tenant);
    const control = request.operation === ads.REVOKE_OPERATION && principal.id === s.controlPrincipalId;
    if (!control) {
      if (principal.id !== s.readPrincipalId || !s.readOperations.includes(request.operation)
        || row.state === 'prepared' && request.operation !== 'google.ads.discovery.read.v1'
        || row.config_digest !== contract.digestFor(binding, s)
        || policy.connections.some(c => c.googleAdsAccounts?.some(a => a.customerId === row.customer))) fail('scope_denied');
      store.assertAssetActive({ tenantRef: row.tenant, connectionRef: row.connection, assetRef: row.scope });
      if (revoked(row.asset)) fail('asset_revoked');
    }
    // Only the exact persisted account receives the closed read/control rights
    // from its approved scope. Never mutate the static policy or accept grants
    // or a manager identity from an API caller.
    return { ...policy, connections: policy.connections.map(c => c !== binding ? c : { ...c,
      googleAdsAccounts: [...(c.googleAdsAccounts || []).filter(a => a.assetRef !== row.asset),
        { assetRef: row.asset, customerId: row.customer, loginCustomerId: row.manager }] }),
    grants: [...policy.grants, { principalId: principal.id, tenantRef: row.tenant, connectionRef: row.connection,
      assetRef: row.asset, operations: [request.operation] }] };
  }
  function assert(request, principal, policy) {
    if (!isOperation(request.operation)) { resolve(request, principal, policy); return; }
    scope(request, policy);
    if (request.operation === contract.OPERATIONS.status) {
      if (!owned(request, principal)) fail('scope_denied'); return;
    }
    if (request.operation === contract.REVOKE_OPERATION) { assertRevoke(request, principal, policy); return; }
    store.assertAssetActive(request);
    if (request.operation !== contract.OPERATIONS.discover) assertCandidate(request, principal, policy);
  }
  const receipt = (request, state) => ({ enrollmentId: request.payload.enrollmentId, assetRef: 'ads:' + request.payload.customerId,
    scopeRef: request.assetRef, clinicCount: request.payload.clinicCount, clinicSetDigest: request.payload.clinicSetDigest, state });
  async function provider(context, s, customerId, developerToken) {
    const raw = await http({ hostname: 'googleads.googleapis.com',
      path: `/${ads.API_VERSION}/customers/${s.rootCustomerId}/googleAds:search`,
      token: context.secret, developerToken, loginCustomerId: s.loginCustomerId, signal: context.signal,
      json: { query: contract.query(customerId) } });
    if (context.signal.aborted) fail('provider_timeout');
    const result = contract.project(raw, customerId);
    if (result.some(c => c.id === s.rootCustomerId) || customerId && result.length !== 1) fail('provider_failed');
    if (JSON.stringify(result).includes(context.secret.toString('utf8'))
      || JSON.stringify(result).includes(developerToken.toString('utf8'))) fail('provider_failed');
    return result;
  }
  const operations = Object.fromEntries([...Object.entries(contract.OPERATIONS), ['revoke', contract.REVOKE_OPERATION]].map(([name, operation]) => [operation, Object.freeze({
    provider: ads.PROVIDER, control: name === 'status' ? 'google_ads_enrollment_status' : name === 'revoke' ? 'google_ads_enrollment_revoke' : undefined,
    secretless: ['status','revoke'].includes(name), persistResult: ['prepare', 'activate', 'revoke'].includes(name), requiredScopes: ads.SCOPES,
    validate: contract.validators[name],
    async execute(context) {
      const { binding, assetRef, tenantRef, payload, policy, principalId } = context;
      const request = { connectionRef: binding.connectionRef, assetRef, tenantRef, payload, operation };
      const principal = { id: principalId }; const s = contract.scopeFor(binding, assetRef, tenantRef);
      if (name === 'revoke') { assertRevoke(request, principal, policy); return { ...receipt(request, 'revoked'), accessBlocked: true }; }
      if (name === 'status') {
        const row = owned(request, principal); if (!row) fail('scope_denied');
        let accessBlocked = true;
        try { store.connection(binding.connectionRef, now()); store.assertAssetActive(request);
          accessBlocked = revoked(row.asset) || row.state !== 'active' || row.config_digest !== contract.digestFor(binding, s); } catch {}
        return { enrollmentId: row.id, assetRef: row.asset, scopeRef: row.scope, clinicCount: row.clinic_count,
          clinicSetDigest: row.clinic_digest, state: revoked(row.asset) ? 'revoked' : row.state, accessBlocked };
      }
      return withDeveloperSecret(binding, async developerToken => {
        if (context.signal.aborted) fail('provider_timeout');
        if (!Buffer.isBuffer(context.secret) || !context.secret.length || !Buffer.isBuffer(developerToken) || !developerToken.length) fail('secret_unavailable');
        if (name !== 'discover') {
          const { row } = assertCandidate(request, principal, policy);
          await provider(context, s, payload.customerId, developerToken);
          return receipt(request, name === 'activate' || row?.state === 'active' ? 'active' : 'prepared');
        }
        for (const [id, p] of pages) if (p.expiresAt <= now()) drop(id);
        const epoch = createHash('sha256').update(context.secret).update(Buffer.from([0])).update(developerToken).digest('hex');
        const key = JSON.stringify([principalId, tenantRef, binding.connectionRef, assetRef, context.policyVersion, contract.digestFor(binding, s)]);
        const cursorScope = { ...context, operation }; let entry; let offset = 0;
        if (payload.pageToken !== null) {
          let page; try { page = JSON.parse(cursor.open(payload.pageToken, cursorScope)); } catch { fail('invalid_request'); }
          if (!page || Object.keys(page).sort().join(',') !== 'id,offset' || typeof page.id !== 'string'
            || !Number.isInteger(page.offset) || page.offset < 0) fail('invalid_request');
          entry = pages.get(page.id); offset = page.offset;
          if (!entry || entry.key !== key || entry.epoch !== epoch || offset >= entry.rows.length) fail('invalid_request');
        } else {
          const rows = await provider(context, s, null, developerToken);
          const size = Buffer.byteLength(JSON.stringify(rows)); if (size > 16 * 1024 * 1024) fail('provider_failed');
          while (pages.size && (pages.size >= 16 || bytes + size > 16 * 1024 * 1024)) drop(pages.keys().next().value);
          entry = { id: randomUUID(), key, epoch, connectionRef: binding.connectionRef, rows, bytes: size, expiresAt: now() + 600000 };
          pages.set(entry.id, entry); bytes += size;
        }
        const rows = entry.rows.slice(offset, offset + 250).filter(c => !revoked('ads:' + c.id)
          && !get('SELECT 1 FROM google_ads_enrollment_cancellations WHERE tenant=? AND connection=? AND customer=?', tenantRef, binding.connectionRef, c.id)
          && !policy.connections.some(b => b.googleAdsAccounts?.some(a => a.customerId === c.id))
          && !get('SELECT 1 FROM google_ads_enrollments WHERE customer=?', c.id));
        const end = Math.min(offset + 250, entry.rows.length);
        return { accounts: rows, nextPageToken: end < entry.rows.length ? cursor.seal(JSON.stringify({ id: entry.id, offset: end }), cursorScope) : null };
      }, { signal: context.signal });
    },
    project(data) {
      if (!data || Buffer.byteLength(JSON.stringify(data)) > 786432) fail('provider_failed'); return structuredClone(data);
    },
    ...(['prepare', 'activate', 'revoke'].includes(name) ? { commit({ request, principal, policy, result }) {
      // Called synchronously inside the command-completion/audit transaction.
      assert(request, principal, policy);
      if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
      const { row, binding, scope: s, owner } = name === 'revoke' ? assertRevoke(request, principal, policy) : assertCandidate(request, principal, policy);
      const p = request.payload;
      if (name === 'revoke') {
        // Before access has been verified, cancellation belongs only to this
        // tenant/connection. It cannot reserve or revoke an unknown customer's
        // future registration in another clinic. An existing enrollment already
        // proves ownership and receives the usual durable asset revocation too.
        store.db.prepare('INSERT OR IGNORE INTO google_ads_enrollment_cancellations VALUES (?,?,?,?,?,?,?,?,?)')
          .run(p.enrollmentId, owner, request.tenantRef, request.connectionRef, request.assetRef, p.customerId, p.clinicCount, p.clinicSetDigest, now());
        const registered = get('SELECT * FROM google_ads_enrollments WHERE id=?', p.enrollmentId);
        if (registered) store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)')
          .run(request.tenantRef, request.connectionRef, 'ads:' + p.customerId, request.requestId, now());
        return;
      }
      if (!row) store.db.prepare('INSERT INTO google_ads_enrollments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('ads:' + p.customerId, p.enrollmentId, owner || principal.id, request.tenantRef, request.connectionRef, request.assetRef,
          p.customerId, s.loginCustomerId || s.rootCustomerId, p.clinicCount, p.clinicSetDigest, contract.digestFor(binding, s), 'prepared', now(), now());
      if (name === 'activate') store.db.prepare("UPDATE google_ads_enrollments SET state='active',updated_at=? WHERE id=? AND state='prepared'")
        .run(now(), p.enrollmentId);
      const current = get('SELECT state FROM google_ads_enrollments WHERE id=?', p.enrollmentId);
      if (current.state !== result.data.state) fail('idempotency_conflict');
    } } : {}),
  })]));
  return { operations, resolve, assert,
    invalidate(ref) { for (const [id, p] of pages) if (p.connectionRef === ref) drop(id); },
    close() { for (const id of pages.keys()) drop(id); },
  };
}
module.exports = { createGoogleAdsEnrollment };
