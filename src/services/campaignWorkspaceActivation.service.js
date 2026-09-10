'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const { Op } = require('sequelize');
const { settingScope, publicSettings, validateAccountSelection } = require('./campaignWorkspaceSettings.service');
const { loadWorkspaceInventory } = require('./campaignWorkspace.service');
const { loadWorkspacePreparation } = require('./campaignWorkspacePreparation.service');
const { buildCampaignModeContract, CAMPAIGN_MODES } = require('./campaignMode.service');
const { loadSignalAuthorizationReview, verifySignalDestination } = require('./campaignWorkspaceSignalAuthorization.service');
const { resolveWorkspaceSignalRoute, loadSignalRoutingScope } = require('./campaignWorkspaceSignalRouting.service');
const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');

const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['expected_version', 'preparation_revision', 'mode', 'signals', 'confirmed'],
  properties: {
    expected_version: { type: 'integer', minimum: 1 },
    preparation_revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    mode: { const: 'measurement' }, confirmed: { const: true },
    signals: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
  },
});
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };

async function activateWorkspaceMeasurement({ models, scope, actorId, input, now = () => new Date(),
  loadPreparation = loadWorkspacePreparation, loadInventory = loadWorkspaceInventory,
  loadSignalReview = loadSignalAuthorizationReview, resolveRoute = resolveWorkspaceSignalRoute, hasAccess,
  deploymentReady = process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true' }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  if (!validate(input)) fail('invalid_workspace_activation', 400);
  // DEV and workers can share a database. Do not migrate a scope until every sender understands its policy.
  if (!deploymentReady) fail('workspace_activation_deployment_pending');
  const where = settingScope(scope);
  const permitted = async () => {
    if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' })) fail('marketing_scope_forbidden', 403);
  };
  return models.sequelize.transaction(async transaction => {
    await permitted();
    const ownerModel = where.scope_type === 'group' ? models.GrupoClinica : models.Clinica;
    const owner = await ownerModel.findByPk(where.scope_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!owner) fail('scope_not_found', 404);
    const members = where.scope_type === 'group' ? await models.Clinica.findAll({ where: { grupoClinicaId: where.scope_id },
      attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], transaction, lock: transaction.LOCK.UPDATE }) : [owner];
    if (JSON.stringify(members.map(row => Number(row.id_clinica)).sort((a, b) => a - b))
      !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b)) || members.some(row => ![true, 1, '1'].includes(row.estado_clinica))) fail('workspace_scope_changed');
    const setting = await models.CampaignWorkspaceSetting.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (!setting || Number(setting.version) !== input.expected_version) fail('workspace_version_conflict');
    if (!setting.preferences || setting.preferences.mode !== input.mode
      || setting.preferences.signals?.enabled !== input.signals.enabled || setting.preferences.optimization) fail('workspace_preferences_mismatch');
    const intakeWhere = where.scope_type === 'group'
      ? { assignment_scope: 'group', group_id: where.scope_id }
      : { assignment_scope: 'clinic', clinic_id: where.scope_id };
    const record = await models.IntakeConfig.findOne({ where: intakeWhere, transaction, lock: transaction.LOCK.UPDATE });
    const preparation = await loadPreparation({ models, scope, transaction, now: now() });
    if (preparation.revision !== input.preparation_revision) fail('workspace_preparation_changed');
    if (!preparation.selectionConfirmed || !preparation.receptionReady) fail('workspace_reception_pending');
    if (preparation.existing && preparation.existing.mode !== CAMPAIGN_MODES.MEASURE) fail('workspace_mode_transition_required');
    if (preparation.campaigns.some(row => row.campaign.assigned && row.configurationScope
      && (row.configurationScope.scope_type !== where.scope_type || Number(row.configurationScope.scope_id) !== where.scope_id))) {
      fail('workspace_shared_web_scope_required');
    }
    const inventory = await loadInventory({ models, scope, transaction });
    const policyScopes = [{ scopeType: where.scope_type, scopeId: where.scope_id },
      { scopeType: 'clinic', scopeId: { [Op.in]: scope.clinicIds } }];
    if (inventory.groups?.length) policyScopes.push({ scopeType: 'group', scopeId: { [Op.in]: inventory.groups } });
    const policies = await models.CampaignOptimizationPolicy.findAll({ where: { [Op.or]: policyScopes,
      status: { [Op.in]: ['active', 'paused'] } }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    if (policies.length) fail('workspace_active_optimization_policy');
    const accounts = validateAccountSelection({ expected_version: input.expected_version, accounts: setting.accounts },
      inventory, setting);
    const signalReview = input.signals.enabled ? await loadSignalReview({ models, scope, setting, transaction, now: now() }) : null;
    if (input.signals.enabled && (!preparation.signals?.ready || !signalReview?.review.ready || !signalReview.authorization)) fail('workspace_signal_preparation_required');
    await permitted();
    const previous = setting.activation || null;
    const activatedAt = now().toISOString();
    const activation = { schema_version: 2, mode: 'measurement', status: 'active', activated_at: activatedAt,
      activated_by_user_id: actorId, account_authorizations: accounts,
      signals: { enabled: input.signals.enabled, events: input.signals.enabled ? [...setting.preferences.signals.events] : [],
        ...(input.signals.enabled ? { authorization: structuredClone(signalReview.authorization) } : {}) },
      preparation_revision: input.preparation_revision };
    const config = record?.config || {};
    const nextConfig = { ...config,
      campaigns: { ...config.campaigns, active_mode: CAMPAIGN_MODES.MEASURE,
        mode_contract: { ...buildCampaignModeContract(CAMPAIGN_MODES.MEASURE), consented_conversion_uploads: input.signals.enabled },
        workspace_policy: { schema_version: 1, setting_id: setting.id, ...where } },
    };
    if (record) await record.update({ config: nextConfig }, { transaction });
    // Native-only workspaces do not need an empty website installation to remember their mode.
    const version = Number(setting.version) + 1;
    await setting.update({ activation, version, updated_by_user_id: actorId }, { transaction });
    if (input.signals.enabled) {
      const scopes = new Map(); const grants = new Map();
      const loadScope = args => {
        if (!scopes.has(args.clinicId)) scopes.set(args.clinicId, loadSignalRoutingScope(args));
        return scopes.get(args.clinicId);
      };
      const verify = args => {
        const key = JSON.stringify([args.clinicId, args.provider, args.accountId, args.setting.id, args.setting.version, args.eventName, args.destinationId]);
        if (!grants.has(key)) grants.set(key, verifySignalDestination(args));
        return grants.get(key);
      };
      // Validate the effective clinic/group intersection before committing the mandate.
      for (const { campaign } of preparation.campaigns.filter(row => row.campaign.assigned)) {
        for (const eventName of activation.signals.events) {
          try {
            const route = await resolveRoute({ models, clinicId: campaign.clinicId, provider: campaign.provider,
              accountId: campaign.account_id, campaignId: campaign.campaign_id, eventName,
              crmEventSource: CRM_MILESTONE_SOURCE, now: now(), transaction, loadScope, verify });
            if (!route) fail('workspace_signal_authorization_required');
          } catch (error) {
            if (/^workspace_/.test(error.code || '')) fail(error.code);
            throw error;
          }
        }
      }
    }
    await permitted();
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
      event_type: 'measurement_activated', actor_user_id: actorId, created_at: now(),
      changes: { activation: { before: previous, after: activation } } }, { transaction });
    return { success: true, configuration: publicSettings(setting, scope) };
  });
}

module.exports = { activateWorkspaceMeasurement };
