'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { webhookEvents, receptionRuntimeNamespace, enqueueMetaLeadNotifications, resolveMetaLeadClinic, retrieveMetaLead,
  persistMetaLead, runMetaLeadReceptionJob, contactFields } = require('../../services/metaLeadReception.service');

const event = { lead_id: '100', page_id: '200', form_id: '300', ad_id: '400' };
const receiptRef = '11111111-1111-4111-8111-111111111111';
const jobPayload = { ...event, receipt_ref: receiptRef, page_asset_id: 10, account_asset_id: 11 };
const identity = { account_id: '500', campaign_id: '600', ad_id: '400', adset_id: '700' };
const notification = (patch = {}) => ({ object: 'page', entry: [{ id: '200', changes: [{ field: 'leadgen', value: {
  leadgen_id: '100', page_id: '200', form_id: '300', ad_id: '400', ...patch,
} }] }] });

test('a native lead invalidation happens after commit, never on rollback', async () => {
  const h = harness();
  const retrieved = await retrieveMetaLead({ models: h.models, event, reader: h.reader, receiptRef, pageAssetId: 10, accountAssetId: 11 });
  const original = h.models.sequelize.transaction;
  let committed = false, published = 0;
  h.models.sequelize.transaction = async fn => { const value = await original(fn); committed = true; return value; };
  await persistMetaLead({ models: h.models, event, retrieved, publishCreated: result => {
    assert.equal(committed, true); assert.equal(result.duplicate, false); published++;
  } });
  assert.equal(published, 1);
  const failed = harness({ auditError: true });
  const other = await retrieveMetaLead({ models: failed.models, event, reader: failed.reader, receiptRef, pageAssetId: 10, accountAssetId: 11 });
  await assert.rejects(persistMetaLead({ models: failed.models, event, retrieved: other, publishCreated: () => assert.fail('uncommitted lead') }));
  assert.equal(failed.state.leads.length, 0);
});
function harness(patch = {}) {
  const state = { leads: [], audits: [], forms: [], notifications: [], graph: [], rollback: 0,
    page: { id: 10, metaAssetId: '200', metaConnectionId: 1, pageAccessToken: 'page-secret',
      assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 99 },
    account: { id: 11, metaAssetId: 'act_500', metaConnectionId: 1, assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 99 },
    decisions: [{ status: 'active', clinica_id: 5 }],
    clinics: [{ id_clinica: 5, grupoClinicaId: 28, estado_clinica: 1 }], settings: [],
    assignments: [{ scopeKey: 'group:28', metaConnectionId: 1 }],
    connection: { id: 1, accessToken: 'user-secret', expiresAt: '2099-01-01' },
    providerLead: { id: '100', ad_id: '400', campaign_id: '600', form_id: '300', created_time: '2026-09-10T10:00:00Z',
      field_data: [{ name: 'email', values: [' PERSON@example.com '] }, { name: 'full_name', values: ['Person'] }] }, ...patch };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    ClinicMetaAsset: { findOne: async () => state.page, findAll: async ({ where }) => where.assetType === 'facebook_page' ? [state.page, ...(state.otherPages || [])].filter(Boolean) : [state.account].filter(Boolean) },
    MetaConnectionAssignment: { findAll: async ({ where }) => state.assignments.filter(row => where.scopeKey[Op.in].includes(row.scopeKey)) },
    MetaConnection: { findByPk: async () => state.connection },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => where.mapping_id ? [{ mapping_id: 10, enrollment_id: receiptRef, scope_key: 'group:28', connection_ref: 'meta:fixture' }]
      : [{ mapping_id: 11, asset_ref: 'meta-ad_account:500' }] },
    ExternalCampaignAssignment: { findAll: async () => state.decisions },
    Clinica: { findByPk: async id => state.clinics.find(row => Number(row.id_clinica) === Number(id)) },
    CampaignWorkspaceSetting: { findAll: async () => state.settings },
    LeadIntake: { findOne: async ({ where }) => state.leads.find(row => row.external_source === where.external_source && row.external_id === where.external_id),
      create: async (input, options) => { assert.equal(options.transaction, transaction); const row = { id: state.leads.length + 1, ...input }; state.leads.push(row); return row; } },
    LeadAttributionAudit: { create: async (input, options) => { assert.equal(options.transaction, transaction); if (state.auditError) throw new Error('audit failed'); state.audits.push(input); } },
    FormSubmissionEvent: {
      findAll: async ({ where }) => state.forms.filter(row => row.lead_intake_id === where.lead_intake_id && row.source_detail === where.source_detail),
      create: async (input, options) => { assert.equal(options.transaction, transaction); if (state.formError) throw Error('private form failed'); const row = { id: state.forms.length + 1, ...input }; state.forms.push(row); return row; },
    },
    sequelize: { transaction: async fn => { const snapshot = structuredClone({ leads: state.leads, audits: state.audits, forms: state.forms });
      try { return await fn(transaction); } catch (error) { Object.assign(state, snapshot); state.rollback++; throw error; } } },
  };
  const http = { get: async (url, options) => {
    state.graph.push({ url, options });
    if (state.graphError) throw state.graphError;
    return { data: url.endsWith('/100') ? state.providerLead : { id: '400', account_id: '500', campaign_id: '600', adset_id: '700', ...state.providerAd } };
  } };
  const notify = async input => { if (state.notifyError) throw new Error('notification failed'); state.notifications.push(input); };
  const reader = {
    preparePair: async () => { if (!state.assignments.length || +new Date(state.connection.expiresAt) < Date.now()) throw Object.assign(Error('meta_lead_page_access_required'), { code: 'meta_lead_page_access_required' }); return {}; },
    assertPair: async () => {
      if (!state.assignments.length) throw Object.assign(Error('meta_lead_page_access_required'), { code: 'meta_lead_page_access_required' });
      return { page: { mappingId: 10, id: '200', connectionId: 1, clinicIds: state.clinics.map(row => Number(row.id_clinica)) },
        account: { mappingId: 11, id: '500', connectionId: 1 } };
    },
    read: async (_pair, operation, payload) => {
      if (operation === 'receiptAccept') return { persisted: true, receipts: [{ receiptRef, event }] };
      state.graph.push({ operation, payload });
      if (state.graphError) throw Object.assign(Error('meta_lead_page_access_required'), { code: 'meta_lead_page_access_required' });
      return { event: state.eventOverride || event, lead: state.providerLead, identity: state.providerLead.is_organic ? null : { ...identity, ...state.providerAd }, recipientClinicId: state.recipientClinicId ?? null,
        ...(payload.responseVersion === 2 ? { form_response: state.formResponse || { version: 2, formId: '300', name: 'Fictitious form',
          fields: [{ key: 'preferred_time', label: 'Preferred time', type: 'CUSTOM', values: ['afternoon'] }] } } : {}) };
    },
  };
  return { state, models, http, notify, reader, receiptRef, pageAssetId: 10, accountAssetId: 11 };
}

