'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { GOOGLE_ADS_SCOPE, missingGoogleScopes, ensureGoogleConnectionAccessToken } = require('./googleAdsScopedRuntime.service');

const JOB_TYPE = 'campaign_google_leads_sync';
const ORIGIN = 'campaign_google_leads_poll';
const LOOKBACK_DAYS = 7;
const MAX_ROWS = 10000;
const enabled = env => env.CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED === 'true';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value) ? value : null;
const query = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const scopeKey = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;
const covers = (account, clinic) => account.assignmentScope === 'group'
  ? Number(account.grupoClinicaId) === Number(clinic.grupoClinicaId)
  : account.assignmentScope === 'clinic' && Number(account.clinicaId) === Number(clinic.id_clinica);

function resourceId(resource, accountId, collection) {
  const prefix = `customers/${accountId}/${collection}/`;
  return typeof resource === 'string' && resource.startsWith(prefix) ? id(resource.slice(prefix.length)) : null;
}

function parseGoogleLeadIdentity(row, accountId, now = new Date()) {
  const data = row?.leadFormSubmissionData || row?.lead_form_submission_data;
  const submissionId = data?.id;
  const resource = data?.resourceName ?? data?.resource_name;
  if (!id(accountId) || typeof submissionId !== 'string' || !submissionId || submissionId.length > 1024
    || /[\s\x00-\x1f]/.test(submissionId) || resource !== `customers/${accountId}/leadFormSubmissionData/${submissionId}`) fail('google_lead_identity_invalid');
  const campaignId = resourceId(data.campaign, accountId, 'campaigns');
  const formId = resourceId(data.asset, accountId, 'assets');
  const rawTime = data.submissionDateTime ?? data.submission_date_time;
  const occurredAt = new Date(rawTime);
  if (!campaignId || !formId || typeof rawTime !== 'string' || !/\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/.test(rawTime)
    || !Number.isFinite(+occurredAt) || +occurredAt > +now + 300000) fail('google_lead_identity_invalid');
  const adGroupResource = data.adGroup ?? data.ad_group;
  const adResource = data.adGroupAd ?? data.ad_group_ad;
  let adGroupId = adGroupResource ? resourceId(adGroupResource, accountId, 'adGroups') : null;
  if (adGroupResource && !adGroupId) fail('google_lead_identity_invalid');
  let adId = null;
  if (adResource) {
    const prefix = `customers/${accountId}/adGroupAds/`;
    const parts = typeof adResource === 'string' && adResource.startsWith(prefix) ? adResource.slice(prefix.length).split('~') : [];
    if (parts.length !== 2 || !id(parts[0]) || !id(parts[1]) || adGroupId && adGroupId !== parts[0]) fail('google_lead_identity_invalid');
    adId = parts[1];
    adGroupId ||= parts[0];
  }
  const gclid = typeof data.gclid === 'string' && data.gclid.length <= 128 && !/\s/.test(data.gclid) ? data.gclid || null : null;
  return { submissionId, occurredAt, identity: { version: 1, verified_by: 'google_ads_api', provider: 'google_ads',
    account_id: accountId, campaign_id: campaignId, form_id: formId, ad_id: adId, adgroup_id: adGroupId }, gclid };
}

function parseGoogleLead(row, accountId, now = new Date()) {
  const identity = parseGoogleLeadIdentity(row, accountId, now);
  const data = row.leadFormSubmissionData || row.lead_form_submission_data;
  const fields = data.leadFormSubmissionFields ?? data.lead_form_submission_fields;
  if (!Array.isArray(fields) || fields.length > 100) fail('google_lead_fields_invalid');
  const contact = new Map();
  for (const field of fields) {
    if (!field || typeof field !== 'object') fail('google_lead_fields_invalid');
    const key = field.fieldType ?? field.field_type;
    if (!['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE_NUMBER'].includes(key)) continue;
    const value = field.fieldValue ?? field.field_value;
    if (typeof value !== 'string' || value.length > 4096 || contact.has(key) && contact.get(key) !== value.trim()) fail('google_lead_fields_invalid');
    contact.set(key, value.trim());
  }
  const email = contact.get('EMAIL')?.toLowerCase();
  const phone = normalizePhoneDigits(contact.get('PHONE_NUMBER'));
  const validEmail = email && email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  const validPhone = phone && /^\d{9,15}$/.test(phone) ? phone : null;
  if (!validEmail && !validPhone) fail('google_lead_contact_unavailable');
  return { ...identity,
    contact: { nombre: (contact.get('FULL_NAME') || [contact.get('FIRST_NAME'), contact.get('LAST_NAME')].filter(Boolean).join(' ')).slice(0, 255) || null,
      email: validEmail, telefono: validPhone, email_hash: validEmail ? hash(validEmail) : null, phone_hash: validPhone ? hash(validPhone) : null } };
}

