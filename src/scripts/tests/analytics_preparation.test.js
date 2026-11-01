'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../lib/intake-analytics-preparation');
const proof = require('../../lib/intake-verification-attestation');
const { createAnalyticsPreparation } = require('../../services/analyticsPreparation.service');
process.env.INTAKE_VERIFICATION_ATTESTATION_SECRET = 'FICTITIOUS_OFFLINE_ATTESTATION_SECRET';
const stream = (id = 1, domain = 'https://example.test') => ({ name: `properties/123/dataStreams/${id}`, type: 'WEB_DATA_STREAM',
  webStreamData: { measurementId: `G-TEST${id}`, defaultUri: domain } });
function fixture() {
  const record = { id: 5, clinic_id: 71, group_id: null, assignment_scope: 'clinic', domains: ['example.test'], hmac_key: 'FICTITIOUS',
    config: { locations: [{ id: 71 }], unrelated: { keep: true }, features: { consent_mode_enabled: true, consent_provider: 'clinicaclick', form_intercept_enabled: true } } };
  const mapping = { id: 17, clinicaId: 71, googleConnectionId: 2, propertyName: 'properties/123', broker_read_connection_ref: 'fixture', broker_read_asset_ref: 'ga4:123' };
  const signals = { installed: true, runtime_compatible: true, consent_mode_detected: true,
    analytics_tags: { ga4_measurement_ids: ['G-TEST1'], gtm_container_ids: [], google_tag_ids: [] } };
  const state = { mappings: [mapping], calls: [], writes: [], streams: [stream()], current: record, beforeLock: null, blocked: false };
  const db = { Sequelize: { Op: { in: Symbol('in') } },
    ClinicAnalyticsProperty: { findAll: async () => state.mappings },
    IntakeConfig: { findByPk: async () => { state.beforeLock?.(); return { ...state.current, update: async value => state.writes.push(value) }; } },
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
  };
  const broker = { prepare: async () => { if (state.blocked) throw Object.assign(Error(), { code: 'asset_revoked' }); return {}; },
    read: async (...args) => { state.calls.push(args); return { data: { dataStreams: state.streams } }; } };
  const token = () => proof.issueVerificationAttestation({ scopeType: 'clinic', scopeId: 71, domain: 'example.test',
    configHash: proof.buildVerificationConfigHash({ scopeType: 'clinic', scopeId: 71, domains: record.domains, config: record.config, hmacKey: record.hmac_key }), signals }).token;
  const body = { clinic_id: 71, domain: 'example.test', verification_attestation: token() };
  const service = createAnalyticsPreparation({ db, broker });
  return { db, broker, state, record, mapping, signals, body, service, token, args: { record, clinicIds: [71], body } };
}
test('matching host resolves a server destination; no duplicate contact channels are inferred from HTML', async () => {
  const f = fixture(); const { result } = await f.service.inspect(f.args);
  assert.equal(result.measurement_id, 'G-TEST1'); assert.equal(result.can_apply, true);
  assert.deepEqual(result.channels, []); assert.deepEqual(result.pending, ['contact_channels_review']);
  assert.equal(result.verified, false); assert.equal(f.state.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /FICTITIOUS|hmac|Token|connection_ref/);
  assert.deepEqual(f.state.calls[0].slice(2, 4), ['streams', {}]);
});
test('a reviewed narrow write preserves locations, form interception, unrelated features and idempotent channel order', async () => {
  const f = fixture(); const { result } = await f.service.inspect(f.args);
  const body = { ...f.body, expected_revision: result.revision, channels: ['whatsapp', 'phone'], channels_reviewed: true };
  const output = await f.service.apply({ ...f.args, body });
  assert.equal(f.state.writes.length, 1); const saved = f.state.writes[0].config;
  assert.deepEqual(saved.locations, f.record.config.locations); assert.deepEqual(saved.unrelated, { keep: true });
  assert.equal(saved.features.form_intercept_enabled, true); assert.equal(saved.features.ga4_measurement_id, 'G-TEST1');
  assert.deepEqual(saved.features.ga4_bridge_channels, ['phone', 'whatsapp']);
  assert.equal(output.verified, false); assert.equal(output.configured, true);
});
test('foreign domains, ambiguous destinations, missing consent/proof and invented properties cannot enable measurement', async () => {
  const f = fixture();
  await assert.rejects(f.service.inspect({ ...f.args, body: { ...f.body, domain: 'other.test' } }), { code: 'analytics_domain_forbidden' });
  assert.equal(f.state.calls.length, 0);
  for (const mutate of [f => { f.state.streams = [stream(1), stream(2)]; }, f => { f.state.streams = [stream(1, 'https://example.test.attacker.invalid')]; },
    f => { f.body.verification_attestation = undefined; }, f => { f.record.config.features.consent_mode_enabled = false; f.body.verification_attestation = f.token(); }]) {
    const sample = fixture(); mutate(sample); const { result } = await sample.service.inspect(sample.args);
    assert.equal(result.can_apply, false);
    await assert.rejects(sample.service.apply({ ...sample.args, body: { ...sample.body, expected_revision: result.revision, channels: ['phone'], channels_reviewed: true } }));
    assert.equal(sample.state.writes.length, 0);
  }
});
test('ambiguous web streams require a selection from the provider result, never an arbitrary measurement ID', async () => {
  const f = fixture(); f.state.streams.push(stream(2));
  const result = (await f.service.inspect({ ...f.args, body: { ...f.body, stream_name: stream(2).name } })).result;
  assert.equal(result.measurement_id, 'G-TEST2');
  const wrong = (await f.service.inspect({ ...f.args, body: { ...f.body, stream_name: 'properties/999/dataStreams/2' } })).result;
  assert.equal(wrong.can_apply, false);
});
test('shared website reads only granted member mappings and uses the verified domain, without creating any new grant', async () => {
  const f = fixture(); const output = await f.service.inspect({ ...f.args, clinicIds: [71, 72] });
  assert.equal(output.result.measurement_id, 'G-TEST1'); assert.equal(f.state.calls.length, 1);
  f.state.mappings.push({ ...f.mapping, id: 18, clinicaId: 999 });
  await assert.rejects(f.service.inspect({ ...f.args, clinicIds: [71, 72] }), { code: 'analytics_scope_changed' });
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes.length, 0);
});
test('stale config, changed mapping, expired proof and revocation never write', async () => {
  for (const change of [f => { f.state.current = { ...f.record, config: { ...f.record.config, changed: true } }; },
    f => { f.state.mappings = [{ ...f.mapping, googleConnectionId: 999 }]; }, f => { f.state.blocked = true; }]) {
    const f = fixture(); const { result } = await f.service.inspect(f.args); f.state.beforeLock = () => change(f);
    await assert.rejects(f.service.apply({ ...f.args, body: { ...f.body, expected_revision: result.revision, channels: ['form'], channels_reviewed: true } }));
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.service.inspect({ ...f.args, body: { ...f.body, verification_attestation: f.token() + 'bad' } }), { code: 'analytics_verification_expired' });
});
test('existing bridge retains reviewed channels and refuses a destination replacement', async () => {
  const f = fixture(); Object.assign(f.record.config.features, { ga4_bridge_enabled: true, ga4_measurement_id: 'G-TEST1', ga4_bridge_channels: ['phone'] });
  const result = (await f.service.inspect(f.args)).result;
  assert.equal(result.configured, true); assert.deepEqual(result.channels, ['phone']); assert.equal(result.pending.length, 0);
  f.record.config.features.ga4_measurement_id = 'G-FOREIGN';
  const blocked = (await f.service.inspect(f.args)).result;
  assert.equal(blocked.can_apply, false); assert.ok(blocked.pending.includes('destination_conflict'));
});