test('signed notification parsing retains only exact provider IDs, never contact data or caller runtime', () => {
  assert.deepEqual(webhookEvents(notification({ email: 'private', __runtime_namespace: 'staging' })), [event]);
  for (const patch of [{ leadgen_id: 100 }, { ad_id: '../me' }, { page_id: '201' }, { form_id: null }]) {
    assert.throws(() => webhookEvents(notification(patch)), /invalid_notification/);
  }
  assert.deepEqual(webhookEvents({ object: 'instagram', entry: [] }), []);
});
test('durable enqueue deduplicates lead IDs and has no external calls or personal data', async () => {
  const h = harness(); const queued = [];
  const options = { models: h.models, reader: h.reader, raw: Buffer.from(JSON.stringify(notification())), signature: 'sha256=' + 'a'.repeat(64) };
  const result = await enqueueMetaLeadNotifications(notification(), { ...options, env: {}, enqueue: async job => queued.push(job) });
  assert.equal(result.queued, 1); assert.deepEqual(queued[0].payload, jobPayload);
  assert.equal(queued[0].dedupeScope, 'meta_leadgen:100'); assert.equal(h.state.graph.length, 0);
  await assert.rejects(enqueueMetaLeadNotifications(notification(), { ...options, enqueue: async () => { throw new Error('queue down'); } }), /queue down/);
  h.state.page = null;
  await assert.rejects(enqueueMetaLeadNotifications(notification(), { ...options, enqueue: async () => assert.fail() }), /page_access_required/);
});
test('the gateway sends receipts to its configured business worker, never to a caller-selected namespace', async () => {
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway' }), 'staging');
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'gateway', META_LEAD_JOB_RUNTIME_NAMESPACE: 'prod' }), 'prod');
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'dev' }), 'dev');
  const h = harness(); const queued = [];
  await enqueueMetaLeadNotifications(notification({ __runtime_namespace: 'dev' }), { models: h.models,
    reader: h.reader, raw: Buffer.from(JSON.stringify(notification())), signature: 'sha256=' + 'a'.repeat(64),
    env: { RUNTIME_ROLE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'prod' }, enqueue: async job => queued.push(job) });
  assert.equal(queued[0].payload.__runtime_namespace, 'prod');
});
test('native reception reads only an opaque owner receipt with the fixed Page/account pair', async () => {
  const h = harness(); const result = await retrieveMetaLead({ ...h, event });
  assert.deepEqual(result.identity, identity); assert.equal(result.clinic.id_clinica, 5);
  assert.deepEqual(h.state.graph, [{ operation: 'receiptRead', payload: { receiptRef, responseVersion: 2 } }]);
});
test('provider failure produces a retryable safe job result, no empty lead and no notification', async () => {
  const h = harness({ graphError: { response: { data: { error: { code: 190, message: 'secret contact' } } }, config: { access_token: 'secret' } } });
  const result = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.deepEqual(result, { status: 'failed', retryable: true, error_message: 'meta_lead_page_access_required' });
  assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('unconfirmed group campaign never falls back to the representative clinic or a duplicate Campana', async () => {
  const h = harness({ decisions: [] });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).error_message, 'meta_lead_clinic_assignment_required');
  assert.equal(h.state.leads.length, 0);
});
test('archived, conflicting, foreign-group or inactive clinic assignments do not receive leads', async () => {
  for (const patch of [{ decisions: [{ status: 'archived', clinica_id: 5 }] },
    { decisions: [{ status: 'active', clinica_id: 5 }, { status: 'active', clinica_id: 6 }] },
    { clinics: [{ id_clinica: 5, grupoClinicaId: 29, estado_clinica: 1 }] },
    { clinics: [{ id_clinica: 5, grupoClinicaId: 28, estado_clinica: 0 }] }]) {
    const h = harness(patch); assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'failed');
    assert.equal(h.state.leads.length, 0);
  }
});
test('account selection includes future campaigns only when explicitly enabled', async () => {
  const h = harness({ settings: [{ scope_type: 'group', accounts: [{ provider: 'meta_ads', account_id: '500', include_future: false, campaign_ids: [] }] }] });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).error_message, 'meta_lead_campaign_not_selected');
  h.state.settings[0].accounts[0].include_future = true;
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'completed');
});
test('revoked scope authorization or expired user token prevents provider access', async () => {
  for (const patch of [{ assignments: [] }, { connection: { id: 1, expiresAt: '2020-01-01' } }]) {
    const h = harness(patch); assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'failed');
    assert.equal(h.state.graph.length, 0);
  }
});
test('provider IDs must match signed notification and account lookup exactly', async () => {
  for (const patch of [{ id: '999' }, { form_id: '999' }, { ad_id: '999' }, { campaign_id: '999' }]) {
    const h = harness(); Object.assign(h.state.providerLead, patch);
    assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).error_message, 'meta_lead_identity_mismatch');
    assert.equal(h.state.leads.length, 0);
  }
});
test('missing email and phone is pending instead of an empty successful lead', async () => {
  assert.throws(() => contactFields({ field_data: [{ name: 'full_name', values: ['Name only'] }] }), /contact_unavailable/);
  const h = harness(); h.state.providerLead.field_data = [];
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).error_message, 'meta_lead_contact_unavailable');
  assert.equal(h.state.leads.length, 0);
});