async function receptionAccount({ models, settingId, accountId, transaction = null, now = new Date() }) {
  if (typeof settingId !== 'string' || !settingId || settingId.length > 36 || !id(accountId)) fail('google_lead_job_invalid');
  const options = query(transaction);
  const setting = await models.CampaignWorkspaceSetting.findByPk(settingId, options);
  const selected = setting?.accounts?.filter(row => row.provider === 'google_ads' && row.account_id === accountId);
  if (!['clinic', 'group'].includes(setting?.scope_type) || !Number.isSafeInteger(Number(setting.scope_id))
    || Number(setting.scope_id) <= 0 || selected?.length !== 1) fail('google_lead_account_not_selected');
  // A group selection may use clinic-owned accounts; all actual owners remain visible when resolving the recipient.
  const members = setting.scope_type === 'group' ? await models.Clinica.findAll({ where: { grupoClinicaId: setting.scope_id }, ...options })
    : [await models.Clinica.findByPk(setting.scope_id, options)].filter(Boolean);
  if (!members.length || members.some(row => ![true, 1, '1'].includes(row.estado_clinica))) fail('google_lead_scope_inactive');
  const accounts = await models.ClinicGoogleAdsAccount.findAll({ where: { customerId: accountId, isActive: true }, ...options });
  const assignments = accounts.length ? await models.GoogleConnectionAssignment.findAll({ where: {
    status: 'active', scopeKey: { [Op.in]: [...new Set(accounts.map(scopeKey))] },
  }, ...options }) : [];
  const authorized = accounts.filter(account => assignments.some(row => row.scopeKey === scopeKey(account)
    && Number(row.googleConnectionId) === Number(account.googleConnectionId)));
  const eligible = authorized.filter(account => members.some(clinic => covers(account, clinic)));
  if (!eligible.length || new Set(eligible.map(row => Number(row.googleConnectionId))).size !== 1
    || new Set(eligible.map(row => row.loginCustomerId || row.managerCustomerId || null)).size !== 1) fail('google_lead_account_access_required');
  const connection = await models.GoogleConnection.findByPk(eligible[0].googleConnectionId, options);
  if (!connection?.accessToken || missingGoogleScopes(connection.scopes, [GOOGLE_ADS_SCOPE]).length
    || (!Number.isFinite(+new Date(connection.expiresAt)) || +new Date(connection.expiresAt) <= +now) && !connection.refreshToken) fail('google_lead_account_access_required');
  const loginCustomerId = eligible[0].loginCustomerId || eligible[0].managerCustomerId || null;
  const fingerprint = hash(JSON.stringify([setting.id, setting.scope_type, setting.scope_id, selected[0],
    members.map(row => [row.id_clinica, row.grupoClinicaId]).sort(),
    eligible.map(row => [row.id, scopeKey(row), row.googleConnectionId]).sort(),
    assignments.filter(row => eligible.some(account => scopeKey(account) === row.scopeKey))
      .map(row => [row.id, row.scopeKey, row.googleConnectionId, row.connectedAt]).sort(),
    connection.id, connection.googleUserId, String(connection.scopes).split(/[\s,]+/).filter(Boolean).sort(), loginCustomerId]));
  return { setting, members, accounts: authorized, eligible, connection, loginCustomerId, fingerprint };
}

