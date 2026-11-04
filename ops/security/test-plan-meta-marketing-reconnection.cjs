'use strict';
// Offline unit tests. No environment loading, AWS calls, SQL, runtime startup,
// real credentials or writes outside each owned temporary fixture directory.
require('../../services/integrations-broker/test/offline-guard.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash, generateKeyPairSync, randomUUID } = require('node:crypto');
const P = require('./plan-meta-marketing-reconnection.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const EXPECTED_IDS = ['gateway:staging:meta-marketing-oauth', 'control:staging:meta-marketing-oauth', 'staging:meta-marketing', 'control:staging:meta-marketing'];
const BASE = {
  version: 1, mode: 'plan', environment: 'staging',
  observed: {
    config: { cohort: 'meta-marketing-oauth-v1', enabled: true, environment: 'staging', standby: true,
      listenAddress: '0.0.0.0', port: 8454, stateFile: '/var/lib/clinicaclick-meta-marketing-staging/broker.sqlite',
      tlsCertFile: '/etc/clinicaclick-meta-marketing-staging/server.crt', tlsKeyFile: '/etc/clinicaclick-meta-marketing-staging/server.key',
      policy: { audience: 'broker:meta-marketing:staging', version: 'empty-installation-v1', maxBacklog: 100,
        principals: [], connections: [], grants: [] } },
    configSha256: sha('offline observed raw config bytes, not a live observation'),
    observedAt: '2030-01-01T00:00:00.000Z', stateTablesComplete: true,
    stateTables: P.REQUIRED_TABLES.map(name => ({ name, rows: 0 })),
  },
  scope: { kind: 'group', id: 507, clinicIds: [701, 702] }, scopes: ['ads_read', 'public_profile'],
  app: { appId: '1807844546609897', secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/meta-marketing/staging/application-u7Px8r', versionId: randomUUID() },
  slot: { secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/meta-marketing/staging/group-507-q8Nm2z', versionId: randomUUID(),
    connectionRef: 'meta-marketing:staging:group-507:' + randomUUID(), expiresAt: '2030-01-15T00:00:00.000Z' },
  redirectUri: 'https://autenticacion.clinicaclick.com/oauth/meta/marketing/callback',
  principalsSourceSha256: sha('offline public identity manifest'),
  principals: EXPECTED_IDS.map((id, i) => ({ id, keyId: 'meta-staging-role-' + i + '-v1',
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) })),
};
const fixture = () => structuredClone(BASE);
const reject = (mutate, code) => {
  const m = fixture(); mutate(m);
  assert.throws(() => P.buildPlan(m), { code });
};
function folder(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-meta-plan-unit-')); fs.chmodSync(p, 0o700);
  t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p;
}
function inputFile(p, m = fixture()) {
  const file = path.join(p, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(m), { mode: 0o600 }); return file;
}
test('minimum Ads scopes create a deterministic plan only; preserve observed transport and state', () => {
  const m = fixture(), original = JSON.stringify(m), result = P.buildPlan(m);
  assert.equal(JSON.stringify(m), original);
  assert.deepEqual(P.buildPlan(m), result);
  assert.equal(result.status, 'plan_prepared'); assert.equal(result.ready, false); assert.equal(result.executable, false);
  assert.deepEqual(result.scope.scopes, ['ads_read', 'public_profile']);
  const cfg = result.candidateConfig;
  assert.equal(cfg.standby, false); assert.equal(cfg.assetDiscovery, true); assert.equal(cfg.assetEnrollment, true);
  for (const key of ['stateFile', 'listenAddress', 'port', 'tlsCertFile', 'tlsKeyFile', 'enabled', 'cohort']) assert.equal(cfg[key], m.observed.config[key]);
  assert.equal(cfg.policy.audience, m.observed.config.policy.audience);
  assert.equal(cfg.policy.principals.length, 4); assert.equal(cfg.policy.connections.length, 1); assert.equal(cfg.policy.grants.length, 2);
  assert.equal(cfg.policy.grants.some(row => row.principalId === 'staging:meta-marketing'), false);
  assert(result.pendingLiveVerification.includes('legacy_mapping_adoption_review_without_deleting_aliases_or_scope_blocks'));
  assert.equal(result.restrictions.adsMetricsEnabled, false); assert.equal(result.restrictions.legacyTransportRemainsQuarantined, true);
});
test('published staging certificate preserves the observed key, renewal and source observation', () => {
  const m = fixture();
  m.observed.config.tlsCertFile = '/etc/clinicaclick-server-certificates/targets/meta-marketing-staging/server.crt';
  m.observed.config.tlsRenewal = { issuerCaFile: '/etc/clinicaclick-meta-marketing-staging/issuer.crt' };
  const original = JSON.stringify(m), result = P.buildPlan(m);
  assert.equal(JSON.stringify(m), original);
  assert.equal(result.status, 'plan_prepared'); assert.equal(result.ready, false); assert.equal(result.executable, false);
  assert.equal(result.candidateConfig.tlsCertFile, m.observed.config.tlsCertFile);
  assert.equal(result.candidateConfig.tlsKeyFile, m.observed.config.tlsKeyFile);
  assert.deepEqual(result.candidateConfig.tlsRenewal, m.observed.config.tlsRenewal);
  assert.notEqual(result.candidateConfig.tlsRenewal, m.observed.config.tlsRenewal);
  assert.deepEqual(result.preconditions.preserveTlsFiles, [m.observed.config.tlsCertFile, m.observed.config.tlsKeyFile]);
  assert.equal(result.preconditions.expectedObservedConfigCanonicalSha256, sha(JSON.stringify(m.observed.config)));
});
test('TLS paths are exact staging files, with no sibling target, basename or normalized alias admission', () => {
  for (const value of [
    '/etc/clinicaclick-meta-marketing-staging/other.crt',
    '/etc/clinicaclick-server-certificates/targets/meta-marketing-staging/other.crt',
    '/etc/clinicaclick-server-certificates/targets/meta-marketing-dev/server.crt',
    '/etc/clinicaclick-server-certificates/targets/google-ads-staging/server.crt',
    '/etc/clinicaclick-server-certificates/targets/meta-marketing-staging/../meta-marketing-staging/server.crt',
    '/etc/clinicaclick-meta-marketing-staging/./server.crt',
  ]) reject(m => { m.observed.config.tlsCertFile = value; }, 'meta_plan_tls_environment_invalid');
  for (const value of [
    '/etc/clinicaclick-meta-marketing-staging/other.key',
    '/etc/clinicaclick-meta-marketing-dev/server.key',
    '/etc/clinicaclick-server-certificates/targets/meta-marketing-staging/server.key',
    '/etc/clinicaclick-meta-marketing-staging/../clinicaclick-meta-marketing-staging/server.key',
  ]) reject(m => { m.observed.config.tlsKeyFile = value; }, 'meta_plan_tls_environment_invalid');
});
test('the existing runtime validator still rejects malformed certificate renewal settings', () => {
  reject(m => { m.observed.config.tlsRenewal = { issuerCaFile: 'issuer.crt' }; }, 'meta_plan_observed_config_invalid');
  reject(m => { m.observed.config.tlsRenewal = { issuerCaFile: '/etc/issuer.crt', extra: true }; }, 'meta_plan_observed_config_invalid');
});
test('five explicit read scopes and a clinic scope are accepted without adding WhatsApp rights', () => {
  const m = fixture(); m.scopes = ['ads_read', 'instagram_basic', 'pages_read_engagement', 'pages_show_list', 'public_profile'];
  m.scope = { kind: 'clinic', id: 701, clinicIds: [701] };
  const p = P.buildPlan(m); assert.equal(p.scope.scopeKey, 'clinic:701');
  assert.equal(p.sqlSlot.parameters[0], 'clinic:701'); assert.equal(p.sqlSlot.parameters[4], '[701]');
  assert.equal(p.sqlSlot.parameters[7], '2030-01-15 00:00:00.000'); assert.equal(p.sqlSlot.dateInterpretation, 'UTC_DATETIME_3');
  assert(!JSON.stringify(p.candidateConfig.policy.grants).includes('whatsapp'));
});
test('partial input reports prerequisites without producing an overlay or declaring ready', () => {
  const m = { version: 1, mode: 'plan', environment: 'staging', app: { appId: '1807844546609897' } };
  const p = P.buildPlan(m); assert.equal(p.status, 'prerequisites_missing'); assert.equal(p.ready, false);
  assert(p.missing.includes('app.secretArn')); assert(p.missing.includes('observed'));
  assert(!Object.hasOwn(p, 'candidateConfig')); assert(!Object.hasOwn(p, 'sqlSlot'));
});
test('partial manifests still reject known cross-environment references and placeholder pins', () => {
  const minimal = { version: 1, mode: 'plan', environment: 'staging' };
  assert.throws(() => P.buildPlan({ ...minimal, app: { secretArn: BASE.app.secretArn.replace('/staging/', '/dev/') } }), { code: 'meta_plan_secret_references_invalid' });
  assert.throws(() => P.buildPlan({ ...minimal, slot: { versionId: 'fake-version-123456789012345678901' } }), { code: 'meta_plan_secret_references_invalid' });
  assert.throws(() => P.buildPlan({ ...minimal, redirectUri: 'https://other.invalid/oauth/meta/marketing/callback' }), { code: 'meta_plan_callback_environment_invalid' });
  assert.throws(() => P.buildPlan({ ...minimal, scopes: ['leads_retrieval', 'public_profile'] }), { code: 'meta_plan_scopes_invalid' });
});
test('all observed table names and zero counts are required, not just a zero total', () => {
  reject(m => { m.observed.stateTablesComplete = false; }, 'meta_plan_observation_invalid');
  reject(m => { m.observed.stateTables = [{ name: 'connections', rows: 0 }]; }, 'meta_plan_state_inventory_incomplete');
  reject(m => { m.observed.stateTables[0].rows = 1; }, 'meta_plan_expected_empty_state_required');
  reject(m => { m.observed.stateTables.push(m.observed.stateTables[0]); }, 'meta_plan_expected_empty_state_required');
  const m = fixture(); m.observed.stateTables.push({ name: 'meta_marketing_ads_pacing', rows: 0 });
  assert.equal(P.buildPlan(m).preconditions.expectedEmptyStateTables.length, 21);
  m.observed.stateTables.at(-1).rows = 1;
  assert.throws(() => P.buildPlan(m), { code: 'meta_plan_expected_empty_state_required' });
});
test('a used or cross-environment runtime cannot be repurposed as initial standby', () => {
  reject(m => { m.observed.config.standby = false; }, 'meta_plan_observed_config_invalid');
  reject(m => { m.observed.config.policy.principals = [structuredClone(m.principals[0])]; }, 'meta_plan_observed_config_invalid');
  reject(m => { m.observed.config.environment = 'dev'; }, 'meta_plan_expected_empty_staging_required');
  reject(m => { m.observed.config.port = 8453; }, 'meta_plan_expected_empty_staging_required');
  reject(m => { m.observed.config.stateFile = '/var/lib/clinicaclick-meta-marketing-dev/broker.sqlite'; }, 'meta_plan_expected_empty_staging_required');
  reject(m => { m.observed.config.policy.audience = 'broker:meta-marketing:dev'; }, 'meta_plan_expected_empty_staging_required');
  reject(m => { m.observed.config.tlsCertFile = '/etc/clinicaclick-meta-marketing-dev/server.crt'; }, 'meta_plan_tls_environment_invalid');
  reject(m => { m.environment = 'dev'; }, 'meta_plan_initial_environment_unsupported');
});
test('scope must contain the complete caller-supplied sorted clinic set and valid IDs', () => {
  reject(m => { m.scope.clinicIds = [702, 701]; }, 'meta_plan_scope_invalid');
  reject(m => { m.scope.clinicIds = [701, 701]; }, 'meta_plan_scope_invalid');
  reject(m => { m.scope.clinicIds = ['701']; }, 'meta_plan_scope_invalid');
  reject(m => { m.scope = { kind: 'clinic', id: 701, clinicIds: [701, 702] }; }, 'meta_plan_scope_invalid');
  reject(m => { m.scope.id = 2147483648; }, 'meta_plan_scope_invalid');
});
test('scope privileges are explicit, sorted, unique and limited to the current read contract', () => {
  for (const scopes of [['public_profile'], ['ads_read'], ['public_profile', 'ads_read'], ['ads_read', 'ads_read', 'public_profile'], ['ads_management', 'public_profile'], ['leads_retrieval', 'public_profile'], ['public_profile', 'whatsapp_business_messaging']]) {
    reject(m => { m.scopes = scopes; }, 'meta_plan_scopes_invalid');
  }
});
test('secret references cannot escape account, region, provider or environment', () => {
  for (const [from, to] of [['eu-west-3', 'eu-west-1'], ['137819318729', '111122223333'], ['/staging/', '/dev/'], ['/meta-marketing/', '/whatsapp/']]) {
    reject(m => { m.app.secretArn = m.app.secretArn.replace(from, to); }, 'meta_plan_secret_references_invalid');
  }
  reject(m => { m.app.secretArn = m.slot.secretArn; }, 'meta_plan_secret_references_invalid');
  reject(m => { m.slot.secretArn = m.slot.secretArn.replace('-q8Nm2z', ''); }, 'meta_plan_secret_references_invalid');
  reject(m => { m.app.secretArn = m.app.secretArn.replace('application', 'placeholder'); }, 'meta_plan_secret_references_invalid');
});
test('immutable pins must have real reference shapes and never reuse app and slot pins', () => {
  for (const value of ['a'.repeat(32), '01234567'.repeat(4), 'REPLACE_ME_WITH_A_REAL_VERSION_ID_1234', 'placeholder-version-123456789012345678', '<versionId>']) {
    reject(m => { m.app.versionId = value; }, 'meta_plan_secret_references_invalid');
  }
  reject(m => { m.app.versionId = m.slot.versionId; }, 'meta_plan_secret_references_invalid');
});
test('new callback, connection reference and expiry are fixed to the initial cohort', () => {
  for (const value of ['https://crm.clinicaclick.com/oauth/meta/marketing/callback', 'https://autenticacion.clinicaclick.com/oauth/meta/callback', 'https://autenticacion.clinicaclick.com/oauth/meta/marketing/callback?environment=dev', 'http://autenticacion.clinicaclick.com/oauth/meta/marketing/callback']) {
    reject(m => { m.redirectUri = value; }, 'meta_plan_callback_environment_invalid');
  }
  reject(m => { m.slot.connectionRef = 'meta-marketing:dev:group-507'; }, 'meta_plan_slot_invalid');
  reject(m => { m.slot.expiresAt = m.observed.observedAt; }, 'meta_plan_slot_invalid');
});
test('four explicit principals use distinct public Ed25519 keys and key IDs', () => {
  reject(m => { m.principals.pop(); }, 'meta_plan_principals_invalid');
  reject(m => { m.principals[0].id = 'gateway:dev:meta-marketing-oauth'; }, 'meta_plan_principals_invalid');
  reject(m => { m.principals[0].keyId = 'meta-dev-oauth-v1'; }, 'meta_plan_principals_invalid');
  reject(m => { m.principals[1].keyId = m.principals[0].keyId; }, 'meta_plan_principals_invalid');
  reject(m => { m.principals[1].publicKey = m.principals[0].publicKey; }, 'meta_plan_principal_key_reuse');
  reject(m => { m.principals[0].publicKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }); }, 'meta_plan_inline_credential_forbidden');
});
test('inline credentials are rejected before missing-input handling and never echoed', () => {
  for (const key of ['accessToken', 'refresh_token', 'appSecret', 'privateKey', 'SecretString', 'password', 'authorization', 'code']) {
    assert.throws(() => P.buildPlan({ version: 1, mode: 'plan', environment: 'staging', [key]: 'SENSITIVE_TEST_VALUE' }), { code: 'meta_plan_inline_credential_forbidden' });
  }
  reject(m => { m.slot.secretArn = 'Bearer SENSITIVE_TEST_VALUE'; }, 'meta_plan_inline_credential_forbidden');
});
test('unknown fields and implicit apply actions are rejected', () => {
  reject(m => { m.apply = true; }, 'meta_plan_input_shape_invalid');
  reject(m => { m.mode = 'apply'; }, 'meta_plan_explicit_plan_required');
  assert.throws(() => P.parse(['apply', '--input', '/tmp/a', '--out', '/tmp/b']), { code: 'meta_plan_arguments_invalid' });
  assert.throws(() => P.parse(['plan', '--input', '/tmp/a', '--out', '/tmp/a']), { code: 'meta_plan_arguments_invalid' });
});
test('CLI writes one private plan and refuses to overwrite or follow links', t => {
  const p = folder(t), input = inputFile(p), out = path.join(p, 'plan.json');
  const report = P.run(['plan', '--input', input, '--out', out]);
  assert.equal(report.ready, false); assert.equal(report.status, 'plan_prepared');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600); const first = fs.readFileSync(out);
  assert.throws(() => P.run(['plan', '--input', input, '--out', out]), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(out), first);
  const linked = path.join(p, 'symlink.json'); fs.symlinkSync(input, linked);
  assert.throws(() => P.run(['plan', '--input', linked, '--out', path.join(p, 'second.json')]), { code: 'meta_plan_private_input_required' });
  const victim = path.join(p, 'victim'); fs.writeFileSync(victim, 'keep');
  const linkedOut = path.join(p, 'linked-out.json'); fs.symlinkSync(victim, linkedOut);
  assert.throws(() => P.run(['plan', '--input', input, '--out', linkedOut]), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});