test('a renewal-required local credential parks the signed receipt without Graph, writes or notification, then resumes', async () => {
  const h = harness(), original = h.reader.preparePair;
  h.reader.preparePair = async () => { throw Object.assign(Error('meta_credential_renewal_required'), { code: 'meta_credential_renewal_required' }); };
  const before = Date.now(), waiting = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.reason, 'meta_credential_renewal_required');
  assert.equal(waiting.error.code, 'meta_credential_renewal_required');
  assert(+waiting.nextAllowedAt >= before + 15 * 60000);
  assert.equal(h.state.graph.length, 0); assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
  h.reader.preparePair = original;
  const resumed = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(resumed.status, 'completed'); assert.equal(h.state.leads.length, 1);
});

test('explicit asset withdrawal remains terminal and never becomes an authorization wait', async () => {
  const h = harness(); h.reader.preparePair = async () => { throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' }); };
  const result = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
  assert.equal(h.state.graph.length, 0); assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
});

test('a confirmed provider credential rejection preserves its exact code and waits instead of discarding the receipt', async () => {
  const h = harness();h.reader.read = async () => { throw Object.assign(Error('credential_revoked'), { code: 'credential_revoked' }); };
  const result = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(result.status, 'waiting');assert.equal(result.reason, 'meta_credential_renewal_required');
  assert.equal(result.credentialError, 'credential_revoked');assert.equal(result.error.code, 'credential_revoked');
  assert.equal(h.state.leads.length, 0);assert.equal(h.state.notifications.length, 0);
});
test('lead and verified minimal attribution commit together, without custom health answers', async () => {
  const h = harness(); h.state.providerLead.field_data.push({ name: 'diagnosis', values: ['never copy'] });
  const result = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(result.status, 'completed'); assert.equal(h.state.leads[0].clinica_id, 5);
  assert.equal(h.state.leads[0].email, 'person@example.com');
  assert.deepEqual(h.state.audits[0].attribution_steps.advertising_identity, { version: 1, verified_by: 'meta_graph',
    provider: 'meta_ads', clinic_id: 5, ...identity, page_id: '200', form_id: '300' });
  assert.ok(!JSON.stringify(h.state.audits).includes('never copy')); assert.equal(h.state.notifications.length, 1);
});

test('historical recovery suppression commits with a new native lead and never overwrites an already existing attribution', async () => {
  const h = harness(), recovery = require('../../lib/metaLeadHistoricalRecovery');
  const retrieved = await retrieveMetaLead({ models: h.models, event, reader: h.reader, receiptRef, pageAssetId: 10, accountAssetId: 11 });
  const recoveryProof = recovery.issue({ actorId: 99, clinicId: 5, event, source: 'accepted_receipt', providerCreatedAt: retrieved.lead.created_time });
  await persistMetaLead({ models: h.models, event, retrieved, recoveryProof });
  assert.equal(h.state.leads.length, 1); assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].attribution_steps.meta_historical_recovery.automatic_messages, 'suppressed');
  assert.equal(h.state.leads[0].created_at.toISOString(), '2026-09-10T10:00:00.000Z');
  assert.equal(Object.hasOwn(h.state.leads[0], 'updated_at'), false);
  const original = JSON.stringify(h.state.audits);
  assert.equal((await persistMetaLead({ models: h.models, event, retrieved, recoveryProof })).duplicate, true);
  assert.equal(JSON.stringify(h.state.audits), original); assert.equal(h.state.notifications.length, 0);
  const ordinary = harness(), normal = await retrieveMetaLead({ models: ordinary.models, event, reader: ordinary.reader, receiptRef, pageAssetId: 10, accountAssetId: 11 });
  await persistMetaLead({ models: ordinary.models, event, retrieved: normal });
  const initial = JSON.stringify(ordinary.state.audits);
  await persistMetaLead({ models: ordinary.models, event, retrieved: normal, recoveryProof });
  assert.equal(JSON.stringify(ordinary.state.audits), initial);
  assert.equal(ordinary.state.audits[0].attribution_steps.meta_historical_recovery, undefined);
});