test('effective shared mappings keep the original broker identity and reject withdrawn sharing before writing', async () => {
  const f = fixture(); f.mapping.clinicaId = 72;
  let shared = true;
  const service = createAnalyticsPreparation({ db: f.db, broker: f.broker, resolveEffectiveMappings: async () => shared
    ? [{ mapping_id: 17, clinic_id: 72, connection_id: 2, resource: 'properties/123' }] : [] });
  const { result } = await service.inspect(f.args);
  assert.equal(result.measurement_id, 'G-TEST1'); assert.equal(f.state.calls[0][0].clinicaId, 72);
  shared = false;
  await assert.rejects(service.apply({ ...f.args, body: { ...f.body, expected_revision: result.revision, channels: ['phone'], channels_reviewed: true } }));
  assert.equal(f.state.writes.length, 0);
});

test('adding a channel to an existing bridge still requires reviewing its previous emitter', async () => {
  const f = fixture(); Object.assign(f.record.config.features, { ga4_bridge_enabled: true, ga4_measurement_id: 'G-TEST1', ga4_bridge_channels: ['phone'] });
  const { result } = await f.service.inspect(f.args);
  await assert.rejects(f.service.apply({ ...f.args, body: { ...f.body, expected_revision: result.revision, channels: ['phone', 'form'] } }), { code: 'analytics_channels_review_required' });
  assert.equal(f.state.writes.length, 0);
});
