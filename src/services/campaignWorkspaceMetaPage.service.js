'use strict';

const { Op } = require('sequelize');
const { graphId, revision, metaCampaignContext } = require('./campaignWorkspaceMetaDestination.service');
const { settingScope } = require('./campaignWorkspaceSettings.service');

const JOB_TYPE = 'campaign_meta_page_reception';
const MAX_AGE = 86400000;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const pageScopeKey = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;
const pageFingerprint = row => revision({ id: row.id, page: row.metaAssetId, scope: pageScopeKey(row),
  connection: row.metaConnectionId, binding: row.bindingFingerprint });
const appId = () => graphId(process.env.META_APP_ID);

function pageProof(page, now = new Date(), applicationId = appId()) {
  const proof = page.brokerProof;
  const age = +now - +new Date(proof?.checked_at);
  if (!applicationId || !proof || Object.keys(proof).sort().join(',') !== 'account_asset_id,app_id,checked_at,fingerprint,job_id,page_asset_id,state,version'
    || !Number.isSafeInteger(proof.job_id) || proof.job_id < 1 || proof.version !== 2 || proof.app_id !== applicationId || proof.fingerprint !== pageFingerprint(page)
    || proof.page_asset_id !== Number(page.id) || proof.account_asset_id !== page.accountAssetId
    || !['verified', 'access_required', 'subscription_required'].includes(proof.state)
    || !Number.isFinite(age) || age < 0 || age >= MAX_AGE) return null;
  return { state: proof.state, checkedAt: proof.checked_at };
}

function pageCommand(input) {
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !['account_id', 'campaign_id', 'page_id', 'revision', 'action', 'confirmed'].includes(key))
    || !graphId(input.account_id) || !graphId(input.campaign_id) || !graphId(input.page_id)
    || !/^[a-f0-9]{64}$/.test(input.revision || '') || !['check', 'enable'].includes(input.action)
    || (input.action === 'enable' ? input.confirmed !== true : input.confirmed !== undefined)) fail('invalid_meta_page_command', 400);
  return { ...input };
}

