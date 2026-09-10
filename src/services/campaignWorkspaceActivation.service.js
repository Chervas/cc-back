'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const { Op } = require('sequelize');
const { settingScope, publicSettings, validateAccountSelection } = require('./campaignWorkspaceSettings.service');
const { loadWorkspaceInventory } = require('./campaignWorkspace.service');
const { loadWorkspacePreparation } = require('./campaignWorkspacePreparation.service');
const { buildCampaignModeContract, CAMPAIGN_MODES } = require('./campaignMode.service');

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
  deploymentReady = process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true' }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  if (!validate(input)) fail('invalid_workspace_activation', 400);
  // DEV and workers can share a database. Do not migrate a scope until every sender understands its policy.
  if (!deploymentReady) fail('workspace_activation_deployment_pending');
  if (input.signals.enabled) fail('workspace_signal_preparation_required');
  const where = settingScope(scope);
  return models.sequelize.transaction(async transaction => {
    const ownerModel = where.scope_type === 'group' ? models.GrupoClinica : models.Clinica;
    if (!await ownerModel.findByPk(where.scope_id, { transaction, lock: transaction.LOCK.UPDATE })) fail('scope_not_found', 404);
    const setting = await models.CampaignWorkspaceSetting.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (!setting || Number(setting.version) !== input.expected_version) fail('workspace_version_conflict');
    if (setting.preferences && (setting.preferences.mode !== input.mode
      || setting.preferences.signals.enabled !== input.signals.enabled)) fail('workspace_preferences_mismatch');
    const intakeWhere = where.scope_type === 'group'
      ? { assignment_scope: 'group', group_id: where.scope_id }
      : { assignment_scope: 'clinic', clinic_id: where.scope_id };
    const record = await models.IntakeConfig.findOne({ where: intakeWhere, transaction, lock: transaction.LOCK.UPDATE });
    const preparation = await loadPreparation({ models, scope, transaction });
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
    const previous = setting.activation || null;
    const activatedAt = now().toISOString();
    const activation = { schema_version: 1, mode: 'measurement', status: 'active', activated_at: activatedAt,
      activated_by_user_id: actorId, account_authorizations: accounts, signals: { enabled: false, events: [] },
      preparation_revision: input.preparation_revision };
    const config = record?.config || {};
    const nextConfig = { ...config,
      campaigns: { ...config.campaigns, active_mode: CAMPAIGN_MODES.MEASURE,
        mode_contract: { ...buildCampaignModeContract(CAMPAIGN_MODES.MEASURE), consented_conversion_uploads: false },
        workspace_policy: { schema_version: 1, setting_id: setting.id, ...where } },
    };
    if (record) await record.update({ config: nextConfig }, { transaction });
    else await models.IntakeConfig.create({ ...intakeWhere, config: nextConfig, domains: [], hmac_key: null }, { transaction });
    const version = Number(setting.version) + 1;
    await setting.update({ activation, version, updated_by_user_id: actorId }, { transaction });
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
      event_type: 'measurement_activated', actor_user_id: actorId, created_at: now(),
      changes: { activation: { before: previous, after: activation } } }, { transaction });
    return { success: true, configuration: publicSettings(setting, scope) };
  });
}

module.exports = { activateWorkspaceMeasurement };
