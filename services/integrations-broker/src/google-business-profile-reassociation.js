'use strict';
const fs = require('node:fs');
const C = require('./google-business-profile-enrollment-contract');
const R = require('./google-business-profile-contract');
const { canonical } = require('./canonical');
const { fail } = require('./errors');

// This module never installs schema. Publication must run the explicit ledger
// migration before enabling a reassociation source in server policy.
const TABLES = ['google_business_profile_reassociations', 'google_business_profile_reassociation_commands',
  'google_business_profile_reassociation_closeouts'];
const DDL = [
  `CREATE TABLE google_business_profile_reassociations (
    enrollment_id TEXT PRIMARY KEY REFERENCES google_business_profile_enrollments(id),
    descriptor_id TEXT NOT NULL, source_tenant TEXT NOT NULL, source_connection TEXT NOT NULL,
    source_scope TEXT NOT NULL, source_asset TEXT NOT NULL, retirement_enrollment_id TEXT NOT NULL,
    retirement_digest TEXT NOT NULL, target_tenant TEXT NOT NULL, target_connection TEXT NOT NULL,
    target_scope TEXT NOT NULL, asset TEXT NOT NULL, proof_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
    CHECK(source_connection=target_connection), CHECK(source_asset=asset), CHECK(source_tenant<>target_tenant))`,
  'CREATE INDEX google_business_profile_reassociation_descriptor ON google_business_profile_reassociations(descriptor_id)',
  `CREATE TABLE google_business_profile_reassociation_commands (
    principal TEXT NOT NULL, request_id TEXT NOT NULL, enrollment_id TEXT NOT NULL, descriptor_id TEXT NOT NULL, asset TEXT NOT NULL,
    proof_digest TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start_ticks TEXT NOT NULL,
    owner_boot_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(principal,request_id))`,
  'CREATE INDEX google_business_profile_reassociation_command_intent ON google_business_profile_reassociation_commands(enrollment_id,descriptor_id)',
  `CREATE TABLE google_business_profile_reassociation_closeouts (
    principal TEXT NOT NULL, request_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
    closed_by_request_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('cancelled_quiescent','cancelled_dead_owner')),
    closed_at INTEGER NOT NULL, PRIMARY KEY(principal,request_id),
    FOREIGN KEY(principal,request_id) REFERENCES google_business_profile_reassociation_commands(principal,request_id))`,
];
// Shared by engines/store instances in this process, without putting payloads,
// credentials or mutable authorization in the registry.
const inFlight = new Map();
function processIdentity(pid = process.pid) {
  return { pid, startTicks: fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[19],
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
const same = (a, b) => canonical(a) === canonical(b);
function createBusinessProfileReassociation({ store, now = Date.now, identity = processIdentity }) {
  const get = (sql, ...args) => store.db.prepare(sql).get(...args);
  const all = (sql, ...args) => store.db.prepare(sql).all(...args);
  const installed = TABLES.every(name => get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  const registry = String(store.db.location?.() || store.filename || 'owner-state');
  const flightKey = (principal, requestId) => registry + ':' + principal + ':' + requestId;
  const ledger = enrollmentId => installed ? get('SELECT * FROM google_business_profile_reassociations WHERE enrollment_id=?', enrollmentId) : null;
  const proofOf = row => ({ descriptorId: row.descriptor_id, sourceTenantRef: row.source_tenant,
    sourceConnectionRef: row.source_connection, sourceScopeRef: row.source_scope, sourceAssetRef: row.source_asset,
    retirementEnrollmentId: row.retirement_enrollment_id, retirementDigest: row.retirement_digest });
  const requestFor = (row, proof) => ({ tenantRef: row.tenant, connectionRef: row.connection, assetRef: row.scope,
    payload: { enrollmentId: row.id, accountId: row.account, locationId: row.location, previousAssetRef: row.previous_asset,
      clinicCount: row.clinic_count, clinicSetDigest: row.clinic_digest, reassociation: proof } });
  function pending(row) {
    if (!installed) return [];
    return all(`SELECT c.*,n.state AS command_state FROM google_business_profile_reassociation_commands c
      LEFT JOIN commands n ON n.principal=c.principal AND n.id=c.request_id
      LEFT JOIN google_business_profile_reassociation_closeouts f ON f.principal=c.principal AND f.request_id=c.request_id
      WHERE c.enrollment_id=? AND f.request_id IS NULL AND (n.state IS NULL OR n.state IN ('started','unknown'))`, row.id);
  }
  const tuple = (tenant, connection, scope, asset) => canonical([tenant, connection, scope, asset]);
  const sourceTuple = proof => tuple(proof.sourceTenantRef, proof.sourceConnectionRef, proof.sourceScopeRef, proof.sourceAssetRef);
  const targetTuple = row => tuple(row.tenant, row.connection, row.scope, `gbp:${row.account}:${row.location}`);
  const fact = proof => canonical([proof.sourceTenantRef, proof.sourceConnectionRef, proof.sourceScopeRef,
    proof.sourceAssetRef, proof.retirementEnrollmentId, proof.retirementDigest]);
  function validateLedger(saved, row) {
    const proof = proofOf(saved); C.validateReassociation(proof);
    if (saved.enrollment_id !== row.id || saved.target_tenant !== row.tenant || saved.target_connection !== row.connection
      || saved.target_scope !== row.scope || saved.asset !== `gbp:${row.account}:${row.location}`
      || saved.source_asset !== saved.asset || saved.source_connection !== row.connection || saved.source_tenant === row.tenant
      || proof.sourceScopeRef !== 'gbp-enroll:' + proof.sourceTenantRef
      || saved.proof_digest !== C.reassociationDigest(proof, requestFor(row, proof))) fail('idempotency_conflict');
    return proof;
  }
  function retirementEvidence(proof, physical) {
    C.validateReassociation(proof);
    const retirement = get('SELECT * FROM google_business_profile_retirements WHERE tenant=? AND connection=? AND asset=?',
      proof.sourceTenantRef, proof.sourceConnectionRef, proof.sourceAssetRef);
    if (!retirement || retirement.location !== physical.locationId || retirement.enrollment_id !== proof.retirementEnrollmentId
      || C.retirementDigest(retirement) !== proof.retirementDigest) fail('asset_revoked');
    const successor = get('SELECT * FROM google_business_profile_enrollments WHERE id=?', proof.retirementEnrollmentId);
    if (!successor || successor.tenant !== proof.sourceTenantRef || successor.connection !== proof.sourceConnectionRef
      || successor.scope !== proof.sourceScopeRef || successor.previous_asset !== proof.sourceAssetRef
      || successor.verified !== 1 || successor.completed_at === null || !['active', 'retired'].includes(successor.state)) fail('scope_denied');
    const head = get('SELECT * FROM google_business_profile_scope_heads WHERE tenant=? AND connection=? AND scope=?',
      proof.sourceTenantRef, proof.sourceConnectionRef, proof.sourceScopeRef);
    if (!head || head.asset === proof.sourceAssetRef || head.enrollment_id === null) fail('scope_denied');
    return retirement;
  }
  function ancestry(proof, request, physical) {
    const sources = new Map(), ancestors = new Map(), prefixes = new Map(), retirements = new Map();
    const seen = new Set([tuple(request.tenantRef, request.connectionRef, request.assetRef, proof.sourceAssetRef)]);
    const seenEnrollments = new Set([request.payload.enrollmentId].filter(Boolean));
    let current = proof;
    for (;;) {
      if (retirements.size >= 20 || current.sourceConnectionRef !== request.connectionRef
        || current.sourceAssetRef !== proof.sourceAssetRef || current.sourceScopeRef !== 'gbp-enroll:' + current.sourceTenantRef
        || seen.has(sourceTuple(current))) fail('scope_denied');
      seen.add(sourceTuple(current));
      const retirement = retirementEvidence(current, physical);
      if (retirements.has(current.retirementDigest)) fail('scope_denied');
      retirements.set(current.retirementDigest, retirement); sources.set(sourceTuple(current), current);
      const owners = all(`SELECT * FROM google_business_profile_enrollments WHERE tenant=? AND connection=? AND scope=?
        AND account=? AND location=? AND verified=1 AND state='retired' AND completed_at IS NOT NULL LIMIT 2`,
      current.sourceTenantRef, current.sourceConnectionRef, current.sourceScopeRef, physical.accountId, physical.locationId);
      if (owners.length > 1) fail('scope_denied');
      const owner = owners[0];
      if (!owner) break;
      if (seenEnrollments.has(owner.id) || owner.id === current.retirementEnrollmentId
        || owner.completed_at > retirement.retired_at || pending(owner).length) fail('scope_denied');
      seenEnrollments.add(owner.id); ancestors.set(owner.id, owner);
      const saved = ledger(owner.id);
      if (!saved) {
        if (get('SELECT 1 FROM google_business_profile_reassociation_commands WHERE enrollment_id=? LIMIT 1', owner.id)) fail('scope_denied');
        break; // A proved ordinary managed source is an independent root.
      }
      const previous = validateLedger(saved, owner);
      prefixes.set(targetTuple(owner), fact(previous));
      current = previous;
    }
    return { sources, ancestors, prefixes, retirements, passive: new Map() };
  }
  function assertReusable(proof, enrollmentId, chain, request) {
    const currentTuple = tuple(request.tenantRef, request.connectionRef, request.assetRef, proof.sourceAssetRef);
    const facts = new Set([...chain.sources.values()].map(fact));
    for (const saved of all(`SELECT * FROM google_business_profile_reassociations
      WHERE (descriptor_id=? OR asset LIKE ?) AND enrollment_id<>?`, proof.descriptorId,
    'gbp:%:' + R.asset(proof.sourceAssetRef).locationId, enrollmentId)) {
      const previous = get('SELECT * FROM google_business_profile_enrollments WHERE id=?', saved.enrollment_id);
      if (!previous || pending(previous).length) fail('idempotency_conflict');
      validateLedger(saved, previous);
      if (chain.ancestors.has(previous.id) && previous.state === 'retired' && previous.completed_at !== null) continue;
      if (previous.state !== 'cancelled' || previous.completed_at !== null) fail('idempotency_conflict');
      const previousFact = fact(proofOf(saved));
      if (targetTuple(previous) !== currentTuple && chain.prefixes.get(targetTuple(previous)) !== previousFact
        || !facts.has(previousFact)) fail('scope_denied');
      chain.passive.set(previous.id, previous);
    }
    // An attempt may have dispatched before creating a candidate/ledger. Its
    // uncertain native command must be reconciled by that same intent first.
    const commands = all(`SELECT DISTINCT c.enrollment_id,e.state FROM google_business_profile_reassociation_commands c
      LEFT JOIN google_business_profile_enrollments e ON e.id=c.enrollment_id
      WHERE (c.descriptor_id=? OR c.asset LIKE ?) AND c.enrollment_id<>?`, proof.descriptorId,
    'gbp:%:' + R.asset(proof.sourceAssetRef).locationId, enrollmentId);
    for (const previous of commands) if ((!chain.ancestors.has(previous.enrollment_id) && !chain.passive.has(previous.enrollment_id))
      || pending({ id: previous.enrollment_id }).length) fail('idempotency_conflict');
  }
  function capture(request, scope, { discover = false, cleanup = false } = {}) {
    const p = request.payload;
    const saved = p.enrollmentId ? ledger(p.enrollmentId) : null;
    let proof = p.reassociation;
    if (discover) {
      const choices = (scope.reassociationSources || []).filter(item => {
        const physical = R.asset(item.sourceAssetRef);
        return physical.accountId === p.accountId && physical.locationId === p.locationId;
      });
      if (choices.length > 1) fail('scope_denied'); proof = choices[0];
    }
    if (!proof) { if (saved) fail('idempotency_conflict'); return null; }
    if (!installed) fail('scope_denied');
    C.validateReassociation(proof);
    const physical = R.asset(proof.sourceAssetRef);
    if (proof.sourceConnectionRef !== request.connectionRef || proof.sourceTenantRef === request.tenantRef
      || proof.sourceScopeRef !== 'gbp-enroll:' + proof.sourceTenantRef
      || physical.accountId !== p.accountId || physical.locationId !== p.locationId
      || !request.assetRef.startsWith('gbp-enroll:clinic:')) fail('scope_denied');
    const digest = discover ? null : C.reassociationDigest(proof, request);
    if (saved && (!same(proofOf(saved), proof) || saved.proof_digest !== digest
      || saved.target_tenant !== request.tenantRef || saved.target_connection !== request.connectionRef
      || saved.target_scope !== request.assetRef || saved.asset !== proof.sourceAssetRef)) fail('idempotency_conflict');
    if (cleanup && saved) return { proof, digest, saved, physical };
    if (cleanup && !discover && all('SELECT proof_digest,descriptor_id FROM google_business_profile_reassociation_commands WHERE enrollment_id=?', p.enrollmentId)
      .some(command => command.proof_digest === digest && command.descriptor_id === proof.descriptorId)) {
      // A previously dispatched, authenticated intent may always be cancelled
      // after its admission capability changed. This grants no resource access.
      return { proof, digest, saved, physical };
    }
    if (!(scope.reassociationSources || []).some(item => same(item, proof))) fail('scope_denied');
    const chain = ancestry(proof, request, physical);
    const targetHead = get('SELECT asset,enrollment_id FROM google_business_profile_scope_heads WHERE tenant=? AND connection=? AND scope=?',
      request.tenantRef, request.connectionRef, request.assetRef);
    const previous = targetHead ? targetHead.asset : scope.bootstrapPreviousAssetRef;
    if (!saved && (previous === proof.sourceAssetRef || !discover && p.previousAssetRef !== previous)) fail('idempotency_conflict');
    if (!cleanup) {
      if (get('SELECT 1 FROM asset_revocations WHERE asset LIKE ? LIMIT 1', 'gbp:%:' + physical.locationId)) fail('asset_revoked');
      const retirements = all('SELECT * FROM google_business_profile_retirements WHERE location=?', physical.locationId);
      if (retirements.length !== chain.retirements.size || retirements.some(row => !chain.retirements.has(C.retirementDigest(row)))) fail('asset_revoked');
      assertReusable(proof, p.enrollmentId || 'discovery', chain, request);
    }
    return { proof, digest, saved, physical, chain };
  }
  function persist(request, scope) {
    const found = capture(request, scope, { cleanup: true }); if (!found || found.saved) return;
    const p = found.proof;
    store.db.prepare(`INSERT INTO google_business_profile_reassociations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(request.payload.enrollmentId, p.descriptorId, p.sourceTenantRef, p.sourceConnectionRef, p.sourceScopeRef,
        p.sourceAssetRef, p.retirementEnrollmentId, p.retirementDigest, request.tenantRef, request.connectionRef,
        request.assetRef, p.sourceAssetRef, found.digest, now());
  }
  function forRow(row, scope) {
    const saved = ledger(row.id); if (!saved) return null;
    return capture(requestFor(row, proofOf(saved)), scope);
  }
  function ownerDead(command) {
    try {
      const actual = identity(command.owner_pid);
      return actual.pid !== command.owner_pid || actual.startTicks !== command.owner_start_ticks || actual.bootId !== command.owner_boot_id;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
  }
  function reconcileCancelled(row, requestId) {
    if (!installed || row.state !== 'cancelled' || row.completed_at !== null) return;
    const local = identity();
    for (const command of pending(row)) {
      if (!['started', 'unknown'].includes(command.command_state)) continue;
      const dead = ownerDead(command);
      const localOwner = command.owner_pid === local.pid && command.owner_start_ticks === local.startTicks && command.owner_boot_id === local.bootId;
      if (!dead && (!localOwner || command.command_state === 'started' || inFlight.has(flightKey(command.principal, command.request_id)))) continue;
      store.db.prepare('INSERT INTO google_business_profile_reassociation_closeouts VALUES (?,?,?,?,?,?)')
        .run(command.principal, command.request_id, row.id, requestId, dead ? 'cancelled_dead_owner' : 'cancelled_quiescent', now());
    }
  }
  async function withIO(request, principal, scope, check, work) {
    if (!request.payload.reassociation) return work();
    const key = flightKey(principal.id, request.requestId);
    if (inFlight.has(key)) fail('idempotency_conflict');
    inFlight.set(key, true);
    try {
      store.transaction(() => {
        check(); const found = capture(request, scope); const owner = identity();
        if (get('SELECT state FROM commands WHERE principal=? AND id=?', principal.id, request.requestId)?.state !== 'started') fail('idempotency_conflict');
        store.db.prepare('INSERT INTO google_business_profile_reassociation_commands VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(principal.id, request.requestId, request.payload.enrollmentId, found.proof.descriptorId, found.proof.sourceAssetRef, found.digest,
            owner.pid, owner.startTicks, owner.bootId, now());
      });
      return await work();
    } finally { inFlight.delete(key); }
  }
  function metadata(row, request, scope) {
    const saved = ledger(row.id);
    const proof = saved ? proofOf(saved) : request.payload.reassociation;
    if (!proof) return {};
    C.validateReassociation(proof);
    return { reassociation: { ...proof, proofDigest: saved?.proof_digest || C.reassociationDigest(proof, requestFor(row, proof)) },
      reassociationCleanupPending: row.state === 'cancelled' && pending(row).length > 0 };
  }
  return { capture, persist, forRow, withIO, metadata, reconcileCancelled, ledger, requestFor,
    allowsSourceGrant: (found, grant) => !!found?.chain && [...found.chain.sources.values()].some(proof => grant.tenantRef === proof.sourceTenantRef
      && grant.connectionRef === proof.sourceConnectionRef && grant.assetRef === proof.sourceAssetRef),
    allowsSourceHistory: (found, row) => {
      if (!found?.chain) return false;
      const captured = found.chain.ancestors.get(row.id) || found.chain.passive.get(row.id);
      return !!captured && ['id', 'tenant', 'connection', 'scope', 'account', 'location', 'state', 'completed_at']
        .every(key => row[key] === captured[key]);
    } };
}
module.exports = { createBusinessProfileReassociation, TABLES, DDL, processIdentity };