async function receivingClinic({ models, context, identity, transaction = null }) {
  const options = query(transaction);
  if (!campaignIncluded(identity, context.setting)) fail('google_lead_campaign_not_selected');
  const assignments = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'google_ads',
    customer_id: identity.account_id, campaign_id: identity.campaign_id }, ...options });
  let clinicId;
  if (assignments.length) {
    if (assignments.length !== 1 || assignments[0].status !== 'active' || !assignments[0].clinica_id) fail('google_lead_clinic_assignment_required');
    clinicId = Number(assignments[0].clinica_id);
  } else {
    if (context.accounts.some(row => row.assignmentScope !== 'clinic')
      || new Set(context.accounts.map(row => Number(row.clinicaId))).size !== 1) fail('google_lead_clinic_assignment_required');
    clinicId = Number(context.accounts[0].clinicaId);
  }
  const clinic = context.members.find(row => Number(row.id_clinica) === clinicId);
  if (!clinic || !context.eligible.some(account => covers(account, clinic))) fail('google_lead_clinic_scope_mismatch');
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
    { scope_type: 'clinic', scope_id: clinicId },
    ...(clinic.grupoClinicaId ? [{ scope_type: 'group', scope_id: clinic.grupoClinicaId }] : []),
  ] }, ...options });
  const effective = settings.find(row => row.scope_type === 'clinic') || settings.find(row => row.scope_type === 'group');
  if (!campaignIncluded(identity, effective)) fail('google_lead_campaign_not_selected');
  return clinic;
}

async function persistGoogleLead({ models, context, parsed, now = new Date() }) {
  return models.sequelize.transaction(async transaction => {
    const fresh = await receptionAccount({ models, settingId: context.setting.id, accountId: parsed.identity.account_id, transaction, now });
    if (fresh.fingerprint !== context.fingerprint) fail('google_lead_authorization_changed');
    const clinic = await receivingClinic({ models, context: fresh, identity: parsed.identity, transaction });
    // Provider IDs are opaque and may exceed the historical varchar(128). A stable hash works for API and future webhooks.
    const externalId = hash(parsed.submissionId);
    const existing = await models.LeadIntake.findOne({ where: { external_source: 'google_lead_form', external_id: externalId },
      transaction, lock: transaction.LOCK.UPDATE });
    if (existing) {
      if (Number(existing.clinica_id) !== Number(clinic.id_clinica) || existing.google_ads_customer_id !== parsed.identity.account_id
        || existing.google_ads_campaign_id !== parsed.identity.campaign_id
        || existing.source_detail !== `leadgen_form:${parsed.identity.form_id}`) fail('google_lead_existing_scope_mismatch');
      return { lead: existing, duplicate: true };
    }
    const identity = { ...parsed.identity, clinic_id: Number(clinic.id_clinica) };
    const lead = await models.LeadIntake.create({ clinica_id: clinic.id_clinica, grupo_clinica_id: clinic.grupoClinicaId || null,
      event_id: `google_lead_form:${externalId}`, external_source: 'google_lead_form', external_id: externalId,
      source: 'google_ads', channel: 'paid', source_detail: `leadgen_form:${identity.form_id}`,
      google_ads_customer_id: identity.account_id, google_ads_campaign_id: identity.campaign_id, gclid: parsed.gclid,
      utm_source: 'google', utm_medium: 'leadgen', status_lead: 'nuevo',
      created_at: parsed.occurredAt,
      clinic_match_source: 'google_campaign_assignment', clinic_match_value: `${identity.account_id}:${identity.campaign_id}`,
      ...parsed.contact,
    }, { transaction });
    // No custom/clinical answers, invented advertising consent, or implicit conversion is created on reception.
    await models.LeadAttributionAudit.create({ lead_intake_id: lead.id,
      raw_payload: { provider: 'google_lead_form', lead_id: parsed.submissionId, form_id: identity.form_id,
        provider_created_at: parsed.occurredAt.toISOString() },
      attribution_steps: { advertising_identity: identity, google_native_received_at: now.toISOString(),
        google_reception_grant: fresh.fingerprint },
    }, { transaction });
    return { lead, duplicate: false };
  });
}

async function enqueueGoogleLeadSyncs({ models, env = process.env, enqueue } = {}) {
  if (!enabled(env)) return { status: 'completed', disabled: true, queued: 0 };
  models ||= require('../../models');
  enqueue ||= require('./jobRequests.service').enqueueUniqueJobRequest;
  const settings = await models.CampaignWorkspaceSetting.findAll({ attributes: ['id', 'accounts'], raw: true });
  let queued = 0;
  for (const setting of settings) for (const account of setting.accounts || []) {
    if (account.provider !== 'google_ads' || !id(account.account_id)) continue;
    const result = await enqueue({ type: JOB_TYPE, origin: ORIGIN, priority: 'high', maxAttempts: 5,
      payload: { setting_id: setting.id, account_id: account.account_id },
      dedupeScope: `${JOB_TYPE}:${setting.id}:${account.account_id}` });
    if (result.created) queued++;
  }
  return { status: 'completed', queued };
}

