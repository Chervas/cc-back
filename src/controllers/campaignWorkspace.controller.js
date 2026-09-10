'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { resolveClinicScope } = require('../lib/clinicScope');
const { getAccessibleMarketingClinicIds, hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { loadCampaignWorkspace, loadWorkspaceInventory } = require('../services/campaignWorkspace.service');
const { settingScope, publicSettings, saveWorkspaceAccounts } = require('../services/campaignWorkspaceSettings.service');
const { loadWorkspacePreparation } = require('../services/campaignWorkspacePreparation.service');
const { activateWorkspaceMeasurement } = require('../services/campaignWorkspaceActivation.service');
const { assignWorkspaceCampaign } = require('../services/campaignWorkspaceAssignment.service');
const { campaignReference, metaCampaignContext, refreshMetaCampaignDestinations } = require('../services/campaignWorkspaceMetaDestination.service');
const { loadNativeFormEvidence } = require('../services/campaignWorkspaceNativeReception.service');
const { requestPageReception, getPageReceptionJob } = require('../services/campaignWorkspaceMetaPage.service');
const { saveWorkspacePreferences } = require('../services/campaignWorkspacePreferences.service');

function createWorkspaceHandler({ models = db, resolveScope = resolveClinicScope,
  accessibleClinics = getAccessibleMarketingClinicIds, hasAccess = hasMarketingClinicScopeAccess,
  load = loadCampaignWorkspace } = {}) {
  return async (req, res) => {
    const userId = Number(req.userData?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ success: false, error: 'unauthenticated' });
    const raw = String(req.query.scope || '').trim();
    if (!/^(all|group:[1-9]\d*|[1-9]\d*(,[1-9]\d*)*)$/.test(raw)) return res.status(400).json({ success: false, error: 'invalid_scope' });
    const days = Number(req.query.days ?? 30);
    if (![7, 30].includes(days)) return res.status(400).json({ success: false, error: 'invalid_period' });
    const scope = await resolveScope(raw, { allowAll: true });
    if (scope.notFound) return res.status(404).json({ success: false, error: 'scope_not_found' });
    if (!scope.isValid) return res.status(400).json({ success: false, error: 'invalid_scope' });
    if (scope.isAll) scope.clinicIds = await accessibleClinics({ userId, clinicIds: scope.clinicIds, access: 'read' });
    if (!scope.clinicIds.length || !await hasAccess({ userId, clinicIds: scope.clinicIds, access: 'read' })) {
      return res.status(403).json({ success: false, error: 'marketing_scope_forbidden' });
    }
    res.set('Cache-Control', 'private, no-store');
    return res.json(await load({ models, scope, days }));
  };
}

exports.getWorkspace = asyncHandler(createWorkspaceHandler());
exports.createWorkspaceHandler = createWorkspaceHandler;

