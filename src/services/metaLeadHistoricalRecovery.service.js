'use strict';

// Administrative recovery is separate from webhook delivery and autoresponses.
// Plans/journals contain IDs and outcomes, never contacts or opaque provider proofs.
const { randomUUID, createHash } = require('node:crypto');
const reception = require('./metaLeadReception.service');
const recovery = require('../lib/metaLeadHistoricalRecovery');
const L = require('../../services/integrations-broker/src/meta-marketing-leads-contract');
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const STOP = new Set(['meta_credential_renewal_required', 'credential_revoked', 'provider_unauthorized',
  'secret_unavailable', 'secret_version_changed', 'rate_limited', 'scope_denied', 'asset_revoked',
  'connection_blocked', 'meta_broker_scope_changed', 'meta_business_activation_uncertain',
  'meta_lead_recovery_forbidden', 'meta_lead_recovery_journal_unavailable']);
const safe = error => STOP.has(error?.code) || /^meta_lead_[a-z_]{1,80}$/.test(error?.code || '')
  ? error.code : 'meta_lead_recovery_unavailable';
function normalizeInput(value) {
  const { actorId, clinicIds, pageAssetId, accountAssetId, formId, startDate, endDate, runtime,
    startInstant, endInstant, timeZone = 'Europe/Madrid', acceptedJobIds = [], maxPages = 10, maxLeads = 100 } = value || {};
  if (!positive(actorId) || !Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 20
    || clinicIds.some(id => !positive(id)) || new Set(clinicIds).size !== clinicIds.length
    || !positive(pageAssetId) || !positive(accountAssetId) || !graphId(formId)
    || !['dev', 'staging', 'prod'].includes(runtime) || timeZone !== 'Europe/Madrid'
    || !Array.isArray(acceptedJobIds) || acceptedJobIds.length > 20 || acceptedJobIds.some(id => !positive(id))
    || new Set(acceptedJobIds).size !== acceptedJobIds.length || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20
    || !Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > 500) fail('meta_lead_recovery_invalid');
  const bounds = L.recoveryWindow({ startDate, endDate });
  const instant = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) return null;
    const canonical = new Date(value).toISOString();
    return canonical === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? canonical : null;
  };
  const from = instant(startInstant), to = instant(endInstant);
  if (!from || !to || Date.parse(from) < bounds.start || Date.parse(to) > bounds.end || from >= to) fail('meta_lead_recovery_invalid_window');
  return { actorId, clinicIds: [...clinicIds].sort((a,b) => a-b), pageAssetId, accountAssetId, formId, startDate, endDate, runtime,
    startInstant: from, endInstant: to, timeZone, language: 'es-ES', providerDayBasis: 'UTC', acceptedJobIds: [...acceptedJobIds].sort((a,b) => a-b), maxPages, maxLeads };
}
function optionsFromPlan(plan) {
  if (!plan || plan.version !== 2 || plan.mode !== 'scan' || plan.complete !== true || !Array.isArray(plan.results)
    || typeof plan.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(plan.authorityDigest)) fail('meta_lead_recovery_plan_invalid');
  const input = normalizeInput(plan.input);
  const selected = plan.results.filter(row => row.status === 'missing');
  if (selected.length > 20 || selected.some(row => !graphId(row.externalId)
    || !['accepted_receipt', 'provider_form_recovery'].includes(row.source))
    || new Set(selected.map(row => row.externalId)).size !== selected.length) fail('meta_lead_recovery_plan_invalid');
  return { ...input, apply: true, expectedLeadIds: selected.map(row => row.externalId), expectedAuthorityDigest: plan.authorityDigest };
}
async function defaultAuthorize(models, input, { transaction } = {}) {
  const locked = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
  const user = await models.Usuario.findByPk(input.actorId, { attributes: ['id_usuario', 'estado_cuenta'], raw: true, logging: false, ...locked });
  if (!user || Number(user.id_usuario) !== input.actorId || user.estado_cuenta !== 'activo') return false;
  return require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess({ userId: input.actorId,
    clinicIds: input.clinicIds, access: 'write', membershipModel: { findAll: options => models.UsuarioClinica.findAll({ ...options, ...locked }) } });
}
function createHistoricalRecovery({ models, reader, persist = reception.persistMetaLead, retrieve = reception.retrieveMetaLead,
  resolveClinic = reception.resolveMetaLeadClinic, authorize = (input, options) => defaultAuthorize(models, input, options), journal = null, now = () => new Date() }) {
  if (!models?.LeadIntake || !reader?.preparePair || !reader?.read || !reader?.assertPair || typeof authorize !== 'function') fail('meta_lead_recovery_invalid');
  async function run(value) {
    const input = normalizeInput(value), { actorId, clinicIds, pageAssetId, accountAssetId, formId, startDate, endDate } = input;
    if (value.expectedLeadIds != null && !Array.isArray(value.expectedLeadIds)) fail('meta_lead_recovery_invalid');
    const apply = value.apply === true, selected = value.expectedLeadIds === undefined || value.expectedLeadIds === null ? null : new Set(value.expectedLeadIds);
    if (value.apply !== undefined && typeof value.apply !== 'boolean'
      || selected && (!Array.isArray(value.expectedLeadIds) || selected.size !== value.expectedLeadIds.length || selected.size > 20 || [...selected].some(id => !graphId(id)))
      || apply && (!selected || typeof journal !== 'function' || !/^[a-f0-9]{64}$/.test(value.expectedAuthorityDigest || ''))) fail('meta_lead_recovery_plan_required');
    const checkActor = async (options = {}) => { if (await authorize(input, options) !== true) fail('meta_lead_recovery_forbidden'); };
    await checkActor();
    const pair = await reader.preparePair(pageAssetId, accountAssetId), captured = await reader.assertPair(pair);
    if (captured.page?.scopeKey !== 'group:29' || captured.account?.scopeKey !== 'group:29'
      || captured.page.mappingId !== pageAssetId || captured.account.mappingId !== accountAssetId
      || JSON.stringify(captured.page.clinicIds) !== JSON.stringify(clinicIds)
      || !clinicIds.includes(captured.route?.recipientClinicId)) fail('meta_lead_recovery_scope_mismatch');
    const authorityDigest = hash(captured);
    if (apply && authorityDigest !== value.expectedAuthorityDigest) fail('meta_lead_recovery_scope_changed');
    const batchId = randomUUID(), results = [], candidates = new Map(), seen = new Set(), cursors = new Set();
    const report = { version: 2, mode: apply ? 'apply' : 'scan', batchId, at: now().toISOString(), input,
      authorityDigest, complete: false, pages: 0, observed: 0, ignoredOutsideWindow: 0, stopped: false, results,
      missingFromProvider: [], messagesSent: 0 };
    let journalFailed = false;
    const write = async event => { if (journal) try { await journal({ version: 1, batchId, at: now().toISOString(), ...event }); }
      catch (_) { journalFailed = true; fail('meta_lead_recovery_journal_unavailable'); } };
    const inWindow = timestamp => Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) >= Date.parse(input.startInstant)
      && Date.parse(timestamp) < Date.parse(input.endInstant);
    await write({ phase: 'started', mode: report.mode, actorId, pageAssetId, accountAssetId, formId, authorityDigest });
    // Known jobs prove an actual accepted webhook. Do not manufacture a receipt
    // for IDs merely found in Leads Center or a downloaded spreadsheet.
    for (const jobId of input.acceptedJobIds) {
      if (!models.JobRequest?.findByPk) fail('meta_lead_recovery_job_invalid');
      const job = await models.JobRequest.findByPk(jobId, { attributes: ['id', 'type', 'payload', 'status'], raw: true, logging: false });
      let payload; try { payload = typeof job?.payload === 'string' ? JSON.parse(job.payload) : job?.payload; } catch (_) { fail('meta_lead_recovery_job_invalid'); }
      if (!job || Number(job.id) !== jobId || job.type !== reception.JOB_TYPE || !['failed', 'completed'].includes(job.status)
        || !payload || payload.__runtime_namespace !== input.runtime || payload.page_asset_id !== pageAssetId || payload.account_asset_id !== accountAssetId
        || payload.page_id !== captured.page.id || payload.form_id !== formId || !graphId(payload.lead_id) || !uuid(payload.receipt_ref)
        || payload.ad_id !== null && !graphId(payload.ad_id)) fail('meta_lead_recovery_job_invalid');
      if (candidates.has(payload.lead_id)) fail('meta_lead_recovery_conflict');
      candidates.set(payload.lead_id, { externalId: payload.lead_id, source: 'accepted_receipt', jobId, payload });
    }
    // Finish bounded enumeration before any clinical INSERT. No opaque proof or
    // provider contact is written into the plan or operation journal.
    let cursor = null;
    do {
      if (++report.pages > input.maxPages) fail('meta_lead_recovery_limit');
      const data = await reader.read(pair, 'recoveryList', { formId, startDate, endDate, cursor });
      for (const candidate of data.results) {
        if (!graphId(candidate.leadId) || candidate.formId !== formId || seen.has(candidate.leadId)) fail('meta_lead_recovery_conflict');
        seen.add(candidate.leadId); if (seen.size > input.maxLeads) fail('meta_lead_recovery_limit');
        if (!inWindow(candidate.createdTime)) { report.ignoredOutsideWindow++; continue; }
        const old = candidates.get(candidate.leadId);
        if (old && old.payload.ad_id !== null && old.payload.ad_id !== candidate.adId) fail('meta_lead_recovery_conflict');
        if (!old) candidates.set(candidate.leadId, { externalId: candidate.leadId, source: 'provider_form_recovery', candidate });
      }
      cursor = data.nextCursor;
      if (cursor !== null) { if (typeof cursor !== 'string' || cursors.has(cursor)) fail('meta_lead_recovery_conflict'); cursors.add(cursor); }
    } while (cursor !== null);
    report.observed = seen.size;
    report.missingFromProvider = selected ? [...selected].filter(id => !candidates.has(id)) : [];
    await checkActor(); await reader.assertPair(pair);
    for (const entry of candidates.values()) {
      if (selected && !selected.has(entry.externalId)) continue;
      const base = { externalId: entry.externalId, source: entry.source, ...(entry.jobId ? { jobId: entry.jobId } : {}) };
      if (report.stopped) { results.push({ ...base, status: 'not_attempted' }); continue; }
      let existing;
      try {
        existing = await models.LeadIntake.findOne({ where: { external_source: 'meta_leadgen', external_id: entry.externalId },
          attributes: ['id', 'clinica_id', 'archived_at'], raw: true, logging: false });
        if (existing && (!clinicIds.includes(Number(existing.clinica_id))
          || Number(existing.clinica_id) !== captured.route.recipientClinicId)) fail('meta_lead_existing_scope_mismatch');
      } catch (error) {
        results.push({ ...base, status: 'unavailable', code: safe(error) }); report.stopped = true; continue;
      }
      if (existing) {
        results.push({ ...base, clinicId: Number(existing.clinica_id), status: 'already_present' }); continue;
      }
      if (!apply) { results.push({ ...base, status: 'missing' }); continue; }
      let intent = false, persisted = false;
      try {
        await checkActor(); await reader.assertPair(pair);
        let event, retrieved;
        if (entry.source === 'accepted_receipt') {
          event = Object.fromEntries(['lead_id', 'page_id', 'form_id', 'ad_id'].map(key => [key, entry.payload[key]]));
          retrieved = await retrieve({ models, reader, event, receiptRef: entry.payload.receipt_ref, pageAssetId, accountAssetId, responseVersion: 2 });
        } else {
          const candidate = entry.candidate;
          event = { lead_id: candidate.leadId, page_id: captured.page.id, form_id: candidate.formId, ad_id: candidate.adId };
          const response = await reader.read(pair, 'recoveryRead', { proof: candidate.proof });
          if (['lead_id', 'page_id', 'form_id', 'ad_id'].some(key => response.event[key] !== event[key])
            || response.lead.id !== event.lead_id || response.lead.form_id !== formId) fail('meta_lead_recovery_conflict');
          const current = await reader.assertPair(pair);
          const details = { identity: response.identity, pageAssetId, accountAssetId, connectionId: current.page.connectionId,
            recipientClinicId: response.recipientClinicId, authority: { assert: async options => { await checkActor(options); return reader.assertPair(pair, options); } } };
          const clinic = await resolveClinic({ models, event, ...details });
          const formResponse = require('./metaLeadFormResponse.service').validatedResponse(response.form_response, formId);
          retrieved = { lead: response.lead, clinic, responseVersion: 2, formResponse, ...details };
        }
        const authority = retrieved.authority;
        retrieved.authority = { assert: async options => { await checkActor(options); return authority.assert(options); } };
        if (!inWindow(retrieved.lead.created_time)) { results.push({ ...base, status: 'outside_window' }); continue; }
        const clinicId = Number(retrieved.clinic.id_clinica);
        if (!clinicIds.includes(clinicId)) fail('meta_lead_recovery_scope_mismatch');
        await checkActor(); await reader.assertPair(pair);
        const proof = recovery.issue({ actorId, clinicId, event, source: entry.source, providerCreatedAt: retrieved.lead.created_time, batchId, recoveredAt: now() });
        await write({ phase: 'persist_intent', ...base, clinicId }); intent = true;
        const result = await persist({ models, event, retrieved, now: now(), recoveryProof: proof }); persisted = true;
        const row = { ...base, clinicId, status: result.duplicate ? 'already_present' : 'recovered' };
        await write({ phase: 'persist_result', ...row }); results.push(row);
      } catch (error) {
        const code = safe(error), uncertain = intent && (persisted || code === 'meta_lead_recovery_unavailable');
        results.push({ ...base, status: uncertain ? 'outcome_unknown' : 'unavailable', code });
        if (uncertain || STOP.has(code)) report.stopped = true;
      }
    }
    report.complete = !report.stopped && report.missingFromProvider.length === 0
      && (!apply || results.every(row => ['already_present', 'recovered'].includes(row.status)));
    if (!journalFailed) try {
      await write({ phase: 'finished', complete: report.complete, observed: report.observed,
        counts: results.reduce((all,row)=>(all[row.status]=(all[row.status]||0)+1,all),{}), messagesSent: 0 });
    } catch (_) { report.complete = false; report.stopped = true; }
    if (journalFailed) report.journalUnavailable = true;
    return report;
  }
  return { run };
}
module.exports = { createHistoricalRecovery, normalizeInput, optionsFromPlan };