test('CLI refuses broad permissions, hard-linked input and public output directories', t => {
  const p = folder(t), input = inputFile(p), out = path.join(p, 'plan.json');
  fs.chmodSync(input, 0o640);
  assert.throws(() => P.run(['plan', '--input', input, '--out', out]), { code: 'meta_plan_private_input_required' });
  fs.chmodSync(input, 0o600); const alias = path.join(p, 'hardlink'); fs.linkSync(input, alias);
  assert.throws(() => P.run(['plan', '--input', input, '--out', out]), { code: 'meta_plan_private_input_required' });
  fs.unlinkSync(alias); fs.chmodSync(p, 0o755);
  assert.throws(() => P.run(['plan', '--input', input, '--out', out]), { code: 'meta_plan_private_output_directory_required' });
});
test('CLI error is fixed and redacted; no original input value appears in stderr', t => {
  const p = folder(t), input = inputFile(p, { version: 1, mode: 'plan', environment: 'staging', appSecret: 'SENSITIVE_TEST_VALUE' });
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'plan-meta-marketing-reconnection.cjs'), 'plan', '--input', input, '--out', path.join(p, 'out.json')],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert(!r.stderr.includes('SENSITIVE_TEST_VALUE'));
  assert.equal(JSON.parse(r.stderr.trim()).code, 'meta_plan_inline_credential_forbidden');
  assert.equal(fs.existsSync(path.join(p, 'out.json')), false);
});