async function pageContext({ models, scope, input, loadInventory, transaction = null, reader }) {
  const context = await metaCampaignContext({ models, scope, reference: input, loadInventory, transaction, reader });
  if (context.revision !== input.revision) fail('workspace_meta_check_conflict');
  if (!context.campaign.nativeForms?.some(form => form.pageId === input.page_id)) fail('workspace_meta_page_not_in_campaign', 403);
  const clinic = await models.Clinica.findByPk(context.campaign.clinicId, { raw: true, transaction });
  const rows = await models.ClinicMetaAsset.findAll({ where: { assetType: 'facebook_page', metaAssetId: input.page_id, isActive: true,
    [Op.or]: [{ assignmentScope: 'clinic', clinicaId: context.campaign.clinicId },
      ...(clinic?.grupoClinicaId ? [{ assignmentScope: 'group', grupoClinicaId: clinic.grupoClinicaId }] : [])] },
  attributes: ['id', 'metaAssetId', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId'],
  raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  const authorized = rows.filter(row => Number(row.metaConnectionId) === Number(context.connection.id));
  const owner = settingScope(scope);
  const preferred = authorized.filter(row => pageScopeKey(row) === `${owner.scope_type}:${owner.scope_id}`);
  const pages = preferred.length ? preferred : authorized;
  if (!pages.length) fail('workspace_meta_page_connection_required');
  if (pages.length !== 1) fail('workspace_meta_page_ambiguous');
  const page = pages[0];
  // A clinic administrator cannot change the subscription of a page owned by the whole group.
  if (input.action === 'enable' && (page.assignmentScope === 'group'
    ? Number(scope.groupId) !== Number(page.grupoClinicaId) : !scope.clinicIds.includes(Number(page.clinicaId)))) {
    fail('workspace_meta_page_group_required', 403);
  }
  const pair = await context.reader.preparePair(Number(page.id), context.accountAssetId, { transaction });
  const authority = await context.reader.assertPair(pair, { transaction });
  if (authority.page.id !== input.page_id || authority.account.id !== input.account_id
    || !authority.page.clinicIds.includes(Number(context.campaign.clinicId))) fail('workspace_meta_permissions_required');
  const described = { ...page, bindingFingerprint: authority.fingerprint, accountAssetId: context.accountAssetId,
    brokerAppId: authority.page.appId };
  return { ...context, pair, page: described, fingerprint: pageFingerprint(described) };
}

function publicJob(job) {
  return { id: job.id, status: job.status, action: job.payload?.action,
    error: job.status === 'failed' ? (job.error_message?.startsWith('workspace_meta_') ? job.error_message : 'workspace_meta_unavailable') : null };
}

async function assertPageMutation({ models, page, actorId, transaction = null, hasAccess }) {
  try {
    await require('../lib/sharedMarketingAssetMutationAccess').assertSharedMarketingAssetMutationAccess({
      userId: actorId, assetType: 'meta.facebook_page', assetId: page.id, ownerClinicId: page.clinicaId, transaction,
      assignmentModel: models.GroupAssetClinicAssignment, authorizeClinicIds: hasAccess,
      findImplicitGroupId: async () => page.assignmentScope === 'group' ? page.grupoClinicaId : null,
      findGroupClinicIds: async groupId => (await models.Clinica.findAll({ where: { grupoClinicaId: groupId },
        attributes: ['id_clinica'], raw: true, transaction })).map(row => row.id_clinica),
      findPrimaryGroupIds: async () => (await models.GrupoClinica.findAll({
        where: { facebook_primary_asset_id: page.id }, attributes: ['id_grupo'], raw: true, transaction,
        ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
      })).map(row => row.id_grupo),
    });
  } catch (error) {
    if (error.code === 'asset_in_use') fail('workspace_meta_page_shared_access_required', 403);
    throw error;
  }
}

async function requestPageReception({ models, scope, actorId, input, loadInventory, enqueue, assertMutation = assertPageMutation, reader }) {
  input = pageCommand(input);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  if (!appId()) fail('workspace_meta_app_unavailable');
  return models.sequelize.transaction(async transaction => {
    const context = await pageContext({ models, scope, input, loadInventory, transaction, reader });
    if (input.action === 'enable') await assertMutation({ models, page: context.page, actorId, transaction });
    const owner = settingScope(scope);
    const result = await (enqueue || require('./jobRequests.service').enqueueUniqueJobRequest)({
      type: JOB_TYPE, payload: { ...input, scope: owner.scope_type === 'group' ? `group:${owner.scope_id}` : String(owner.scope_id),
        asset_id: context.page.id, account_asset_id: context.accountAssetId, fingerprint: context.fingerprint },
      dedupeScope: `meta_page_reception:${owner.scope_type}:${owner.scope_id}:${context.page.id}:${context.fingerprint}:${input.action}`,
      origin: 'campaign_workspace', requestedBy: actorId, priority: 'high', maxAttempts: 3,
    }, { transaction, JobRequestModel: models.JobRequest, sequelizeInstance: models.sequelize });
    return { success: true, job: publicJob(result.job) };
  });
}

async function getPageReceptionJob({ models, scope, input, jobId, loadInventory, reader }) {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) fail('invalid_meta_page_job', 400);
  const job = await models.JobRequest.findByPk(jobId, { raw: true });
  const owner = settingScope(scope);
  const key = owner.scope_type === 'group' ? `group:${owner.scope_id}` : String(owner.scope_id);
  if (!job || job.type !== JOB_TYPE || job.payload?.scope !== key || job.payload?.account_id !== input.account_id
    || job.payload?.campaign_id !== input.campaign_id) fail('workspace_meta_job_not_found', 404);
  await pageContext({ models, scope, input: job.payload, loadInventory, reader });
  return { success: true, job: publicJob(job) };
}

async function inspectPage(context, read) {
  const response = await read(context.pair, 'pageStatus', {});
  if (response.page.id !== context.page.metaAssetId) fail('workspace_meta_identity_mismatch');
  return { fields: response.subscription.fields, subscriptionRevision: response.subscription.revision,
    state: !response.page.has_lead_access ? 'access_required' : response.subscription.subscribed
      && response.subscription.fields.includes('leadgen') ? 'verified' : 'subscription_required' };
}

async function runPageReceptionJob(payload, job, overrides = {}) {
  const models = overrides.models || require('../../models');
  const loadInventory = overrides.loadInventory || require('./campaignWorkspace.service').loadWorkspaceInventory;
  const resolveScope = overrides.resolveScope || require('../lib/clinicScope').resolveClinicScope;
  const hasAccess = overrides.hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
  const reader = overrides.reader || require('./metaMarketingLeadReader.service').forModels(models);
  const applicationId = overrides.applicationId || appId();
  let context; let input; let revalidate;
  const persist = async state => models.sequelize.transaction(async transaction => {
    const latest = await revalidate(transaction);
    return { version: 2, fingerprint: latest.fingerprint, app_id: applicationId, checked_at: new Date().toISOString(),
      state, job_id: job.id, page_asset_id: Number(latest.page.id), account_asset_id: latest.accountAssetId };
  });
  try {
    input = pageCommand(Object.fromEntries(['account_id', 'campaign_id', 'page_id', 'revision', 'action', 'confirmed']
      .filter(key => payload[key] !== undefined).map(key => [key, payload[key]])));
    if (!applicationId || !/^(group:)?[1-9]\d*$/.test(payload.scope || '') || !job?.requested_by) fail('workspace_meta_job_invalid');
    revalidate = async (transaction = null) => {
      const latestScope = await resolveScope(payload.scope);
      if (!latestScope.isValid || !latestScope.clinicIds?.length || !await hasAccess({ userId: job.requested_by,
        clinicIds: latestScope.clinicIds, access: 'write' })) fail('workspace_meta_job_access_revoked', 403);
      const current = await pageContext({ models, scope: latestScope, input, loadInventory, transaction, reader });
      if (Number(current.page.id) !== Number(payload.asset_id) || current.accountAssetId !== payload.account_asset_id
        || current.fingerprint !== payload.fingerprint) fail('workspace_meta_check_conflict');
      if (input.action === 'enable') await (overrides.assertMutation || assertPageMutation)({
        models, page: current.page, actorId: job.requested_by, transaction, hasAccess,
      });
      return current;
    };
    context = await revalidate();
    const deadline = Date.now() + 45000;
    const boundedRead = (pair, operation, data) => {
      const remaining = deadline - Date.now();
      if (remaining < 1000) fail('workspace_meta_check_timeout');
      return reader.read(pair, operation, data, { timeoutMs: Math.min(30000, remaining) });
    };
    let result = await inspectPage(context, boundedRead);
    if (input.action === 'enable' && result.state === 'subscription_required') {
      context = await revalidate();
      await boundedRead(context.pair, 'pageEnable', { expectedSubscriptionRevision: result.subscriptionRevision });
      result = await inspectPage(context, boundedRead);
      if (result.state === 'subscription_required') fail('workspace_meta_subscription_unconfirmed');
    }
    const proof = await persist(result.state);
    return { status: 'completed', page_id: input.page_id, reception: result.state, proof };
  } catch (error) {
    const waiting = require('./metaMarketingLeadReader.service').cooldownWait(error, JOB_TYPE);
    if (waiting) return waiting;
    const providerCode = Number(error.response?.data?.error?.code);
    const code = error.code?.startsWith('workspace_meta_') ? error.code
      : /^META_RATE_LIMIT/.test(error.code || '') || [4, 17, 613].includes(providerCode) ? 'workspace_meta_rate_limited'
      : [10, 190, 200].includes(providerCode) ? 'workspace_meta_permissions_required' : 'workspace_meta_unavailable';
    if (context && code === 'workspace_meta_permissions_required') {
      // Failed jobs invalidate the newest readiness proof. No asset metadata
      // or credential-bearing legacy row is changed to record that failure.
    }
    return { status: 'failed', retryable: ['workspace_meta_unavailable', 'workspace_meta_rate_limited',
      'workspace_meta_check_timeout', 'workspace_meta_subscription_unconfirmed'].includes(code), error_message: code };
  }
}

module.exports = { JOB_TYPE, pageFingerprint, pageProof, pageCommand, pageContext, inspectPage, assertPageMutation,
  requestPageReception, getPageReceptionJob, runPageReceptionJob };
