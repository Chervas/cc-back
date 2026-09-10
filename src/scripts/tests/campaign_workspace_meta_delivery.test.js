'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendWorkspaceMetaSignal, minimalEvent, receipt, failure, LEASE_MS } = require('../../services/metaWorkspaceSignalDelivery.service');
const { resolveMetaSignalContext } = require('../../services/metaWorkspaceSignalContext.service');
const { CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');

function harness() {
  const account = { provider: 'meta_ads', account_id: '20', include_future: false, campaign_ids: ['30', '31'] };
  const state = { date: new Date('2026-09-10T18:00:00Z'), rows: [], calls: [],
    clinic: { id_clinica: 1, grupoClinicaId: 8, estado_clinica: true },
    clinicRecord: { id: 'web-1', assignment_scope: 'clinic', clinic_id: 1, config: {
      meta_ads: { enabled: true, connection_id: 7, ad_account_id: 'act_20', pixel_id: '50' },
      campaigns: { workspace_policy: { schema_version: 1, setting_id: 'setting', scope_type: 'clinic', scope_id: 1 } },
    } },
    groupRecord: null,
    setting: { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 2, accounts: [account], activation: {
      schema_version: 1, status: 'active', mode: 'measurement', signals: { enabled: true, events: ['lead', 'contact', 'qualified_lead', 'schedule'] },
      account_authorizations: [account],
    } },
    assignment: { id: 3, scopeKey: 'clinic:1', assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7, status: 'active', connectedAt: '2026-09-01T00:00:00Z' },
    mappings: [{ id: 4, metaAssetId: 'act_20' }], connection: { id: 7, accessToken: 'private-token', expiresAt: '2027-01-01' },
    response: { data: { events_received: 1, messages: [], fbtrace_id: 'trace' } },
  };
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async () => state.clinic },
    IntakeConfig: { findOne: async ({ where }) => where.assignment_scope === 'clinic' ? state.clinicRecord : state.groupRecord },
    MetaConnectionAssignment: { findOne: async ({ where }) => state.assignment && Object.keys(where).every(key => state.assignment[key] === where[key]) ? state.assignment : null },
    ClinicMetaAsset: { findAll: async () => state.mappings },
    MetaConnection: { findByPk: async () => state.connection },
    CampaignWorkspaceSetting: { findByPk: async id => state.setting?.id === id ? state.setting : null },
    MetaSignalDelivery: {
      findOne: async ({ where }) => state.rows.find(row => row.dedupe_key === where.dedupe_key) || null,
      create: async values => {
        if (state.onCreate) await state.onCreate();
        const row = { ...values, created_at: values.attempted_at, update: async patch => { Object.assign(row, patch); return row; } };
        state.rows.push(row); return row;
      },
      update: async (values, { where }) => {
        const row = state.rows.find(row => Object.keys(where).every(key => row[key] === where[key]));
        if (!row) return [0]; Object.assign(row, values); return [1];
      },
    },
  };
  const input = { eventName: 'Lead', eventId: 'lead-123', eventTime: +state.date / 1000, advertisingConsent: true,
    clinicId: 1, adAccountId: 'act_20', campaignId: '30', pixelId: '50', accessToken: 'stale-input-token',
    webPolicyRecord: state.clinicRecord, signalPolicyRecord: state.clinicRecord,
    eventSourceUrl: 'https://example.com/private-treatment?email=private',
    userData: { em: ['a'.repeat(64)], ph: ['b'.repeat(64)], client_user_agent: 'test-agent', client_ip_address: '127.0.0.1' },
  };
  const send = async (...args) => { state.calls.push(args); if (state.onSend) await state.onSend(); return state.response; };
  return { state, models, input,
    run: (patch = {}, deps = {}) => sendWorkspaceMetaSignal({ ...input, ...patch }, { models, now: () => state.date, send, ...deps }),
    context: patch => resolveMetaSignalContext({ models, now: state.date, input: { ...input, ...patch } }),
  };
}