function createWorkspaceConfigurationHandlers({ models = db, resolveScope = resolveClinicScope,
  hasAccess = hasMarketingClinicScopeAccess, loadInventory = loadWorkspaceInventory, save = saveWorkspaceAccounts,
  prepare = loadWorkspacePreparation, activate = activateWorkspaceMeasurement, assign = assignWorkspaceCampaign,
  metaContext = metaCampaignContext, refreshMeta = refreshMetaCampaignDestinations, nativeEvidence = loadNativeFormEvidence,
  requestMetaPage = requestPageReception, metaPageJob = getPageReceptionJob, savePreferences = saveWorkspacePreferences } = {}) {
  async function authorize(req, res, access) {
    const actorId = Number(req.userData?.userId);
    if (!Number.isSafeInteger(actorId) || actorId <= 0) { res.status(401).json({ success: false, error: 'unauthenticated' }); return null; }
    const raw = String(req.query.scope || '').trim();
    if (!/^(group:)?[1-9]\d*$/.test(raw)) { res.status(400).json({ success: false, error: 'single_workspace_scope_required' }); return null; }
    const scope = await resolveScope(raw);
    if (scope.notFound) { res.status(404).json({ success: false, error: 'scope_not_found' }); return null; }
    if (!scope.isValid || !scope.clinicIds.length) { res.status(400).json({ success: false, error: 'invalid_scope' }); return null; }
    if (!await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access })) {
      res.status(403).json({ success: false, error: 'marketing_scope_forbidden' }); return null;
    }
    res.set('Cache-Control', 'private, no-store');
    return { scope, actorId };
  }
  return {
    preferences: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try { return res.json(await savePreferences({ models, ...context, input: req.body, loadInventory })); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    requestMetaPage: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try { return res.status(202).json(await requestMetaPage({ models, ...context, input: req.body, loadInventory })); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    metaPageJob: async (req, res) => {
      const context = await authorize(req, res, 'read');
      if (!context) return;
      try {
        const input = campaignReference({ account_id: req.query.account_id, campaign_id: req.query.campaign_id });
        return res.json(await metaPageJob({ models, ...context, input, jobId: Number(req.params.jobId), loadInventory }));
      } catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    metaPreparation: async (req, res) => {
      const context = await authorize(req, res, 'read');
      if (!context) return;
      try {
        const reference = campaignReference({ account_id: req.query.account_id, campaign_id: req.query.campaign_id });
        const result = await metaContext({ models, scope: context.scope, reference, loadInventory });
        const inventory = await loadInventory({ models, scope: context.scope });
        const evidence = await nativeEvidence({ models, campaigns: [result.campaign], selectedClinics: inventory.selectedClinics, scope: context.scope });
        return res.json({ success: true, revision: result.revision, campaign: result.campaign,
          canWrite: await hasAccess({ userId: context.actorId, clinicIds: context.scope.clinicIds, access: 'write' }),
          forms: evidence.get(result.campaign.id)?.forms || [],
          reception: evidence.get(result.campaign.id)?.reception || null });
      } catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    refreshMeta: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try { return res.json(await refreshMeta({ models, ...context, input: req.body, loadInventory })); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    assign: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try { return res.json(await assign({ models, ...context, input: req.body })); }
      catch (error) {
        const status = error.status || error.httpStatus;
        if (status >= 400 && status < 500) return res.status(status).json({ success: false, error: error.code });
        throw error;
      }
    },
    activate: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try { return res.json(await activate({ models, ...context, input: req.body })); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
        throw error;
      }
    },
    preparation: async (req, res) => {
      const context = await authorize(req, res, 'read');
      if (!context) return;
      return res.json(await prepare({ models, scope: context.scope, loadInventory }));
    },
    get: async (req, res) => {
      const context = await authorize(req, res, 'read');
      if (!context) return;
      const row = await models.CampaignWorkspaceSetting.findOne({ where: settingScope(context.scope), raw: true });
      const inventory = await loadInventory({ models, scope: context.scope });
      return res.json({ success: true, configuration: publicSettings(row, context.scope),
        canWrite: await hasAccess({ userId: context.actorId, clinicIds: context.scope.clinicIds, access: 'write' }),
        scope: { clinicIds: context.scope.clinicIds, groupId: context.scope.groupId || null },
        accounts: inventory.accounts, campaigns: inventory.campaigns });
    },
    put: async (req, res) => {
      const context = await authorize(req, res, 'write');
      if (!context) return;
      try {
        return res.json(await save({ models, ...context, input: req.body, loadInventory }));
      } catch (error) {
        if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code || error.message });
        throw error;
      }
    },
  };
}

const configurationHandlers = createWorkspaceConfigurationHandlers();
exports.getConfiguration = asyncHandler(configurationHandlers.get);
exports.saveAccounts = asyncHandler(configurationHandlers.put);
exports.getPreparation = asyncHandler(configurationHandlers.preparation);
exports.activateMeasurement = asyncHandler(configurationHandlers.activate);
exports.assignCampaign = asyncHandler(configurationHandlers.assign);
exports.getMetaPreparation = asyncHandler(configurationHandlers.metaPreparation);
exports.refreshMetaPreparation = asyncHandler(configurationHandlers.refreshMeta);
exports.requestMetaPageReception = asyncHandler(configurationHandlers.requestMetaPage);
exports.getMetaPageReceptionJob = asyncHandler(configurationHandlers.metaPageJob);
exports.savePreferences = asyncHandler(configurationHandlers.preferences);
exports.createWorkspaceConfigurationHandlers = createWorkspaceConfigurationHandlers;
