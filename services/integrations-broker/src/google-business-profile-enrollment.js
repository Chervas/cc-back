'use strict';
const { createHash } = require('node:crypto');
const C = require('./google-business-profile-enrollment-contract');
const reads = require('./google-business-profile-contract');
const { fail } = require('./errors');
const { createBusinessProfileReassociation } = require('./google-business-profile-reassociation');

function createBusinessProfileEnrollment({ store, http, cursor, now = Date.now }) {
  const get = (sql, ...args) => store.db.prepare(sql).get(...args);
  const all = (sql, ...args) => store.db.prepare(sql).all(...args);
  const reassociations = createBusinessProfileReassociation({ store, now });
  const assetFor = p => `gbp:${p.accountId}:${p.locationId}`;
  const retired = request => !!get('SELECT 1 FROM google_business_profile_retirements WHERE tenant=? AND connection=? AND asset=?',
    request.tenantRef, request.connectionRef, request.assetRef);
  const revokedLocation = location => !!get("SELECT 1 FROM asset_revocations WHERE asset LIKE ? LIMIT 1", `gbp:%:${location}`)
    || !!get('SELECT 1 FROM google_business_profile_retirements WHERE location=? LIMIT 1', location);
  function scope(request, policy) {
    const binding = policy.connections.find(c => c.connectionRef === request.connectionRef);
    return { binding, scope: C.scopeFor(binding, request.assetRef, request.tenantRef) };
  }
  function owned(request, principal, policy, control = false) {
    const { binding, scope: s } = scope(request, policy);
    if (control && principal.id !== s.controlPrincipalId) fail('scope_denied');
    const owner = C.ownerFor(policy, binding, s);
    if (!control && principal.id !== owner) fail('scope_denied');
    const row = get('SELECT * FROM google_business_profile_enrollments WHERE id=?', request.payload.enrollmentId);
    if (row && (row.principal !== owner || row.tenant !== request.tenantRef || row.connection !== request.connectionRef
      || row.scope !== request.assetRef)) fail('scope_denied');
    return { row, binding, scope: s, owner };
  }
  function sameIdentity(row, p) {
    if (row && (row.account !== p.accountId || row.location !== p.locationId || row.previous_asset !== p.previousAssetRef
      || row.clinic_count !== p.clinicCount || row.clinic_digest !== p.clinicSetDigest)) fail('idempotency_conflict');
  }
  function currentHead(request, s) {
    const row = get('SELECT * FROM google_business_profile_scope_heads WHERE tenant=? AND connection=? AND scope=?',
      request.tenantRef, request.connectionRef, request.assetRef);
    return row || { asset: s.bootstrapPreviousAssetRef, enrollment_id: null, revision: 0 };
  }
  function assertPredecessor(request, s, binding, policy, row) {
    const p = request.payload; const head = currentHead(request, s);
    if (row?.completed_at !== null && row?.completed_at !== undefined) {
      if (row.state !== 'active' || head.asset !== assetFor(p) || head.enrollment_id !== row.id) fail('asset_revoked');
      return;
    }
    if (head.asset !== p.previousAssetRef) fail('idempotency_conflict');
    if (p.previousAssetRef === null) return;
    const previous = reads.asset(p.previousAssetRef);
    if (previous.locationId === p.locationId) fail('scope_denied');
    store.assertAssetActive({ ...request, assetRef: p.previousAssetRef });
    if (retired({ ...request, assetRef: p.previousAssetRef })) fail('asset_revoked');
    const managed = get("SELECT * FROM google_business_profile_enrollments WHERE location=? AND state='active'", previous.locationId);
    if (head.enrollment_id !== null) {
      if (!managed || managed.id !== head.enrollment_id || managed.tenant !== request.tenantRef
        || managed.connection !== binding.connectionRef || managed.scope !== request.assetRef
        || assetFor({ accountId: managed.account, locationId: managed.location }) !== p.previousAssetRef) fail('scope_denied');
    } else if (p.previousAssetRef !== s.bootstrapPreviousAssetRef || !policy.grants.some(g => g.principalId === s.readPrincipalId
      && g.tenantRef === request.tenantRef && g.connectionRef === binding.connectionRef && g.assetRef === p.previousAssetRef
      && g.operations.includes(reads.PREFIX + 'discovery.read.v1'))) fail('scope_denied');
  }
  function candidateAllowed(request, policy, s) {
    const p = request.payload;
    if (!s.accountIds.includes(p.accountId) || !s.locationIds.includes(p.locationId)
      || s.assetRef.startsWith('gbp-enroll:clinic:') && p.clinicCount !== 1) fail('scope_denied');
    const lineage = reassociations.capture(request, s, { discover: !p.enrollmentId });
    if (!lineage && revokedLocation(p.locationId)) fail('asset_revoked');
    // The location ID is global. An alternate account prefix must not create a
    // second owner or evade a static registration/revocation.
    if (policy.grants.some(g => g.assetRef.startsWith('gbp:') && reads.asset(g.assetRef).locationId === p.locationId
      && g.operations.some(op => C.resourceOperations.includes(op)) && !reassociations.allowsSourceGrant(lineage, g))) fail('scope_denied');
    const histories = all('SELECT id,tenant,connection,scope,account,location,state,completed_at FROM google_business_profile_enrollments WHERE location=? AND verified=1', p.locationId);
    if (histories.some(row => (row.tenant !== request.tenantRef || row.connection !== request.connectionRef || row.scope !== request.assetRef)
      && !reassociations.allowsSourceHistory(lineage, row))) fail('scope_denied');
    return lineage;
  }
  function assertCandidate(request, principal, policy) {
    const found = owned(request, principal, policy); const { row, binding, scope: s } = found; const p = request.payload;
    sameIdentity(row, p);
    if (row && (['cancelled', 'retired'].includes(row.state) || row.config_digest !== C.digestFor(binding, s))) fail('asset_revoked');
    if (row && p.reassociation && !reassociations.ledger(row.id)) fail('scope_denied');
    candidateAllowed(request, policy, s); assertPredecessor(request, s, binding, policy, row);
    if (!row && request.operation === C.OPERATIONS.activate) fail('scope_denied');
    const other = get("SELECT id FROM google_business_profile_enrollments WHERE tenant=? AND connection=? AND scope=? AND state IN ('prepared','active') AND completed_at IS NULL AND id<>? LIMIT 1",
      request.tenantRef, request.connectionRef, request.assetRef, p.enrollmentId);
    if (other) fail('idempotency_conflict');
    const reserved = get("SELECT id FROM google_business_profile_enrollments WHERE location=? AND state IN ('prepared','active') AND id<>? LIMIT 1", p.locationId, p.enrollmentId);
    if (reserved) fail('scope_denied');
    if (!row && get("SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE connection=? AND scope=? AND state IN ('prepared','active')",
      request.connectionRef, request.assetRef).n >= s.maxAssets) fail('rate_limited');
    return found;
  }
  function assertControl(request, principal, policy) {
    const found = owned(request, principal, policy, true); const { row, binding, scope: s } = found;
    sameIdentity(row, request.payload);
    if (request.payload.reassociation || row && reassociations.ledger(row.id)) {
      reassociations.capture(request, s, { cleanup: request.operation === C.OPERATIONS.abort });
    }
    if (request.operation === C.OPERATIONS.retire) {
      if (!row || row.state !== 'active' || row.config_digest !== C.digestFor(binding, s)) fail('scope_denied');
      candidateAllowed(request, policy, s); assertPredecessor(request, s, binding, policy, row);
    } else if (row && (row.state === 'retired' || row.completed_at !== null)) fail('scope_denied');
    return found;
  }
  function resolve(request, principal, policy) {
    const control = request.operation === reads.REVOKE_OPERATION;
    if (!(control || C.resourceOperations.includes(request.operation)) || !request.assetRef.startsWith('gbp:')) return policy;
    if (!control && retired(request)) fail('asset_revoked');
    const target = reads.asset(request.assetRef);
    const row = get("SELECT * FROM google_business_profile_enrollments WHERE location=? AND verified=1 ORDER BY CASE WHEN state IN ('prepared','active') THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1", target.locationId);
    if (!row) return policy;
    if (row.tenant !== request.tenantRef || row.connection !== request.connectionRef || row.account !== target.accountId) fail('scope_denied');
    const binding = policy.connections.find(c => c.connectionRef === row.connection);
    const s = C.scopeFor(binding, row.scope, row.tenant);
    if (control) {
      // Ordinary disconnect keeps the established control principal. Ownership
      // must already have been proved and committed, but reducing that exact
      // resource's rights remains possible after expiry, revocation or removal
      // from a candidate allowlist. An unverified cancellation grants nothing.
      if (principal.id !== s.controlPrincipalId) fail('scope_denied');
      return { ...policy, grants: [...policy.grants, { principalId: principal.id, tenantRef: row.tenant,
        connectionRef: row.connection, assetRef: request.assetRef, operations: [reads.REVOKE_OPERATION] }] };
    }
    if (!['prepared', 'active'].includes(row.state) || principal.id !== s.readPrincipalId || !s.readOperations.includes(request.operation)
      || row.state === 'prepared' && request.operation !== reads.PREFIX + 'discovery.read.v1'
      || row.config_digest !== C.digestFor(binding, s) || !s.accountIds.includes(row.account) || !s.locationIds.includes(row.location)) fail('scope_denied');
    const lineage = reassociations.forRow(row, s);
    if (!lineage && revokedLocation(row.location)) fail('asset_revoked');
    store.assertAssetActive({ tenantRef: row.tenant, connectionRef: row.connection, assetRef: row.scope });
    return { ...policy, grants: [...policy.grants, { principalId: principal.id, tenantRef: row.tenant,
      connectionRef: row.connection, assetRef: request.assetRef, operations: [request.operation] }] };
  }
  function assert(request, principal, policy) {
    if (!C.isOperation(request.operation)) { resolve(request, principal, policy); return; }
    if ([C.OPERATIONS.retire, C.OPERATIONS.abort].includes(request.operation)) { assertControl(request, principal, policy); return; }
    const { binding, scope: s } = scope(request, policy);
    if (request.operation === C.OPERATIONS.status) { owned(request, principal, policy); return; }
    if (principal.id !== C.ownerFor(policy, binding, s)) fail('scope_denied');
    store.assertAssetActive(request);
    if (request.operation !== C.OPERATIONS.discover) assertCandidate(request, principal, policy);
  }
  function receipt(row, request, s) {
    let accessBlocked = true;
    try {
      store.connection(row.connection, now());
      store.assertAssetActive({ tenantRef: row.tenant, connectionRef: row.connection, assetRef: row.scope });
      const binding = request.policy.connections.find(c => c.connectionRef === row.connection);
      // A valid preparation permits only its exact discovery read. Its state
      // still gates all ordinary reads; accessBlocked describes a separate
      // loss of authority, rather than treating preparation as revocation.
      accessBlocked = !['prepared', 'active'].includes(row.state) || row.config_digest !== C.digestFor(binding, s)
        || !s.accountIds.includes(row.account) || !s.locationIds.includes(row.location);
      const lineage = request.payload.reassociation
        ? reassociations.capture({ ...request, payload: { ...request.payload, ...reassociations.requestFor(row, request.payload.reassociation).payload } }, s)
        : reassociations.forRow(row, s);
      if (!lineage && revokedLocation(row.location)) accessBlocked = true;
    } catch { accessBlocked = true; }
    return { enrollmentId: row.id, assetRef: `gbp:${row.account}:${row.location}`, scopeRef: row.scope,
      accountId: row.account, locationId: row.location, previousAssetRef: row.previous_asset,
      clinicCount: row.clinic_count, clinicSetDigest: row.clinic_digest, state: row.state,
      previousAssetRetired: row.completed_at !== null, accessBlocked,
      ...reassociations.metadata(row, request, s) };
  }
  const draft = (request, found, state, verified = 1) => ({ id: request.payload.enrollmentId, principal: found.owner,
    tenant: request.tenantRef, connection: request.connectionRef, scope: request.assetRef,
    account: request.payload.accountId, location: request.payload.locationId, previous_asset: request.payload.previousAssetRef,
    clinic_count: request.payload.clinicCount, clinic_digest: request.payload.clinicSetDigest,
    config_digest: C.digestFor(found.binding, found.scope), state, verified, created_at: now(), updated_at: now(), completed_at: null });
  async function identity(context) {
    const raw = await http({ hostname: 'www.googleapis.com', path: '/oauth2/v2/userinfo', token: context.secret, signal: context.signal });
    context.assertActive?.();
    if (raw?.id !== context.binding.oauth.subject) fail('oauth_identity_mismatch');
  }
  async function account(context, id) {
    const raw = await http({ hostname: 'mybusinessaccountmanagement.googleapis.com', path: `/v1/accounts/${id}`,
      token: context.secret, signal: context.signal });
    context.assertActive?.();
    if (raw?.name !== `accounts/${id}` || raw.accountName !== undefined
      && (typeof raw.accountName !== 'string' || Buffer.byteLength(raw.accountName) > 8192)) fail('scope_denied');
    return { accountId: id, accountName: raw.name, accountDisplayName: raw.accountName || raw.name };
  }
  async function page(context, id, token) {
    const query = new URLSearchParams({ readMask: C.SUMMARY_READ_MASK, pageSize: '100' });
    if (token !== null) query.set('pageToken', token);
    const raw = await http({ hostname: 'mybusinessbusinessinformation.googleapis.com',
      path: `/v1/accounts/${id}/locations?${query}`, token: context.secret, signal: context.signal });
    context.assertActive?.();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error || raw.locations !== undefined && !Array.isArray(raw.locations)
      || (raw.locations || []).length > 100 || raw.nextPageToken !== undefined
      && (typeof raw.nextPageToken !== 'string' || !raw.nextPageToken || raw.nextPageToken.length > 1024)) fail('provider_failed');
    const rows = raw.locations || []; const ids = new Set();
    for (const item of rows) {
      if (typeof item?.name !== 'string' || !/^locations\/[1-9]\d{0,29}$/.test(item.name) || ids.has(item.name)) fail('provider_failed');
      ids.add(item.name);
    }
    return { rows, next: raw.nextPageToken || null };
  }
  async function verify(context, s, p) {
    await identity(context); await account(context, p.accountId);
    let token = null; const seen = new Set(); let total = 0; let selected = null;
    for (let i = 0; i < 10; i++) {
      const result = await page(context, p.accountId, token); total += result.rows.length;
      if (total > 1000) fail('provider_failed');
      for (const row of result.rows) {
        if (seen.has(row.name)) fail('provider_failed'); seen.add(row.name);
        if (row.name === `locations/${p.locationId}`) selected = C.projectLocation(row);
      }
      // A complete bounded traversal prevents a truncated or cyclic inventory
      // from being treated as proof. It never substitutes storeCode or fid.
      if (result.next === null) {
        if (!selected) fail('scope_denied');
        return selected;
      }
      if (result.next === token || seen.has('cursor:' + result.next)) fail('provider_failed');
      seen.add('cursor:' + result.next); token = result.next;
    }
    fail('provider_failed');
  }
  const controls = { status: 'google_business_profile_enrollment_status', retire: 'google_business_profile_enrollment_retire',
    abort: 'google_business_profile_enrollment_abort' };
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([name, operation]) => [operation, Object.freeze({
    provider: reads.PROVIDER, control: controls[name], secretless: Object.hasOwn(controls, name),
    persistResult: name !== 'discover', requiredScopes: ['https://www.googleapis.com/auth/business.manage'],
    validate: C.validators[name],
    async execute(context) {
      const request = { requestId: context.requestId, operation, connectionRef: context.binding.connectionRef, tenantRef: context.tenantRef,
        assetRef: context.assetRef, payload: context.payload };
      const principal = { id: context.principalId }; const { binding, scope: s } = scope(request, context.policy);
      const withPolicy = { ...request, policy: context.policy };
      if (name === 'status') {
        const row = owned(request, principal, context.policy).row;
        return row ? receipt(row, withPolicy, s) : { enrollmentId: request.payload.enrollmentId, state: 'not_found', accessBlocked: true };
      }
      if (name === 'abort' || name === 'retire') {
        const found = assertControl(request, principal, context.policy);
        const row = found.row || draft(request, found, 'cancelled', 0);
        return receipt({ ...row, state: name === 'abort' ? 'cancelled' : 'active',
          completed_at: name === 'retire' ? row.completed_at || now() : null }, withPolicy, s);
      }
      if (name !== 'discover') {
        const found = assertCandidate(request, principal, context.policy);
        if (name === 'activate' && found.row.state === 'active') return receipt(found.row, withPolicy, s);
        await reassociations.withIO(request, principal, s,
          () => assertCandidate(request, principal, context.policy), () => verify(context, s, request.payload));
        return receipt({ ...(found.row || draft(request, found, 'prepared')), state: name === 'activate' ? 'active' : found.row?.state || 'prepared' }, withPolicy, s);
      }
      await identity(context);
      const epoch = createHash('sha256').update(context.secret).digest('hex');
      const cursorScope = { ...context, operation }; let index = 0; let providerToken = null; let count = 0;
      if (context.payload.pageToken !== null) {
        let value; try { value = JSON.parse(cursor.open(context.payload.pageToken, cursorScope)); } catch { fail('invalid_request'); }
        if (!value || Object.keys(value).sort().join(',') !== 'count,digest,epoch,index,providerToken'
          || value.epoch !== epoch || value.digest !== C.digestFor(binding, s) || !Number.isInteger(value.index)
          || value.index < 0 || value.index >= s.accountIds.length || !Number.isInteger(value.count) || value.count < 0 || value.count >= 1000
          || value.providerToken !== null && (typeof value.providerToken !== 'string' || !value.providerToken || value.providerToken.length > 1024)) fail('invalid_request');
        ({ index, providerToken, count } = value);
      }
      const id = s.accountIds[index]; const observedAccount = await account(context, id);
      const result = await page(context, id, providerToken); count += result.rows.length;
      if (count > 1000 || result.next !== null && (count >= 1000 || result.next === providerToken)) fail('provider_failed');
      const locations = [];
      for (const row of result.rows.filter(row => s.locationIds.includes(row.name.slice('locations/'.length)))) {
        let lineage;
        try { lineage = candidateAllowed({ ...request, payload: { accountId: id, locationId: row.name.slice(10), clinicCount: 1 } }, context.policy, s); }
        catch { continue; }
        locations.push({ ...observedAccount, ...C.projectLocation(row), ...(lineage ? { reassociation: { ...lineage.proof } } : {}) });
      }
      if (result.next === null) { index++; providerToken = null; } else providerToken = result.next;
      return { locations, nextPageToken: index < s.accountIds.length ? cursor.seal(JSON.stringify({ index, providerToken, count,
        epoch, digest: C.digestFor(binding, s) }), cursorScope) : null };
    },
    project(data) { if (!data || Buffer.byteLength(JSON.stringify(data)) > 786432) fail('provider_failed'); return structuredClone(data); },
    ...(['prepare', 'activate', 'retire', 'abort', 'status'].includes(name) ? { commit({ request, principal, policy, result }) {
      assert(request, principal, policy);
      if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
      if (name === 'status') {
        const found = owned(request, principal, policy);
        if (found.row) {
          reassociations.reconcileCancelled(found.row, request.requestId);
          result.data = receipt(found.row, { ...request, policy }, found.scope);
        }
        return;
      }
      const found = ['retire', 'abort'].includes(name) ? assertControl(request, principal, policy) : assertCandidate(request, principal, policy);
      const { row, scope: s } = found; const p = request.payload;
      if (name === 'abort') {
        if (row) store.db.prepare("UPDATE google_business_profile_enrollments SET state='cancelled',updated_at=? WHERE id=? AND completed_at IS NULL").run(now(), row.id);
        else insert(draft(request, found, 'cancelled', 0));
        if (request.payload.reassociation) reassociations.persist(request, s);
        reassociations.reconcileCancelled(get('SELECT * FROM google_business_profile_enrollments WHERE id=?', p.enrollmentId), request.requestId);
        result.data = receipt(get('SELECT * FROM google_business_profile_enrollments WHERE id=?', p.enrollmentId), { ...request, policy }, s);
        return;
      }
      if (name === 'retire') {
        if (row.completed_at !== null) return;
        if (p.previousAssetRef !== null) {
          const previous = reads.asset(p.previousAssetRef);
          store.db.prepare('INSERT INTO google_business_profile_retirements(tenant,connection,asset,location,enrollment_id,retired_at) VALUES (?,?,?,?,?,?)')
            .run(request.tenantRef, request.connectionRef, p.previousAssetRef, previous.locationId, p.enrollmentId, now());
          store.db.prepare("UPDATE google_business_profile_enrollments SET state='retired',updated_at=? WHERE location=? AND tenant=? AND connection=? AND scope=? AND state='active'")
            .run(now(), previous.locationId, request.tenantRef, request.connectionRef, request.assetRef);
        }
        const head = currentHead(request, s);
        const changed = store.db.prepare('UPDATE google_business_profile_scope_heads SET asset=?,enrollment_id=?,revision=revision+1,updated_at=? WHERE tenant=? AND connection=? AND scope=? AND revision=? AND asset IS ?')
          .run(assetFor(p), p.enrollmentId, now(), request.tenantRef, request.connectionRef, request.assetRef, head.revision, p.previousAssetRef);
        if (changed.changes !== 1) fail('idempotency_conflict');
        store.db.prepare('UPDATE google_business_profile_enrollments SET completed_at=?,updated_at=? WHERE id=? AND completed_at IS NULL').run(now(), now(), row.id);
        return;
      }
      if (!row) {
        insert(draft(request, found, 'prepared'));
        if (request.payload.reassociation) reassociations.persist(request, s);
        store.db.prepare('INSERT OR IGNORE INTO google_business_profile_scope_heads(tenant,connection,scope,asset,enrollment_id,revision,updated_at) VALUES (?,?,?,?,NULL,1,?)')
          .run(request.tenantRef, request.connectionRef, request.assetRef, p.previousAssetRef, now());
      }
      if (name === 'activate') store.db.prepare("UPDATE google_business_profile_enrollments SET state='active',updated_at=? WHERE id=? AND state='prepared'").run(now(), p.enrollmentId);
      const current = get('SELECT state FROM google_business_profile_enrollments WHERE id=?', p.enrollmentId);
      if (current.state !== result.data.state) fail('idempotency_conflict');
    } } : {}),
  })]));
  function insert(row) {
    store.db.prepare('INSERT INTO google_business_profile_enrollments(id,principal,tenant,connection,scope,account,location,previous_asset,clinic_count,clinic_digest,config_digest,state,verified,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.principal, row.tenant, row.connection, row.scope, row.account, row.location, row.previous_asset,
        row.clinic_count, row.clinic_digest, row.config_digest, row.state, row.verified, row.created_at, row.updated_at, row.completed_at);
  }
  return { operations, resolve, assert, close() {} };
}
module.exports = { createBusinessProfileEnrollment };