test('Meta receives a minimal payload and its receipt is durable, without contacts or medical metadata in the ledger', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.status, 'accepted'); assert.equal(result.sent, true); assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].attempt_count, 1); assert.equal(h.state.rows[0].lease_id, null);
  const [dataset, body, options] = h.state.calls[0]; assert.equal(dataset, '50'); assert.equal(options.accessToken, 'private-token');
  assert.equal(body.data[0].event_source_url, 'https://example.com/'); assert.equal(body.data[0].custom_data, undefined);
  assert.equal(body.data[0].user_data.client_ip_address, undefined);
  assert.doesNotMatch(JSON.stringify(h.state.rows), /private|test-agent|aaaa|bbbb|event_source_url|client_user_agent/);
  assert.deepEqual(h.state.rows[0].policy_refs, [{ setting_id: 'setting', scope_type: 'clinic', scope_id: 1, version: 2 }]);
});
test('CRM milestones require the internal capability and remove website and arbitrary business context', async () => {
  const h = harness();
  assert.equal((await h.run({ eventName: 'Schedule' })).reason, 'workspace_crm_milestone_required');
  const result = await h.run({ eventName: 'Schedule', crmEventSource: CRM_MILESTONE_SOURCE, verifiedNativeLeadId: '777',
    value: 8000, customData: { treatment: 'private' } });
  assert.equal(result.sent, true);
  const event = h.state.calls[0][1].data[0];
  assert.deepEqual(event.user_data, { lead_id: '777' }); assert.equal(event.event_source_url, undefined);
  assert.equal(event.action_source, 'system_generated');
  assert.deepEqual(event.custom_data, { event_source: 'crm', lead_event_source: 'ClinicaClick' });
  assert.throws(() => minimalEvent({ ...h.input, eventName: 'Schedule', verifiedNativeLeadId: '777' }, h.state.date), /workspace_crm_milestone_required/);
});
test('consent is checked before any grant lookup, ledger write or provider call', async () => {
  for (const advertisingConsent of [false, null, 'true', undefined]) {
    const h = harness();
    assert.equal((await h.run({ advertisingConsent }, { context: () => assert.fail('no lookup') })).reason, 'consent_not_granted');
    assert.equal(h.state.rows.length, 0); assert.equal(h.state.calls.length, 0);
  }
});
test('invalid, future, expired or unmatched events never enter the ledger', async () => {
  for (const patch of [{ eventId: '../private' }, { eventTime: 1 }, { eventTime: 9999999999 }, { eventTime: '123' },
    { userData: { em: ['raw@email.example'], client_user_agent: 'agent' } }, { eventSourceUrl: 'http://example.com' },
    { eventSourceUrl: 'https://user:secret@example.com' }, { userData: { em: ['a'.repeat(64)] } }]) {
    const h = harness(); assert.equal((await h.run(patch)).sent, false); assert.equal(h.state.rows.length, 0); assert.equal(h.state.calls.length, 0);
  }
});
test('accepted and warning receipts are not sent again', async () => {
  for (const messages of [[], ['provider warning: private-contact']]) {
    const h = harness(); h.state.response.data.messages = messages; await h.run();
    assert.equal((await h.run()).reason, 'meta_event_already_received'); assert.equal(h.state.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(h.state.rows), /private-contact/);
  }
});
test('parallel emissions are leased, and a stale lease can be reclaimed with the original event identity', async () => {
  const h = harness(); h.state.onSend = async () => assert.equal((await h.run()).reason, 'meta_event_in_progress');
  await h.run(); assert.equal(h.state.calls.length, 1);
  Object.assign(h.state.rows[0], { status: 'pending', lease_id: 'abandoned', completed_at: null });
  h.state.date = new Date(+h.state.date + LEASE_MS); h.state.onSend = null;
  assert.equal((await h.run()).sent, true); assert.equal(h.state.rows[0].attempt_count, 2);
});
test('event collisions cannot silently change campaign, occurrence time or grant identity', async () => {
  const h = harness(); await h.run();
  for (const patch of [{ campaignId: '31' }, { eventTime: h.input.eventTime - 1 }]) assert.equal((await h.run(patch)).reason, 'meta_event_identity_conflict');
  h.state.assignment.connectedAt = '2026-09-02T00:00:00Z';
  assert.equal((await h.run()).reason, 'meta_event_identity_conflict'); assert.equal(h.state.calls.length, 1);
});
test('malformed and negative responses never become received', async () => {
  for (const body of [null, [], '', {}, { events_received: '1' }, { events_received: 2 }, { events_received: 1, id: '999' },
    { events_received: 1, messages: [{}] }, { events_received: 1, error: {} }, { events_received: 0 }]) {
    const h = harness(); h.state.response.data = body;
    const result = await h.run(); assert.equal(result.sent, false); assert.ok(['unknown', 'failed'].includes(result.status));
  }
  assert.equal(receipt({ data: { events_received: 1, messages: ['notice'] } }, '50').status, 'warning');
});
test('timeouts, permission errors and rate limits are recorded without provider messages', async () => {
  for (const error of [null, undefined, { response: {} }, new Error('private contact timeout'),
    { response: { status: 503, data: { error: { message: 'private' } } } },
    { response: { status: 400, data: { error: { code: 190, message: 'private' } } } },
    { code: 'META_RATE_LIMIT_PAUSED' }]) {
    const h = harness(); h.state.onSend = () => { throw error; };
    const result = await h.run(); assert.equal(result.sent, false); assert.equal(result.status, failure(error).status);
    assert.doesNotMatch(JSON.stringify(h.state.rows), /private/);
  }
});
test('lease loss cannot overwrite another worker result', async () => {
  const h = harness(); h.state.onSend = () => { h.state.rows[0].lease_id = 'another-worker'; };
  assert.equal((await h.run()).reason, 'meta_delivery_result_conflict'); assert.equal(h.state.rows[0].status, 'pending');
});
test('ledger failure or a competing unique key prevents an unrecorded provider request', async () => {
  const h = harness(); h.state.onCreate = () => { throw new Error('database unavailable'); };
  await assert.rejects(h.run(), /database unavailable/); assert.equal(h.state.calls.length, 0);
  h.state.onCreate = () => { throw Object.assign(new Error('race'), { name: 'SequelizeUniqueConstraintError' }); };
  assert.equal((await h.run()).reason, 'meta_event_in_progress'); assert.equal(h.state.calls.length, 0);
});
test('permission, destination and policy changes between reservation and send cancel delivery', async () => {
  for (const change of [s => { s.assignment.status = 'revoked'; }, s => { s.setting.version++; },
    s => { s.setting.activation.signals.enabled = false; }, s => { s.clinicRecord.config.meta_ads.pixel_id = '99'; },
    s => { s.mappings = []; }]) {
    const h = harness(); h.state.onCreate = () => change(h.state);
    const result = await h.run(); assert.equal(result.status, 'skipped'); assert.equal(h.state.calls.length, 0);
  }
});
test('grant context requires current clinic, owner, assignment, mapping and an unexpired connection', async () => {
  for (const change of [s => { s.clinic.estado_clinica = false; }, s => { s.assignment.status = 'revoked'; },
    s => { s.assignment.clinicaId = 99; }, s => { s.connection.expiresAt = 'invalid'; },
    s => { s.connection.expiresAt = '2020-01-01'; }, s => { s.mappings = []; }, s => { s.mappings.push(s.mappings[0]); },
    s => { s.clinicRecord.config.meta_ads.enabled = false; }, s => { s.clinicRecord.config.meta_ads.pixel_id = null; }]) {
    const h = harness(); change(h.state); assert.equal((await h.run()).sent, false); assert.equal(h.state.calls.length, 0);
  }
  const h = harness(); await assert.rejects(h.context({ webPolicyRecord: { id: 'foreign-record' } }), /workspace_meta_web_scope_changed/);
});
test('a global pixel cannot be disguised as a workspace destination', async () => {
  const previous = process.env.META_PIXEL_ID; process.env.META_PIXEL_ID = '50';
  try {
    const h = harness(); h.state.clinicRecord.config.meta_ads.pixel_id = null;
    assert.equal((await h.run()).reason, 'workspace_meta_destination_changed'); assert.equal(h.state.calls.length, 0);
  } finally { if (previous === undefined) delete process.env.META_PIXEL_ID; else process.env.META_PIXEL_ID = previous; }
});
test('group web ownership requires an explicit location, not mere clinic membership', async () => {
  const h = harness(); h.state.groupRecord = { ...h.state.clinicRecord, id: 'group-web', assignment_scope: 'group', group_id: 8, clinic_id: null };
  await assert.rejects(h.context({ webPolicyRecord: h.state.groupRecord }), /workspace_meta_web_scope_changed/);
  h.state.groupRecord.config.locations = {};
  await assert.rejects(h.context({ webPolicyRecord: h.state.groupRecord }), /workspace_meta_web_scope_changed/);
});