async function runGoogleLeadSync(payload, job, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (!enabled(env)) return { status: 'completed', disabled: true };
  if (job?.type !== JOB_TYPE || job.origin !== ORIGIN || job.requested_by != null) return { status: 'failed', retryable: false, error_message: 'google_lead_internal_job_required' };
  const models = dependencies.models || require('../../models');
  const now = (dependencies.now || (() => new Date()))();
  const counts = { received: 0, duplicates: 0, excluded: 0, pending: 0, invalid_contacts: 0 };
  try {
    const context = await receptionAccount({ models, settingId: payload.setting_id, accountId: payload.account_id, now });
    const token = await (dependencies.ensureToken || ensureGoogleConnectionAccessToken)(context.connection, { requiredScopes: [GOOGLE_ADS_SCOPE] });
    const since = new Date(+now - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const search = dependencies.search || googleAdsSearchRows;
    const rows = await search({ customerId: payload.account_id, accessToken: token.accessToken, loginCustomerId: context.loginCustomerId,
      maxPages: 10, timeoutMs: 45000, query: `SELECT lead_form_submission_data.id, lead_form_submission_data.resource_name,
        lead_form_submission_data.asset, lead_form_submission_data.campaign, lead_form_submission_data.ad_group,
        lead_form_submission_data.ad_group_ad, lead_form_submission_data.gclid,
        lead_form_submission_data.submission_date_time, lead_form_submission_data.lead_form_submission_fields
        FROM lead_form_submission_data WHERE lead_form_submission_data.submission_date_time >= '${since}'
        ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC LIMIT ${MAX_ROWS + 1}` });
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('google_lead_response_incomplete');
    // Validate the whole response before writing: a malformed identity is not a partial successful import.
    const parsed = rows.map(row => parseGoogleLeadIdentity(row, payload.account_id, now));
    const seen = new Map();
    for (const lead of parsed) {
      const fingerprint = JSON.stringify(lead.identity);
      if (seen.has(lead.submissionId) && seen.get(lead.submissionId) !== fingerprint) fail('google_lead_identity_invalid');
      seen.set(lead.submissionId, fingerprint);
    }
    for (const [index, identity] of parsed.entries()) {
      if (!enabled(env)) fail('google_lead_sync_disabled');
      if (!campaignIncluded(identity.identity, context.setting)) { counts.excluded++; continue; }
      let lead;
      try { lead = parseGoogleLead(rows[index], payload.account_id, now); }
      catch (error) {
        if (['google_lead_fields_invalid', 'google_lead_contact_unavailable'].includes(error.code)) { counts.invalid_contacts++; continue; }
        throw error;
      }
      let result;
      try { result = await persistGoogleLead({ models, context, parsed: lead, now }); }
      catch (error) {
        if (['google_lead_clinic_assignment_required', 'google_lead_clinic_scope_mismatch', 'google_lead_campaign_not_selected'].includes(error.code)) { counts.pending++; continue; }
        throw error;
      }
      counts[result.duplicate ? 'duplicates' : 'received']++;
      if (!result.lead.archived_at) await (dependencies.notify || require('./leadAutoReply.service').enqueueForLead)({
        lead: result.lead, eventKind: 'write', eventAt: result.lead.created_at || result.lead.createdAt || now });
    }
    return counts.pending ? { status: 'failed', retryable: true, error_message: 'google_lead_assignment_pending', ...counts }
      : counts.invalid_contacts ? { status: 'failed', retryable: false, error_message: 'google_lead_contact_pending', ...counts }
      : { status: 'completed', ...counts };
  } catch (error) {
    const code = /^google_lead_[a-z_]+$/.test(error.code || '') ? error.code : 'google_lead_sync_failed';
    return { status: 'failed', retryable: !['google_lead_job_invalid', 'google_lead_sync_disabled'].includes(code), error_message: code, ...counts };
  }
}

module.exports = { JOB_TYPE, ORIGIN, LOOKBACK_DAYS, parseGoogleLead, receptionAccount, receivingClinic,
  persistGoogleLead, enqueueGoogleLeadSyncs, runGoogleLeadSync };