test('a forged historical recovery marker cannot write a lead, attribution, form or change consent', async () => {
  const h = harness(), retrieved = await retrieveMetaLead({ models: h.models, event, reader: h.reader, receiptRef, pageAssetId: 10, accountAssetId: 11 });
  await assert.rejects(persistMetaLead({ models: h.models, event, retrieved, recoveryProof: { automatic_messages: 'suppressed' } }), /proof_invalid/);
  assert.equal(h.state.leads.length, 0); assert.equal(h.state.audits.length, 0); assert.equal(h.state.forms.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('audit failure rolls back the lead and never notifies', async () => {
  const h = harness({ auditError: true });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'failed');
  assert.equal(h.state.rollback, 1); assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('redelivery and an outbox failure retry use the original lead, not a second lead or global contact merge', async () => {
  const h = harness({ notifyError: true });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'failed');
  assert.equal(h.state.leads.length, 1); h.state.notifyError = false;
  const result = await runMetaLeadReceptionJob(jobPayload, null, h);
  assert.equal(result.duplicate, true); assert.equal(h.state.leads.length, 1); assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.forms.length, 1);
});
test('private form failure atomically rolls back the native lead and attribution without notifying', async () => {
  const h = harness({ formError: true });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'failed');
  assert.equal(h.state.leads.length, 0); assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.forms.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('explicit v1 reads remain contact-only while the default rejects a missing v2 response', async () => {
  const h = harness();
  const v1 = await retrieveMetaLead({ ...h, event, responseVersion: 1 });
  assert.equal(v1.formResponse, null);
  assert.deepEqual(h.state.graph[0].payload, { receiptRef });
  h.state.formResponse = { version: 2, formId: '999', name: 'Foreign form', fields: [] };
  await assert.rejects(retrieveMetaLead({ ...h, event }), /meta_lead_form_response_invalid/);
  assert.equal(h.state.leads.length, 0);
});
test('invalid native form data and identity failures are terminal without lead, form or notification writes', async () => {
  const invalid = harness({ formResponse: { version: 2, formId: '999', name: 'Foreign form', fields: [] } });
  const identityMismatch = harness();
  const create = identityMismatch.models.LeadIntake.create;
  identityMismatch.models.LeadIntake.create = async (...args) => ({ ...await create(...args), external_id: '999' });
  for (const [h, code] of [[invalid, 'meta_lead_form_response_invalid'], [identityMismatch, 'meta_lead_form_identity_mismatch']]) {
    assert.deepEqual(await runMetaLeadReceptionJob(jobPayload, null, h), {
      status: 'failed', retryable: false, error_message: code,
    });
    assert.equal(h.state.leads.length, 0); assert.equal(h.state.forms.length, 0);
    assert.equal(h.state.audits.length, 0); assert.equal(h.state.notifications.length, 0);
  }
});
test('a changed response on redelivery is terminal and preserves the original lead, private event and notification count', async () => {
  const h = harness();
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'completed');
  const before = structuredClone({ leads: h.state.leads, forms: h.state.forms,
    audits: h.state.audits, notifications: h.state.notifications });
  h.state.formResponse = { version: 2, formId: '300', name: 'Fictitious form',
    fields: [{ key: 'preferred_time', label: 'Preferred time', type: 'CUSTOM', values: ['morning'] }] };
  assert.deepEqual(await runMetaLeadReceptionJob(jobPayload, null, h), {
    status: 'failed', retryable: false, error_message: 'meta_lead_form_conflict',
  });
  assert.deepEqual({ leads: h.state.leads, forms: h.state.forms,
    audits: h.state.audits, notifications: h.state.notifications }, before);
});
test('a previously imported lead is neither moved nor notified in a different clinic', async () => {
  const h = harness({ leads: [{ id: 1, clinica_id: 6, external_source: 'meta_leadgen', external_id: '100' }] });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).error_message, 'meta_lead_existing_scope_mismatch');
  assert.equal(h.state.notifications.length, 0);
});
test('assignment revocation between provider retrieval and persistence is checked again in the transaction', async () => {
  const h = harness(); const retrieved = await retrieveMetaLead({ ...h, event });
  h.state.assignments = [];
  await assert.rejects(persistMetaLead({ models: h.models, event, retrieved }), /page_access_required/);
  assert.equal(h.state.leads.length, 0);
});
test('organic form without campaign identity cannot choose an arbitrary clinic from a shared page', async () => {
  const h = harness();
  await assert.rejects(resolveMetaLeadClinic({ models: h.models, event, identity: null, pageAssetId: 10, connectionId: 1 }), /clinic_assignment_required/);
});
test('an explicit trusted Page route permits paid shared-account reception without inferring a group representative', async () => {
  const h = harness({ decisions: [], recipientClinicId: 5 });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, h)).status, 'completed');
  assert.equal(h.state.leads[0].clinica_id, 5);
  const conflict = harness({ decisions: [{ status: 'active', clinica_id: 5 }], recipientClinicId: 6 });
  assert.equal((await runMetaLeadReceptionJob(jobPayload, null, conflict)).error_message, 'meta_lead_clinic_scope_mismatch');
  assert.equal(conflict.state.leads.length, 0);
});
test('organic shared Page requires the independently reviewed Page route and never takes it from the job', async () => {
  const h = harness({ decisions: [], recipientClinicId: 5, eventOverride: { ...event, ad_id: null } });
  Object.assign(h.state.providerLead, { ad_id: null, campaign_id: null, is_organic: true });
  const payload = { ...jobPayload, ad_id: null, recipientClinicId: 99 };
  assert.equal((await runMetaLeadReceptionJob(payload, null, h)).status, 'completed');
  assert.equal(h.state.leads[0].clinica_id, 5); assert.equal(h.state.leads[0].channel, 'organic');
  h.state.recipientClinicId = null;
  assert.equal((await runMetaLeadReceptionJob(payload, null, h)).error_message, 'meta_lead_clinic_assignment_required');
});
