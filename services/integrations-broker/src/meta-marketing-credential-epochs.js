'use strict';
const K=require('./meta-marketing-credential-shape');
const C = require('./meta-marketing-oauth-contract'), E = require('./meta-marketing-enrollment-contract');
const R = require('./meta-marketing-credential-renewal-contract'), { fail } = require('./errors');
function createMetaMarketingCredentialEpochs({ store, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_credential_renewals (
    id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,scope TEXT NOT NULL,
    expected_epoch INTEGER NOT NULL,expected_version TEXT NOT NULL,expected_digest TEXT NOT NULL,state_hash TEXT NOT NULL UNIQUE,
    scope_digest TEXT NOT NULL,clinic_digest TEXT NOT NULL,asset_digest TEXT NOT NULL,grant_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('awaiting','processing','staged','active','aborted','rejected','interrupted')),
    candidate_digest TEXT,candidate_metadata TEXT,last_error TEXT,activation_request TEXT,activation_reconciled_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS meta_marketing_credential_one_pending ON meta_marketing_credential_renewals(enrollment)
      WHERE state IN ('awaiting','processing','staged','interrupted');
    CREATE TABLE IF NOT EXISTS meta_marketing_effective_credentials (
      enrollment TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>0),version TEXT NOT NULL,digest TEXT NOT NULL,
      metadata TEXT NOT NULL,renewal TEXT NOT NULL UNIQUE,switched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_marketing_credential_protections (
      enrollment TEXT NOT NULL,version TEXT NOT NULL,label TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('intent','held')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(enrollment,version));`);
  const flowFor = id => store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(id);
  function current(row, binding) {
    const original = flowFor(row.flow), pointer = store.db.prepare('SELECT * FROM meta_marketing_effective_credentials WHERE enrollment=?').get(row.id);
    const flow = pointer ? flowFor(pointer.version) : original;
    if (!original || !flow || flow.state !== 'staged' || flow.connection !== row.connection || flow.tenant !== row.tenant || flow.asset !== row.scope
      || flow.config_digest !== row.config_digest || flow.scope_digest !== row.scope_digest || flow.clinic_digest !== original.clinic_digest
      || pointer && (pointer.epoch < 1 || pointer.renewal !== flow.id || pointer.digest !== flow.secret_digest || pointer.metadata !== flow.credential_metadata)) fail('secret_unavailable');
    const metadata = K.metadata(JSON.parse(flow.credential_metadata), binding), originalMetadata = K.metadata(JSON.parse(original.credential_metadata), binding);
    if (['appId','subjectId','tokenType','clientBusinessId','issuerKind','issuerBusinessId','systemUserId','configId','graphVersion'].some(key=>metadata[key]!==originalMetadata[key])) fail('oauth_identity_mismatch');
    const protection = store.db.prepare('SELECT * FROM meta_marketing_credential_protections WHERE enrollment=? AND version=?').get(row.id, flow.id);
    if (protection && (protection.label !== R.retentionStage(row.id, flow.id) || protection.digest !== flow.secret_digest)) fail('secret_unavailable');
    if (pointer && protection?.state !== 'held') fail('secret_unavailable');
    return { epoch: pointer?.epoch || 0, flow, versionId: flow.id, digest: flow.secret_digest, metadata,
      retentionStage: protection?.state === 'held' ? protection.label : null };
  }
  const view = value => ({ epoch: value.epoch, versionId: value.versionId, digest: value.digest, metadata: structuredClone(value.metadata) });
  function expected(value, payload) {
    if (value.epoch !== payload.expectedEpoch || value.versionId !== payload.expectedVersionId || value.digest !== payload.expectedCandidateDigest) fail('secret_version_changed');
  }
  function grantDigest(row) {
    return C.hash(JSON.stringify([row.id, row.flow, row.principal, row.tenant, row.connection, row.scope, row.config_digest,
      row.scope_digest, row.candidate_digest, row.selection_digest, E.assets(JSON.parse(row.assets)).map(E.identity), row.activated_at]));
  }
  async function protect(row, binding, credential, secrets, signal) {
    const label = R.retentionStage(row.id, credential.versionId);
    store.transaction(() => {
      const old = store.db.prepare('SELECT * FROM meta_marketing_credential_protections WHERE enrollment=? AND version=?').get(row.id, credential.versionId);
      if (old && (old.label !== label || old.digest !== credential.digest)) fail('secret_unavailable');
      store.db.prepare("INSERT OR IGNORE INTO meta_marketing_credential_protections VALUES (?,?,?,?,'intent',?,?)")
        .run(row.id, credential.versionId, label, credential.digest, now(), now());
    });
    await secrets.retainCandidate(binding, credential.flow, credential.digest, label, signal);
    store.transaction(() => {
      const held = store.db.prepare("UPDATE meta_marketing_credential_protections SET state='held',updated_at=? WHERE enrollment=? AND version=? AND label=? AND digest=?")
        .run(now(), row.id, credential.versionId, label, credential.digest);
      if (held.changes !== 1) fail('secret_unavailable');
    });
    return label;
  }
  return { current, view, expected, grantDigest, protect, flowFor };
}
module.exports = { createMetaMarketingCredentialEpochs };
