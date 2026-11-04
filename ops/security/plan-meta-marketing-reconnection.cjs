#!/usr/bin/env node
'use strict';
// Initial staging cohort, PLAN ONLY. No AWS client, credential loader, application
// models, SQLite constructor, environment loader or runtime entry point is called.
// A prepared plan does not prove live permissions, schema, provider acceptance or
// that the caller's observation is still current. There is deliberately no apply.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPublicKey } = require('node:crypto');
const M = require('../../services/integrations-broker/src/meta-marketing-contract');
const C = require('../../services/integrations-broker/src/meta-marketing-oauth-contract');
const D = require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
const E = require('../../services/integrations-broker/src/meta-marketing-enrollment-contract');

const ENVIRONMENT = 'staging';
const ACCOUNT = '137819318729';
const ORIGIN = 'https://13.39.100.55:8454';
const AUDIENCE = 'broker:meta-marketing:staging';
const CALLBACK = 'https://autenticacion.clinicaclick.com/oauth/meta/marketing/callback';
const STATE_FILE = '/var/lib/clinicaclick-meta-marketing-staging/broker.sqlite';
const CLIENT_ROOT = '/etc/clinicaclick-meta-clients-v1/staging';
// Certificate publication relocates only the certificate; the enrolled private
// key remains in its original service directory. Never rewrite an observation.
const TLS_CERT_FILES = Object.freeze([
  '/etc/clinicaclick-meta-marketing-staging/server.crt',
  '/etc/clinicaclick-server-certificates/targets/meta-marketing-staging/server.crt',
]);
const TLS_KEY_FILE = '/etc/clinicaclick-meta-marketing-staging/server.key';
const REQUIRED_TABLES = Object.freeze([
  'asset_revocations', 'audit_outbox', 'commands', 'connections',
  'google_ads_enrollment_cancellations', 'google_ads_enrollments', 'google_oauth_flows',
  'meta_marketing_enrollment_assets', 'meta_marketing_enrollment_claims',
  'meta_marketing_enrollments', 'meta_marketing_oauth_flows', 'nonces', 'rate_windows',
  'sqlite_sequence', 'whatsapp_onboarding_assets', 'whatsapp_onboarding_flows',
  'whatsapp_onboarding_phone_observations', 'whatsapp_onboarding_scope_blocks',
  'whatsapp_onboarding_selections', 'whatsapp_onboarding_wabas',
]);
const PENDING = Object.freeze([
  'fresh_config_and_all_state_table_counts_match_preconditions',
  'app_and_slot_pins_kms_and_iam_verified_in_aws',
  'required_rds_schema_scope_blocks_and_asset_ownership_verified',
  'legacy_mapping_adoption_review_without_deleting_aliases_or_scope_blocks',
  'client_key_file_ownership_tls_and_principal_admission_verified',
  'compatible_audit_reader_writer_and_reconciliation_owner_verified',
  'holder_mfa_oauth_selection_and_provider_acceptance_completed',
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const placeholder = value => typeof value === 'string' && /(?:placeholder|fictitious|sentinel|changeme|replace[_-]?me|example|dummy|mock|<|>|(?:^|[-_:/])(?:fake|todo|test|testing|sample)(?:$|[-_:/]))/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  && new Set(value).size >= 6;
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('meta_plan_input_shape_invalid');
}
function noCredentials(value, depth = 0) {
  if (depth > 24) fail('meta_plan_input_shape_invalid');
  if (typeof value === 'string') {
    if (value.length > 65536 || /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|^Bearer\s|^EAA[A-Za-z0-9]{20,}/.test(value)) fail('meta_plan_inline_credential_forbidden');
    return;
  }
  if (Array.isArray(value)) { for (const item of value) noCredentials(item, depth + 1); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:access_?token|refresh_?token|token|app_?secret|private_?key|secretstring|secretbinary|password|authorization|client_secret|code)$/i.test(key)) fail('meta_plan_inline_credential_forbidden');
    noCredentials(item, depth + 1);
  }
}
function pin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{32,64}$/.test(value)
    && new Set(value.toLowerCase()).size >= 6 && !placeholder(value)
    && !/^(.{1,8})\1+$/.test(value);
}
function secretArn(value) {
  const prefix = `arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/meta-marketing/${ENVIRONMENT}/`;
  return typeof value === 'string' && value.length <= 2048 && value.startsWith(prefix)
    && /^[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/.test(value.slice(prefix.length)) && !placeholder(value);
}
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validScopes(scopes) {
  return Array.isArray(scopes) && scopes.length >= 2 && scopes.includes('public_profile')
    && new Set(scopes).size === scopes.length
    && scopes.every((value, i, values) => M.SCOPES.includes(value) && (i === 0 || value > values[i - 1]));
}
function validateObserved(observed) {
  fields(observed, ['config', 'configSha256', 'observedAt', 'stateTables', 'stateTablesComplete']);
  const missing = ['config', 'configSha256', 'observedAt', 'stateTables', 'stateTablesComplete'].filter(key => !Object.hasOwn(observed, key));
  if (missing.length) return missing.map(key => 'observed.' + key);
  if (!hash(observed.configSha256) || !iso(observed.observedAt)
    || observed.stateTablesComplete !== true || !Array.isArray(observed.stateTables)
    || !observed.stateTables.length || observed.stateTables.length > 200) fail('meta_plan_observation_invalid');
  const names = new Set();
  for (const row of observed.stateTables) {
    fields(row, ['name', 'rows']);
    if (typeof row.name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(row.name)
      || names.has(row.name) || row.rows !== 0) fail('meta_plan_expected_empty_state_required');
    names.add(row.name);
  }
  if (REQUIRED_TABLES.some(name => !names.has(name))) fail('meta_plan_state_inventory_incomplete');
  // Importing this module only obtains the existing pure validator. Never call
  // its main(), which would open/create the state database and connect AWS.
  const validateConfig = require('../../services/integrations-broker/src/meta-marketing-oauth-main').validateConfig;
  try { validateConfig(observed.config); } catch { fail('meta_plan_observed_config_invalid'); }
  const cfg = observed.config;
  if (cfg.environment !== ENVIRONMENT || cfg.standby !== true || cfg.port !== 8454
    || cfg.stateFile !== STATE_FILE || cfg.policy.audience !== AUDIENCE
    || cfg.policy.principals.length || cfg.policy.connections.length || cfg.policy.grants.length
    || Object.hasOwn(cfg, 'adsRead')) fail('meta_plan_expected_empty_staging_required');
  if (!TLS_CERT_FILES.includes(cfg.tlsCertFile) || cfg.tlsKeyFile !== TLS_KEY_FILE) fail('meta_plan_tls_environment_invalid');
  return [];
}
function buildPlan(manifest) {
  noCredentials(manifest);
  fields(manifest, ['version', 'mode', 'environment', 'observed', 'scope', 'scopes', 'app', 'slot', 'principals', 'principalsSourceSha256', 'redirectUri']);
  if (manifest.version !== 1 || manifest.mode !== 'plan') fail('meta_plan_explicit_plan_required');
  if (manifest.environment !== ENVIRONMENT) fail('meta_plan_initial_environment_unsupported');
  const missing = [];
  for (const key of ['observed', 'scope', 'scopes', 'app', 'slot', 'principals', 'principalsSourceSha256', 'redirectUri']) {
    if (!Object.hasOwn(manifest, key)) missing.push(key);
  }
  if (Object.hasOwn(manifest, 'observed')) missing.push(...validateObserved(manifest.observed));
  if (Object.hasOwn(manifest, 'scope')) {
    fields(manifest.scope, ['kind', 'id', 'clinicIds']);
    for (const key of ['kind', 'id', 'clinicIds']) if (!Object.hasOwn(manifest.scope, key)) missing.push('scope.' + key);
  }
  for (const [name, keys] of [['app', ['appId', 'secretArn', 'versionId']], ['slot', ['secretArn', 'versionId', 'connectionRef', 'expiresAt']]]) {
    if (!Object.hasOwn(manifest, name)) continue;
    fields(manifest[name], keys);
    for (const key of keys) if (!Object.hasOwn(manifest[name], key)) missing.push(name + '.' + key);
    // Known invalid references remain invalid even while other prerequisites
    // are missing; a partial manifest is not an escape from the environment gate.
    if (Object.hasOwn(manifest[name], 'secretArn') && !secretArn(manifest[name].secretArn)
      || Object.hasOwn(manifest[name], 'versionId') && !pin(manifest[name].versionId)) fail('meta_plan_secret_references_invalid');
  }
  if (Object.hasOwn(manifest, 'redirectUri') && manifest.redirectUri !== CALLBACK) fail('meta_plan_callback_environment_invalid');
  if (Object.hasOwn(manifest, 'scopes') && !validScopes(manifest.scopes)) fail('meta_plan_scopes_invalid');
  if (missing.length) return { version: 1, mode: 'plan', status: 'prerequisites_missing', ready: false, executable: false,
    missing: missing.sort(), pendingLiveVerification: [...PENDING] };

  const { scope, app, slot } = manifest;
  if (!['clinic', 'group'].includes(scope.kind) || !Number.isSafeInteger(scope.id) || scope.id < 1 || scope.id > 2147483647
    || !Array.isArray(scope.clinicIds) || !scope.clinicIds.length || scope.clinicIds.length > 1000
    || scope.clinicIds.some((id, i, ids) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647 || i > 0 && id <= ids[i - 1])
    || scope.kind === 'clinic' && (scope.clinicIds.length !== 1 || scope.clinicIds[0] !== scope.id)) fail('meta_plan_scope_invalid');
  const scopeKey = scope.kind + ':' + scope.id;
  if (!validScopes(manifest.scopes)) fail('meta_plan_scopes_invalid');
  if (!secretArn(app.secretArn) || !secretArn(slot.secretArn) || app.secretArn === slot.secretArn
    || !pin(app.versionId) || !pin(slot.versionId) || app.versionId === slot.versionId
    || typeof app.appId !== 'string' || !/^[1-9][0-9]{5,29}$/.test(app.appId) || new Set(app.appId).size < 3) fail('meta_plan_secret_references_invalid');
  if (typeof slot.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(slot.connectionRef)
    || placeholder(slot.connectionRef) || /(?:^|[_.:-])dev(?:$|[_.:-])/.test(slot.connectionRef)
    || !iso(slot.expiresAt) || Date.parse(slot.expiresAt) <= Date.parse(manifest.observed.observedAt)) fail('meta_plan_slot_invalid');
  if (manifest.redirectUri !== CALLBACK) fail('meta_plan_callback_environment_invalid');
  if (!hash(manifest.principalsSourceSha256) || !Array.isArray(manifest.principals) || manifest.principals.length !== 4) fail('meta_plan_principals_invalid');
  const roles = E.roles(ENVIRONMENT), expectedIds = Object.values(roles), publicKeys = new Set(), keyIds = new Set(), ids = new Set();
  const principals = manifest.principals.map(principal => {
    fields(principal, ['id', 'keyId', 'publicKey']);
    if (!expectedIds.includes(principal.id) || ids.has(principal.id) || typeof principal.keyId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(principal.keyId) || placeholder(principal.keyId)
      || /(?:^|[_.:-])dev(?:$|[_.:-])/.test(principal.keyId) || keyIds.has(principal.keyId)
      || typeof principal.publicKey !== 'string' || !principal.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')) fail('meta_plan_principals_invalid');
    let key;
    try { key = createPublicKey(principal.publicKey); } catch { fail('meta_plan_principals_invalid'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('meta_plan_principals_invalid');
    const fingerprint = sha(key.export({ type: 'spki', format: 'der' }));
    if (publicKeys.has(fingerprint)) fail('meta_plan_principal_key_reuse');
    publicKeys.add(fingerprint); ids.add(principal.id); keyIds.add(principal.keyId);
    return { id: principal.id, keyId: principal.keyId, publicKey: key.export({ type: 'spki', format: 'pem' }), enabled: true, maxPerMinute: 20 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const binding = { connectionRef: slot.connectionRef, provider: C.PROVIDER, initialState: 'active', expiresAt: Date.parse(slot.expiresAt),
    secretArn: slot.secretArn, clientSecretArn: app.secretArn, metaMarketingOAuth: { appId: app.appId,
      appVersionId: app.versionId, slotVersionId: slot.versionId, redirectUri: CALLBACK, scopeKey,
      clinicIds: [...scope.clinicIds], scopes: [...manifest.scopes] } };
  const context = { tenantRef: 'clinic:' + scope.clinicIds[0], connectionRef: slot.connectionRef, assetRef: 'meta-enroll:' + scopeKey };
  const cfg = structuredClone(manifest.observed.config);
  cfg.standby = false; cfg.assetDiscovery = true; cfg.assetEnrollment = true;
  cfg.policy.version = 'meta-marketing-reconnection-' + digest({ scopeKey, connectionRef: slot.connectionRef, appVersionId: app.versionId, slotVersionId: slot.versionId }).slice(0, 16);
  cfg.policy.principals = principals; cfg.policy.connections = [binding];
  cfg.policy.grants = [
    { ...context, principalId: roles.gateway, operations: [...Object.values(C.OPERATIONS), D.OPERATION, ...Object.values(E.OPERATIONS)].sort() },
    { ...context, principalId: roles.control, operations: [C.OPERATIONS.status, C.OPERATIONS.abort, E.OPERATIONS.status, E.OPERATIONS.revoke].sort() },
  ];
  try { require('../../services/integrations-broker/src/meta-marketing-oauth-main').validateConfig(cfg); }
  catch { fail('meta_plan_candidate_config_invalid'); }
  const byId = id => principals.find(row => row.id === id);
  const client = (prefix, role, file) => ({ [prefix + '_KEY_ID']: byId(role).keyId, [prefix + '_KEY_FILE']: CLIENT_ROOT + '/' + file + '.pem' });
  const clients = { META_MARKETING_BROKER_ORIGIN: ORIGIN, META_MARKETING_BROKER_AUDIENCE: AUDIENCE,
    META_MARKETING_BROKER_CA_FILE: CLIENT_ROOT + '/issuer.crt', META_MARKETING_OAUTH_BROKER_ORIGIN: ORIGIN,
    META_MARKETING_OAUTH_BROKER_AUDIENCE: AUDIENCE, META_MARKETING_OAUTH_BROKER_CA_FILE: CLIENT_ROOT + '/issuer.crt',
    ...client('META_MARKETING_BROKER', roles.reader, 'reader'), ...client('META_MARKETING_BROKER_CONTROL', roles.assetControl, 'asset-control'),
    ...client('META_MARKETING_OAUTH_BROKER', roles.gateway, 'oauth-gateway'), ...client('META_MARKETING_OAUTH_BROKER_CONTROL', roles.control, 'oauth-control') };
  return { version: 1, mode: 'plan', status: 'plan_prepared', ready: false, executable: false, missing: [], pendingLiveVerification: [...PENDING],
    scope: { scopeKey, clinicIds: [...scope.clinicIds], clinicSetDigest: C.clinicDigest(binding.metaMarketingOAuth), scopes: [...manifest.scopes] },
    preconditions: { expectedConfigFileSha256: manifest.observed.configSha256, expectedObservedConfigCanonicalSha256: digest(manifest.observed.config),
      observedAt: manifest.observed.observedAt, stateTablesComplete: true, expectedEmptyStateTables: structuredClone(manifest.observed.stateTables).sort((a, b) => a.name.localeCompare(b.name)),
      principalsSourceSha256: manifest.principalsSourceSha256, preserveStateFile: STATE_FILE, preserveTlsFiles: [cfg.tlsCertFile, cfg.tlsKeyFile],
      requireFreshObservationBeforeAnyExternalApply: true },
    candidateConfig: cfg, candidateConfigCanonicalSha256: digest(cfg),
    sqlSlot: { table: 'MetaMarketingOAuthSlots', requires: 'fresh_schema_and_scope_review_then_insert_only_if_absent_in_one_transaction',
      statement: 'INSERT INTO MetaMarketingOAuthSlots (scope_key,connection_ref,asset_ref,app_id,clinic_ids,scopes,redirect_uri,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?)',
      parameters: [scopeKey, slot.connectionRef, context.assetRef, app.appId, JSON.stringify(scope.clinicIds), JSON.stringify(manifest.scopes), CALLBACK, slot.expiresAt.replace('T', ' ').replace('Z', ''), 'active'],
      dateInterpretation: 'UTC_DATETIME_3' },
    secretReferences: { app: { arn: app.secretArn, versionId: app.versionId, requiredStage: 'AWSCURRENT' },
      slot: { arn: slot.secretArn, versionId: slot.versionId, requiredStage: 'AWSCURRENT' }, candidateStage: 'AWSPENDING', promoteCurrent: false },
    stagedClientOverlays: { clients, gates: [
      { phase: 'legacy_generation_only_after_root_prepared_snapshot', values: { META_MARKETING_LEGACY_RECOVERY_ENABLED: 'true' },
        requires: 'dedicated_schema_and_positive_recovery_generation_with_fresh_oauth_no_tombstone_removal' },
      { phase: 'recovery_ready', values: { META_MARKETING_REVOCATION_ENABLED: 'true', META_MARKETING_REVOCATION_WORKER_ENABLED: 'true' } },
      { phase: 'oauth_after_prerequisites', values: { META_MARKETING_OAUTH_ENABLED: 'true', META_MARKETING_OAUTH_WORKER_ENABLED: 'true' } },
      { phase: 'candidate_inventory', values: { META_MARKETING_OAUTH_DISCOVERY_ENABLED: 'true' } },
      { phase: 'selection', values: { META_MARKETING_ENROLLMENT_ENABLED: 'true', META_MARKETING_ENROLLMENT_WORKER_ENABLED: 'true' } },
      { phase: 'verified_active_metadata_reader', values: { META_MARKETING_BROKER_ENABLED: 'true', META_MARKETING_ACCESS_CHECK_ENABLED: 'true' } },
    ], gatewayWorkers: false, schedulerOwner: 'staging', applyToUnrelatedEnvironment: false },
    restrictions: { onlyOneInitialScope: true, metadataOperationsOnly: true, legacyTransportRemainsQuarantined: true,
      adsMetricsEnabled: false, whatsappAuthorizationChanged: false, sqlExecuted: false, awsCalled: false, runtimeChanged: false,
      noCredentialCreationOrCopy: true, preserveHistoryAndControlOnRollback: true, neverRestoreStandbyAfterAuthority: true } };
}
function parse(argv) {
  const [action, inputOption, input, outOption, out, ...extra] = argv;
  if (action !== 'plan' || inputOption !== '--input' || outOption !== '--out' || extra.length
    || !path.isAbsolute(input || '') || !path.isAbsolute(out || '') || path.normalize(input) !== input || path.normalize(out) !== out
    || input === out) fail('meta_plan_arguments_invalid');
  return { input, out };
}
function privateInput(filename) {
  if (fs.realpathSync(filename) !== filename) fail('meta_plan_private_input_required');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > 1048576) fail('meta_plan_private_input_required');
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { fail('meta_plan_input_json_invalid'); }
  } finally { fs.closeSync(fd); }
}
function run(argv) {
  const { input, out } = parse(argv), parent = path.dirname(out);
  if (fs.realpathSync(parent) !== parent) fail('meta_plan_private_output_directory_required');
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700) fail('meta_plan_private_output_directory_required');
  const plan = buildPlan(privateInput(input)), bytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(parent, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return { status: plan.status, ready: false, executable: false, missing: plan.missing,
    outputSha256: sha(bytes), candidateConfigCanonicalSha256: plan.candidateConfigCanonicalSha256 || null };
}
if (require.main === module) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ status: 'meta_plan_failed', ready: false,
    code: /^meta_plan_[a-z_]+$/.test(error.code || '') ? error.code : 'meta_plan_operation_failed' })); process.exitCode = 1; }
}
module.exports = { buildPlan, parse, privateInput, run, REQUIRED_TABLES };
