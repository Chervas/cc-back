'use strict';
// Creates empty, version-pinned candidate slots only. Never exchanges a Meta
// code, reads another provider's credentials, grants sending, or changes IAM.
const { randomUUID } = require('node:crypto');
const { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const C = require('./whatsapp-onboarding-contract'); const P = require('./whatsapp-provisioning-contract');
const { authenticate } = require('./auth'); const { request: validateRequest } = require('./contracts');
const { canonical } = require('./broker'); const { eventFor } = require('./audit'); const { BrokerError, fail } = require('./errors');
const { SECRET_KEY } = require('./google-main');
function createWhatsappProvisioning({ store, policy, settings, client, now = () => Date.now() }) {
  const config = P.validateSettings(settings);
  // Capacity is an operational limit, not part of an existing grant's identity.
  const { maxConnections } = config;
  const configDigest = P.settingsDigest(config);
  const template = P.publicTemplate(config);
  store.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_provisioned_slots (
    scope TEXT PRIMARY KEY, connection TEXT NOT NULL UNIQUE, clinic_ids TEXT NOT NULL,
    config_digest TEXT NOT NULL, version_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
    arn TEXT, state TEXT NOT NULL CHECK(state IN ('preparing','ready')), created_at INTEGER NOT NULL,
    provider_grant_policy TEXT CHECK(provider_grant_policy IS NULL OR provider_grant_policy IN ('strict-v1','meta-app-companion-v1')));
    CREATE TABLE IF NOT EXISTS whatsapp_preparation_requests (
    id TEXT PRIMARY KEY, digest TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER);`);
  // Additive only: historical NULL profiles keep their exact legacy binding.
  store.transaction(() => {
    if (!store.db.prepare("PRAGMA table_info(whatsapp_provisioned_slots)").all().some(column => column.name === 'provider_grant_policy')) {
      store.db.exec("ALTER TABLE whatsapp_provisioned_slots ADD COLUMN provider_grant_policy TEXT CHECK(provider_grant_policy IS NULL OR provider_grant_policy IN ('strict-v1','meta-app-companion-v1'))");
    }
  });
  const rowFor = scope => store.db.prepare('SELECT * FROM whatsapp_provisioned_slots WHERE scope=?').get(scope);
  const grantPolicy = binding => binding.customer.providerGrantPolicy || P.STRICT_GRANT_POLICY;
  function policyForRow(row) {
    if (row.provider_grant_policy != null) {
      if (![P.STRICT_GRANT_POLICY,C.PROVIDER_GRANT_POLICY].includes(row.provider_grant_policy)) fail('scope_denied');
      return row.provider_grant_policy;
    }
    return grantPolicy(P.publicBinding(template,row.scope,JSON.parse(row.clinic_ids)));
  }
  function hasRetainedAuthority(row, requestId) {
    // An expired/interrupted attempt is not a virgin scope. Only a confirmed
    // abort without any candidate evidence can precede a profile selection.
    const asset = 'wa-enroll:' + row.scope;
    if (store.db.prepare("SELECT 1 FROM whatsapp_onboarding_flows WHERE (connection=? OR asset=?) AND (state<>'aborted' OR secret_digest IS NOT NULL OR credential_metadata IS NOT NULL) LIMIT 1").get(row.connection,asset)) return true;
    for (const table of ['whatsapp_onboarding_assets','whatsapp_onboarding_wabas']) {
      if (store.db.prepare(`SELECT 1 FROM ${table} WHERE connection=? OR asset=? LIMIT 1`).get(row.connection,asset)) return true;
    }
    if (store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='whatsapp_activations'").get()
      && store.db.prepare("SELECT 1 FROM whatsapp_activations a LEFT JOIN whatsapp_onboarding_flows f ON f.id=a.flow_id WHERE f.connection=? OR f.asset=? OR json_extract(a.definition,'$.enrollmentBinding.connectionRef')=? OR json_extract(a.definition,'$.enrollmentBinding.whatsappOnboarding.scopeKey')=? LIMIT 1").get(row.connection,asset,row.connection,row.scope)) return true;
    if (store.db.prepare('SELECT 1 FROM whatsapp_preparation_requests WHERE scope=? AND completed_at IS NULL AND id<>? LIMIT 1').get(row.scope,requestId)) return true;
    // Old command journals do not retain their scope. Conservatively defer a
    // profile change while any Owner command is in flight, without changing it.
    return !!store.db.prepare("SELECT 1 FROM commands WHERE state='started' LIMIT 1").get();
  }
  function checkBlocks(scope, clinicIds) {
    for (const key of new Set([scope, ...clinicIds.map(id => 'clinic:' + id)])) {
      if (store.db.prepare('SELECT 1 FROM whatsapp_onboarding_scope_blocks WHERE scope_key=?').get(key)) fail('asset_revoked');
    }
    const ref = P.connectionRef(scope);
    const state = store.db.prepare('SELECT 1 FROM connections WHERE ref=?').get(ref);
    if (state) store.connection(ref, now());
    store.assertAssetActive({ tenantRef: 'clinic:' + clinicIds[0], connectionRef: ref, assetRef: 'wa-enroll:' + scope });
  }
  function fromRow(row) {
    return P.bindingFromSlot(config,row);
  }
  function resolveBinding(ref) {
    const row = store.db.prepare('SELECT * FROM whatsapp_provisioned_slots WHERE connection=?').get(ref);
    return row ? fromRow(row) : null;
  }
  function resolve(request, principal, base) {
    if (base.connections.some(b => b.connectionRef === request.connectionRef)) return base;
    const binding = resolveBinding(request.connectionRef); if (!binding) return base;
    // These are enrollment grants only. They cannot reach the sending broker.
    C.authorize({ request, principal, binding });
    const grants = ['gateway:whatsapp-onboarding','control:whatsapp-onboarding'].map(principalId => ({ principalId,
      tenantRef: 'clinic:' + binding.whatsappOnboarding.clinicIds[0], assetRef: 'wa-enroll:' + binding.whatsappOnboarding.scopeKey,
      connectionRef: binding.connectionRef, operations: principalId.startsWith('gateway:') ? Object.values(C.OPERATIONS)
        : [C.OPERATIONS.status,C.OPERATIONS.abort,C.REVOKE] }));
    return { ...base, connections: [...base.connections,binding], grants: [...base.grants,...grants] };
  }
  const tagsFor = row => [{ Key: 'ManagedBy', Value: 'clinicaclick-whatsapp-onboarding' },
    { Key: 'ClinicaclickScope', Value: row.scope }, { Key: 'Purpose', Value: 'candidate' }];
  const placeholderFor = row => ({ version: 1, provider: 'meta-whatsapp-onboarding-slot',
    connectionRef: row.connection, scopeKey: row.scope, appId: config.appId });
  const validArn = (arn, row) => typeof arn === 'string' && arn.startsWith(P.ARN_PREFIX + row.name + '-')
    && /^[A-Za-z0-9]{6}$/.test(arn.slice((P.ARN_PREFIX + row.name + '-').length));
  async function observe(row, signal) {
    let metadata;
    try { metadata = await client.send(new DescribeSecretCommand({ SecretId: row.arn || row.name }), { abortSignal: signal }); }
    catch (error) { if (error?.name === 'ResourceNotFoundException') return null; throw error; }
    if (!validArn(metadata.ARN,row) || metadata.Name !== row.name || metadata.KmsKeyId !== SECRET_KEY || metadata.DeletedDate
      || !metadata.VersionIdsToStages?.[row.version_id]?.includes('AWSCURRENT')
      || Object.entries(metadata.VersionIdsToStages).some(([id,stages]) => id !== row.version_id && stages.includes('AWSCURRENT'))
      || tagsFor(row).some(tag => !metadata.Tags?.some(t => t.Key === tag.Key && t.Value === tag.Value))) fail('secret_unavailable');
    // Only our pre-journaled placeholder version is read; candidates and tokens
    // are never read by this provisioning path.
    const value = await client.send(new GetSecretValueCommand({ SecretId: metadata.ARN, VersionId: row.version_id, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
    try {
      if (value.ARN !== metadata.ARN || value.VersionId !== row.version_id || !value.VersionStages?.includes('AWSCURRENT')
        || typeof value.SecretString !== 'string' || value.SecretString.length > 2048
        || canonical(JSON.parse(value.SecretString)) !== canonical(placeholderFor(row))) fail('secret_unavailable');
      return metadata.ARN;
    } finally { delete value.SecretString; value.SecretBinary?.fill?.(0); }
  }
  async function ensureSlot(row, signal) {
    let arn = await observe(row,signal);
    if (!arn) {
      // A missing ready slot is not permission to recreate deleted evidence.
      if (row.state === 'ready') fail('secret_unavailable');
      let createError;
      try {
        await client.send(new CreateSecretCommand({ Name: row.name, KmsKeyId: SECRET_KEY,
          ClientRequestToken: row.version_id, SecretString: JSON.stringify(placeholderFor(row)), Tags: tagsFor(row) }), { abortSignal: signal });
      } catch (error) { createError = error; }
      // A lost acknowledgement or concurrent creator is reconciled by exact
      // version, tags, KMS and placeholder. Never overwrite/adopt another slot.
      arn = await observe(row,signal);
      if (!arn) throw createError || new BrokerError('secret_unavailable');
    }
    return arn;
  }
  async function prepare(raw, headers) {
    if (!Buffer.isBuffer(raw) || raw.length > 32768) fail('invalid_request');
    let request;
    try { request = validateRequest(JSON.parse(raw.toString('utf8'))); } catch { fail('invalid_request'); }
    const principal = authenticate(raw,headers,request,policy,now());
    store.acceptNonce(principal.id,request.nonce,now(),principal.maxPerMinute);
    if (request.operation !== P.PREPARE || principal.id !== 'gateway:whatsapp-onboarding') fail('scope_denied');
    const v = P.validatePreparation(request.payload,now());
    if (request.connectionRef !== P.connectionRef(v.scopeKey) || request.assetRef !== 'wa-enroll:' + v.scopeKey
      || request.tenantRef !== 'clinic:' + v.clinicIds[0]
      || policy.connections.some(b => b.whatsappOnboarding.scopeKey === v.scopeKey || b.connectionRef === request.connectionRef)) fail('scope_denied');
    const desired = grantPolicy(P.publicBinding(template,v.scopeKey,v.clinicIds,v.mode));
    // A modern automatic coexistence admission must be ready to validate the
    // mixed application grant. Refuse before creating even an empty slot when
    // the server capability/legacy override is absent.
    if (v.mode === 'coexistence' && desired !== C.PROVIDER_GRANT_POLICY) fail('invalid_request');
    // The request has passed principal, scope and template validation. Audit this
    // exact preparation grant; it is not an operational send authorization.
    const auditPolicy = { ...policy, grants: [{ principalId: principal.id, tenantRef: request.tenantRef,
      assetRef: request.assetRef, connectionRef: request.connectionRef, operations: [P.PREPARE] }] };
    const digest = C.hash(canonical({ connectionRef: request.connectionRef, payload: v,
      ...(Object.hasOwn(v,'mode') ? { providerGrantPolicy: desired } : {}) }));
    const row = store.transaction(() => {
      checkBlocks(v.scopeKey,v.clinicIds);
      const prior = store.db.prepare('SELECT * FROM whatsapp_preparation_requests WHERE id=?').get(request.requestId);
      if (prior && (prior.digest !== digest || prior.scope !== v.scopeKey)) fail('idempotency_conflict');
      let found = rowFor(v.scopeKey);
      if (found && (found.config_digest !== configDigest || found.clinic_ids !== JSON.stringify(v.clinicIds))) fail('idempotency_conflict');
      if (store.backlog().pending + 2 > policy.maxBacklog) fail('audit_unavailable');
      if (!found) {
        if (store.db.prepare('SELECT count(*) AS n FROM whatsapp_provisioned_slots').get().n >= maxConnections) fail('rate_limited');
        store.db.prepare("INSERT INTO whatsapp_provisioned_slots(scope,connection,clinic_ids,config_digest,version_id,name,arn,state,created_at,provider_grant_policy) VALUES (?,?,?,?,?,?,NULL,'preparing',?,?)")
          .run(v.scopeKey,request.connectionRef,JSON.stringify(v.clinicIds),configDigest,randomUUID(),P.PREFIX + v.scopeKey.replace(':','-') + '/candidate',now(),
            Object.hasOwn(v,'mode') ? desired : null);
        found = rowFor(v.scopeKey);
      } else {
        const effective = policyForRow(found);
        if (effective !== desired) {
          // Never downgrade or rewrite a previously selected profile. An old
          // strict NULL slot may be upgraded only before it has authority.
          if (found.provider_grant_policy != null || desired !== C.PROVIDER_GRANT_POLICY
            || effective !== P.STRICT_GRANT_POLICY || hasRetainedAuthority(found,request.requestId)) fail('idempotency_conflict');
          store.db.prepare('UPDATE whatsapp_provisioned_slots SET provider_grant_policy=? WHERE scope=? AND provider_grant_policy IS NULL')
            .run(desired,found.scope);
          found = rowFor(v.scopeKey);
        } else if (found.provider_grant_policy == null && Object.hasOwn(v,'mode') && !hasRetainedAuthority(found,request.requestId)) {
          // Pin an empty slot, but do not even rewrite NULL on historical
          // authorities whose effective fingerprint is already compatible.
          store.db.prepare('UPDATE whatsapp_provisioned_slots SET provider_grant_policy=? WHERE scope=? AND provider_grant_policy IS NULL')
            .run(desired,found.scope);
          found = rowFor(v.scopeKey);
        }
      }
      if (!prior) {
        store.db.prepare('INSERT INTO whatsapp_preparation_requests VALUES (?,?,?,?,NULL)').run(request.requestId,digest,v.scopeKey,now());
        store.appendAudit(eventFor(request,principal,auditPolicy,'integration.requested','accepted','whatsapp_slot_preparation_requested',now()));
      }
      return found;
    });
    const signal = AbortSignal.timeout(15000);
    try {
      const arn = await ensureSlot(row,signal);
      return store.transaction(() => {
        if (signal.aborted || now() >= v.expiresAt) fail('oauth_flow_interrupted');
        checkBlocks(v.scopeKey,v.clinicIds);
        if (store.backlog().pending >= policy.maxBacklog) fail('audit_unavailable');
        const current = rowFor(v.scopeKey);
        if (current.version_id !== row.version_id || current.config_digest !== configDigest || current.arn && current.arn !== arn
          || current.provider_grant_policy !== row.provider_grant_policy || policyForRow(current) !== desired) fail('idempotency_conflict');
        if (current.state !== 'ready') {
          store.db.prepare("UPDATE whatsapp_provisioned_slots SET arn=?,state='ready' WHERE scope=?").run(arn,v.scopeKey);
          store.seedConnection(row.connection,{state:'active',expiresAt:null});
        }
        const completed = store.db.prepare('SELECT completed_at FROM whatsapp_preparation_requests WHERE id=?').get(request.requestId);
        if (completed.completed_at === null) {
          store.appendAudit(eventFor(request,principal,auditPolicy,'integration.completed','success','whatsapp_slot_prepared',now()));
          store.db.prepare('UPDATE whatsapp_preparation_requests SET completed_at=? WHERE id=?').run(now(),request.requestId);
        }
        return { requestId: request.requestId, replayed: completed.completed_at !== null, data: {
          status: 'prepared', connected: false, binding: P.publicBinding(template,v.scopeKey,v.clinicIds,v.mode) } };
      });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      fail('secret_unavailable');
    }
  }
  return { prepare, resolve, resolveBinding };
}
module.exports = { createWhatsappProvisioning };