test('shared advertising preserves both web and group revisions and uses the assigned group grant', async () => {
  const h = harness();
  const groupSetting = { ...h.state.setting, id: 'group-setting', scope_type: 'group', scope_id: 8, version: 10 };
  h.state.groupRecord = { id: 'group-web', assignment_scope: 'group', group_id: 8, config: {
    meta_ads: { ...h.state.clinicRecord.config.meta_ads },
    campaigns: { workspace_policy: { schema_version: 1, setting_id: groupSetting.id, scope_type: 'group', scope_id: 8 } },
  } };
  delete h.state.clinicRecord.config.meta_ads;
  Object.assign(h.state.assignment, { scopeKey: 'group:8', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 8 });
  h.models.CampaignWorkspaceSetting.findByPk = async id => id === groupSetting.id ? groupSetting : h.state.setting;
  h.input.signalPolicyRecord = h.state.groupRecord;
  assert.equal((await h.run()).sent, true); assert.equal(h.state.rows[0].policy_refs.length, 2);
  assert.equal(h.state.rows[0].policy_version, 10);
  h.state.onCreate = () => { h.state.setting.version++; };
  assert.equal((await h.run({ eventId: 'lead-124' })).status, 'skipped'); assert.equal(h.state.calls.length, 1);
  h.state.onCreate = null;
  h.state.groupRecord.config.locations = [{ id: 1 }];
  h.input.webPolicyRecord = h.state.groupRecord;
  assert.equal((await h.run({ eventId: 'lead-125' })).sent, true);
});
